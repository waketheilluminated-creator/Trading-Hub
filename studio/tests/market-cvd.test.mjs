import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANALYST_DATA_PACK_KIND,
  ANALYST_SYSTEM_PROMPT,
  assembleAnalystDataPack,
  buildOrderFlowContext,
  formatAnalystUserMessage,
  parseAnalystMarketRef,
} from "../lib/ai-context.ts";
import {
  computeCvdBook,
  fetchVenueCvd,
  interpretForce,
  parseVenueTrades,
  tradeRequestUrl,
  unavailableBook,
} from "../lib/market-cvd.ts";
import { intervalDurationMs, toOkxSpotInstId } from "../lib/market-venues.ts";

test("maps compact symbols onto OKX spot instruments", () => {
  assert.equal(toOkxSpotInstId("BTCUSDT"), "BTC-USDT");
  assert.equal(intervalDurationMs("15"), 900_000);
});

test("builds public trade URLs for perp and spot on each venue", () => {
  assert.equal(
    tradeRequestUrl("okx", "BTCUSDT", "perp"),
    "https://www.okx.com/api/v5/market/trades?instId=BTC-USDT-SWAP&limit=500",
  );
  assert.equal(
    tradeRequestUrl("okx", "BTCUSDT", "spot"),
    "https://www.okx.com/api/v5/market/trades?instId=BTC-USDT&limit=500",
  );
  assert.match(tradeRequestUrl("bybit", "ETHUSDT", "perp"), /category=linear&symbol=ETHUSDT/);
  assert.match(tradeRequestUrl("bybit", "ETHUSDT", "spot"), /category=spot&symbol=ETHUSDT/);
  assert.match(tradeRequestUrl("binance", "BTCUSDT", "perp"), /fapi\.binance\.com\/fapi\/v1\/aggTrades/);
  assert.match(tradeRequestUrl("binance", "BTCUSDT", "spot", "public-mirror"), /data-api\.binance\.vision\/api\/v3\/aggTrades/);
  assert.match(tradeRequestUrl("bitget", "BTCUSDT", "perp"), /mix\/market\/fills-history/);
  assert.match(tradeRequestUrl("bitget", "BTCUSDT", "spot"), /spot\/market\/fills/);
});

test("parses taker side from Bybit, OKX, Bitget, and Binance trades", () => {
  assert.deepEqual(parseVenueTrades("bybit", {
    result: { list: [
      { time: "1700000900000", price: "2", size: "3", side: "Sell" },
      { time: "1700000000000", price: "1", size: "4", side: "Buy" },
    ] },
  }), [
    { time: 1700000000000, price: 1, size: 4, side: "buy" },
    { time: 1700000900000, price: 2, size: 3, side: "sell" },
  ]);
  assert.deepEqual(parseVenueTrades("okx", {
    data: [{ ts: "1700000000000", px: "1.5", sz: "2", side: "buy" }],
  }), [
    { time: 1700000000000, price: 1.5, size: 2, side: "buy" },
  ]);
  assert.deepEqual(parseVenueTrades("bitget", {
    data: [{ ts: "1700000000000", price: "1.5", size: "2", side: "sell" }],
  }), [
    { time: 1700000000000, price: 1.5, size: 2, side: "sell" },
  ]);
  assert.deepEqual(parseVenueTrades("binance", [
    { T: 1700000000000, p: "1", q: "2", m: false },
    { T: 1700000001000, p: "1", q: "1", m: true },
  ]), [
    { time: 1700000000000, price: 1, size: 2, side: "buy" },
    { time: 1700000001000, price: 1, size: 1, side: "sell" },
  ]);
});

test("computes bar-aligned CVD and does not invent a book from empty trades", () => {
  const book = computeCvdBook([
    { time: 1_700_000_000_000, price: 1, size: 2, side: "buy" },
    { time: 1_700_000_010_000, price: 1, size: 0.5, side: "sell" },
    { time: 1_700_000_900_000, price: 1, size: 1, side: "buy" },
  ], "15", "perp");
  assert.equal(book.available, true);
  assert.equal(book.buyVolume, 3);
  assert.equal(book.sellVolume, 0.5);
  assert.equal(book.delta, 2.5);
  assert.equal(book.cvd, 2.5);
  assert.equal(book.bars.length, 2);
  assert.equal(book.bars[0].delta, 1.5);
  assert.equal(book.bars[1].cvd, 2.5);
  assert.ok(book.spark.length >= book.bars.length);
  assert.equal(book.spark.at(-1)?.cvd, book.cvd);

  const empty = computeCvdBook([], "15", "spot");
  assert.equal(empty.available, false);
  assert.equal(empty.cvd, 0);
  assert.match(empty.reason ?? "", /No public trades/);
});

test("applies an OKX contract multiplier so perp CVD stays in base size", () => {
  const book = computeCvdBook([
    { time: 1_700_000_000_000, price: 100, size: 10, side: "buy" },
  ], "15", "perp", 0.01);
  assert.equal(book.cvd, 0.1);
  assert.equal(book.unit, "base");
});

test("interprets futures-versus-spot force and degrades when a book is missing", () => {
  const perpBuy = computeCvdBook([
    { time: 1, price: 1, size: 10, side: "buy" },
    { time: 2, price: 1, size: 1, side: "sell" },
  ], "15", "perp");
  const spotSell = computeCvdBook([
    { time: 1, price: 1, size: 1, side: "buy" },
    { time: 2, price: 1, size: 8, side: "sell" },
  ], "15", "spot");
  const both = interpretForce(perpBuy, spotSell);
  assert.equal(both.available, true);
  assert.equal(both.dominantBook, "perp");
  assert.equal(both.perpAggression, "buy");
  assert.equal(both.spotAggression, "sell");
  assert.ok(both.perpMinusSpotDelta != null && both.perpMinusSpotDelta > 0);
  assert.match(both.interpretation, /Perpetual takers are buying/i);

  const spotOnly = interpretForce(unavailableBook("perp", "blocked"), spotSell);
  assert.equal(spotOnly.available, false);
  assert.equal(spotOnly.dominantBook, "spot");
  assert.match(spotOnly.interpretation, /Perpetual CVD is unavailable/i);

  const none = interpretForce(unavailableBook("perp", "none"), unavailableBook("spot", "none"));
  assert.equal(none.available, false);
  assert.match(none.interpretation, /cannot be attributed/);
});

test("uses Binance spot public-mirror trades when official hosts fail", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("fapi.binance.com") || url.includes("api.binance.com")) {
      return new Response(JSON.stringify({ msg: "Service unavailable from a restricted location" }), { status: 451 });
    }
    return new Response(JSON.stringify([{ T: 1700000000000, p: "1", q: "3", m: false }]), { status: 200 });
  };
  const snapshot = await fetchVenueCvd("binance", "BTCUSDT", "15", fetchImpl);
  assert.equal(snapshot.perp.available, false);
  assert.equal(snapshot.spot.available, true);
  assert.equal(snapshot.spot.cvd, 3);
  assert.equal(snapshot.source, "public-mirror");
  assert.equal(snapshot.comparison.available, false);
  assert.match(snapshot.notice ?? "", /Perp trades unavailable/i);
  assert.ok(calls.some((url) => url.includes("data-api.binance.vision")));
});

test("does not invent CVD when both Binance trade hosts fail", async () => {
  const fetchImpl = async () => new Response("blocked", { status: 403 });
  await assert.rejects(
    () => fetchVenueCvd("binance", "BTCUSDT", "15", fetchImpl),
    (error) => {
      assert.equal(error.blocked, true);
      assert.equal(error.venue, "binance");
      assert.match(error.message, /blocked/i);
      return true;
    },
  );
});

test("AI prompt requires backend CVD/OI/K-line packs and forbids screenshots", () => {
  assert.match(ANALYST_SYSTEM_PROMPT, /backend market data packs/);
  assert.match(ANALYST_SYSTEM_PROMPT, /klines \(OHLCV series JSON\)/);
  assert.match(ANALYST_SYSTEM_PROMPT, /openInterest/);
  assert.match(ANALYST_SYSTEM_PROMPT, /cvd \(perp\/spot series JSON\)/);
  assert.match(ANALYST_SYSTEM_PROMPT, /do not receive screenshots, scroll-captures/);
  assert.match(ANALYST_SYSTEM_PROMPT, /Futures-vs-spot force/);
  assert.match(ANALYST_SYSTEM_PROMPT, /entry versus exit/);
  assert.match(ANALYST_SYSTEM_PROMPT, /never invent CVD/i);
});

test("assembleAnalystDataPack attaches backend series JSON, not client chart pixels", async () => {
  const perp = computeCvdBook([{ time: 1_700_000_000_000, price: 1, size: 4, side: "buy" }], "15", "perp");
  const spot = computeCvdBook([{ time: 1_700_000_000_000, price: 1, size: 1, side: "sell" }], "15", "spot");
  const pack = await assembleAnalystDataPack(
    { symbol: "BTCUSDT", venue: "okx", interval: "15", derivativesVenue: "okx" },
    { ema9Visible: true, customPine: { source: "ema", plots: [] } },
    {
      fetchKlines: async () => ({
        venue: "okx",
        symbol: "BTCUSDT",
        interval: "15",
        source: "official",
        candles: [
          { time: 1_700_000_000, open: 1, high: 2, low: 1, close: 2, volume: 3 },
          { time: 1_700_000_900, open: 2, high: 3, low: 2, close: 2.5, volume: 4 },
        ],
      }),
      fetchCvd: async () => ({
        venue: "okx",
        symbol: "BTCUSDT",
        interval: "15",
        source: "official",
        perp,
        spot,
        comparison: interpretForce(perp, spot),
        notice: null,
        updatedAt: 1,
      }),
      fetchDerivatives: async () => ({
        exchange: "okx",
        symbol: "BTC/USDT:USDT",
        openInterestAmount: 2,
        openInterestValue: 100,
        fundingRate: 0.0001,
        fundingInterval: "8h",
        nextFundingTimestamp: null,
        markPrice: 1,
        indexPrice: 1,
        updatedAt: 1,
      }),
    },
  );

  assert.equal(pack.kind, ANALYST_DATA_PACK_KIND);
  assert.equal(pack.input, "backend-api");
  assert.deepEqual(pack.media, { screenshots: false, scrollCapture: false, chartImages: false });
  assert.equal(pack.packs.klines.pack, "klines");
  assert.equal(pack.packs.klines.series.length, 2);
  assert.equal(pack.packs.klines.series[1].c, 2.5);
  assert.equal(pack.packs.klines.derived.last, 2.5);
  assert.equal(pack.packs.openInterest.pack, "openInterest");
  assert.equal(pack.packs.openInterest.openInterestUsd, 100);
  assert.equal(pack.packs.cvd.pack, "cvd");
  assert.equal(pack.packs.cvd.perp.available, true);
  assert.equal(pack.packs.cvd.perp.series.at(-1)?.cvd, 4);
  assert.match(pack.packs.cvd.comparison.interpretation, /buying/i);
  const message = formatAnalystUserMessage("Force?", pack);
  assert.match(message, /BACKEND MARKET DATA PACKS/);
  assert.match(message, /not a screenshot/);
  assert.match(message, /"pack":"klines"/);
  assert.match(message, /"pack":"cvd"/);
  assert.equal(buildOrderFlowContext(null).available, false);
  assert.deepEqual(parseAnalystMarketRef({ symbol: "btc/usdt:usdt", venue: "bitget", interval: "5" }), {
    symbol: "BTCUSDT",
    venue: "bitget",
    interval: "5",
    derivativesVenue: "bitget",
  });
});

test("workspace asks analyze to attach backend packs instead of posting client candles", () => {
  const workspace = readFileSync(fileURLToPath(new URL("../app/trading-workspace.tsx", import.meta.url)), "utf8");
  const analyze = readFileSync(fileURLToPath(new URL("../app/api/ai/analyze/route.ts", import.meta.url)), "utf8");
  const analyzeCall = workspace.slice(workspace.indexOf("const analyzeMarket"), workspace.indexOf("const response = await fetch(\"/api/ai/analyze\"") + 800);
  assert.doesNotMatch(analyzeCall, /buildAnalystContext|candles\.slice|orderFlow: cvd|screenshot|scroll-capture/i);
  assert.match(analyzeCall, /market: \{ symbol, venue: activeVenue, interval, derivativesVenue: derivativesExchange \}/);
  assert.match(workspace, /\/api\/cvd/);
  assert.match(workspace, /Futures vs spot/);
  assert.match(workspace, /Order flow/);
  assert.match(workspace, /cvd_perp/);
  assert.match(workspace, /Backend data packs are ready/);
  assert.match(analyze, /assembleAnalystDataPack/);
  assert.match(analyze, /void body\.context/);
  assert.match(analyze, /ANALYST_SYSTEM_PROMPT/);
});
