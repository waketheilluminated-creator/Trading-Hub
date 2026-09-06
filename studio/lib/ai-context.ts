import type { CvdSnapshot } from "./market-cvd.ts";

export const ANALYST_SYSTEM_PROMPT = [
  "You are πlab AI Analyst, an experimental crypto market research assistant.",
  "Analyze only the supplied market snapshot: OHLCV candles, indicator outputs, derivatives metrics (open interest, funding, mark/index), and order-flow CVD.",
  "CVD is computed from the latest public trades, not the full chart history. If a book is unavailable, say so — never invent CVD or trade counts.",
  "When both perpetual and spot CVD are present, interpret whether current buy/sell aggression is coming more from futures (perp) or spot, and how that should affect entry versus exit conviction.",
  "Combine CVD with open interest and funding: rising OI plus futures-led buying supports continuation; falling OI with futures-led selling suggests long liquidation or exit pressure; funding extremes can make a futures-led move crowded.",
  "Separate observations from inference. Never invent missing values or claim certainty.",
  "Respond in the same language as the user's question.",
  "Use this compact structure: Market state, Indicator read, Derivatives read, Futures-vs-spot force, Entry/exit implication, Scenarios, Risks/invalidations.",
  "This is analytical research, not personalized financial advice or an instruction to trade.",
].join(" ");

export type AnalystMarket = {
  symbol: string;
  venue: string;
  contract: string;
  timeframe: string | undefined;
  lastPrice: number | null;
};

export type AnalystCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type AnalystIndicators = {
  builtIn: { ema9: number | null; ema21: number | null; ema9Visible: boolean; ema21Visible: boolean };
  customPine: { source: string; plots: { title: string; recentValues: (number | null)[] }[] };
};

export type AnalystDerivatives = {
  sourceExchange: string;
  openInterestUsd: number | null;
  openInterestBase: number | null;
  fundingRate: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  nextFundingTimestamp: number | null;
};

export function buildOrderFlowContext(cvd: CvdSnapshot | null) {
  if (!cvd) return null;
  return {
    venue: cvd.venue,
    interval: cvd.interval,
    source: cvd.source,
    notice: cvd.notice,
    windowNote: "CVD uses the latest public trades for this venue, not the full displayed chart.",
    perp: slimBook(cvd.perp),
    spot: slimBook(cvd.spot),
    comparison: cvd.comparison,
  };
}

export function buildAnalystContext(input: {
  capturedAt: string;
  market: AnalystMarket;
  candles: AnalystCandle[];
  indicators: AnalystIndicators;
  derivatives: AnalystDerivatives | null;
  orderFlow: CvdSnapshot | null;
}) {
  return {
    capturedAt: input.capturedAt,
    market: input.market,
    candles: input.candles,
    indicators: input.indicators,
    derivatives: input.derivatives,
    orderFlow: buildOrderFlowContext(input.orderFlow),
  };
}

function slimBook(book: CvdSnapshot["perp"]) {
  return {
    available: book.available,
    unit: book.unit,
    tradeCount: book.tradeCount,
    windowStart: book.windowStart,
    windowEnd: book.windowEnd,
    buyVolume: book.buyVolume,
    sellVolume: book.sellVolume,
    delta: book.delta,
    cvd: book.cvd,
    recentBars: book.bars.slice(-12),
    recentSpark: book.spark.slice(-12),
    reason: book.reason,
  };
}
