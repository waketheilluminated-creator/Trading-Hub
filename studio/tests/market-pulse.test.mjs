import assert from "node:assert/strict";
import test from "node:test";
import { computeCvdBook, unavailableBook } from "../lib/market-cvd.ts";
import { loadDerivativesPulse, loadOrderFlowCvd, sanitizeCvdSnapshot } from "../lib/market-pulse.ts";
import { formatVenueFallbackNotice } from "../lib/market-venues.ts";

const LEGAL_WALL = "Binance is blocked in this region (Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.).";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function okxCvd() {
  const perp = computeCvdBook([{ time: 1_700_000_000_000, price: 1, size: 4, side: "buy" }], "15", "perp");
  const spot = computeCvdBook([{ time: 1_700_000_000_000, price: 1, size: 1, side: "sell" }], "15", "spot");
  return {
    venue: "okx",
    symbol: "BTCUSDT",
    interval: "15",
    source: "official",
    perp,
    spot,
    comparison: { available: true, perpAggression: "buy", spotAggression: "sell", dominantBook: "perp", perpMinusSpotDelta: 3, interpretation: "Perp buying leads spot selling." },
    notice: null,
    updatedAt: 1,
  };
}

test("loadDerivativesPulse skips a geo-blocked venue and uses OKX numbers", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("exchange=binance")) {
      return jsonResponse({ error: LEGAL_WALL, blocked: true, exchange: "binance" }, 403);
    }
    if (url.includes("exchange=okx")) {
      return jsonResponse({
        exchange: "okx",
        symbol: "BTC/USDT:USDT",
        openInterestAmount: 12,
        openInterestValue: 1_200_000,
        fundingRate: 0.0001,
        markPrice: 100,
        indexPrice: 99.9,
        nextFundingTimestamp: null,
        updatedAt: 1,
      });
    }
    return new Response("no", { status: 502 });
  };

  const result = await loadDerivativesPulse("binance", "BTCUSDT", fetchImpl);
  assert.equal(result.venue, "okx");
  assert.equal(result.fallbackFrom, "binance");
  assert.equal(result.snapshot.openInterestValue, 1_200_000);
  assert.equal(result.notice, formatVenueFallbackNotice("binance", "okx", true));
  assert.doesNotMatch(result.notice ?? "", /eligibility|https?:\/\//i);
  assert.ok(calls.some((url) => url.includes("exchange=binance")));
  assert.ok(calls.some((url) => url.includes("exchange=okx")));
});

test("loadOrderFlowCvd falls back when Binance perp is blocked but spot still works", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("exchange=binance")) {
      const spot = computeCvdBook([{ time: 1_700_000_000_000, price: 1, size: 2, side: "sell" }], "15", "spot");
      return jsonResponse({
        venue: "binance",
        symbol: "BTCUSDT",
        interval: "15",
        source: "public-mirror",
        perp: unavailableBook("perp", LEGAL_WALL),
        spot,
        comparison: {
          available: false,
          perpAggression: "unknown",
          spotAggression: "sell",
          dominantBook: "spot",
          perpMinusSpotDelta: null,
          interpretation: `Spot selling. Perp CVD unavailable. ${LEGAL_WALL}`,
        },
        notice: `Perp trades unavailable: ${LEGAL_WALL} Binance spot CVD is from the public data mirror.`,
        updatedAt: 1,
      });
    }
    if (url.includes("exchange=okx")) {
      return jsonResponse(okxCvd());
    }
    return new Response("no", { status: 502 });
  };

  const result = await loadOrderFlowCvd("binance", "BTCUSDT", "15", fetchImpl);
  assert.equal(result.venue, "okx");
  assert.equal(result.snapshot.perp.available, true);
  assert.equal(result.snapshot.perp.cvd, 4);
  assert.equal(result.notice, formatVenueFallbackNotice("binance", "okx", true));
  assert.doesNotMatch(JSON.stringify(result), /eligibility|binance\.com\/en\/terms/i);
  assert.ok(calls.some((url) => url.includes("exchange=binance")));
  assert.ok(calls.some((url) => url.includes("exchange=okx")));
});

test("sanitizeCvdSnapshot never leaves a legal wall in card copy", () => {
  const snapshot = sanitizeCvdSnapshot({
    venue: "binance",
    symbol: "BTCUSDT",
    interval: "15",
    source: "public-mirror",
    perp: unavailableBook("perp", LEGAL_WALL),
    spot: unavailableBook("spot", "No spot trades"),
    comparison: {
      available: false,
      perpAggression: "unknown",
      spotAggression: "unknown",
      dominantBook: "unknown",
      perpMinusSpotDelta: null,
      interpretation: LEGAL_WALL,
    },
    notice: LEGAL_WALL,
    updatedAt: 1,
  });
  assert.equal(snapshot.perp.reason, "Binance blocked here — try OKX.");
  assert.equal(snapshot.notice, "Binance blocked here — try OKX.");
  assert.equal(snapshot.comparison.interpretation, "Binance blocked here — try OKX.");
  assert.doesNotMatch(JSON.stringify(snapshot), /eligibility|https?:\/\/www\.binance\.com/i);
});
