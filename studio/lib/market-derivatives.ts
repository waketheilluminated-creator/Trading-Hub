import { binance, bitget, bybit, okx, type Exchange } from "ccxt";
import { isMarketVenue, toUnifiedSwapSymbol, type MarketVenue } from "./market-venues.ts";

export type DerivativesSnapshot = {
  exchange: MarketVenue;
  symbol: string;
  openInterestAmount: number | null;
  openInterestValue: number | null;
  fundingRate: number | null;
  fundingInterval: string | null;
  nextFundingTimestamp: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  updatedAt: number;
};

function withPlatformFetch(exchange: Exchange) {
  // CCXT otherwise selects Node's undici transport. Sites runs on Workers,
  // where the platform fetch implementation is the compatible transport.
  exchange.fetchImplementation = (input: RequestInfo | URL, init: RequestInit & Record<string, unknown> = {}) => {
    const platformInit = { ...init };
    delete platformInit.agent;
    delete platformInit.dispatcher;
    delete platformInit.timeout;
    return globalThis.fetch(input, platformInit);
  };
  exchange.fetchIsNative = false;
  return exchange;
}

const exchanges: Record<MarketVenue, () => Exchange> = {
  bybit: () => withPlatformFetch(new bybit({ enableRateLimit: true })),
  binance: () => withPlatformFetch(new binance({ enableRateLimit: true, options: { defaultType: "swap" } })),
  okx: () => withPlatformFetch(new okx({ enableRateLimit: true, options: { defaultType: "swap" } })),
  bitget: () => withPlatformFetch(new bitget({ enableRateLimit: true, options: { defaultType: "swap" } })),
};

function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function fetchDerivativesSnapshot(
  venue: MarketVenue,
  symbol: string,
): Promise<DerivativesSnapshot> {
  if (!isMarketVenue(venue)) throw new Error(`Unsupported derivatives venue ${venue}`);
  const unified = toUnifiedSwapSymbol(symbol);
  const exchange = exchanges[venue]();
  await exchange.loadMarkets();
  if (!exchange.has.fetchOpenInterest || !exchange.has.fetchFundingRate) {
    throw new Error(`${venue} does not expose the required unified methods`);
  }

  const [openInterest, funding] = await Promise.all([
    exchange.fetchOpenInterest(unified),
    exchange.fetchFundingRate(unified),
  ]);
  const markPrice = numeric(funding.markPrice);
  const openInterestAmount = numeric(openInterest.openInterestAmount);
  const reportedValue = numeric(openInterest.openInterestValue);

  return {
    exchange: venue,
    symbol: unified,
    openInterestAmount,
    openInterestValue: reportedValue ?? (openInterestAmount != null && markPrice != null ? openInterestAmount * markPrice : null),
    fundingRate: numeric(funding.fundingRate),
    fundingInterval: funding.interval || null,
    nextFundingTimestamp: numeric(funding.nextFundingTimestamp ?? funding.fundingTimestamp),
    markPrice,
    indexPrice: numeric(funding.indexPrice),
    updatedAt: Date.now(),
  };
}
