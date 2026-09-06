export type ContextCandle = {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type ContextPlot = { title?: string; data?: Array<number | null> };

export type ContextDerivatives = {
  sourceExchange: string;
  openInterestUsd: number | null;
  openInterestBase: number | null;
  fundingRate: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  nextFundingTimestamp: number | null;
};

export type ContextCvd = {
  last?: number | null;
  recent?: Array<{ time?: string; value: number }>;
};

export type AnalystSnapshot = {
  symbol: string;
  venue: string;
  timeframe: string;
  candles: ContextCandle[];
  lastPrice?: number | null;
  ema9?: number | null;
  ema21?: number | null;
  ema9Visible?: boolean;
  ema21Visible?: boolean;
  pineSource?: string;
  pinePlots?: ContextPlot[];
  derivatives?: ContextDerivatives | null;
  cvd?: ContextCvd | null;
};

export type ContextPack = {
  capturedAt: string;
  market: {
    symbol: string;
    venue: string;
    contract: string;
    timeframe: string;
    lastPrice: number | null;
  };
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }>;
  indicators: {
    builtIn: { ema9: number | null; ema21: number | null; ema9Visible: boolean; ema21Visible: boolean };
    customPine: { source: string; plots: Array<{ title: string; recentValues: Array<number | null> }> };
  };
  derivatives: ({ available: true } & ContextDerivatives) | { available: false; reason: string };
  cvd: ({ available: true } & ContextCvd) | { available: false; reason: string };
};

const CANDLE_LIMIT = 120;

function candleTime(value: number | string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return candleTime(numeric);
  return String(value);
}

function lastEma(candles: ContextCandle[], length: number): number | null {
  if (!candles.length) return null;
  const multiplier = 2 / (length + 1);
  let ema = candles[0].close;
  for (let index = 1; index < candles.length; index += 1) {
    ema = candles[index].close * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

export function buildContextPack(snapshot: AnalystSnapshot, capturedAt = new Date().toISOString()): ContextPack {
  const candles = snapshot.candles.slice(-CANDLE_LIMIT).map((candle) => ({
    time: candleTime(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? null,
  }));
  const last = snapshot.candles.at(-1);
  return {
    capturedAt,
    market: {
      symbol: snapshot.symbol,
      venue: snapshot.venue,
      contract: "USDT perpetual",
      timeframe: snapshot.timeframe,
      lastPrice: snapshot.lastPrice ?? last?.close ?? null,
    },
    candles,
    indicators: {
      builtIn: {
        ema9: snapshot.ema9 ?? lastEma(snapshot.candles, 9),
        ema21: snapshot.ema21 ?? lastEma(snapshot.candles, 21),
        ema9Visible: snapshot.ema9Visible ?? true,
        ema21Visible: snapshot.ema21Visible ?? true,
      },
      customPine: {
        source: snapshot.pineSource ?? "",
        plots: (snapshot.pinePlots ?? []).map((plot, index) => ({
          title: plot.title || `Plot ${index + 1}`,
          recentValues: plot.data?.slice(-30) ?? [],
        })),
      },
    },
    derivatives: snapshot.derivatives
      ? { available: true, ...snapshot.derivatives }
      : { available: false, reason: "Derivatives snapshot is not loaded for this chart." },
    cvd: snapshot.cvd
      ? { available: true, ...snapshot.cvd }
      : { available: false, reason: "CVD is not attached on this chart yet." },
  };
}

export function summarizeContextPack(pack: ContextPack) {
  return {
    candles: pack.candles.length,
    hasDerivatives: pack.derivatives.available,
    hasCvd: pack.cvd.available,
    indicators: (pack.indicators.builtIn.ema9Visible ? 1 : 0) + (pack.indicators.builtIn.ema21Visible ? 1 : 0) + pack.indicators.customPine.plots.length,
  };
}
