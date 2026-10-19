/** TH-FEAT-17 replay liq service: validation + data assembly. Pure apart from the injected fetch/clock. */
import { computeReplayLiq, REPLAY_COHORT_LOOKBACK_MS, REPLAY_HISTORY_MS, REPLAY_OUT_OF_RANGE, type OiPoint } from "./liq-replay.ts";
import { fetchOiHistory, fetchPriceBars, REPLAY_OI_VENUES } from "./history.ts";

export const REPLAY_SYMBOL = /^[A-Z0-9]{2,20}USDT$/;
export const REPLAY_BTC_SYMBOL = "BTCUSDT";
export const REPLAY_BTC_OI_WINDOW_MS = 2 * 60 * 60 * 1000;
type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type ReplayQuery = { ok: true; symbol: string; cutoff: number } | { ok: false; status: 400 | 422; error: string; outOfRange?: boolean };

/** Strict query: symbol=<BASE>USDT, ts=<ms integer> (close time of the replay candle) within the OI history window. */
export function parseReplayQuery(url: URL, now: number): ReplayQuery {
  const allowed = new Set(["symbol", "ts"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return { ok: false, status: 400, error: "Unknown parameter." };
  const symbol = url.searchParams.get("symbol") ?? "";
  const tsRaw = url.searchParams.get("ts") ?? "";
  if (!REPLAY_SYMBOL.test(symbol)) return { ok: false, status: 400, error: "Invalid symbol." };
  if (!/^\d{12,14}$/.test(tsRaw)) return { ok: false, status: 400, error: "ts must be a millisecond timestamp." };
  const cutoff = Number(tsRaw);
  if (cutoff > now + 60_000) return { ok: false, status: 400, error: "ts is in the future." };
  if (cutoff < now - REPLAY_HISTORY_MS) return { ok: false, status: 422, error: REPLAY_OUT_OF_RANGE, outOfRange: true };
  return { ok: true, symbol, cutoff };
}

const results = new Map<string, unknown>();
const RESULT_CACHE_MAX = 120;

export async function replayLiqZones(symbol: string, cutoff: number, fetchImpl: Fetch, now: number) {
  const key = `${symbol}:${cutoff}`;
  if (results.has(key)) return results.get(key) as Awaited<ReturnType<typeof compute>>;
  const value = await compute(symbol, cutoff, fetchImpl, now);
  if (value.ok) {
    results.set(key, value);
    while (results.size > RESULT_CACHE_MAX) results.delete(results.keys().next().value as string);
  }
  return value;
}

async function compute(symbol: string, cutoff: number, fetchImpl: Fetch, now: number) {
  const from = cutoff - REPLAY_COHORT_LOOKBACK_MS - 10 * 60_000;
  const bars = await fetchPriceBars(symbol, from, cutoff, fetchImpl, now).catch(() => []);
  const closeAt = (ts: number) => {
    let best: number | null = null;
    for (const b of bars) { if (b.time <= ts) best = b.close; else break; }
    return best;
  };
  const oi: Record<string, OiPoint[]> = {};
  const unavailable: string[] = [];
  await Promise.all(REPLAY_OI_VENUES.map(async (venue) => {
    const points = await fetchOiHistory(venue, symbol, from, cutoff, fetchImpl, now, closeAt);
    if (points && points.length) oi[venue] = points; else unavailable.push(venue);
  }));
  // TH-FEAT-20: alts need BTC OI at cutoff (same venues) for OI-scaled tier cutoffs. Only a 2h window is
  // fetched; a failure leaves btcOi empty → unscaled BTC floors (never blocks the replay).
  const btcOi: Record<string, OiPoint[]> = {};
  if (!symbol.startsWith("BTC") && Object.keys(oi).length) {
    const btcFrom = cutoff - REPLAY_BTC_OI_WINDOW_MS;
    const btcBars = await fetchPriceBars(REPLAY_BTC_SYMBOL, btcFrom, cutoff, fetchImpl, now).catch(() => []);
    const btcCloseAt = (ts: number) => {
      let best: number | null = null;
      for (const b of btcBars) { if (b.time <= ts) best = b.close; else break; }
      return best;
    };
    await Promise.all(Object.keys(oi).map(async (venue) => {
      const points = await fetchOiHistory(venue as (typeof REPLAY_OI_VENUES)[number], REPLAY_BTC_SYMBOL, btcFrom, cutoff, fetchImpl, now, btcCloseAt).catch(() => null);
      if (points && points.length) btcOi[venue] = points;
    }));
  }
  const result = computeReplayLiq({ symbol, cutoff, bars, oi, btcOi, barMs: 60_000 });
  if (!result.ok) return { ok: false as const, error: result.error, venuesUnavailable: [...unavailable, ...Object.keys(oi)].sort() };
  const venuesUnavailable = [...new Set([...unavailable, ...result.venuesUnavailable])].sort();
  return {
    ok: true as const,
    snapshot: { ...result.snapshot, venuesFailed: venuesUnavailable },
    venuesUsed: result.venuesUsed.sort(),
    venuesUnavailable,
    mark: result.mark,
    tierThresholds: result.tierThresholds,
  };
}
