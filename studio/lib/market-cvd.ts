import {
  classifyMarketFailure,
  compactSymbol,
  intervalDurationMs,
  toOkxSpotInstId,
  toOkxSwapInstId,
  type ChartInterval,
  type MarketRequestFailure,
  type MarketVenue,
} from "./market-venues.ts";

type FetchImpl = typeof fetch;

export type TradeSide = "buy" | "sell";
export type OrderBookKind = "perp" | "spot";
export type Aggression = "buy" | "sell" | "neutral" | "unknown";
export type DominantBook = "perp" | "spot" | "balanced" | "unknown";
export type CvdUnit = "base" | "contracts";

export type MarketTrade = {
  time: number;
  price: number;
  size: number;
  side: TradeSide;
};

export type CvdBar = {
  time: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cvd: number;
};

export type CvdBook = {
  available: boolean;
  market: OrderBookKind;
  unit: CvdUnit;
  tradeCount: number;
  windowStart: number | null;
  windowEnd: number | null;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cvd: number;
  bars: CvdBar[];
  reason: string | null;
};

export type ForceReading = {
  available: boolean;
  perpAggression: Aggression;
  spotAggression: Aggression;
  dominantBook: DominantBook;
  perpMinusSpotDelta: number | null;
  interpretation: string;
};

export type CvdSnapshot = {
  venue: MarketVenue;
  symbol: string;
  interval: ChartInterval;
  source: "official" | "public-mirror";
  perp: CvdBook;
  spot: CvdBook;
  comparison: ForceReading;
  notice: string | null;
  updatedAt: number;
};

const BINANCE_TRADE_HOSTS = {
  perpOfficial: "https://fapi.binance.com/fapi/v1/aggTrades",
  spotOfficial: "https://api.binance.com/api/v3/aggTrades",
  spotMirror: "https://data-api.binance.vision/api/v3/aggTrades",
};

const NEUTRAL_IMBALANCE = 0.05;
const DOMINANCE_RATIO = 1.25;

export function tradeRequestUrl(
  venue: MarketVenue,
  symbol: string,
  market: OrderBookKind,
  host: "official" | "public-mirror" = "official",
): string {
  const compact = compactSymbol(symbol);
  if (venue === "bybit") {
    const category = market === "perp" ? "linear" : "spot";
    return `https://api.bybit.com/v5/market/recent-trade?category=${category}&symbol=${compact}&limit=1000`;
  }
  if (venue === "okx") {
    const instId = market === "perp" ? toOkxSwapInstId(compact) : toOkxSpotInstId(compact);
    return `https://www.okx.com/api/v5/market/trades?instId=${encodeURIComponent(instId)}&limit=500`;
  }
  if (venue === "bitget") {
    if (market === "spot") return `https://api.bitget.com/api/v2/spot/market/fills?symbol=${compact}&limit=500`;
    return host === "public-mirror"
      ? `https://api.bitget.com/api/v2/mix/market/fills?productType=USDT-FUTURES&symbol=${compact}&limit=100`
      : `https://api.bitget.com/api/v2/mix/market/fills-history?productType=USDT-FUTURES&symbol=${compact}&limit=1000`;
  }
  const endpoint = market === "perp"
    ? BINANCE_TRADE_HOSTS.perpOfficial
    : host === "public-mirror" ? BINANCE_TRADE_HOSTS.spotMirror : BINANCE_TRADE_HOSTS.spotOfficial;
  return `${endpoint}?symbol=${compact}&limit=1000`;
}

export function parseVenueTrades(venue: MarketVenue, payload: unknown): MarketTrade[] {
  if (venue === "bybit") {
    const rows = Array.isArray((payload as { result?: { list?: unknown } })?.result?.list)
      ? (payload as { result: { list: Record<string, unknown>[] } }).result.list
      : [];
    return rows.map(parseBybitTrade).filter(isTrade).sort(byTime);
  }
  if (venue === "okx") {
    const rows = Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: Record<string, unknown>[] }).data
      : [];
    return rows.map(parseOkxTrade).filter(isTrade).sort(byTime);
  }
  if (venue === "bitget") {
    const rows = Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: Record<string, unknown>[] }).data
      : [];
    return rows.map(parseBitgetTrade).filter(isTrade).sort(byTime);
  }
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map(parseBinanceTrade).filter(isTrade).sort(byTime);
}

export function unavailableBook(market: OrderBookKind, reason: string, unit: CvdUnit = "base"): CvdBook {
  return {
    available: false,
    market,
    unit,
    tradeCount: 0,
    windowStart: null,
    windowEnd: null,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    cvd: 0,
    bars: [],
    reason,
  };
}

export function computeCvdBook(
  trades: MarketTrade[],
  interval: ChartInterval,
  market: OrderBookKind,
  contractMultiplier = 1,
  unit: CvdUnit = "base",
): CvdBook {
  if (!trades.length) {
    return unavailableBook(market, "No public trades returned for this market.", unit);
  }

  const multiplier = Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : 1;
  const bars = new Map<number, CvdBar>();
  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of trades) {
    const size = trade.size * multiplier;
    if (trade.side === "buy") buyVolume += size;
    else sellVolume += size;
    const open = barOpenSeconds(trade.time, interval);
    const bar = bars.get(open) ?? { time: open, buyVolume: 0, sellVolume: 0, delta: 0, cvd: 0 };
    if (trade.side === "buy") bar.buyVolume += size;
    else bar.sellVolume += size;
    bars.set(open, bar);
  }

  let running = 0;
  const series = [...bars.values()].sort((left, right) => left.time - right.time).map((bar) => {
    bar.delta = bar.buyVolume - bar.sellVolume;
    running += bar.delta;
    bar.cvd = running;
    return bar;
  });

  return {
    available: true,
    market,
    unit,
    tradeCount: trades.length,
    windowStart: trades[0].time,
    windowEnd: trades[trades.length - 1].time,
    buyVolume,
    sellVolume,
    delta: buyVolume - sellVolume,
    cvd: running,
    bars: series,
    reason: null,
  };
}

export function interpretForce(perp: CvdBook, spot: CvdBook): ForceReading {
  const perpAggression = aggressionOf(perp);
  const spotAggression = aggressionOf(spot);
  if (!perp.available && !spot.available) {
    return {
      available: false,
      perpAggression,
      spotAggression,
      dominantBook: "unknown",
      perpMinusSpotDelta: null,
      interpretation: "CVD is unavailable. Public trades were not returned for perpetual or spot, so buy/sell force cannot be attributed.",
    };
  }
  if (perp.available && perp.unit === "contracts") {
    return {
      available: false,
      perpAggression,
      spotAggression,
      dominantBook: "unknown",
      perpMinusSpotDelta: null,
      interpretation: "Perp CVD is in contracts, not base size, so it is not compared with spot. Treat the perpetual book on its own.",
    };
  }
  if (perp.available !== spot.available) {
    const present = perp.available ? perp : spot;
    const missing = perp.available ? "spot" : "perpetual";
    return {
      available: false,
      perpAggression,
      spotAggression,
      dominantBook: perp.available ? "perp" : "spot",
      perpMinusSpotDelta: null,
      interpretation: `${labelBook(present.market)} takers are ${aggressionPhrase(aggressionOf(present))} over the latest public trades. ${missing === "spot" ? "Spot" : "Perpetual"} CVD is unavailable, so futures-versus-spot attribution is incomplete.`,
    };
  }

  const spread = perp.delta - spot.delta;
  const dominantBook = dominantOf(perp, spot);
  return {
    available: true,
    perpAggression,
    spotAggression,
    dominantBook,
    perpMinusSpotDelta: spread,
    interpretation: forceSentence(perpAggression, spotAggression, dominantBook, spread),
  };
}

export function buildCvdSnapshot(input: {
  venue: MarketVenue;
  symbol: string;
  interval: ChartInterval;
  source?: "official" | "public-mirror";
  perp: CvdBook;
  spot: CvdBook;
  notice?: string | null;
  updatedAt?: number;
}): CvdSnapshot {
  return {
    venue: input.venue,
    symbol: compactSymbol(input.symbol),
    interval: input.interval,
    source: input.source ?? "official",
    perp: input.perp,
    spot: input.spot,
    comparison: interpretForce(input.perp, input.spot),
    notice: input.notice ?? null,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export async function fetchVenueCvd(
  venue: MarketVenue,
  symbol: string,
  interval: ChartInterval,
  fetchImpl: FetchImpl = fetch,
): Promise<CvdSnapshot> {
  const compact = compactSymbol(symbol);
  if (venue === "binance") {
    return fetchBinanceCvd(compact, interval, fetchImpl);
  }

  const contractSize = venue === "okx"
    ? await fetchOkxSwapCtVal(compact, fetchImpl).catch(() => null)
    : 1;
  const [perpResult, spotResult] = await Promise.allSettled([
    venue === "bitget"
      ? fetchBitgetPerpTrades(compact, fetchImpl)
      : fetchMarketTrades(venue, compact, "perp", fetchImpl),
    fetchMarketTrades(venue, compact, "spot", fetchImpl),
  ]);

  if (perpResult.status === "rejected" && spotResult.status === "rejected") {
    throw asFailure(perpResult.reason, venue);
  }

  const perpUnit: CvdUnit = venue === "okx" && (contractSize == null || contractSize <= 0) ? "contracts" : "base";
  const perp = perpResult.status === "fulfilled"
    ? computeCvdBook(perpResult.value, interval, "perp", contractSize ?? 1, perpUnit)
    : unavailableBook("perp", failureReason(perpResult.reason, venue));
  const spot = spotResult.status === "fulfilled"
    ? computeCvdBook(spotResult.value, interval, "spot")
    : unavailableBook("spot", failureReason(spotResult.reason, venue));

  const notices = [
    perpResult.status === "rejected" ? `Perp trades unavailable: ${failureReason(perpResult.reason, venue)}` : null,
    spotResult.status === "rejected" ? `Spot trades unavailable: ${failureReason(spotResult.reason, venue)}` : null,
    perp.available && perp.unit === "contracts" ? "OKX contract multiplier was unavailable; perp CVD is not compared with spot." : null,
  ].filter(Boolean);

  return buildCvdSnapshot({
    venue,
    symbol: compact,
    interval,
    perp,
    spot,
    notice: notices.length ? notices.join(" ") : null,
  });
}

export function summarizeCvdWindow(book: CvdBook): string | null {
  if (!book.available || book.windowStart == null || book.windowEnd == null) return null;
  const elapsed = Math.max(0, book.windowEnd - book.windowStart);
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  return `${book.tradeCount} trades · ~${minutes}m`;
}

async function fetchBinanceCvd(
  symbol: string,
  interval: ChartInterval,
  fetchImpl: FetchImpl,
): Promise<CvdSnapshot> {
  const [perpResult, spotResult] = await Promise.allSettled([
    fetchMarketTrades("binance", symbol, "perp", fetchImpl),
    fetchBinanceSpotTrades(symbol, fetchImpl),
  ]);

  if (perpResult.status === "rejected" && spotResult.status === "rejected") {
    throw asFailure(perpResult.reason, "binance");
  }

  const spotSource = spotResult.status === "fulfilled" ? spotResult.value.source : "official";
  const perp = perpResult.status === "fulfilled"
    ? computeCvdBook(perpResult.value, interval, "perp")
    : unavailableBook("perp", failureReason(perpResult.reason, "binance"));
  const spot = spotResult.status === "fulfilled"
    ? computeCvdBook(spotResult.value.trades, interval, "spot")
    : unavailableBook("spot", failureReason(spotResult.reason, "binance"));

  const notices = [
    perpResult.status === "rejected" ? `Perp trades unavailable: ${failureReason(perpResult.reason, "binance")}` : null,
    spotResult.status === "rejected" ? `Spot trades unavailable: ${failureReason(spotResult.reason, "binance")}` : null,
    spotSource === "public-mirror" ? "Binance spot CVD is from the public data mirror." : null,
  ].filter(Boolean);

  return buildCvdSnapshot({
    venue: "binance",
    symbol,
    interval,
    source: spotSource,
    perp,
    spot,
    notice: notices.length ? notices.join(" ") : null,
  });
}

async function fetchBinanceSpotTrades(
  symbol: string,
  fetchImpl: FetchImpl,
): Promise<{ trades: MarketTrade[]; source: "official" | "public-mirror" }> {
  let lastFailure: MarketRequestFailure | undefined;
  for (const host of ["official", "public-mirror"] as const) {
    try {
      const trades = await fetchMarketTrades("binance", symbol, "spot", fetchImpl, host);
      return { trades, source: host };
    } catch (error) {
      lastFailure = asFailure(error, "binance");
    }
  }
  throw lastFailure ?? classifyMarketFailure("binance", 502, "Spot trades unavailable");
}

async function fetchBitgetPerpTrades(symbol: string, fetchImpl: FetchImpl): Promise<MarketTrade[]> {
  try {
    return await fetchMarketTrades("bitget", symbol, "perp", fetchImpl);
  } catch (historyError) {
    try {
      return await fetchMarketTrades("bitget", symbol, "perp", fetchImpl, "public-mirror");
    } catch {
      throw historyError;
    }
  }
}

async function fetchMarketTrades(
  venue: MarketVenue,
  symbol: string,
  market: OrderBookKind,
  fetchImpl: FetchImpl,
  host: "official" | "public-mirror" = "official",
): Promise<MarketTrade[]> {
  const payload = await requestJson(fetchImpl, tradeRequestUrl(venue, symbol, market, host), venue);
  assertVenuePayload(venue, payload, `${venue} ${market} trades request failed`);
  return parseVenueTrades(venue, payload);
}

async function fetchOkxSwapCtVal(symbol: string, fetchImpl: FetchImpl): Promise<number | null> {
  const instId = toOkxSwapInstId(symbol);
  const payload = await requestJson(
    fetchImpl,
    `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`,
    "okx",
  );
  assertVenuePayload("okx", payload, "OKX instrument request failed");
  const rows = Array.isArray((payload as { data?: unknown })?.data)
    ? (payload as { data: Record<string, unknown>[] }).data
    : [];
  const ctVal = Number(rows[0]?.ctVal);
  return Number.isFinite(ctVal) && ctVal > 0 ? ctVal : null;
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

function parseBybitTrade(row: Record<string, unknown>): MarketTrade | null {
  return tradeFrom(row.time ?? row.T, row.price, row.size ?? row.qty, row.side);
}

function parseOkxTrade(row: Record<string, unknown>): MarketTrade | null {
  return tradeFrom(row.ts, row.px, row.sz, row.side);
}

function parseBitgetTrade(row: Record<string, unknown>): MarketTrade | null {
  return tradeFrom(row.ts ?? row.t, row.price ?? row.px, row.size ?? row.baseVolume ?? row.sz, row.side);
}

function parseBinanceTrade(row: unknown): MarketTrade | null {
  if (!row || typeof row !== "object") return null;
  const item = row as Record<string, unknown>;
  const buyerMaker = item.m;
  if (typeof buyerMaker !== "boolean") return null;
  return tradeFrom(item.T, item.p, item.q, buyerMaker ? "sell" : "buy");
}

function tradeFrom(time: unknown, price: unknown, size: unknown, side: unknown): MarketTrade | null {
  const parsedSide = normalizeSide(side);
  const trade = {
    time: Number(time),
    price: Number(price),
    size: Number(size),
    side: parsedSide ?? "buy",
  };
  if (!parsedSide || !Number.isFinite(trade.time) || !Number.isFinite(trade.price) || !Number.isFinite(trade.size) || trade.size <= 0) {
    return null;
  }
  return trade;
}

function normalizeSide(value: unknown): TradeSide | null {
  const side = String(value || "").trim().toLowerCase();
  if (side === "buy" || side === "bid") return "buy";
  if (side === "sell" || side === "ask") return "sell";
  return null;
}

function isTrade(value: MarketTrade | null): value is MarketTrade {
  return Boolean(value);
}

function byTime(left: MarketTrade, right: MarketTrade): number {
  return left.time - right.time;
}

function barOpenSeconds(timeMs: number, interval: ChartInterval): number {
  const duration = intervalDurationMs(interval);
  return Math.floor(timeMs / duration) * (duration / 1000);
}

function aggressionOf(book: CvdBook): Aggression {
  if (!book.available) return "unknown";
  const total = book.buyVolume + book.sellVolume;
  if (total <= 0) return "neutral";
  if (Math.abs(book.delta) / total < NEUTRAL_IMBALANCE) return "neutral";
  return book.delta > 0 ? "buy" : "sell";
}

function dominantOf(perp: CvdBook, spot: CvdBook): DominantBook {
  const perpMag = Math.abs(perp.delta);
  const spotMag = Math.abs(spot.delta);
  if (perpMag === 0 && spotMag === 0) return "balanced";
  if (perpMag >= spotMag * DOMINANCE_RATIO) return "perp";
  if (spotMag >= perpMag * DOMINANCE_RATIO) return "spot";
  return "balanced";
}

function forceSentence(
  perpAggression: Aggression,
  spotAggression: Aggression,
  dominantBook: DominantBook,
  spread: number,
): string {
  const spreadWord = spread > 0 ? "futures-led buying versus spot" : spread < 0 ? "futures-led selling versus spot" : "no net futures-versus-spot gap";
  if (dominantBook === "perp") {
    return `Perpetual takers are ${aggressionPhrase(perpAggression)} more than spot (${aggressionPhrase(spotAggression)}). Force looks ${spreadWord}; that favors following the perp side for entry and fading it only if open interest or funding disagree.`;
  }
  if (dominantBook === "spot") {
    return `Spot takers are ${aggressionPhrase(spotAggression)} more than perps (${aggressionPhrase(perpAggression)}). Force looks spot-led; a perp entry is weaker unless open interest confirms the same side.`;
  }
  return `Perp and spot aggression are similar (perp ${perpAggression}, spot ${spotAggression}). Force is not clearly futures- or spot-led in this trade window; wait for CVD or open interest to diverge before adding conviction.`;
}

function aggressionPhrase(value: Aggression): string {
  if (value === "buy") return "buying";
  if (value === "sell") return "selling";
  if (value === "neutral") return "balanced";
  return "unknown";
}

function labelBook(market: OrderBookKind): string {
  return market === "perp" ? "Perpetual" : "Spot";
}

function failureReason(error: unknown, venue: MarketVenue): string {
  return asFailure(error, venue).message;
}

function asFailure(error: unknown, venue: MarketVenue): MarketRequestFailure {
  if (error && typeof error === "object" && "blocked" in error && "venue" in error) {
    return error as MarketRequestFailure;
  }
  return classifyMarketFailure(venue, 502, error instanceof Error ? error.message : "Market request failed");
}
