import { binance, bitget, bybit, okx, type Exchange } from "ccxt";
import { isMarketVenue, toOkxSpotInstId, toUnifiedSwapSymbol, type MarketVenue } from "./market-venues.ts";

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

async function fillMarkIndex(
  exchange: Exchange,
  venue: MarketVenue,
  unified: string,
  symbol: string,
): Promise<{ markPrice: number | null; indexPrice: number | null }> {
  let markPrice: number | null = null;
  let indexPrice: number | null = null;
  if (exchange.has.fetchMarkPrice) {
    try {
      const mark = await exchange.fetchMarkPrice(unified);
      markPrice = numeric(mark.markPrice) ?? numeric((mark.info as { markPx?: unknown } | undefined)?.markPx);
      indexPrice = numeric(mark.indexPrice) ?? numeric((mark.info as { idxPx?: unknown } | undefined)?.idxPx);
    } catch {
      // Funding already returned whatever this venue exposes.
    }
  }
  if (indexPrice == null && venue === "okx") {
    try {
      const response = await globalThis.fetch(
        `https://www.okx.com/api/v5/market/index-tickers?instId=${encodeURIComponent(toOkxSpotInstId(symbol))}`,
      );
      const payload = await response.json() as { data?: { idxPx?: unknown }[] };
      indexPrice = numeric(payload.data?.[0]?.idxPx);
    } catch {
      // Basis stays blank when the index ticker is unavailable.
    }
  }
  return { markPrice, indexPrice };
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
  let markPrice = numeric(funding.markPrice);
  let indexPrice = numeric(funding.indexPrice);
  if (markPrice == null || indexPrice == null) {
    const extras = await fillMarkIndex(exchange, venue, unified, symbol);
    markPrice = markPrice ?? extras.markPrice;
    indexPrice = indexPrice ?? extras.indexPrice;
  }
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
    indexPrice,
    updatedAt: Date.now(),
  };
}
