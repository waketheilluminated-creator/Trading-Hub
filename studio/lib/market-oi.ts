import {
  classifyMarketFailure,
  compactSymbol,
  toOkxSwapInstId,
  type ChartInterval,
  type MarketVenue,
} from "./market-venues.ts";

type FetchImpl = typeof fetch;

export type OiUnit = "usd" | "contracts" | "base";
export type OiPoint = { time: number; value: number };
export type OiHistorySnapshot = {
  venue: MarketVenue;
  symbol: string;
  interval: ChartInterval;
  unit: OiUnit;
  points: OiPoint[];
  notice: string | null;
  updatedAt: number;
};

const BYBIT_OI_INTERVAL: Record<ChartInterval, string> = {
  "1": "5min",
  "5": "5min",
  "15": "15min",
  "60": "1h",
  "240": "4h",
  D: "1d",
};

const BINANCE_OI_PERIOD: Record<ChartInterval, string> = {
  "1": "5m",
  "5": "5m",
  "15": "15m",
  "60": "1h",
  "240": "4h",
  D: "1d",
};

const OKX_OI_PERIOD: Record<ChartInterval, string> = {
  "1": "5m",
  "5": "5m",
  "15": "15m",
  "60": "1H",
  "240": "4H",
  D: "1D",
};

export function oiHistoryRequestUrl(venue: MarketVenue, symbol: string, interval: ChartInterval): string {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") {
    return `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${compact}&intervalTime=${BYBIT_OI_INTERVAL[interval]}&limit=200`;
  }
  if (venue === "okx") {
    return `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${encodeURIComponent(toOkxSwapInstId(compact))}&period=${OKX_OI_PERIOD[interval]}`;
  }
  if (venue === "bitget") {
    return `https://api.bitget.com/api/v2/mix/market/open-interest?productType=USDT-FUTURES&symbol=${compact}`;
  }
  return `https://fapi.binance.com/futures/data/openInterestHist?symbol=${compact}&period=${BINANCE_OI_PERIOD[interval]}&limit=200`;
}

export function parseVenueOiHistory(venue: MarketVenue, payload: unknown): { points: OiPoint[]; unit: OiUnit } {
  if (venue === "bybit") return parseBybitOi(payload);
  if (venue === "okx") return parseOkxOi(payload);
  if (venue === "bitget") return parseBitgetOi(payload);
  return parseBinanceOi(payload);
}

export function unavailableOiHistory(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  reason: string,
): OiHistorySnapshot {
  return {
    venue,
    symbol: compactSymbol(symbol),
    interval,
    unit: "usd",
    points: [],
    notice: reason,
    updatedAt: Date.now(),
  };
}

export async function fetchVenueOiHistory(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  fetchImpl: FetchImpl = fetch,
): Promise<OiHistorySnapshot> {
  const compact = compactSymbol(symbol);
  const payload = await requestJson(fetchImpl, oiHistoryRequestUrl(venue, compact, interval), venue);
  assertVenuePayload(venue, payload, `${venue} open interest history request failed`);
  const parsed = parseVenueOiHistory(venue, payload);
  if (!parsed.points.length) {
    throw classifyMarketFailure(venue, 502, "Open interest series unavailable.");
  }
  return {
    venue,
    symbol: compact,
    interval,
    unit: parsed.unit,
    points: parsed.points,
    notice: parsed.points.length < 2 ? "Live OI snapshot — history unavailable." : null,
    updatedAt: Date.now(),
  };
}

export function toOkxCcy(symbol: string): string {
  const compact = compactSymbol(symbol);
  if (compact.endsWith("USDT")) return compact.slice(0, -4);
  if (compact.endsWith("USDC")) return compact.slice(0, -4);
  return compact;
}

function parseBybitOi(payload: unknown): { points: OiPoint[]; unit: OiUnit } {
  const rows = Array.isArray((payload as { result?: { list?: unknown } })?.result?.list)
    ? (payload as { result: { list: Record<string, unknown>[] } }).result.list
    : [];
  return {
    unit: "base",
    points: sortPoints(rows.map((row) => pointFrom(row.timestamp ?? row.time, row.openInterest))),
  };
}

function parseBinanceOi(payload: unknown): { points: OiPoint[]; unit: OiUnit } {
  const rows = Array.isArray(payload) ? payload as Record<string, unknown>[] : [];
  const usd = sortPoints(rows.map((row) => pointFrom(row.timestamp ?? row.time, row.sumOpenInterestValue)));
  if (usd.length) return { unit: "usd", points: usd };
  return {
    unit: "contracts",
    points: sortPoints(rows.map((row) => pointFrom(row.timestamp ?? row.time, row.sumOpenInterest))),
  };
}

function parseOkxOi(payload: unknown): { points: OiPoint[]; unit: OiUnit } {
  const rows = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: unknown[] }).data
    : [];
  return {
    unit: "usd",
    points: sortPoints(rows.map((row) => {
      if (Array.isArray(row)) return pointFrom(row[0], row[3] ?? row[1]);
      if (!row || typeof row !== "object") return null;
      const item = row as Record<string, unknown>;
      return pointFrom(item.ts ?? item.time, item.oi ?? item.oiUsd ?? item.openInterest);
    })),
  };
}

function parseBitgetOi(payload: unknown): { points: OiPoint[]; unit: OiUnit } {
  const data = (payload as { data?: unknown })?.data;
  const list = Array.isArray((data as { openInterestList?: unknown })?.openInterestList)
    ? (data as { openInterestList: Record<string, unknown>[] }).openInterestList
    : Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const ts = Number((data as { ts?: unknown })?.ts);
  return {
    unit: "contracts",
    points: sortPoints(list.map((row) => pointFrom(row.ts ?? row.timestamp ?? ts, row.size ?? row.openInterest ?? row.holdAmount))),
  };
}

function pointFrom(time: unknown, value: unknown): OiPoint | null {
  const timestamp = toChartSeconds(Number(time));
  const amount = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(amount)) return null;
  return { time: timestamp, value: amount };
}

function sortPoints(points: Array<OiPoint | null>): OiPoint[] {
  const byTime = new Map<number, number>();
  for (const point of points) {
    if (!point) continue;
    byTime.set(point.time, point.value);
  }
  return [...byTime.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([time, value]) => ({ time, value }));
}

export function toChartSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
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
