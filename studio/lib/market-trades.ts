import { parseVenueTrades, tradeRequestUrl, type MarketTrade } from "./market-cvd.ts";
import {
  clampMinNotional,
  formatNotionalUsd,
  formatWallPrice,
  okxInstrumentUrl,
  parseOkxContractValue,
  relativeNotionalPercents,
} from "./market-depth.ts";
import {
  classifyMarketFailure,
  compactSymbol,
  formatVenueFallbackNotice,
  intervalDurationMs,
  isMarketVenue,
  looksGeoBlocked,
  sanitizeMarketCopy,
  shortBlockedMessage,
  suggestedFallbackVenue,
  venueFallbackOrder,
  type ChartInterval,
  type MarketRequestFailure,
  type MarketVenue,
} from "./market-venues.ts";

type FetchImpl = typeof fetch;

export const LARGE_TRADES_STORAGE_KEY = "th-large-trades";
export const LARGE_TRADES_EMPTY = "Large trades unavailable.";
export const MAX_LARGE_TRADES = 40;

export type TradeSide = "buy" | "sell";

export type LargeTrade = {
  time: number;
  price: number;
  size: number;
  notional: number;
  side: TradeSide;
};

export type LargeTradeSnapshot = {
  venue: MarketVenue;
  symbol: string;
  source: "official";
  minNotional: number;
  trades: LargeTrade[];
  notice: string | null;
  updatedAt: number;
};

export type LargeTradeLoadResult = {
  snapshot: LargeTradeSnapshot;
  venue: MarketVenue;
  fallbackFrom: MarketVenue | null;
  notice: string | null;
};

export type TradesQuery =
  | { ok: true; venue: MarketVenue; symbol: string; minNotional: number }
  | { ok: false; error: string };

export type PlannedTradeMarker = {
  time: number;
  price: number;
  side: TradeSide;
  notional: number;
  radius: number;
  color: string;
};

export type TradeListEntry = {
  side: TradeSide;
  time: number;
  price: number;
  priceLabel: string;
  notionalLabel: string;
  clockLabel: string;
  barPct: number;
};

const lastGoodTradeVenue = new Map<string, MarketVenue>();

export function parseTradesQuery(url: URL, supportedExchangesMessage: string): TradesQuery {
  const exchange = (url.searchParams.get("exchange") || "bybit").toLowerCase();
  const symbol = compactSymbol(url.searchParams.get("symbol") || "BTCUSDT");
  if (!isMarketVenue(exchange)) {
    return { ok: false, error: supportedExchangesMessage };
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return { ok: false, error: "Use a compact perpetual symbol such as BTCUSDT" };
  }
  return {
    ok: true,
    venue: exchange,
    symbol,
    minNotional: clampMinNotional(url.searchParams.get("minNotional")),
  };
}

export function selectLargeTrades(
  trades: readonly MarketTrade[],
  contractMultiplier: number,
  minNotional: number,
): LargeTrade[] {
  const scale = Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : 1;
  const min = clampMinNotional(minNotional);
  const selected: LargeTrade[] = [];
  const seen = new Set<string>();
  for (const trade of trades) {
    if (trade.side !== "buy" && trade.side !== "sell") continue;
    const price = trade.price;
    const size = trade.size * scale;
    const notional = price * size;
    if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(notional)) continue;
    if (price <= 0 || size <= 0 || notional < min) continue;
    const time = trade.time < 10_000_000_000 ? trade.time * 1000 : trade.time;
    const key = `${time}:${price}:${trade.side}:${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ time, price, size, notional, side: trade.side });
  }
  return selected.sort((left, right) => right.time - left.time).slice(0, MAX_LARGE_TRADES);
}

export function sanitizeLargeTrades(value: unknown, minNotional: number): LargeTrade[] {
  if (!Array.isArray(value)) return [];
  const min = clampMinNotional(minNotional);
  const trades: LargeTrade[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (item.side !== "buy" && item.side !== "sell") continue;
    const price = Number(item.price);
    const size = Number(item.size);
    const notional = Number(item.notional);
    const time = Number(item.time);
    if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(notional) || !Number.isFinite(time)) continue;
    if (price <= 0 || size <= 0 || notional < min || time <= 0) continue;
    if (Math.abs(notional - price * size) / notional > 0.02) continue;
    trades.push({ time, price, size, notional, side: item.side });
  }
  return trades.sort((left, right) => right.time - left.time).slice(0, MAX_LARGE_TRADES);
}

export function sanitizeLargeTradeSnapshot(
  snapshot: LargeTradeSnapshot,
  venue: MarketVenue = snapshot.venue,
  symbol = snapshot.symbol,
  minNotional = snapshot.minNotional,
): LargeTradeSnapshot {
  const min = clampMinNotional(minNotional);
  return {
    venue: isMarketVenue(snapshot.venue) ? snapshot.venue : venue,
    symbol: compactSymbol(snapshot.symbol || symbol),
    source: "official",
    minNotional: min,
    trades: sanitizeLargeTrades(snapshot.trades, min),
    notice: sanitizeMarketCopy(snapshot.notice, snapshot.venue || venue) || null,
    updatedAt: Number.isFinite(snapshot.updatedAt) ? Number(snapshot.updatedAt) : Date.now(),
  };
}

export function tradeBarTimeSeconds(time: number, interval: ChartInterval): number {
  const ms = time < 10_000_000_000 ? time * 1000 : time;
  const duration = intervalDurationMs(interval);
  return Math.floor(ms / duration) * (duration / 1000);
}

export function tradeMarkerColor(side: TradeSide | "unknown"): string {
  if (side === "buy") return "rgba(83, 201, 144, 0.92)";
  if (side === "sell") return "rgba(231, 103, 112, 0.92)";
  return "rgba(176, 186, 198, 0.88)";
}

export function planTradeMarkers(trades: readonly LargeTrade[], interval: ChartInterval): PlannedTradeMarker[] {
  const notionals = trades.map((trade) => trade.notional).filter((value) => Number.isFinite(value) && value > 0);
  const min = notionals.length ? Math.min(...notionals) : 0;
  const max = notionals.length ? Math.max(...notionals) : 0;
  return trades.map((trade) => ({
    time: tradeBarTimeSeconds(trade.time, interval),
    price: trade.price,
    side: trade.side,
    notional: trade.notional,
    radius: markerRadius(trade.notional, min, max),
    color: tradeMarkerColor(trade.side),
  }));
}

export function formatTradeClock(time: number): string {
  const ms = time < 10_000_000_000 ? time * 1000 : time;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds} UTC`;
}

export function tradeListEntries(trades: readonly LargeTrade[]): TradeListEntry[] {
  const ordered = [...trades].sort((left, right) => right.time - left.time);
  const bars = relativeNotionalPercents(ordered.map((trade) => trade.notional));
  return ordered.map((trade, index) => ({
    side: trade.side,
    time: trade.time,
    price: trade.price,
    priceLabel: formatWallPrice(trade.price),
    notionalLabel: formatNotionalUsd(trade.notional),
    clockLabel: formatTradeClock(trade.time),
    barPct: bars[index] ?? 0,
  }));
}

export async function fetchVenueLargeTrades(
  venue: MarketVenue,
  symbol: string,
  minNotional = clampMinNotional(undefined),
  fetchImpl: FetchImpl = fetch,
): Promise<LargeTradeSnapshot> {
  const compact = compactSymbol(symbol);
  const min = clampMinNotional(minNotional);
  const [trades, multiplier] = await Promise.all([
    loadPerpTrades(venue, compact, fetchImpl),
    venue === "okx" ? fetchOkxContractMultiplier(compact, fetchImpl) : Promise.resolve(1),
  ]);
  return {
    venue,
    symbol: compact,
    source: "official",
    minNotional: min,
    trades: selectLargeTrades(trades, multiplier, min),
    notice: null,
    updatedAt: Date.now(),
  };
}

export async function loadLargeTrades(
  preferred: MarketVenue,
  symbol: string,
  fetchImpl: FetchImpl = fetch,
  options: { minNotional?: number; retryPreferred?: boolean } = {},
): Promise<LargeTradeLoadResult> {
  const compact = compactSymbol(symbol);
  const minNotional = clampMinNotional(options.minNotional);
  const cacheKey = `${preferred}:${compact}`;
  const retryPreferred = options.retryPreferred ?? true;
  const failures: MarketRequestFailure[] = [];
  for (const venue of tradeVenueOrder(preferred, cacheKey, retryPreferred)) {
    try {
      const response = await fetchImpl(
        `/api/trades?exchange=${venue}&symbol=${encodeURIComponent(compact)}&minNotional=${minNotional}`,
      );
      const body = await response.text();
      if (!response.ok) {
        failures.push(failureFromResponse(venue, response.status, body));
        continue;
      }
      const snapshot = sanitizeLargeTradeSnapshot(parseJson(body) as LargeTradeSnapshot, venue, compact, minNotional);
      lastGoodTradeVenue.set(cacheKey, venue);
      const fallbackFrom = venue === preferred ? null : preferred;
      const blocked = failures.some((failure) => failure.venue === preferred && failure.blocked);
      return {
        snapshot,
        venue,
        fallbackFrom,
        notice: fallbackFrom ? formatVenueFallbackNotice(preferred, venue, blocked) : snapshot.notice,
      };
    } catch (error) {
      failures.push(classifyMarketFailure(venue, 0, error instanceof Error ? error.message : "Failed to fetch"));
    }
  }
  throw Object.assign(new Error(joinTradeFailures(preferred, failures)), {
    failures,
    blocked: failures.some((failure) => failure.blocked),
    venue: preferred,
    status: failures.find((failure) => failure.venue === preferred)?.status ?? 0,
  });
}

function markerRadius(notional: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(notional) || notional <= 0) return 5.5;
  const span = (Math.log(notional) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return 4 + Math.min(1, Math.max(0, span)) * 5;
}

async function loadPerpTrades(venue: MarketVenue, symbol: string, fetchImpl: FetchImpl): Promise<MarketTrade[]> {
  const hosts = venue === "bitget" ? (["official", "public-mirror"] as const) : (["official"] as const);
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const payload = await requestJson(fetchImpl, tradeRequestUrl(venue, symbol, "perp", host), venue);
      assertVenuePayload(venue, payload, `${venue} trades request failed`);
      return parseVenueTrades(venue, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? classifyMarketFailure(venue, 502, LARGE_TRADES_EMPTY);
}

async function fetchOkxContractMultiplier(symbol: string, fetchImpl: FetchImpl): Promise<number> {
  const payload = await requestJson(fetchImpl, okxInstrumentUrl(symbol), "okx");
  assertVenuePayload("okx", payload, "OKX instrument request failed");
  const rows = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: Record<string, unknown>[] }).data
    : [];
  const ctVal = Number(rows[0]?.ctVal);
  if (!rows.length || !Number.isFinite(ctVal) || ctVal <= 0) {
    throw classifyMarketFailure("okx", 502, "OKX contract size unavailable.");
  }
  return parseOkxContractValue(payload);
}

function tradeVenueOrder(preferred: MarketVenue, cacheKey: string, retryPreferred: boolean): MarketVenue[] {
  const order = venueFallbackOrder(preferred);
  const cached = lastGoodTradeVenue.get(cacheKey);
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

function joinTradeFailures(preferred: MarketVenue, failures: MarketRequestFailure[]): string {
  if (failures.some((failure) => failure.blocked)) {
    return shortBlockedMessage(preferred, suggestedFallbackVenue(preferred));
  }
  return sanitizeMarketCopy(failures[0]?.message) || LARGE_TRADES_EMPTY;
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(body) as unknown;
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : { error: body };
  } catch {
    return { error: body };
  }
}

async function requestJson(fetchImpl: FetchImpl, url: string, venue: MarketVenue): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw classifyMarketFailure(venue, 0, error instanceof Error ? error.message : "Failed to fetch");
  }
  const body = await response.text();
  if (!response.ok) throw classifyMarketFailure(venue, response.status, body);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw classifyMarketFailure(venue, response.status, body);
  }
}

function assertVenuePayload(venue: MarketVenue, payload: unknown, fallback: string): void {
  if (venue === "bybit") {
    const code = (payload as { retCode?: unknown })?.retCode;
    if (code != null && Number(code) !== 0) {
      throw classifyMarketFailure(venue, 502, String((payload as { retMsg?: unknown }).retMsg || fallback));
    }
  }
  if (venue === "okx") {
    const code = (payload as { code?: unknown })?.code;
    if (code != null && String(code) !== "0") {
      throw classifyMarketFailure(venue, 502, String((payload as { msg?: unknown }).msg || fallback));
    }
  }
  if (venue === "bitget") {
    const code = (payload as { code?: unknown })?.code;
    if (code != null && String(code) !== "00000") {
      throw classifyMarketFailure(venue, 502, String((payload as { msg?: unknown }).msg || fallback));
    }
  }
}
