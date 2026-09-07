import type { CvdSnapshot } from "./market-cvd.ts";
import type { DerivativesSnapshot } from "./market-derivatives.ts";
import {
  classifyMarketFailure,
  compactSymbol,
  formatVenueFallbackNotice,
  looksGeoBlocked,
  sanitizeMarketCopy,
  shortBlockedMessage,
  suggestedFallbackVenue,
  toUnifiedSwapSymbol,
  venueFallbackOrder,
  type ChartInterval,
  type MarketRequestFailure,
  type MarketVenue,
} from "./market-venues.ts";

type FetchImpl = typeof fetch;

export type DerivativesPulseResult = {
  snapshot: DerivativesSnapshot;
  venue: MarketVenue;
  fallbackFrom: MarketVenue | null;
  notice: string | null;
};

export type OrderFlowResult = {
  snapshot: CvdSnapshot;
  venue: MarketVenue;
  fallbackFrom: MarketVenue | null;
  notice: string | null;
};

const lastGoodDerivativesVenue = new Map<string, MarketVenue>();
const lastGoodCvdVenue = new Map<string, MarketVenue>();

export function hasDerivativesData(snapshot: Partial<DerivativesSnapshot> | null | undefined): boolean {
  if (!snapshot) return false;
  return [snapshot.openInterestValue, snapshot.openInterestAmount, snapshot.fundingRate, snapshot.markPrice, snapshot.indexPrice]
    .some((value) => value != null && Number.isFinite(Number(value)));
}

export async function loadDerivativesPulse(
  preferred: MarketVenue,
  symbol: string,
  fetchImpl: FetchImpl = fetch,
  options: { retryPreferred?: boolean } = {},
): Promise<DerivativesPulseResult> {
  const compact = compactSymbol(symbol);
  const unified = toUnifiedSwapSymbol(compact);
  const cacheKey = `${preferred}:${compact}`;
  const retryPreferred = options.retryPreferred ?? true;
  const failures: MarketRequestFailure[] = [];
  for (const venue of pulseOrder(preferred, lastGoodDerivativesVenue, cacheKey, retryPreferred)) {
    try {
      const response = await fetchImpl(`/api/derivatives?exchange=${venue}&symbol=${encodeURIComponent(unified)}`);
      const body = await response.text();
      if (!response.ok) {
        failures.push(failureFromResponse(venue, response.status, body));
        continue;
      }
      const snapshot = parseJson(body) as DerivativesSnapshot;
      if (!hasDerivativesData(snapshot)) {
        failures.push(classifyMarketFailure(venue, 502, "Empty derivatives snapshot"));
        continue;
      }
      lastGoodDerivativesVenue.set(cacheKey, venue);
      const fallbackFrom = venue === preferred ? null : preferred;
      const blocked = preferredWasBlocked(preferred, failures);
      return {
        snapshot,
        venue,
        fallbackFrom,
        notice: fallbackFrom ? formatVenueFallbackNotice(preferred, venue, blocked) : null,
      };
    } catch (error) {
      failures.push(classifyMarketFailure(venue, 0, error instanceof Error ? error.message : "Failed to fetch"));
    }
  }
  throw Object.assign(new Error(joinPulseFailures(preferred, failures, "Open interest")), {
    failures,
    blocked: failures.some((failure) => failure.blocked),
    venue: preferred,
    status: failures.find((failure) => failure.venue === preferred)?.status ?? 0,
  });
}

export async function loadOrderFlowCvd(
  preferred: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  fetchImpl: FetchImpl = fetch,
  options: { retryPreferred?: boolean } = {},
): Promise<OrderFlowResult> {
  const compact = compactSymbol(symbol);
  const cacheKey = `${preferred}:${compact}:${interval}`;
  const retryPreferred = options.retryPreferred ?? true;
  const failures: MarketRequestFailure[] = [];
  let bestPartial: CvdSnapshot | null = null;

  for (const venue of pulseOrder(preferred, lastGoodCvdVenue, cacheKey, retryPreferred)) {
    try {
      const response = await fetchImpl(`/api/cvd?exchange=${venue}&symbol=${encodeURIComponent(compact)}&interval=${interval}`);
      const body = await response.text();
      if (!response.ok) {
        failures.push(failureFromResponse(venue, response.status, body));
        continue;
      }
      const snapshot = sanitizeCvdSnapshot(parseJson(body) as CvdSnapshot);
      if (snapshot.perp.available) {
        lastGoodCvdVenue.set(cacheKey, venue);
        const fallbackFrom = venue === preferred ? null : preferred;
        const blocked = preferredWasBlocked(preferred, failures);
        return {
          snapshot,
          venue,
          fallbackFrom,
          notice: fallbackFrom
            ? formatVenueFallbackNotice(preferred, venue, blocked)
            : snapshot.notice,
        };
      }
      const perpFailure = perpUnavailableFailure(snapshot);
      if (perpFailure) failures.push(perpFailure);
      if (!bestPartial || (snapshot.spot.available && !bestPartial.spot.available)) {
        bestPartial = snapshot;
      }
    } catch (error) {
      failures.push(classifyMarketFailure(venue, 0, error instanceof Error ? error.message : "Failed to fetch"));
    }
  }

  if (bestPartial) {
    return {
      snapshot: bestPartial,
      venue: bestPartial.venue,
      fallbackFrom: bestPartial.venue === preferred ? null : preferred,
      notice: partialCvdNotice(preferred, bestPartial, failures),
    };
  }

  throw Object.assign(new Error(joinPulseFailures(preferred, failures, "Order flow")), {
    failures,
    blocked: failures.some((failure) => failure.blocked),
    venue: preferred,
    status: failures.find((failure) => failure.venue === preferred)?.status ?? 0,
  });
}

export function sanitizeCvdSnapshot(snapshot: CvdSnapshot): CvdSnapshot {
  return {
    ...snapshot,
    notice: sanitizeMarketCopy(snapshot.notice, snapshot.venue) || null,
    perp: { ...snapshot.perp, reason: snapshot.perp.reason ? sanitizeMarketCopy(snapshot.perp.reason, snapshot.venue) || null : null },
    spot: { ...snapshot.spot, reason: snapshot.spot.reason ? sanitizeMarketCopy(snapshot.spot.reason, snapshot.venue) || null : null },
    comparison: {
      ...snapshot.comparison,
      interpretation: sanitizeMarketCopy(snapshot.comparison.interpretation, snapshot.venue) || snapshot.comparison.interpretation,
    },
  };
}

function pulseOrder(
  preferred: MarketVenue,
  cache: Map<string, MarketVenue>,
  cacheKey: string,
  retryPreferred: boolean,
): MarketVenue[] {
  const order = venueFallbackOrder(preferred);
  const cached = cache.get(cacheKey);
  if (!retryPreferred && cached && order.includes(cached)) {
    return [cached, ...order.filter((venue) => venue !== cached)];
  }
  return order;
}

function failureFromResponse(venue: MarketVenue, status: number, body: string): MarketRequestFailure {
  const payload = parseJson(body);
  const classified = classifyMarketFailure(venue, status, typeof payload.error === "string" ? payload.error : body);
  const blocked = classified.blocked || payload.blocked === true || looksGeoBlocked(status, body);
  return blocked
    ? { ...classified, blocked: true, message: shortBlockedMessage(venue) }
    : classified;
}

function perpUnavailableFailure(snapshot: CvdSnapshot): MarketRequestFailure {
  const reason = snapshot.perp.reason || snapshot.notice || "Perp CVD unavailable";
  const blocked = looksGeoBlocked(0, reason) || /\bblocked\b/i.test(reason);
  return {
    venue: snapshot.venue,
    status: blocked ? 403 : 502,
    blocked,
    message: blocked ? shortBlockedMessage(snapshot.venue) : sanitizeMarketCopy(reason, snapshot.venue) || "Perp CVD unavailable",
  };
}

function partialCvdNotice(preferred: MarketVenue, snapshot: CvdSnapshot, failures: MarketRequestFailure[]): string {
  const blocked = preferredWasBlocked(preferred, failures);
  const tried = new Set(failures.map((failure) => failure.venue));
  const unused = venueFallbackOrder(preferred).filter((venue) => venue !== preferred && !tried.has(venue));
  const parts: string[] = [];
  if (blocked) {
    parts.push(unused[0] ? shortBlockedMessage(preferred, unused[0]) : `${shortBlockedMessage(preferred).replace(/ — try .+$/, "")}. Perp CVD unavailable.`);
  } else if (snapshot.notice) {
    parts.push(snapshot.notice);
  } else {
    parts.push("Perp CVD unavailable.");
  }
  if (snapshot.source === "public-mirror" && snapshot.spot.available) {
    parts.push("Spot via public mirror.");
  }
  return parts.join(" ");
}

function preferredWasBlocked(preferred: MarketVenue, failures: MarketRequestFailure[]): boolean {
  return failures.some((failure) => failure.venue === preferred && failure.blocked);
}

function joinPulseFailures(preferred: MarketVenue, failures: MarketRequestFailure[], label: string): string {
  if (failures.some((failure) => failure.blocked)) {
    return shortBlockedMessage(preferred, suggestedFallbackVenue(preferred));
  }
  return sanitizeMarketCopy(failures[0]?.message) || `${label} is unavailable.`;
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(body) as unknown;
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : { error: body };
  } catch {
    return { error: body };
  }
}
