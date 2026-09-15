import {
  classifyMarketFailure,
  compactSymbol,
  formatVenueFallbackNotice,
  isMarketVenue,
  looksGeoBlocked,
  sanitizeMarketCopy,
  shortBlockedMessage,
  suggestedFallbackVenue,
  toOkxSwapInstId,
  venueFallbackOrder,
  type MarketRequestFailure,
  type MarketVenue,
} from "./market-venues.ts";

type FetchImpl = typeof fetch;

export const LARGE_ORDER_SR_STORAGE_KEY = "th-large-order-sr";
export const LARGE_ORDER_SR_EMPTY = "Order book unavailable.";
export const DEFAULT_MIN_WALL_NOTIONAL_USD = 250_000;
export const MIN_WALL_NOTIONAL_USD = 10_000;
export const MAX_WALL_NOTIONAL_USD = 50_000_000;
export const DEFAULT_CLUSTER_BPS = 8;
export const MAX_WALLS_PER_SIDE = 18;

export type BookSide = "bid" | "ask";

export type DepthLevel = {
  price: number;
  size: number;
  notional: number;
};

export type OrderWall = {
  side: BookSide;
  price: number;
  low: number;
  high: number;
  size: number;
  notional: number;
};

export type VisualWall = OrderWall & {
  opacity: number;
  thicknessPx: number;
};

export type DepthSnapshot = {
  venue: MarketVenue;
  symbol: string;
  source: "official";
  midPrice: number | null;
  walls: OrderWall[];
  notice: string | null;
  updatedAt: number;
};

export type DepthLoadResult = {
  snapshot: DepthSnapshot;
  venue: MarketVenue;
  fallbackFrom: MarketVenue | null;
  notice: string | null;
};

export type DepthQuery =
  | { ok: true; venue: MarketVenue; symbol: string; minNotional: number }
  | { ok: false; error: string };

const lastGoodDepthVenue = new Map<string, MarketVenue>();

export function clampMinNotional(value: unknown, fallback = DEFAULT_MIN_WALL_NOTIONAL_USD): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_WALL_NOTIONAL_USD, Math.max(MIN_WALL_NOTIONAL_USD, numeric));
}

export function parseDepthQuery(url: URL, supportedExchangesMessage: string): DepthQuery {
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

export function depthRequestUrl(venue: MarketVenue, symbol: string): string {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") {
    return `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${compact}&limit=200`;
  }
  if (venue === "okx") {
    return `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(toOkxSwapInstId(compact))}&sz=400`;
  }
  if (venue === "bitget") {
    return `https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${compact}&productType=USDT-FUTURES&limit=150`;
  }
  return `https://fapi.binance.com/fapi/v1/depth?symbol=${compact}&limit=200`;
}

export function okxInstrumentUrl(symbol: string): string {
  return `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(toOkxSwapInstId(compactSymbol(symbol)))}`;
}

export function parseOkxContractValue(payload: unknown): number {
  const rows = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: Record<string, unknown>[] }).data
    : [];
  const ctVal = Number(rows[0]?.ctVal);
  return Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1;
}

export function parseVenueDepth(
  venue: MarketVenue,
  payload: unknown,
  contractMultiplier = 1,
): { bids: DepthLevel[]; asks: DepthLevel[] } {
  if (venue === "bybit") {
    const result = (payload as { result?: { b?: unknown; a?: unknown } })?.result;
    return sortedBook(parseLevels(result?.b, contractMultiplier), parseLevels(result?.a, contractMultiplier));
  }
  if (venue === "okx") {
    const row = Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: { bids?: unknown; asks?: unknown }[] }).data[0]
      : undefined;
    return sortedBook(parseLevels(row?.bids, contractMultiplier), parseLevels(row?.asks, contractMultiplier));
  }
  if (venue === "bitget") {
    const data = (payload as { data?: { bids?: unknown; asks?: unknown } })?.data;
    return sortedBook(parseLevels(data?.bids, contractMultiplier), parseLevels(data?.asks, contractMultiplier));
  }
  const book = payload as { bids?: unknown; asks?: unknown };
  return sortedBook(parseLevels(book?.bids, contractMultiplier), parseLevels(book?.asks, contractMultiplier));
}

export function clusterOrderWalls(
  bids: readonly DepthLevel[],
  asks: readonly DepthLevel[],
  options: { minNotional?: number; clusterBps?: number; maxPerSide?: number } = {},
): OrderWall[] {
  const minNotional = clampMinNotional(options.minNotional);
  const clusterBps = Number.isFinite(options.clusterBps) ? Math.max(1, Number(options.clusterBps)) : DEFAULT_CLUSTER_BPS;
  const maxPerSide = Math.max(1, options.maxPerSide ?? MAX_WALLS_PER_SIDE);
  const bidWalls = clusterSide(bids.filter((level) => level.notional >= minNotional), "bid", clusterBps, maxPerSide);
  const askWalls = clusterSide(asks.filter((level) => level.notional >= minNotional), "ask", clusterBps, maxPerSide);
  return [...bidWalls, ...askWalls];
}

export function visualWallBands(walls: readonly OrderWall[]): VisualWall[] {
  if (!walls.length) return [];
  const notionals = walls.map((wall) => wall.notional);
  const minN = Math.min(...notionals);
  const maxN = Math.max(...notionals);
  const logSpan = Math.log(maxN) - Math.log(minN);
  return walls.map((wall) => {
    const t = logSpan <= 0 ? 0.65 : (Math.log(wall.notional) - Math.log(minN)) / logSpan;
    return {
      ...wall,
      opacity: 0.16 + t * 0.42,
      thicknessPx: 3 + t * 14,
    };
  });
}

export function wallFillStyle(wall: Pick<VisualWall, "side" | "opacity">): string {
  return `rgba(${wall.side === "bid" ? "83, 201, 144" : "231, 103, 112"}, ${wall.opacity.toFixed(3)})`;
}

export async function fetchVenueDepth(
  venue: MarketVenue,
  symbol: string,
  minNotional = DEFAULT_MIN_WALL_NOTIONAL_USD,
  fetchImpl: FetchImpl = fetch,
): Promise<DepthSnapshot> {
  const compact = compactSymbol(symbol);
  const [payload, multiplier] = await Promise.all([
    requestJson(fetchImpl, depthRequestUrl(venue, compact), venue),
    venue === "okx" ? fetchOkxContractValue(compact, fetchImpl) : Promise.resolve(1),
  ]);
  assertVenuePayload(venue, payload, `${venue} order book request failed`);
  const { bids, asks } = parseVenueDepth(venue, payload, multiplier);
  if (!bids.length && !asks.length) {
    throw classifyMarketFailure(venue, 502, LARGE_ORDER_SR_EMPTY);
  }
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midPrice = bestBid != null && bestAsk != null
    ? (bestBid + bestAsk) / 2
    : bestBid ?? bestAsk;
  return {
    venue,
    symbol: compact,
    source: "official",
    midPrice,
    walls: clusterOrderWalls(bids, asks, { minNotional }),
    notice: null,
    updatedAt: Date.now(),
  };
}

export async function loadLargeOrderWalls(
  preferred: MarketVenue,
  symbol: string,
  fetchImpl: FetchImpl = fetch,
  options: { minNotional?: number; retryPreferred?: boolean } = {},
): Promise<DepthLoadResult> {
  const compact = compactSymbol(symbol);
  const minNotional = clampMinNotional(options.minNotional);
  const cacheKey = `${preferred}:${compact}:${minNotional}`;
  const retryPreferred = options.retryPreferred ?? true;
  const failures: MarketRequestFailure[] = [];
  for (const venue of depthOrder(preferred, cacheKey, retryPreferred)) {
    try {
      const response = await fetchImpl(
        `/api/depth?exchange=${venue}&symbol=${encodeURIComponent(compact)}&minNotional=${minNotional}`,
      );
      const body = await response.text();
      if (!response.ok) {
        failures.push(failureFromResponse(venue, response.status, body));
        continue;
      }
      const snapshot = sanitizeDepthSnapshot(parseJson(body) as DepthSnapshot, venue, compact, minNotional);
      lastGoodDepthVenue.set(cacheKey, venue);
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
  throw Object.assign(new Error(joinDepthFailures(preferred, failures)), {
    failures,
    blocked: failures.some((failure) => failure.blocked),
    venue: preferred,
    status: failures.find((failure) => failure.venue === preferred)?.status ?? 0,
  });
}

export function sanitizeDepthSnapshot(
  snapshot: DepthSnapshot,
  venue: MarketVenue = snapshot.venue,
  symbol = snapshot.symbol,
  minNotional = DEFAULT_MIN_WALL_NOTIONAL_USD,
): DepthSnapshot {
  const walls = Array.isArray(snapshot.walls)
    ? snapshot.walls.filter((wall) => isOrderWall(wall) && wall.notional >= minNotional)
    : [];
  const midPrice = Number.isFinite(snapshot.midPrice) ? Number(snapshot.midPrice) : null;
  return {
    venue: snapshot.venue || venue,
    symbol: compactSymbol(snapshot.symbol || symbol),
    source: "official",
    midPrice,
    walls,
    notice: sanitizeMarketCopy(snapshot.notice, snapshot.venue || venue) || null,
    updatedAt: Number.isFinite(snapshot.updatedAt) ? Number(snapshot.updatedAt) : Date.now(),
  };
}

function clusterSide(
  levels: DepthLevel[],
  side: BookSide,
  clusterBps: number,
  maxPerSide: number,
): OrderWall[] {
  const sorted = [...levels].sort((left, right) => left.price - right.price);
  const clusters: OrderWall[] = [];
  for (const level of sorted) {
    const last = clusters.at(-1);
    const threshold = Math.max(level.price, last?.high ?? 0) * (clusterBps / 10_000);
    if (last && level.price - last.high <= threshold) {
      const size = last.size + level.size;
      const notional = last.notional + level.notional;
      last.high = level.price;
      last.size = size;
      last.notional = notional;
      last.price = notional > 0 ? notional / (size || 1) : last.price;
      continue;
    }
    clusters.push({
      side,
      price: level.price,
      low: level.price,
      high: level.price,
      size: level.size,
      notional: level.notional,
    });
  }
  return clusters
    .sort((left, right) => right.notional - left.notional)
    .slice(0, maxPerSide)
    .sort((left, right) => left.price - right.price);
}

function sortedBook(bids: DepthLevel[], asks: DepthLevel[]): { bids: DepthLevel[]; asks: DepthLevel[] } {
  return {
    bids: [...bids].sort((left, right) => right.price - left.price),
    asks: [...asks].sort((left, right) => left.price - right.price),
  };
}

function parseLevels(rows: unknown, multiplier: number): DepthLevel[] {
  if (!Array.isArray(rows)) return [];
  const scale = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const levels: DepthLevel[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = Number(row[0]);
    const size = Number(row[1]) * scale;
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    levels.push({ price, size, notional: price * size });
  }
  return levels;
}

function isOrderWall(value: unknown): value is OrderWall {
  if (!value || typeof value !== "object") return false;
  const wall = value as OrderWall;
  return (wall.side === "bid" || wall.side === "ask")
    && Number.isFinite(wall.price)
    && Number.isFinite(wall.low)
    && Number.isFinite(wall.high)
    && Number.isFinite(wall.size)
    && Number.isFinite(wall.notional);
}

async function fetchOkxContractValue(symbol: string, fetchImpl: FetchImpl): Promise<number> {
  try {
    const payload = await requestJson(fetchImpl, okxInstrumentUrl(symbol), "okx");
    assertVenuePayload("okx", payload, "OKX instrument request failed");
    return parseOkxContractValue(payload);
  } catch {
    return 1;
  }
}

function depthOrder(preferred: MarketVenue, cacheKey: string, retryPreferred: boolean): MarketVenue[] {
  const order = venueFallbackOrder(preferred);
  const cached = lastGoodDepthVenue.get(cacheKey);
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

function joinDepthFailures(preferred: MarketVenue, failures: MarketRequestFailure[]): string {
  if (failures.some((failure) => failure.blocked)) {
    return shortBlockedMessage(preferred, suggestedFallbackVenue(preferred));
  }
  return sanitizeMarketCopy(failures[0]?.message) || LARGE_ORDER_SR_EMPTY;
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
