import { binance, bitget, bybit, okx, type Exchange } from "ccxt";
import { supportedExchangesMessage } from "@/lib/market-venues.ts";

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

const exchanges: Record<string, () => Exchange> = {
  bybit: () => withPlatformFetch(new bybit({ enableRateLimit: true })),
  binance: () => withPlatformFetch(new binance({ enableRateLimit: true, options: { defaultType: "swap" } })),
  okx: () => withPlatformFetch(new okx({ enableRateLimit: true, options: { defaultType: "swap" } })),
  bitget: () => withPlatformFetch(new bitget({ enableRateLimit: true, options: { defaultType: "swap" } })),
};

function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchangeId = (url.searchParams.get("exchange") || "bybit").toLowerCase();
  const symbol = url.searchParams.get("symbol") || "BTC/USDT:USDT";
  const makeExchange = exchanges[exchangeId];

  if (!makeExchange) {
    return Response.json({ error: supportedExchangesMessage() }, { status: 400 });
  }
  if (!/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}:[A-Z0-9]{2,12}$/.test(symbol)) {
    return Response.json({ error: "Use a unified perpetual symbol such as BTC/USDT:USDT" }, { status: 400 });
  }

  try {
    const exchange = makeExchange();
    await exchange.loadMarkets();
    if (!exchange.has.fetchOpenInterest || !exchange.has.fetchFundingRate) {
      return Response.json({ error: `${exchangeId} does not expose the required unified methods` }, { status: 422 });
    }

    const [openInterest, funding] = await Promise.all([
      exchange.fetchOpenInterest(symbol),
      exchange.fetchFundingRate(symbol),
    ]);
    const markPrice = numeric(funding.markPrice);
    const openInterestAmount = numeric(openInterest.openInterestAmount);
    const reportedValue = numeric(openInterest.openInterestValue);

    return Response.json({
      exchange: exchangeId,
      symbol,
      openInterestAmount,
      openInterestValue: reportedValue ?? (openInterestAmount != null && markPrice != null ? openInterestAmount * markPrice : null),
      fundingRate: numeric(funding.fundingRate),
      fundingInterval: funding.interval || null,
      nextFundingTimestamp: numeric(funding.nextFundingTimestamp ?? funding.fundingTimestamp),
      markPrice,
      indexPrice: numeric(funding.indexPrice),
      updatedAt: Date.now(),
    }, { headers: { "Cache-Control": "public, max-age=20, s-maxage=20" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Exchange data request failed",
      exchange: exchangeId,
      symbol,
    }, { status: 502 });
  }
}
