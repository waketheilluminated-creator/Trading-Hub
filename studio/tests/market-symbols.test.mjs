import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("../lib/market-symbols.js", import.meta.url);

test("normalizes only active Bybit USDT perpetual markets", async () => {
  assert.ok(existsSync(fileURLToPath(moduleUrl)), "market symbol logic module should exist");
  const { normalizeBybitMarkets } = await import(moduleUrl.href);
  const payload = {
    result: {
      list: [
        { symbol: "SOLUSDT", baseCoin: "SOL", quoteCoin: "USDT", contractType: "LinearPerpetual", status: "Trading" },
        { symbol: "BTCUSD", baseCoin: "BTC", quoteCoin: "USD", contractType: "InversePerpetual", status: "Trading" },
        { symbol: "ETHUSDT", baseCoin: "ETH", quoteCoin: "USDT", contractType: "LinearPerpetual", status: "Settled" },
        { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", contractType: "LinearPerpetual", status: "Trading" },
      ],
    },
  };

  assert.deepEqual(normalizeBybitMarkets(payload), [
    { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
    { symbol: "SOLUSDT", base: "SOL", quote: "USDT" },
  ]);
});

test("normalizes Binance USDT markets and OKX linear swaps", async () => {
  const { normalizeBinanceMarkets, normalizeOkxSwapMarkets } = await import(moduleUrl.href);
  assert.deepEqual(normalizeBinanceMarkets({
    symbols: [
      { symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", contractType: "PERPETUAL" },
      { symbol: "ETHUSDT", status: "BREAK", baseAsset: "ETH", quoteAsset: "USDT", contractType: "PERPETUAL" },
      { symbol: "SOLUSDT", status: "TRADING", baseAsset: "SOL", quoteAsset: "USDT" },
    ],
  }), [
    { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
    { symbol: "SOLUSDT", base: "SOL", quote: "USDT" },
  ]);
  assert.deepEqual(normalizeOkxSwapMarkets({
    data: [
      { state: "live", ctType: "linear", settleCcy: "USDT", ctValCcy: "SOL", instFamily: "SOL-USDT" },
      { state: "suspend", ctType: "linear", settleCcy: "USDT", ctValCcy: "BTC", instFamily: "BTC-USDT" },
    ],
  }), [{ symbol: "SOLUSDT", base: "SOL", quote: "USDT" }]);
});

test("searches market symbols by ticker and coin name", async () => {
  assert.ok(existsSync(fileURLToPath(moduleUrl)), "market symbol logic module should exist");
  const { searchMarkets } = await import(moduleUrl.href);
  const markets = [
    { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
    { symbol: "SOLUSDT", base: "SOL", quote: "USDT" },
  ];

  assert.deepEqual(searchMarkets(markets, "sol"), [markets[1]]);
  assert.deepEqual(searchMarkets(markets, "btc / usdt"), [markets[0]]);
});

test("keeps recent symbols unique and newest first", async () => {
  assert.ok(existsSync(fileURLToPath(moduleUrl)), "market symbol logic module should exist");
  const { nextRecentSymbols } = await import(moduleUrl.href);

  assert.deepEqual(nextRecentSymbols(["ETHUSDT", "BTCUSDT", "SOLUSDT"], "BTCUSDT", 3), [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
  ]);
});
