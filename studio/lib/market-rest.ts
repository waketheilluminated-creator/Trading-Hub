import {
  classifyMarketFailure,
  compactSymbol,
  toBinanceInterval,
  toBitgetBar,
  toOkxSwapInstId,
  toOkxBar,
  type ChartInterval,
  type MarketCandle,
  type MarketRequestFailure,
  type MarketVenue,
} from "./market-venues.ts";

type FetchImpl = typeof fetch;

export type RestKlineResult = {
  venue: MarketVenue;
  symbol: string;
  interval: ChartInterval;
  candles: MarketCandle[];
  source: "official" | "public-mirror";
};

export type RestMarketOption = { symbol: string; base: string; quote: string };

export type RestMarketsResult = {
  venue: MarketVenue;
  markets: RestMarketOption[];
  source: "official" | "public-mirror";
};

const BINANCE_KLINE_HOSTS = [
  { source: "official" as const, klines: "https://fapi.binance.com/fapi/v1/klines", markets: "https://fapi.binance.com/fapi/v1/exchangeInfo" },
  { source: "public-mirror" as const, klines: "https://data-api.binance.vision/api/v3/klines", markets: "https://data-api.binance.vision/api/v3/exchangeInfo" },
];

export function klineRequestUrl(venue: MarketVenue, symbol: string, interval: ChartInterval, limit: number, host = "official"): string {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") {
    return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${compact}&interval=${interval}&limit=${limit}`;
  }
  if (venue === "okx") {
    return `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(toOkxSwapInstId(compact))}&bar=${toOkxBar(interval)}&limit=${limit}`;
  }
  if (venue === "bitget") {
    return `https://api.bitget.com/api/v2/mix/market/candles?symbol=${compact}&granularity=${toBitgetBar(interval)}&limit=${limit}&productType=USDT-FUTURES`;
  }
  const endpoint = (host === "public-mirror" ? BINANCE_KLINE_HOSTS[1] : BINANCE_KLINE_HOSTS[0]).klines;
  return `${endpoint}?symbol=${compact}&interval=${toBinanceInterval(interval)}&limit=${limit}`;
}

export function marketsRequestUrl(venue: MarketVenue, host = "official"): string {
  if (venue === "bybit") return "https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000";
  if (venue === "okx") return "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
  if (venue === "bitget") return "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES";
  return (host === "public-mirror" ? BINANCE_KLINE_HOSTS[1] : BINANCE_KLINE_HOSTS[0]).markets;
}

export function parseVenueKlines(venue: MarketVenue, payload: unknown): MarketCandle[] {
  if (venue === "bybit") {
    const rows = Array.isArray((payload as { result?: { list?: unknown } })?.result?.list)
      ? (payload as { result: { list: unknown[] } }).result.list
      : [];
    return rows.map(parseBybitRow).filter(isCandle).sort(byTime);
  }
  if (venue === "okx") {
    const rows = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: unknown[] }).data : [];
    return rows.map(parseOkxRow).filter(isCandle).sort(byTime);
  }
  if (venue === "bitget") {
    const rows = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: unknown[] }).data : [];
    return rows.map(parseBitgetRow).filter(isCandle).sort(byTime);
  }
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map(parseBinanceRow).filter(isCandle).sort(byTime);
}

export async function fetchVenueKlines(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  limit = 300,
  fetchImpl: FetchImpl = fetch,
): Promise<RestKlineResult> {
  if (venue === "binance") {
    return fetchFirstWorking(BINANCE_KLINE_HOSTS, venue, async (host) => {
      const payload = await requestJson(fetchImpl, klineRequestUrl(venue, symbol, interval, limit, host.source), venue);
      return { venue, symbol: compactSymbol(symbol), interval, candles: parseVenueKlines(venue, payload), source: host.source };
    });
  }
  const payload = await requestJson(fetchImpl, klineRequestUrl(venue, symbol, interval, limit), venue);
  assertVenuePayload(venue, payload);
  return { venue, symbol: compactSymbol(symbol), interval, candles: parseVenueKlines(venue, payload), source: "official" };
}

export async function fetchVenueMarkets(
  venue: MarketVenue,
  fetchImpl: FetchImpl = fetch,
): Promise<RestMarketsResult> {
  if (venue === "binance") {
    return fetchFirstWorking(BINANCE_KLINE_HOSTS, venue, async (host) => {
      const payload = await requestJson(fetchImpl, marketsRequestUrl(venue, host.source), venue);
      return { venue, markets: parseVenueMarkets(venue, payload), source: host.source };
    });
  }
  const payload = await requestJson(fetchImpl, marketsRequestUrl(venue), venue);
  return { venue, markets: parseVenueMarkets(venue, payload), source: "official" };
}

export function parseVenueMarkets(venue: MarketVenue, payload: unknown): RestMarketOption[] {
  if (venue === "bybit") {
    const rows = Array.isArray((payload as { result?: { list?: unknown } })?.result?.list)
      ? (payload as { result: { list: Record<string, unknown>[] } }).result.list
      : [];
    return uniqueMarkets(rows.flatMap((row) => {
      if (row.status !== "Trading" || row.contractType !== "LinearPerpetual" || row.quoteCoin !== "USDT") return [];
      if (typeof row.symbol !== "string" || typeof row.baseCoin !== "string") return [];
      return [{ symbol: row.symbol, base: row.baseCoin, quote: "USDT" }];
    }));
  }
  if (venue === "okx") {
    const rows = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: Record<string, unknown>[] }).data : [];
    return uniqueMarkets(rows.flatMap((row) => {
      if (row.state !== "live" || row.ctType !== "linear" || row.settleCcy !== "USDT") return [];
      const family = typeof row.instFamily === "string" ? row.instFamily : "";
      const base = typeof row.ctValCcy === "string" && row.ctValCcy ? row.ctValCcy : family.split("-")[0];
      if (!base) return [];
      return [{ symbol: `${base}USDT`, base, quote: "USDT" }];
    }));
  }
  if (venue === "bitget") {
    const rows = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: Record<string, unknown>[] }).data : [];
    return uniqueMarkets(rows.flatMap((row) => {
      if (row.symbolStatus !== "normal" || row.symbolType !== "perpetual" || row.quoteCoin !== "USDT") return [];
      if (typeof row.symbol !== "string" || typeof row.baseCoin !== "string") return [];
      return [{ symbol: row.symbol, base: row.baseCoin, quote: "USDT" }];
    }));
  }
  const rows = Array.isArray((payload as { symbols?: unknown })?.symbols)
    ? (payload as { symbols: Record<string, unknown>[] }).symbols
    : [];
  return uniqueMarkets(rows.flatMap((row) => {
    if (row.status !== "TRADING" || row.quoteAsset !== "USDT") return [];
    if (row.contractType && row.contractType !== "PERPETUAL") return [];
    if (typeof row.symbol !== "string" || typeof row.baseAsset !== "string") return [];
    return [{ symbol: row.symbol, base: row.baseAsset, quote: "USDT" }];
  }));
}

async function fetchFirstWorking<T extends { source: "official" | "public-mirror" }>(
  hosts: typeof BINANCE_KLINE_HOSTS,
  venue: MarketVenue,
  run: (host: (typeof BINANCE_KLINE_HOSTS)[number]) => Promise<T>,
): Promise<T> {
  let lastFailure: MarketRequestFailure | undefined;
  for (const host of hosts) {
    try {
      return await run(host);
    } catch (error) {
      lastFailure = asFailure(error, venue);
    }
  }
  throw lastFailure ?? classifyMarketFailure(venue, 502, "Market request failed");
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

function assertVenuePayload(venue: MarketVenue, payload: unknown): void {
  if (venue === "bybit") {
    const code = (payload as { retCode?: unknown })?.retCode;
    if (code != null && Number(code) !== 0) {
      throw classifyMarketFailure(venue, 502, String((payload as { retMsg?: unknown }).retMsg || "Bybit kline request failed"));
    }
  }
  if (venue === "okx") {
    const code = (payload as { code?: unknown })?.code;
    if (code != null && String(code) !== "0") {
      throw classifyMarketFailure(venue, 502, String((payload as { msg?: unknown }).msg || "OKX kline request failed"));
    }
  }
  if (venue === "bitget") {
    const code = (payload as { code?: unknown })?.code;
    if (code != null && String(code) !== "00000") {
      throw classifyMarketFailure(venue, 502, String((payload as { msg?: unknown }).msg || "Bitget kline request failed"));
    }
  }
}

function parseBybitRow(row: unknown): MarketCandle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return candleFromMs(row[0], row[1], row[2], row[3], row[4], row[5]);
}

function parseBinanceRow(row: unknown): MarketCandle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return candleFromMs(row[0], row[1], row[2], row[3], row[4], row[5]);
}

function parseOkxRow(row: unknown): MarketCandle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return candleFromMs(row[0], row[1], row[2], row[3], row[4], row[5]);
}

function parseBitgetRow(row: unknown): MarketCandle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return candleFromMs(row[0], row[1], row[2], row[3], row[4], row[5]);
}

function candleFromMs(time: unknown, open: unknown, high: unknown, low: unknown, close: unknown, volume: unknown): MarketCandle | null {
  const ms = Number(time);
  const candle = {
    time: Math.floor(ms / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  };
  return isCandle(candle) ? candle : null;
}

function isCandle(value: MarketCandle | null): value is MarketCandle {
  return Boolean(value
    && Number.isFinite(value.time)
    && Number.isFinite(value.open)
    && Number.isFinite(value.high)
    && Number.isFinite(value.low)
    && Number.isFinite(value.close)
    && Number.isFinite(value.volume));
}

function byTime(left: MarketCandle, right: MarketCandle): number {
  return left.time - right.time;
}

function uniqueMarkets(markets: RestMarketOption[]): RestMarketOption[] {
  const unique = new Map<string, RestMarketOption>();
  for (const market of markets) unique.set(market.symbol, market);
  return [...unique.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function asFailure(error: unknown, venue: MarketVenue): MarketRequestFailure {
  if (error && typeof error === "object" && "blocked" in error && "venue" in error) {
    return error as MarketRequestFailure;
  }
  return classifyMarketFailure(venue, 502, error instanceof Error ? error.message : "Market request failed");
}
