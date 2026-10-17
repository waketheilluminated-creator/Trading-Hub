/**
 * TH-BUG-04: price precision from the instrument tick size (exchange info), shared by the price axis,
 * OHLC legend, crosshair label, liq/wall labels and the alert dialog.
 */
import { compactSymbol, toOkxSwapInstId, type MarketCandle, type MarketVenue } from "./market-venues.ts";

export const MAX_PRICE_PRECISION = 10;
export const DEFAULT_TICK = 0.01;

export type PriceFormatSpec = { type: "price"; precision: number; minMove: number };

/** Decimal places of a tick size: 0.00001→5, 0.0001→4, 0.01→2, 0.5→1, 1→0, 5→0. */
export function precisionFromTick(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 2;
  for (let d = 0; d <= MAX_PRICE_PRECISION; d += 1) {
    const scaled = tick * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return MAX_PRICE_PRECISION;
}

/** Normalises float noise (e.g. 0.1 * 3) so minMove is an exact multiple of 10^-precision. */
export function normalizeTick(tick: number): number | null {
  if (!Number.isFinite(tick) || tick <= 0 || tick >= 1e6) return null;
  const d = precisionFromTick(tick);
  return Number(tick.toFixed(d)) || null;
}

export function priceFormatForTick(tick: number | null | undefined): PriceFormatSpec {
  const t = tick != null ? normalizeTick(tick) : null;
  const minMove = t ?? DEFAULT_TICK;
  return { type: "price", precision: precisionFromTick(minMove), minMove };
}

function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = value.toString();
  if (text.includes("e-")) { const [m, e] = text.split("e-"); return Math.min(MAX_PRICE_PRECISION, Number(e) + (m.split(".")[1]?.length ?? 0)); }
  return Math.min(MAX_PRICE_PRECISION, text.split(".")[1]?.length ?? 0);
}

/** Fallback when exchange info is unavailable: the finest decimals seen in recent OHLC values. */
export function inferTickFromCandles(candles: readonly Pick<MarketCandle, "open" | "high" | "low" | "close">[]): number | null {
  if (!candles.length) return null;
  let d = 0;
  for (const c of candles.slice(-500)) d = Math.max(d, decimalsOf(c.open), decimalsOf(c.high), decimalsOf(c.low), decimalsOf(c.close));
  return Number((10 ** -d).toFixed(d));
}

/** Formats with exactly `precision` decimals (thousands separators for ≥ 1000). */
export function formatPriceWithPrecision(value: number | null | undefined, precision: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const p = precision == null ? (Math.abs(value) >= 1000 ? 2 : 4) : Math.max(0, Math.min(MAX_PRICE_PRECISION, precision));
  return value.toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p });
}

/** Rounds to the tick grid (alert dialog prefill etc.). */
export function roundToTick(value: number, tick: number | null): number {
  const t = tick != null ? normalizeTick(tick) : null;
  if (!t) return value;
  const p = precisionFromTick(t);
  return Number((Math.round(value / t) * t).toFixed(p));
}

export function instrumentRequestUrl(venue: MarketVenue, symbol: string): string {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") return `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${compact}`;
  if (venue === "okx") return `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(toOkxSwapInstId(compact))}`;
  if (venue === "bitget") return `https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=${compact}`;
  return `https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${compact}`;
}

const num = (v: unknown): number | null => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) && n > 0 ? n : null; };

/** Extracts the tick size from each venue's instrument payload; null when absent/malformed. */
export function parseInstrumentTick(venue: MarketVenue, symbol: string, payload: unknown): number | null {
  const compact = compactSymbol(symbol);
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (venue === "bybit") {
    const row = ((p.result as { list?: Record<string, unknown>[] })?.list ?? []).find((r) => r.symbol === compact);
    return normalizeTick(num((row?.priceFilter as Record<string, unknown> | undefined)?.tickSize) ?? NaN);
  }
  if (venue === "okx") {
    const row = ((p.data as Record<string, unknown>[]) ?? []).find((r) => r.instId === toOkxSwapInstId(compact));
    return normalizeTick(num(row?.tickSz) ?? NaN);
  }
  if (venue === "bitget") {
    const row = ((p.data as Record<string, unknown>[]) ?? []).find((r) => r.symbol === compact);
    if (!row) return null;
    const place = Number(row.pricePlace);
    const step = num(row.priceEndStep) ?? 1;
    if (!Number.isInteger(place) || place < 0 || place > MAX_PRICE_PRECISION) return null;
    return normalizeTick(step * 10 ** -place);
  }
  const row = ((p.symbols as Record<string, unknown>[]) ?? []).find((r) => r.symbol === compact);
  const filter = ((row?.filters as Record<string, unknown>[]) ?? []).find((f) => f.filterType === "PRICE_FILTER");
  return normalizeTick(num(filter?.tickSize) ?? NaN);
}

const cache = new Map<string, { tick: number | null; at: number }>();
const CACHE_MS = 60 * 60_000;

export async function fetchInstrumentTick(venue: MarketVenue, symbol: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<number | null> {
  const key = `${venue}:${compactSymbol(symbol)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.tick;
  let tick: number | null = null;
  try {
    const response = await fetchImpl(instrumentRequestUrl(venue, symbol));
    if (response.ok) tick = parseInstrumentTick(venue, symbol, await response.json());
  } catch { tick = null; }
  if (cache.size > 500) cache.clear();
  cache.set(key, { tick, at: now });
  return tick;
}

/** Chart history retry backoff after a failed load: 3s, 6s, 12s, 24s, then every 30s. */
export function historyRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, Math.min(10, attempt - 1)));
}

/** Alert dialog price prefill, same decimals as the axis. */
export function formatAlertPrefill(price: number | null, precision: number | null): string {
  if (price == null || !Number.isFinite(price)) return "";
  return precision != null && precision >= 0 && precision <= 10 ? price.toFixed(precision) : String(price);
}
