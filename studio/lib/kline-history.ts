import { asFailure, assertVenuePayload, BINANCE_KLINE_HOSTS, parseVenueKlines, requestJson } from "./market-rest.ts";
import { classifyMarketFailure, compactSymbol, toBinanceInterval, toBitgetBar, toOkxBar, toOkxSwapInstId, type ChartInterval, type MarketCandle, type MarketRequestFailure, type MarketVenue } from "./market-venues.ts";

type FetchImpl = typeof fetch;

/** Hard server-side ceiling for one /api/klines response. */
export const MAX_KLINE_BARS = 5000;
/** Default history depth the chart asks for (TH-FEAT-09). */
export const DEFAULT_CHART_BARS = 5000;
export const CHART_BAR_COUNT_OPTIONS = [1000, 2000, 5000] as const;
/** Older bars fetched per lazy-load step when the user scrolls left. */
export const LAZY_LOAD_BARS = 1000;
/** Upper bound of bars kept in memory (initial history + lazy loads + live ticks). */
export const MAX_LOADED_BARS = 20000;

/** Max rows per request each venue accepts (probed 2026-10: Bybit/Binance 1000, OKX history 300, Bitget 1000 recent / 200 history). */
export const VENUE_PAGE_LIMIT: Record<MarketVenue, number> = { bybit: 1000, binance: 1000, okx: 300, bitget: 1000 };
const BITGET_HISTORY_PAGE_LIMIT = 200;

export type KlinePageMode = "recent" | "history";

export type KlineHistoryResult = {
  venue: MarketVenue;
  symbol: string;
  interval: ChartInterval;
  candles: MarketCandle[];
  source: "official" | "public-mirror";
  /** True when the venue ran out of older bars before `limit` was reached. */
  exhausted: boolean;
  /** True when a later page failed; `candles` holds what loaded before the failure. */
  partial: boolean;
  warning: string | null;
  pages: number;
};

/**
 * One page of klines ending at `endMs` (inclusive, epoch ms) or at the latest bar when null.
 * OKX: /market/candles only covers recent bars, so pages with an end bound use /history-candles
 * (`after` is exclusive, hence +1). Bitget: /candles covers a recent window, /history-candles older data.
 */
export function klinePageUrl(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  limit: number,
  endMs: number | null,
  options: { host?: "official" | "public-mirror"; mode?: KlinePageMode } = {},
): string {
  const compact = compactSymbol(symbol);
  const end = endMs == null ? null : Math.floor(endMs);
  if (venue === "bybit") {
    return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${compact}&interval=${interval}&limit=${limit}${end == null ? "" : `&end=${end}`}`;
  }
  if (venue === "okx") {
    const instId = encodeURIComponent(toOkxSwapInstId(compact));
    if (end == null && options.mode !== "history") {
      return `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${toOkxBar(interval)}&limit=${limit}`;
    }
    return `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${toOkxBar(interval)}&limit=${limit}${end == null ? "" : `&after=${end + 1}`}`;
  }
  if (venue === "bitget") {
    const path = options.mode === "history" ? "history-candles" : "candles";
    return `https://api.bitget.com/api/v2/mix/market/${path}?symbol=${compact}&granularity=${toBitgetBar(interval)}&limit=${limit}&productType=USDT-FUTURES${end == null ? "" : `&endTime=${end}`}`;
  }
  const endpoint = (options.host === "public-mirror" ? BINANCE_KLINE_HOSTS[1] : BINANCE_KLINE_HOSTS[0]).klines;
  return `${endpoint}?symbol=${compact}&interval=${toBinanceInterval(interval)}&limit=${limit}${end == null ? "" : `&endTime=${end}`}`;
}

/** Dedupe by bar time (later value wins), sort ascending. */
export function mergeCandles(...groups: readonly (readonly MarketCandle[])[]): MarketCandle[] {
  const byTime = new Map<number, MarketCandle>();
  for (const group of groups) for (const candle of group) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

/**
 * Walk a venue's kline API backwards page by page until `limit` bars are collected, the venue
 * has no older data, or a page fails. First-page failures throw (caller falls back to another
 * venue); later failures return the bars already loaded with `partial: true`.
 */
export async function fetchVenueKlineHistory(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  request: { limit: number; endTime?: number | null },
  fetchImpl: FetchImpl = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<KlineHistoryResult> {
  const limit = Math.max(1, Math.min(MAX_KLINE_BARS, Math.floor(request.limit) || 1));
  const upperBoundSec = request.endTime == null ? Infinity : Math.floor(request.endTime);
  let endMs: number | null = request.endTime == null ? null : Math.floor(request.endTime) * 1000 + (venue === "bitget" ? 1 : 0);
  let mode: KlinePageMode = request.endTime == null ? "recent" : "history";
  if (venue === "bitget") mode = "recent"; // Bitget /candles honours endTime inside its recent window.
  let host: "official" | "public-mirror" = "official";
  const collected = new Map<number, MarketCandle>();
  let pages = 0;
  let exhausted = false;
  let partial = false;
  let warning: string | null = null;
  // Bitget daily history pages can hold <100 rows, so allow more pages than limit/pageSize.
  const maxPages = Math.ceil(limit / 100) + 10;

  while (collected.size < limit && pages < maxPages) {
    const pageSize = venue === "bitget" && mode === "history" ? BITGET_HISTORY_PAGE_LIMIT : VENUE_PAGE_LIMIT[venue];
    const pageLimit = Math.min(pageSize, limit - collected.size);
    let rows: MarketCandle[];
    try {
      if (venue === "binance" && pages === 0) {
        const first = await firstWorkingBinance(fetchImpl, (h) => klinePageUrl(venue, symbol, interval, pageLimit, endMs, { host: h }));
        host = first.host;
        rows = parseVenueKlines(venue, first.payload);
      } else {
        const url = klinePageUrl(venue, symbol, interval, pageLimit, endMs, { host, mode });
        const payload = await withRateLimitRetry(() => requestJson(fetchImpl, url, venue), sleep);
        assertVenuePayload(venue, payload);
        rows = parseVenueKlines(venue, payload);
      }
    } catch (error) {
      if (!collected.size) throw asFailure(error, venue);
      partial = true;
      warning = `Loaded ${collected.size} bars; an older ${venue} page failed: ${asFailure(error, venue).message}`.slice(0, 300);
      break;
    }
    pages += 1;
    // Bitget throttles bursts (HTTP 429 at ~20 pages/s); space pages out slightly.
    if (venue === "bitget" && pages > 1) await sleep(60);
    let added = 0;
    let oldest = Infinity;
    for (const row of rows) {
      if (row.time > upperBoundSec) continue;
      if (row.time < oldest) oldest = row.time;
      if (!collected.has(row.time)) added += 1;
      collected.set(row.time, row);
    }
    if (!added) {
      if (venue === "bitget" && mode === "recent") { mode = "history"; continue; }
      if (venue === "okx" && mode === "recent") { mode = "history"; if (endMs == null && Number.isFinite(oldest)) endMs = nextPageEnd(venue, oldest); continue; }
      exhausted = true;
      break;
    }
    endMs = nextPageEnd(venue, oldest);
    // OKX /candles only serves the first page; older pages come from /history-candles.
    if (venue === "okx") mode = "history";
  }

  const candles = [...collected.values()].sort((left, right) => left.time - right.time).slice(-limit);
  return { venue, symbol: compactSymbol(symbol), interval, candles, source: host, exhausted, partial, warning, pages };
}

/** Next page end bound. Bitget's endTime is exclusive (open < endTime); the others are inclusive. */
function nextPageEnd(venue: MarketVenue, oldestSec: number): number {
  return venue === "bitget" ? oldestSec * 1000 : oldestSec * 1000 - 1;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a page up to twice when the venue answers HTTP 429. Other failures surface immediately. */
export async function withRateLimitRetry<T>(run: () => Promise<T>, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status !== 429 || attempt >= 2) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function firstWorkingBinance(fetchImpl: FetchImpl, urlFor: (host: "official" | "public-mirror") => string) {
  let lastFailure: MarketRequestFailure | undefined;
  for (const entry of BINANCE_KLINE_HOSTS) {
    try {
      return { host: entry.source, payload: await requestJson(fetchImpl, urlFor(entry.source), "binance") };
    } catch (error) {
      lastFailure = asFailure(error, "binance");
    }
  }
  throw lastFailure ?? classifyMarketFailure("binance", 502, "Market request failed");
}

export type KlineQuery = { limit: number; endTime: number | null };

/**
 * Strict parsing for /api/klines `limit` and `end` (epoch seconds, exclusive upper bound handled
 * by caller as inclusive end). Returns an error string for malformed input instead of guessing.
 */
export function parseKlineQuery(params: URLSearchParams, nowSec = Math.floor(Date.now() / 1000)): KlineQuery | { error: string } {
  const rawLimit = params.get("limit");
  let limit = 300;
  if (rawLimit != null && rawLimit !== "") {
    if (!/^\d{1,6}$/.test(rawLimit)) return { error: `limit must be an integer between 1 and ${MAX_KLINE_BARS}` };
    limit = Math.min(MAX_KLINE_BARS, Math.max(1, Number(rawLimit)));
  }
  const rawEnd = params.get("end");
  let endTime: number | null = null;
  if (rawEnd != null && rawEnd !== "") {
    if (!/^\d{9,11}$/.test(rawEnd)) return { error: "end must be a unix timestamp in seconds" };
    endTime = Number(rawEnd);
    if (endTime > nowSec + 86400) return { error: "end is in the future" };
  }
  return { limit, endTime };
}
