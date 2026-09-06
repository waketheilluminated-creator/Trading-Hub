import { classifyMarketFailure, compactSymbol, formatVenueFallbackNotice, toBinanceInterval, toOkxBar, toOkxSwapInstId, venueFallbackOrder, venueLabel, type ChartInterval, type MarketCandle, type MarketRequestFailure, type MarketVenue } from "./market-venues.ts";

export type ChartHistoryResult = {
  venue: MarketVenue;
  candles: MarketCandle[];
  notice: string | null;
  fallbackFrom: MarketVenue | null;
  source: "official" | "public-mirror";
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

export function mergeLiveCandle<T extends { time: unknown }>(current: T[], next: T): T[] {
  if (!current.length) return [next];
  const last = current.at(-1);
  if (last && last.time === next.time) return [...current.slice(0, -1), next];
  if (last && Number(next.time) < Number(last.time)) return current;
  return [...current.slice(-499), next];
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
): Promise<ChartHistoryResult> {
  const compact = compactSymbol(symbol);
  const failures: MarketRequestFailure[] = [];
  for (const venue of venueFallbackOrder(preferred)) {
    try {
      const response = await fetchImpl(`/api/klines?exchange=${venue}&symbol=${encodeURIComponent(compact)}&interval=${interval}&limit=300`);
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
      };
    } catch (error) {
      failures.push(classifyMarketFailure(venue, 0, error instanceof Error ? error.message : "Failed to fetch"));
    }
  }
  const preferredFailure = failures.find((failure) => failure.venue === preferred);
  throw Object.assign(new Error(joinFailureMessage(failures)), { failures, blocked: failures.some((failure) => failure.blocked), venue: preferred, status: preferredFailure?.status ?? 0 });
}

export async function loadMarketCatalog(
  preferred: MarketVenue,
  fetchImpl: FetchImpl = fetch,
): Promise<{ venue: MarketVenue; markets: { symbol: string; base: string; quote: string }[] }> {
  for (const venue of venueFallbackOrder(preferred)) {
    try {
      const response = await fetchImpl(`/api/markets?exchange=${venue}`);
      if (!response.ok) continue;
      const payload = await response.json() as { markets?: { symbol: string; base: string; quote: string }[] };
      if (payload.markets?.length) return { venue, markets: payload.markets };
    } catch {
      // Try the next public catalog before using the offline fallback.
    }
  }
  return { venue: preferred, markets: [] };
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
    if (venue === "bybit" || venue === "okx") {
      heartbeat = setIntervalSafe(() => {
        if (socket.readyState === 1) socket.send(venue === "okx" ? "ping" : JSON.stringify({ op: "ping" }));
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
  return `wss://fstream.binance.com/ws/${compact.toLowerCase()}@kline_${toBinanceInterval(interval)}`;
}

export function klineSubscribeMessage(venue: MarketVenue, symbol: string, interval: ChartInterval): string | null {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") return JSON.stringify({ op: "subscribe", args: [`kline.${interval}.${compact}`] });
  if (venue === "okx") {
    return JSON.stringify({ op: "subscribe", args: [{ channel: `candle${toOkxBar(interval)}`, instId: toOkxSwapInstId(compact) }] });
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
  if (!failures.length) return "Live market data is unavailable from Bybit, Binance, and OKX.";
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
