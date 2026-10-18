/**
 * TH-FEAT-17 historical inputs for replay liquidation zones: 1m price bars (Binance USDT-M) and 5m OI history
 * (Binance openInterestHist, Bybit open-interest, OKX rubik open-interest-history; Bitget has no OI history → unavailable).
 * Fetched in aligned 6h chunks with a small in-memory LRU (no files, no daily snapshots).
 */
import type { OiPoint, PriceBar } from "./liq-replay.ts";

export const REPLAY_CHUNK_MS = 6 * 60 * 60 * 1000;
export const REPLAY_CACHE_MAX = 400;
export const REPLAY_OI_VENUES = ["binance", "bybit", "okx", "bitget"] as const;
export type ReplayOiVenue = (typeof REPLAY_OI_VENUES)[number];
type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const cache = new Map<string, { at: number; value: unknown }>();
function remember(key: string, value: unknown, now: number) {
  cache.delete(key);
  cache.set(key, { at: now, value });
  while (cache.size > REPLAY_CACHE_MAX) cache.delete(cache.keys().next().value as string);
}
export function clearReplayCache() { cache.clear(); }
export function replayCacheSize() { return cache.size; }

async function cached<T>(key: string, chunkEnd: number, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  // Closed chunks never change; the chunk still forming is reused for 60s.
  if (hit && (chunkEnd < now - 10 * 60_000 || now - hit.at < 60_000)) { remember(key, hit.value, hit.at); return hit.value as T; }
  const value = await load();
  remember(key, value, now);
  return value;
}

function chunkStarts(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(from / REPLAY_CHUNK_MS) * REPLAY_CHUNK_MS; t <= to; t += REPLAY_CHUNK_MS) out.push(t);
  return out;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);

/** 1m price bars (the replay path and the mark at the replay candle close). */
export async function fetchPriceBars(symbol: string, from: number, to: number, fetchImpl: Fetch, now: number): Promise<PriceBar[]> {
  const out: PriceBar[] = [];
  for (const start of chunkStarts(from, to)) {
    const end = start + REPLAY_CHUNK_MS - 1;
    const rows = await cached(`px1:${symbol}:${start}`, end, now, async () => {
      const r = await fetchImpl(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${start}&endTime=${end}&limit=400`);
      if (!r.ok) throw new Error("price history unavailable");
      const data = await r.json();
      return Array.isArray(data) ? data.map((k) => ({ time: num((k as unknown[])[0]), open: num((k as unknown[])[1]), high: num((k as unknown[])[2]), low: num((k as unknown[])[3]), close: num((k as unknown[])[4]) })) : [];
    });
    out.push(...rows.filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)));
  }
  return out.filter((b) => b.time >= from && b.time <= to);
}

function okxInst(symbol: string) { return `${symbol.replace(/USDT$/, "")}-USDT-SWAP`; }

export async function fetchOiHistory(venue: ReplayOiVenue, symbol: string, from: number, to: number, fetchImpl: Fetch, now: number, priceAt: (ts: number) => number | null): Promise<OiPoint[] | null> {
  if (venue === "bitget") return null; // no public OI history
  const out: OiPoint[] = [];
  try {
    for (const start of chunkStarts(from, to)) {
      const end = start + REPLAY_CHUNK_MS - 1;
      const rows = await cached(`oi:${venue}:${symbol}:${start}`, end, now, async (): Promise<{ ts: number; usd: number | null; coins: number | null }[]> => {
        if (venue === "binance") {
          const r = await fetchImpl(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=100&startTime=${start}&endTime=${end}`);
          if (!r.ok) throw new Error("oi");
          const data = await r.json();
          return Array.isArray(data) ? data.map((d) => ({ ts: num((d as Record<string, unknown>).timestamp), usd: num((d as Record<string, unknown>).sumOpenInterestValue), coins: null })) : [];
        }
        if (venue === "bybit") {
          const r = await fetchImpl(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&startTime=${start}&endTime=${end}&limit=200`);
          if (!r.ok) throw new Error("oi");
          const data = (await r.json()) as { result?: { list?: Record<string, unknown>[] } };
          return (data.result?.list ?? []).map((d) => ({ ts: num(d.timestamp), usd: null, coins: num(d.openInterest) }));
        }
        const r = await fetchImpl(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${okxInst(symbol)}&period=5m&begin=${start}&end=${end}&limit=100`);
        if (!r.ok) throw new Error("oi");
        const data = (await r.json()) as { data?: unknown[][] };
        return (data.data ?? []).map((d) => ({ ts: num(d[0]), usd: num(d[3]), coins: null }));
      });
      for (const row of rows) {
        if (!Number.isFinite(row.ts)) continue;
        const usd = row.usd != null && Number.isFinite(row.usd) ? row.usd : row.coins != null && Number.isFinite(row.coins) ? (priceAt(row.ts) ?? NaN) * row.coins : NaN;
        if (Number.isFinite(usd) && usd > 0) out.push({ ts: row.ts, oiUsd: usd });
      }
    }
  } catch {
    return null;
  }
  const dedup = new Map(out.filter((p) => p.ts >= from && p.ts <= to).map((p) => [p.ts, p]));
  return [...dedup.values()].sort((a, b) => a.ts - b.ts);
}
