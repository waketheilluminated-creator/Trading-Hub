import { fetchVenueCvd, type CvdBook, type CvdSnapshot, type ForceReading } from "./market-cvd.ts";
import { fetchDerivativesSnapshot, type DerivativesSnapshot } from "./market-derivatives.ts";
import { fetchVenueKlines, type RestKlineResult } from "./market-rest.ts";
import {
  compactSymbol,
  isChartInterval,
  isMarketVenue,
  type ChartInterval,
  type MarketCandle,
  type MarketVenue,
} from "./market-venues.ts";

export const ANALYST_DATA_PACK_KIND = "pilab.market-datapack/v1";

export const ANALYST_SYSTEM_PROMPT = [
  "You are πlab AI Analyst, an experimental crypto market research assistant.",
  "Analyze only the attached backend market data packs: klines (OHLCV series JSON), openInterest (OI/funding snapshot JSON), and cvd (perp/spot series JSON).",
  "These packs are assembled by the server from public market APIs. You do not receive screenshots, scroll-captures, chart images, or pixel data. Never ask for a picture of the chart.",
  "CVD is computed from the latest public trades, not the full chart history. If a pack or book is unavailable, say so — never invent CVD, OI, or candle values.",
  "When both perpetual and spot CVD series are present, interpret whether current buy/sell aggression is coming more from futures (perp) or spot, and how that should affect entry versus exit conviction.",
  "Combine CVD with open interest and funding: rising OI plus futures-led buying supports continuation; falling OI with futures-led selling suggests long liquidation or exit pressure; funding extremes can make a futures-led move crowded.",
  "Separate observations from inference. Never invent missing values or claim certainty.",
  "Respond in the same language as the user's question.",
  "Use this compact structure: Market state, Indicator read, Derivatives read, Futures-vs-spot force, Entry/exit implication, Scenarios, Risks/invalidations.",
  "This is analytical research, not personalized financial advice or an instruction to trade.",
].join(" ");

export type AnalystOverlay = {
  ema9Visible?: boolean;
  ema21Visible?: boolean;
  customPine?: { source: string; plots: { title: string; recentValues: (number | null)[] }[] };
};

export type KlineBar = { t: number; o: number; h: number; l: number; c: number; v: number | null };
export type CvdBarJson = { t: number; buyVolume: number; sellVolume: number; delta: number; cvd: number };

export type KlineDataPack = {
  pack: "klines";
  available: boolean;
  venue: MarketVenue | null;
  symbol: string;
  interval: ChartInterval;
  source: "official" | "public-mirror" | null;
  series: KlineBar[];
  derived: { last: number | null; ema9: number | null; ema21: number | null };
  reason: string | null;
};

export type OpenInterestDataPack = {
  pack: "openInterest";
  available: boolean;
  venue: MarketVenue | null;
  symbol: string;
  openInterestUsd: number | null;
  openInterestBase: number | null;
  fundingRate: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  nextFundingTimestamp: number | null;
  reason: string | null;
};

export type CvdBookPack = {
  available: boolean;
  unit: CvdBook["unit"] | null;
  tradeCount: number;
  windowStart: number | null;
  windowEnd: number | null;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cvd: number;
  series: CvdBarJson[];
  spark: CvdBarJson[];
  reason: string | null;
};

export type CvdDataPack = {
  pack: "cvd";
  available: boolean;
  venue: MarketVenue | null;
  interval: ChartInterval;
  source: "official" | "public-mirror" | null;
  notice: string | null;
  windowNote: string;
  perp: CvdBookPack;
  spot: CvdBookPack;
  comparison: ForceReading | null;
  reason: string | null;
};

export type AnalystDataPack = {
  kind: typeof ANALYST_DATA_PACK_KIND;
  capturedAt: string;
  input: "backend-api";
  media: { screenshots: false; scrollCapture: false; chartImages: false };
  market: { symbol: string; venue: MarketVenue; interval: ChartInterval; contract: "USDT perpetual" };
  packs: {
    klines: KlineDataPack;
    openInterest: OpenInterestDataPack;
    cvd: CvdDataPack;
  };
  overlay: AnalystOverlay | null;
};

export type AnalystMarketRef = {
  symbol: string;
  venue: MarketVenue;
  interval: ChartInterval;
  derivativesVenue?: MarketVenue;
};

export type DataPackLoaders = {
  fetchKlines?: typeof fetchVenueKlines;
  fetchCvd?: typeof fetchVenueCvd;
  fetchDerivatives?: typeof fetchDerivativesSnapshot;
};

export function parseAnalystMarketRef(input: unknown): AnalystMarketRef {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const symbol = compactSymbol(typeof raw.symbol === "string" ? raw.symbol : "BTCUSDT");
  const venue = isMarketVenue(raw.venue) ? raw.venue : "okx";
  const interval = isChartInterval(raw.interval) ? raw.interval : "15";
  const derivativesVenue = isMarketVenue(raw.derivativesVenue) ? raw.derivativesVenue : venue;
  return { symbol, venue, interval, derivativesVenue };
}

export function buildOrderFlowContext(cvd: CvdSnapshot | null): CvdDataPack {
  if (!cvd) {
    return emptyCvdPack("15", "CVD pack was not returned by the backend.");
  }
  return {
    pack: "cvd",
    available: cvd.perp.available || cvd.spot.available,
    venue: cvd.venue,
    interval: cvd.interval,
    source: cvd.source,
    notice: cvd.notice,
    windowNote: "CVD series JSON from the latest public trades, not a screenshot of the chart.",
    perp: slimBook(cvd.perp),
    spot: slimBook(cvd.spot),
    comparison: cvd.comparison,
    reason: cvd.perp.available || cvd.spot.available ? null : (cvd.notice || "No public trades returned."),
  };
}

export async function assembleAnalystDataPack(
  market: AnalystMarketRef,
  overlay: AnalystOverlay | null = null,
  loaders: DataPackLoaders = {},
): Promise<AnalystDataPack> {
  const loadKlines = loaders.fetchKlines ?? fetchVenueKlines;
  const loadCvd = loaders.fetchCvd ?? fetchVenueCvd;
  const loadDerivatives = loaders.fetchDerivatives ?? fetchDerivativesSnapshot;
  const symbol = compactSymbol(market.symbol);
  const klineVenue = market.venue;
  const oiVenue = market.derivativesVenue ?? market.venue;

  const [klinesResult, cvdResult, oiResult] = await Promise.allSettled([
    loadKlines(klineVenue, symbol, market.interval, 120),
    loadCvd(klineVenue, symbol, market.interval),
    loadDerivatives(oiVenue, symbol),
  ]);

  const klines = klinesResult.status === "fulfilled"
    ? klinePackFromRest(klinesResult.value)
    : emptyKlinePack(symbol, market.interval, failureReason(klinesResult.reason));
  const cvd = cvdResult.status === "fulfilled"
    ? buildOrderFlowContext(cvdResult.value)
    : emptyCvdPack(market.interval, failureReason(cvdResult.reason));
  const openInterest = oiResult.status === "fulfilled"
    ? oiPackFromSnapshot(oiResult.value)
    : emptyOiPack(symbol, failureReason(oiResult.reason));

  return {
    kind: ANALYST_DATA_PACK_KIND,
    capturedAt: new Date().toISOString(),
    input: "backend-api",
    media: { screenshots: false, scrollCapture: false, chartImages: false },
    market: { symbol, venue: klineVenue, interval: market.interval, contract: "USDT perpetual" },
    packs: { klines, openInterest, cvd },
    overlay,
  };
}

export function formatAnalystUserMessage(question: string, pack: AnalystDataPack): string {
  return `${question}\n\nπlab BACKEND MARKET DATA PACKS (API/series JSON — not a screenshot)\n${JSON.stringify(pack)}`;
}

export function analystPackIsEmpty(pack: AnalystDataPack): boolean {
  return !pack.packs.klines.available && !pack.packs.openInterest.available && !pack.packs.cvd.available;
}

function klinePackFromRest(result: RestKlineResult): KlineDataPack {
  const series = result.candles.slice(-120).map(toKlineBar);
  return {
    pack: "klines",
    available: series.length > 0,
    venue: result.venue,
    symbol: result.symbol,
    interval: result.interval,
    source: result.source,
    series,
    derived: {
      last: series.at(-1)?.c ?? null,
      ema9: emaOf(series, 9),
      ema21: emaOf(series, 21),
    },
    reason: series.length ? null : "Kline pack contained no bars.",
  };
}

function oiPackFromSnapshot(snapshot: DerivativesSnapshot): OpenInterestDataPack {
  const available = snapshot.openInterestValue != null || snapshot.fundingRate != null;
  return {
    pack: "openInterest",
    available,
    venue: snapshot.exchange,
    symbol: snapshot.symbol,
    openInterestUsd: snapshot.openInterestValue,
    openInterestBase: snapshot.openInterestAmount,
    fundingRate: snapshot.fundingRate,
    markPrice: snapshot.markPrice,
    indexPrice: snapshot.indexPrice,
    nextFundingTimestamp: snapshot.nextFundingTimestamp,
    reason: available ? null : "Open interest pack had no OI or funding values.",
  };
}

function slimBook(book: CvdBook): CvdBookPack {
  return {
    available: book.available,
    unit: book.available ? book.unit : null,
    tradeCount: book.tradeCount,
    windowStart: book.windowStart,
    windowEnd: book.windowEnd,
    buyVolume: book.buyVolume,
    sellVolume: book.sellVolume,
    delta: book.delta,
    cvd: book.cvd,
    series: book.bars.slice(-24).map((bar) => ({ t: bar.time, buyVolume: bar.buyVolume, sellVolume: bar.sellVolume, delta: bar.delta, cvd: bar.cvd })),
    spark: book.spark.slice(-24).map((bar) => ({ t: bar.time, buyVolume: bar.buyVolume, sellVolume: bar.sellVolume, delta: bar.delta, cvd: bar.cvd })),
    reason: book.reason,
  };
}

function emptyKlinePack(symbol: string, interval: ChartInterval, reason: string): KlineDataPack {
  return {
    pack: "klines",
    available: false,
    venue: null,
    symbol,
    interval,
    source: null,
    series: [],
    derived: { last: null, ema9: null, ema21: null },
    reason,
  };
}

function emptyOiPack(symbol: string, reason: string): OpenInterestDataPack {
  return {
    pack: "openInterest",
    available: false,
    venue: null,
    symbol,
    openInterestUsd: null,
    openInterestBase: null,
    fundingRate: null,
    markPrice: null,
    indexPrice: null,
    nextFundingTimestamp: null,
    reason,
  };
}

function emptyCvdPack(interval: ChartInterval, reason: string): CvdDataPack {
  const emptyBook: CvdBookPack = {
    available: false,
    unit: null,
    tradeCount: 0,
    windowStart: null,
    windowEnd: null,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    cvd: 0,
    series: [],
    spark: [],
    reason,
  };
  return {
    pack: "cvd",
    available: false,
    venue: null,
    interval,
    source: null,
    notice: reason,
    windowNote: "CVD series JSON from the latest public trades, not a screenshot of the chart.",
    perp: emptyBook,
    spot: { ...emptyBook },
    comparison: null,
    reason,
  };
}

function toKlineBar(candle: MarketCandle): KlineBar {
  return { t: candle.time, o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume ?? null };
}

function emaOf(series: KlineBar[], length: number): number | null {
  if (!series.length) return null;
  const multiplier = 2 / (length + 1);
  return series.reduce((ema, bar, index) => (index === 0 ? bar.c : bar.c * multiplier + ema * (1 - multiplier)), series[0].c);
}

function failureReason(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return error instanceof Error ? error.message : "Backend pack request failed";
}
