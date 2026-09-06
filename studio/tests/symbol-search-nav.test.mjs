import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("../lib/symbol-search-nav.ts", import.meta.url);

const markets = [
  { venue: "binance", symbol: "BTCUSDT", base: "BTC", quote: "USDT", kind: "perpetual" },
  { venue: "okx", symbol: "BTCUSDT", base: "BTC", quote: "USDT", kind: "perpetual" },
  { venue: "bybit", symbol: "SOLUSDT", base: "SOL", quote: "USDT", kind: "perpetual" },
  { venue: "bitget", symbol: "ETHUSDT", base: "ETH", quote: "USDT", kind: "perpetual" },
];

test("Crypto keeps live venues while other asset types stay empty", async () => {
  const { CRYPTO_SOURCES, filterWorkspaceSymbols, sourcesForAssetType, symbolSearchEmptyCopy } = await import(moduleUrl.href);
  assert.deepEqual(CRYPTO_SOURCES.map((source) => source.id).sort(), ["binance", "bitget", "bybit", "okx"]);
  assert.deepEqual(sourcesForAssetType("crypto").map((source) => source.label), ["Binance", "Bitget", "Bybit", "OKX"]);
  assert.deepEqual(sourcesForAssetType("stocks"), []);
  assert.equal(filterWorkspaceSymbols(markets, { type: "crypto" }).length, 4);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "stocks" }), []);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "funds" }), []);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "currency" }), []);
  assert.match(symbolSearchEmptyCopy({ type: "stocks" }).title, /Stocks markets are coming soon/);
});

test("selecting a source filters symbols to that venue only", async () => {
  const { filterWorkspaceSymbols, resolveSourceFilter } = await import(moduleUrl.href);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "crypto", source: "binance" }).map((item) => item.venue), ["binance"]);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "crypto", source: "okx", query: "btc" }).map((item) => item.venue), ["okx"]);
  assert.equal(resolveSourceFilter("crypto", "bybit"), "bybit");
  assert.equal(resolveSourceFilter("stocks", "binance"), "all");
});

test("Sources sheet search matches exchange names without inventing venues", async () => {
  const { filterSources, groupSourcesByCategory, sourcesEmptyCopy, sourcesForAssetType } = await import(moduleUrl.href);
  const crypto = sourcesForAssetType("crypto");
  assert.deepEqual(filterSources(crypto, "byb").map((source) => source.id), ["bybit"]);
  assert.deepEqual(filterSources(crypto, "OKX").map((source) => source.label), ["OKX"]);
  assert.deepEqual(groupSourcesByCategory(crypto).map((group) => group.category), ["CRYPTOCURRENCY"]);
  assert.match(sourcesEmptyCopy("funds").title, /No funds sources yet/);
});

test("Sources sheet UI lists live crypto venues and no invented stock tickers", () => {
  const dialog = readFileSync(fileURLToPath(new URL("../components/symbol-search-dialog.tsx", import.meta.url)), "utf8");
  assert.match(dialog, /CRYPTOCURRENCY|sources-category/);
  assert.match(dialog, /Binance, Bybit, OKX, and Bitget/);
  assert.match(dialog, /coming soon/i);
  assert.doesNotMatch(dialog, /AAPL|NASDAQ|NYSE|SPY/);
});

test("spot and DEX filters stay empty instead of faking catalogs", async () => {
  const { filterWorkspaceSymbols, symbolSearchEmptyCopy } = await import(moduleUrl.href);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "crypto", kind: "spot" }), []);
  assert.deepEqual(filterWorkspaceSymbols(markets, { type: "crypto", exchangeType: "dex" }), []);
  assert.match(symbolSearchEmptyCopy({ type: "crypto", kind: "spot" }).title, /Spot markets are coming soon/);
  assert.match(symbolSearchEmptyCopy({ type: "crypto", exchangeType: "dex" }).title, /Decentralized venues are coming soon/);
});
