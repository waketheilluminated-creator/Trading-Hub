import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyMarketFailure, compactSymbol, formatVenueFallbackNotice, sanitizeMarketCopy, toOkxSpotInstId, toOkxSwapInstId, toUnifiedSwapSymbol, venueFallbackOrder } from "../lib/market-venues.ts";
import { fetchVenueKlines, parseVenueKlines, parseVenueMarkets } from "../lib/market-rest.ts";
import { loadChartHistory, mergeLiveCandle, parseLiveKline } from "../lib/market-feed.ts";

test("falls back from Bybit to OKX before Bitget and Binance", () => {
  assert.deepEqual(venueFallbackOrder("bybit"), ["bybit", "okx", "bitget", "binance"]);
  assert.deepEqual(venueFallbackOrder("okx"), ["okx", "bitget", "binance", "bybit"]);
});

test("classifies CloudFront and Binance geo blocks", () => {
  const bybit = classifyMarketFailure("bybit", 403, "{ error: The Amazon CloudFront distribution is configured to block access from your country }");
  assert.equal(bybit.blocked, true);
  assert.equal(bybit.message, "Bybit blocked here — try OKX");

  const binance = classifyMarketFailure("binance", 451, JSON.stringify({
    msg: "Service unavailable from a restricted location according to 'b. Eligibility'",
  }));
  assert.equal(binance.blocked, true);
  assert.equal(binance.message, "Binance blocked here — try OKX");
  assert.doesNotMatch(binance.message, /eligibility|https?:\/\//i);

  const wall = classifyMarketFailure("binance", 451, "Binance is blocked in this region (Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.).");
  assert.equal(wall.message, "Binance blocked here — try OKX");
  assert.doesNotMatch(wall.message, /eligibility|customer service|https?:\/\//i);
});

test("strips exchange legal walls before UI copy", () => {
  const legal = "Binance is blocked in this region (Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.).";
  assert.equal(sanitizeMarketCopy(legal), "Binance blocked here — try OKX");
  assert.doesNotMatch(sanitizeMarketCopy(legal), /eligibility|https?:\/\//i);
  assert.equal(sanitizeMarketCopy("Bybit blocked here — using OKX."), "Bybit blocked here — using OKX.");
});

test("maps compact symbols onto OKX swap instruments", () => {
  assert.equal(toOkxSwapInstId("BTCUSDT"), "BTC-USDT-SWAP");
  assert.equal(toOkxSpotInstId("BTCUSDT"), "BTC-USDT");
  assert.equal(toUnifiedSwapSymbol("BTCUSDT"), "BTC/USDT:USDT");
  assert.equal(compactSymbol("BTC/USDT:USDT"), "BTCUSDT");
  assert.equal(compactSymbol("BTC-USDT-SWAP"), "BTCUSDT");
});

test("normalizes REST klines from Bybit, Binance, and OKX", () => {
  assert.deepEqual(parseVenueKlines("bybit", {
    result: { list: [["1700000900000", "2", "4", "1", "3", "10"], ["1700000000000", "1", "2", "1", "2", "8"]] },
  }), [
    { time: 1700000000, open: 1, high: 2, low: 1, close: 2, volume: 8 },
    { time: 1700000900, open: 2, high: 4, low: 1, close: 3, volume: 10 },
  ]);
  assert.deepEqual(parseVenueKlines("binance", [
    [1700000000000, "1", "2", "1", "2", "8"],
  ]), [
    { time: 1700000000, open: 1, high: 2, low: 1, close: 2, volume: 8 },
  ]);
  assert.deepEqual(parseVenueKlines("okx", {
    data: [["1700000900000", "2", "4", "1", "3", "10"]],
  }), [
    { time: 1700000900, open: 2, high: 4, low: 1, close: 3, volume: 10 },
  ]);
  assert.deepEqual(parseVenueKlines("bitget", {
    data: [["1700000900000", "2", "4", "1", "3", "10"]],
  }), [
    { time: 1700000900, open: 2, high: 4, low: 1, close: 3, volume: 10 },
  ]);
});

test("parses live websocket klines without mixing them into compiler state", () => {
  assert.deepEqual(parseLiveKline("bybit", { data: [{ start: 1700000000000, open: "1", high: "2", low: "1", close: "1.5", volume: "9" }] }), {
    time: 1700000000, open: 1, high: 2, low: 1, close: 1.5, volume: 9,
  });
  assert.deepEqual(parseLiveKline("binance", { k: { t: 1700000000000, o: "1", h: "2", l: "1", c: "1.5", v: "9" } }), {
    time: 1700000000, open: 1, high: 2, low: 1, close: 1.5, volume: 9,
  });
  assert.deepEqual(parseLiveKline("okx", { data: [["1700000000000", "1", "2", "1", "1.5", "9"]] }), {
    time: 1700000000, open: 1, high: 2, low: 1, close: 1.5, volume: 9,
  });
  assert.deepEqual(parseLiveKline("bitget", { data: [["1700000000000", "1", "2", "1", "1.5", "9"]] }), {
    time: 1700000000, open: 1, high: 2, low: 1, close: 1.5, volume: 9,
  });
});

test("updates the current bar and appends a new bar", () => {
  const first = { time: 10, open: 1, high: 2, low: 1, close: 2, volume: 1 };
  const update = { time: 10, open: 1, high: 3, low: 1, close: 2.5, volume: 2 };
  const next = { time: 20, open: 2.5, high: 3, low: 2, close: 2.8, volume: 1 };
  assert.deepEqual(mergeLiveCandle([first], update), [update]);
  assert.deepEqual(mergeLiveCandle([update], next), [update, next]);
});

test("uses Binance public-mirror klines when the official host is geo-blocked", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("fapi.binance.com")) {
      return new Response(JSON.stringify({ msg: "Service unavailable from a restricted location" }), { status: 451 });
    }
    return new Response(JSON.stringify([[1700000000000, "1", "2", "1", "1.5", "4"]]), { status: 200 });
  };
  const result = await fetchVenueKlines("binance", "BTCUSDT", "15", 2, fetchImpl);
  assert.equal(result.source, "public-mirror");
  assert.equal(result.candles[0].close, 1.5);
  assert.ok(calls.some((url) => url.includes("data-api.binance.vision")));
});

test("loadChartHistory skips a blocked preferred venue and uses the next working feed", async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("exchange=bybit")) {
      return new Response(JSON.stringify({ error: "Bybit is blocked in this region.", blocked: true }), { status: 403 });
    }
    if (url.includes("exchange=okx")) {
      return new Response(JSON.stringify({
        exchange: "okx",
        source: "official",
        candles: [{ time: 1700000000, open: 1, high: 2, low: 1, close: 1.5, volume: 3 }],
      }), { status: 200 });
    }
    return new Response("no", { status: 502 });
  };
  const result = await loadChartHistory("bybit", "BTCUSDT", "15", fetchImpl);
  assert.equal(result.venue, "okx");
  assert.equal(result.fallbackFrom, "bybit");
  assert.equal(result.notice, formatVenueFallbackNotice("bybit", "okx", true));
  assert.equal(result.candles.length, 1);
});

test("parses OKX swap catalogs into compact USDT symbols", () => {
  assert.deepEqual(parseVenueMarkets("okx", {
    data: [
      { state: "live", ctType: "linear", settleCcy: "USDT", ctValCcy: "BTC", instFamily: "BTC-USDT" },
      { state: "live", ctType: "inverse", settleCcy: "USD", ctValCcy: "ETH", instFamily: "ETH-USD" },
    ],
  }), [{ symbol: "BTCUSDT", base: "BTC", quote: "USDT" }]);
});

test("keeps market fetch errors out of the Pine compiler console", () => {
  const source = readFileSync(fileURLToPath(new URL("../app/trading-workspace.tsx", import.meta.url)), "utf8");
  const marketEffect = source.slice(source.indexOf("loadChartHistory(chartVenue"), source.indexOf("}, [symbol, interval, chartVenue]"));
  assert.doesNotMatch(marketEffect, /setConsoleText|setConsoleKind/);
  assert.match(source, /Compiler output/);
  assert.match(source, /market-feed-error/);
});

test("symbol search binds the selected venue to the chart feed", () => {
  const workspace = readFileSync(fileURLToPath(new URL("../app/trading-workspace.tsx", import.meta.url)), "utf8");
  const dialog = readFileSync(fileURLToPath(new URL("../components/symbol-search-dialog.tsx", import.meta.url)), "utf8");
  assert.match(workspace, /setChartVenue\(market\.venue\)/);
  assert.match(workspace, /loadAllMarketCatalogs/);
  assert.match(workspace, /chartDrawingMarket\(symbol, chartVenue\)/);
  assert.match(workspace, /SymbolSearchDialog/);
  assert.match(dialog, /Open sources/);
  assert.match(dialog, /All sources/);
  assert.match(dialog, /id="sources-sheet-title"/);
  assert.match(dialog, /Asset type/);
});
