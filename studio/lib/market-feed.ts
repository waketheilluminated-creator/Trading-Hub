import { classifyMarketFailure, compactSymbol, formatVenueFallbackNotice, isMarketVenue, MARKET_VENUES, toBinanceInterval, toBitgetBar, toOkxBar, toOkxSwapInstId, venueFallbackOrder, venueLabel, type ChartInterval, type MarketCandle, type MarketRequestFailure, type MarketVenue } from "./market-venues.ts";
import { fallbackCatalog, tagMarket } from "./market-symbols.js";
import { DEFAULT_CHART_BARS, LAZY_LOAD_BARS, MAX_KLINE_BARS, MAX_LOADED_BARS, mergeCandles } from "./kline-history.ts";

export type ChartHistoryResult = {
  venue: MarketVenue;
  candles: MarketCandle[];
  notice: string | null;
  fallbackFrom: MarketVenue | null;
  source: "official" | "public-mirror";
  /** Venue has no older bars than the first candle. */
  exhausted: boolean;
  /** A later history page failed; candles are what loaded before it. */
  warning: string | null;
};

export type LiveConnection = {
  close(): void;
};

type FetchImpl = typeof fetch;

type SocketCtor = {
  new (url: string): {
    readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
  };
};

export function mergeLiveCandle<T extends { time: unknown }>(current: T[], next: T, maxBars = MAX_LOADED_BARS): T[] {
  if (!current.length) return [next];
  const last = current.at(-1);
  if (last && last.time === next.time) return [...current.slice(0, -1), next];
  if (last && Number(next.time) < Number(last.time)) return current;
  return [...current.slice(-(Math.max(1, maxBars) - 1)), next];
}

/** Clamp a user/stored bar-count to 1..MAX_KLINE_BARS, defaulting to DEFAULT_CHART_BARS. */
export function normalizeBarCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CHART_BARS;
  return Math.min(MAX_KLINE_BARS, n);
}

/** Merge lazily loaded older bars in front of the current series (dedupe by time), capped at MAX_LOADED_BARS keeping the newest. */
export function prependOlderCandles<T extends { time: unknown }>(current: T[], older: T[], maxBars = MAX_LOADED_BARS): T[] {
  const byTime = new Map<number, T>();
  for (const candle of older) byTime.set(Number(candle.time), candle);
  for (const candle of current) byTime.set(Number(candle.time), candle);
  const merged = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  return merged.slice(-maxBars);
}

export async function loadOlderCandles(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  beforeTime: number,
  limit = LAZY_LOAD_BARS,
  fetchImpl: FetchImpl = fetch,
): Promise<{ candles: MarketCandle[]; exhausted: boolean }> {
  const end = Math.floor(beforeTime) - 1;
  if (!Number.isFinite(end) || end <= 0) return { candles: [], exhausted: true };
  const response = await fetchImpl(`/api/klines?exchange=${venue}&symbol=${encodeURIComponent(compactSymbol(symbol))}&interval=${interval}&limit=${normalizeBarCount(limit)}&end=${end}`);
  const body = await response.text();
  if (!response.ok) throw classifyMarketFailure(venue, response.status, body);
  const payload = parseJson(body) as { candles?: unknown; exhausted?: unknown } | null;
  const candles = Array.isArray(payload?.candles) ? mergeCandles((payload.candles as MarketCandle[]).filter((c) => Number(c?.time) < beforeTime)) : [];
  return { candles, exhausted: Boolean(payload?.exhausted) || candles.length === 0 };
}

export function parseLiveKline(venue: MarketVenue, payload: unknown): MarketCandle | null {
  if (venue === "bybit") {
    const item = (payload as { data?: Record<string, unknown>[] })?.data?.[0];
    if (!item?.start) return null;
    return candle(item.start, item.open, item.high, item.low, item.close, item.volume);
  }
  if (venue === "binance") {
    const item = (payload as { k?: Record<string, unknown> })?.k;
    if (!item?.t) return null;
    return candle(item.t, item.o, item.h, item.l, item.c, item.v);
  }
  if (venue === "bitget") {
    const rows = (payload as { data?: unknown[] })?.data;
    const row = Array.isArray(rows?.[0]) ? rows[0] : null;
    if (!row) return null;
    return candle(row[0], row[1], row[2], row[3], row[4], row[5]);
  }
  const rows = (payload as { data?: unknown[] })?.data;
  const row = Array.isArray(rows?.[0]) ? rows[0] : null;
  if (!row) return null;
  return candle(row[0], row[1], row[2], row[3], row[4], row[5]);
}

export async function loadChartHistory(
  preferred: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  fetchImpl: FetchImpl = fetch,
  options: { limit?: number } = {},
): Promise<ChartHistoryResult> {
  const compact = compactSymbol(symbol);
  const limit = normalizeBarCount(options.limit ?? DEFAULT_CHART_BARS);
  const failures: MarketRequestFailure[] = [];
  for (const venue of venueFallbackOrder(preferred)) {
    try {
      const response = await fetchImpl(`/api/klines?exchange=${venue}&symbol=${encodeURIComponent(compact)}&interval=${interval}&limit=${limit}`);
      const body = await response.text();
      const payload = parseJson(body);
      if (!response.ok) {
        failures.push(classifyMarketFailure(venue, response.status, body));
        continue;
      }
      const candles = Array.isArray((payload as { candles?: unknown })?.candles)
        ? (payload as { candles: MarketCandle[] }).candles
        : [];
      if (!candles.length) {
        failures.push(classifyMarketFailure(venue, 502, "Empty kline response"));
        continue;
      }
      const fallbackFrom = venue === preferred ? null : preferred;
      const blocked = failures.some((failure) => failure.venue === preferred && failure.blocked);
      return {
        venue,
        candles,
        fallbackFrom,
        source: (payload as { source?: "official" | "public-mirror" }).source === "public-mirror" ? "public-mirror" : "official",
        notice: fallbackFrom ? formatVenueFallbackNotice(preferred, venue, blocked) : null,
        exhausted: Boolean((payload as { exhausted?: unknown }).exhausted),
        warning: typeof (payload as { warning?: unknown }).warning === "string" ? (payload as { warning: string }).warning : null,
      };
    } catch (error) {
      failures.push(classifyMarketFailure(venue, 0, error instanceof Error ? error.message : "Failed to fetch"));
    }
  }
  const preferredFailure = failures.find((failure) => failure.venue === preferred);
  throw Object.assign(new Error(joinFailureMessage(failures)), { failures, blocked: failures.some((failure) => failure.blocked), venue: preferred, status: preferredFailure?.status ?? 0 });
}

export type CatalogMarket = { venue: MarketVenue; symbol: string; base: string; quote: string; kind?: string };

export async function loadMarketCatalog(
  preferred: MarketVenue,
  fetchImpl: FetchImpl = fetch,
): Promise<{ venue: MarketVenue; markets: CatalogMarket[] }> {
  for (const venue of venueFallbackOrder(preferred)) {
    try {
      const response = await fetchImpl(`/api/markets?exchange=${venue}`);
      if (!response.ok) continue;
      const payload = await response.json() as { markets?: { symbol: string; base: string; quote: string }[] };
      if (payload.markets?.length) {
        return { venue, markets: payload.markets.map((market) => tagMarket(venue, market)) };
      }
    } catch {
      // Try the next public catalog before using the offline fallback.
    }
  }
  return { venue: preferred, markets: [] };
}

export async function loadAllMarketCatalogs(fetchImpl: FetchImpl = fetch): Promise<CatalogMarket[]> {
  try {
    const response = await fetchImpl("/api/markets?exchange=all");
    if (response.ok) {
      const payload = await response.json() as { markets?: CatalogMarket[] };
      const markets = (payload.markets || []).filter((market) => isMarketVenue(market.venue) && market.symbol);
      if (markets.length) return markets;
    }
  } catch {
    // Fall through to per-venue fetches, then the offline catalog.
  }

  const catalogs = await Promise.all(MARKET_VENUES.map(async (venue) => {
    try {
      const response = await fetchImpl(`/api/markets?exchange=${venue}`);
      if (!response.ok) return fallbackCatalog([venue]);
      const payload = await response.json() as { markets?: { symbol: string; base: string; quote: string }[] };
      return payload.markets?.length
        ? payload.markets.map((market) => tagMarket(venue, market))
        : fallbackCatalog([venue]);
    } catch {
      return fallbackCatalog([venue]);
    }
  }));
  const merged = catalogs.flat();
  return merged.length ? merged : fallbackCatalog();
}

export function openKlineStream(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  handlers: {
    onCandle(candle: MarketCandle): void;
    onOpen(): void;
    onClose(): void;
    onError(): void;
  },
  Socket: SocketCtor | undefined = typeof WebSocket === "undefined" ? undefined : WebSocket,
): LiveConnection {
  if (!Socket) {
    handlers.onError();
    return { close() {} };
  }
  const compact = compactSymbol(symbol);
  const socket = new Socket(klineStreamUrl(venue, compact, interval));
  let heartbeat = 0;
  socket.onopen = () => {
    const subscribe = klineSubscribeMessage(venue, compact, interval);
    if (subscribe) socket.send(subscribe);
    if (venue === "bybit" || venue === "okx" || venue === "bitget") {
      heartbeat = setIntervalSafe(() => {
        if (socket.readyState === 1) {
          socket.send(venue === "okx" || venue === "bitget" ? "ping" : JSON.stringify({ op: "ping" }));
        }
      }, 20000);
    }
    handlers.onOpen();
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    let payload: unknown;
    try { payload = JSON.parse(event.data); } catch { return; }
    const candle = parseLiveKline(venue, payload);
    if (candle) handlers.onCandle(candle);
  };
  socket.onerror = () => handlers.onError();
  socket.onclose = () => {
    if (heartbeat) clearIntervalSafe(heartbeat);
    handlers.onClose();
  };
  return {
    close() {
      if (heartbeat) clearIntervalSafe(heartbeat);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    },
  };
}

export function klineStreamUrl(venue: MarketVenue, symbol: string, interval: ChartInterval): string {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") return "wss://stream.bybit.com/v5/public/linear";
  if (venue === "okx") return "wss://ws.okx.com:8443/ws/v5/public";
  if (venue === "bitget") return "wss://ws.bitget.com/v2/ws/public";
  return `wss://fstream.binance.com/ws/${compact.toLowerCase()}@kline_${toBinanceInterval(interval)}`;
}

export function klineSubscribeMessage(venue: MarketVenue, symbol: string, interval: ChartInterval): string | null {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") return JSON.stringify({ op: "subscribe", args: [`kline.${interval}.${compact}`] });
  if (venue === "okx") {
    return JSON.stringify({ op: "subscribe", args: [{ channel: `candle${toOkxBar(interval)}`, instId: toOkxSwapInstId(compact) }] });
  }
  if (venue === "bitget") {
    return JSON.stringify({
      op: "subscribe",
      args: [{ instType: "USDT-FUTURES", channel: `candle${toBitgetBar(interval)}`, instId: compact }],
    });
  }
  return null;
}

function candle(time: unknown, open: unknown, high: unknown, low: unknown, close: unknown, volume: unknown): MarketCandle | null {
  const ms = Number(time);
  const next = {
    time: ms > 10_000_000_000 ? Math.floor(ms / 1000) : ms,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  };
  return [next.time, next.open, next.high, next.low, next.close, next.volume].every(Number.isFinite) ? next : null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { error: body };
  }
}

function joinFailureMessage(failures: MarketRequestFailure[]): string {
  if (!failures.length) return "Live market data is unavailable from Bybit, Binance, OKX, and Bitget.";
  const unique = [...new Map(failures.map((failure) => [failure.venue, failure])).values()];
  const blocked = unique.filter((failure) => failure.blocked).map((failure) => venueLabel(failure.venue));
  if (blocked.length === unique.length) {
    return `${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} blocked in this region. Switch venue or retry from a supported location.`;
  }
  return unique.map((failure) => failure.message).join(" ");
}

function setIntervalSafe(callback: () => void, delay: number): number {
  return (typeof window === "undefined" ? globalThis.setInterval(callback, delay) : window.setInterval(callback, delay)) as unknown as number;
}

function clearIntervalSafe(handle: number): void {
  if (typeof window === "undefined") globalThis.clearInterval(handle);
  else window.clearInterval(handle);
}
