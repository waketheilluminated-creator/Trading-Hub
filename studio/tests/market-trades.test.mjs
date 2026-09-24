import assert from "node:assert/strict";
import test from "node:test";
import { readStoredFlag, writeStoredFlag } from "../lib/chart-indicator-panes.ts";
import { formatVenueFallbackNotice, supportedExchangesMessage } from "../lib/market-venues.ts";
import {
  fetchVenueLargeTrades,
  formatTradeClock,
  LARGE_TRADES_STORAGE_KEY,
  loadLargeTrades,
  MAX_LARGE_TRADES,
  parseTradesQuery,
  planTradeMarkers,
  sanitizeLargeTrades,
  selectLargeTrades,
  tradeListEntries,
  tradeMarkerColor,
} from "../lib/market-trades.ts";

const LEGAL_WALL = "Binance is blocked in this region (Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.).";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    store,
  };
}

test("rejects forged venue, symbol, and privilege flags without trusting a client trade dump", () => {
  const badVenue = parseTradesQuery(new URL("http://localhost/api/trades?exchange=unknown&symbol=BTCUSDT"), supportedExchangesMessage());
  assert.deepEqual(badVenue, { ok: false, error: "Supported exchanges: bybit, binance, okx, bitget" });

  const badSymbol = parseTradesQuery(new URL("http://localhost/api/trades?exchange=okx&symbol=../etc/passwd"), supportedExchangesMessage());
  assert.deepEqual(badSymbol, { ok: false, error: "Use a compact perpetual symbol such as BTCUSDT" });

  const forged = parseTradesQuery(new URL("http://localhost/api/trades?exchange=okx&symbol=BTCUSDT&minNotional=-1&privileged=1&skipMin=1&limit=999999&trades=%5B%7B%22price%22%3A1%7D%5D"), supportedExchangesMessage());
  assert.equal(forged.ok, true);
  if (forged.ok) {
    assert.equal(forged.venue, "okx");
    assert.equal(forged.symbol, "BTCUSDT");
    assert.equal(forged.minNotional, 10_000);
    assert.equal("privileged" in forged, false);
    assert.equal("trades" in forged, false);
    assert.equal("limit" in forged, false);
    assert.equal("skipMin" in forged, false);
  }
});

test("keeps only prints at or above the clamped minimum and scales OKX contracts", () => {
  const trades = selectLargeTrades([
    { time: 1_700_000_000_000, price: 80_000, size: 2, side: "buy" },
    { time: 1_700_000_001_000, price: 80_000, size: 0.05, side: "sell" },
    { time: 1_700_000_001_000, price: 80_000, size: 0.05, side: "sell" },
  ], 1, 100_000);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].notional, 160_000);
  assert.equal(trades[0].side, "buy");

  const scaled = selectLargeTrades([
    { time: 1_700_000_000_000, price: 80_000, size: 200, side: "buy" },
    { time: 1_700_000_002_000, price: 80_000, size: 50, side: "sell" },
  ], 0.01, 100_000);
  assert.equal(scaled.length, 1);
  assert.equal(scaled[0].size, 2);
  assert.equal(scaled[0].notional, 160_000);

  const many = Array.from({ length: MAX_LARGE_TRADES + 15 }, (_, index) => ({
    time: 1_700_000_000_000 + index * 1000,
    price: 80_000,
    size: 2,
    side: index % 2 === 0 ? "buy" : "sell",
  }));
  const capped = selectLargeTrades(many, 1, 100_000);
  assert.equal(capped.length, MAX_LARGE_TRADES);
  assert.equal(capped[0].time, 1_700_000_000_000 + (MAX_LARGE_TRADES + 14) * 1000);
});

test("drops inconsistent, tiny, and unlabeled trades from a proxied payload", () => {
  const cleaned = sanitizeLargeTrades([
    { time: 1_700_000_000_000, price: 80_000, size: 2, notional: 160_000, side: "buy", privileged: true },
    { time: 1_700_000_001_000, price: 80_000, size: 2, notional: 9_000_000, side: "sell" },
    { time: 1_700_000_002_000, price: 80_000, size: 0.01, notional: 800, side: "buy" },
    { time: 1_700_000_003_000, price: 80_000, size: 3, notional: 240_000, side: "unknown" },
    { time: 1_700_000_004_000, price: 81_000, size: 2, notional: 162_000, side: "admin" },
    "not-a-trade",
  ], 100_000);
  assert.deepEqual(cleaned.map((trade) => trade.time), [1_700_000_000_000]);
  assert.equal(cleaned[0].notional, 160_000);
});

test("places buy and sell markers on the containing candle", () => {
  const markers = planTradeMarkers([
    { time: 1_700_000_100_000, price: 80_100, size: 2, notional: 160_200, side: "sell" },
    { time: 1_700_000_000_000, price: 80_000, size: 4, notional: 320_000, side: "buy" },
  ], "15");
  assert.equal(markers.length, 2);
  assert.ok(markers.every((marker) => marker.time % 900 === 0));
  assert.equal(markers[1].color, tradeMarkerColor("buy"));
  assert.match(markers[1].color, /83, 201, 144/);
  assert.match(markers[0].color, /231, 103, 112/);
  assert.ok(markers[1].radius >= markers[0].radius);
  assert.equal(formatTradeClock(1_700_000_000_000), "22:13:20 UTC");
  const rows = tradeListEntries([
    { time: 1_700_000_000_000, price: 80_000, size: 2, notional: 160_000, side: "buy" },
    { time: 1_700_000_090_000, price: 80_200, size: 3, notional: 240_600, side: "sell" },
  ]);
  assert.equal(rows[0].side, "sell");
  assert.equal(rows[0].clockLabel, formatTradeClock(1_700_000_090_000));
  assert.equal(rows[0].barPct, 100);
  assert.ok(rows[1].barPct < rows[0].barPct);
});

test("does not invent large prints when the venue book is empty", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    return jsonResponse({ retCode: 0, result: { list: [] } });
  };
  const snapshot = await fetchVenueLargeTrades("bybit", "BTCUSDT", 100_000, fetchImpl);
  assert.deepEqual(snapshot.trades, []);
  assert.equal(snapshot.source, "official");
  assert.match(calls[0], /api\.bybit\.com\/v5\/market\/recent-trade\?category=linear&symbol=BTCUSDT&limit=1000/);
  assert.doesNotMatch(calls[0], /limit=999999|privileged|trades=/);
});

test("scales OKX swap prints by contract size and skips prints under the minimum", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/public/instruments")) return jsonResponse({ code: "0", data: [{ ctVal: "0.01" }] });
    return jsonResponse({
      code: "0",
      data: [
        { ts: "1700000000000", px: "80000", sz: "200", side: "buy" },
        { ts: "1700000002000", px: "80000", sz: "50", side: "sell" },
      ],
    });
  };
  const snapshot = await fetchVenueLargeTrades("okx", "BTCUSDT", 100_000, fetchImpl);
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.trades[0].notional, 160_000);
  assert.equal(snapshot.trades[0].side, "buy");
  assert.ok(calls.some((url) => url.includes("BTC-USDT-SWAP")));
  assert.ok(calls.some((url) => url.includes("/public/instruments")));
});

test("falls back from Bitget fills history to recent fills", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("fills-history")) return new Response("no", { status: 502 });
    return jsonResponse({
      code: "00000",
      data: [{ ts: "1700000000000", price: "80000", size: "3", side: "sell" }],
    });
  };
  const snapshot = await fetchVenueLargeTrades("bitget", "BTCUSDT", 100_000, fetchImpl);
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.trades[0].side, "sell");
  assert.equal(snapshot.trades[0].notional, 240_000);
  assert.ok(calls.some((url) => url.includes("fills-history")));
  assert.ok(calls.some((url) => url.includes("/mix/market/fills?")));
});

test("classifies a geo-blocked trade host without leaking legal-wall text", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ msg: LEGAL_WALL }), { status: 451 });
  await assert.rejects(
    () => fetchVenueLargeTrades("binance", "BTCUSDT", 100_000, fetchImpl),
    (error) => {
      assert.equal(error.blocked, true);
      assert.match(error.message, /blocked here/i);
      assert.doesNotMatch(error.message, /eligibility|https?:\/\//i);
      return true;
    },
  );
});

test("loadLargeTrades skips blocked Bybit and ignores trades stuffed into the error", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("exchange=bybit")) {
      return jsonResponse({
        error: "Bybit blocked here — try OKX.",
        blocked: true,
        privileged: true,
        trades: [{ time: 1, price: 80_000, size: 10, notional: 800_000, side: "buy" }],
      }, 403);
    }
    if (url.includes("exchange=okx")) {
      return jsonResponse({
        venue: "okx",
        symbol: "BTCUSDT",
        source: "official",
        minNotional: 1,
        trades: [
          { time: 1_700_000_000_000, price: 80_000, size: 2, notional: 160_000, side: "buy" },
          { time: 1_700_000_001_000, price: 80_000, size: 1, notional: 9_999_999, side: "sell" },
        ],
        notice: null,
        updatedAt: 1,
      });
    }
    return jsonResponse({ error: "no", trades: [{ time: 1, price: 1, size: 1, notional: 1, side: "buy" }] }, 502);
  };

  const result = await loadLargeTrades("bybit", "BTCUSDT", fetchImpl, { minNotional: 100_000 });
  assert.equal(result.venue, "okx");
  assert.equal(result.fallbackFrom, "bybit");
  assert.equal(result.notice, formatVenueFallbackNotice("bybit", "okx", true));
  assert.doesNotMatch(result.notice ?? "", /eligibility|https?:\/\//i);
  assert.equal(result.snapshot.trades.length, 1);
  assert.equal(result.snapshot.trades[0].notional, 160_000);
  assert.equal(result.snapshot.minNotional, 100_000);
  assert.ok(calls.every((url) => url.startsWith("/api/trades?") && !url.includes("privileged") && !url.includes("trades=")));
  assert.ok(calls.some((url) => url.includes("minNotional=100000")));
});

test("loadLargeTrades clamps an insane minimum and does not call with the raw value", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    return jsonResponse({
      venue: "okx",
      symbol: "BTCUSDT",
      source: "mirror",
      minNotional: 1,
      trades: [{ time: 1_700_000_000_000, price: 80_000, size: 2, notional: 160_000, side: "buy" }],
      notice: LEGAL_WALL,
      updatedAt: 1,
    });
  };
  const result = await loadLargeTrades("okx", "BTCUSDT", fetchImpl, { minNotional: -5, retryPreferred: false });
  assert.ok(calls.some((url) => url.includes("minNotional=10000")));
  assert.ok(calls.every((url) => !url.includes("minNotional=-5")));
  assert.equal(result.snapshot.source, "official");
  assert.match(result.snapshot.notice, /blocked here/i);
  assert.doesNotMatch(result.snapshot.notice, /eligibility|https?:\/\//i);
});

test("persists the executed-trades toggle independently of unfilled walls", () => {
  const storage = memoryStorage({ "th-large-order-sr": "1" });
  assert.equal(readStoredFlag(storage, LARGE_TRADES_STORAGE_KEY, false), false);
  writeStoredFlag(storage, LARGE_TRADES_STORAGE_KEY, true);
  assert.equal(readStoredFlag(storage, LARGE_TRADES_STORAGE_KEY), true);
  assert.equal(readStoredFlag(storage, "th-large-order-sr"), true);
});
