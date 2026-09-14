import assert from "node:assert/strict";
import test from "node:test";
import { computeCvdBook, unavailableBook } from "../lib/market-cvd.ts";
import {
  CVD_PANE_EMPTY,
  CVD_PANE_STORAGE_KEY,
  INDICATOR_PANE_STRETCH,
  OI_PANE_EMPTY,
  OI_PANE_STORAGE_KEY,
  applyIndicatorPaneStretch,
  cvdPaneModel,
  indicatorPaneIndex,
  indicatorPaneStack,
  mergeLiveOiPoint,
  normalizeLinePoints,
  oiPaneModel,
  pointerInMainPane,
  readStoredFlag,
  shortPaneNotice,
  toBarTimeSeconds,
  writeStoredFlag,
} from "../lib/chart-indicator-panes.ts";

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    store,
  };
}

test("SSR pane defaults stay off until localStorage is applied after mount", () => {
  assert.equal(readStoredFlag(undefined, CVD_PANE_STORAGE_KEY, false), false);
  assert.equal(readStoredFlag(undefined, OI_PANE_STORAGE_KEY, false), false);
  const stored = memoryStorage({ [CVD_PANE_STORAGE_KEY]: "1", [OI_PANE_STORAGE_KEY]: "1" });
  assert.equal(readStoredFlag(stored, CVD_PANE_STORAGE_KEY, false), true);
  assert.equal(readStoredFlag(stored, OI_PANE_STORAGE_KEY, false), true);
});

test("persists CVD and OI pane toggles without throwing in private mode", () => {
  const storage = memoryStorage();
  assert.equal(readStoredFlag(storage, CVD_PANE_STORAGE_KEY, false), false);
  writeStoredFlag(storage, CVD_PANE_STORAGE_KEY, true);
  writeStoredFlag(storage, OI_PANE_STORAGE_KEY, true);
  assert.equal(readStoredFlag(storage, CVD_PANE_STORAGE_KEY), true);
  assert.equal(readStoredFlag(storage, OI_PANE_STORAGE_KEY), true);
  writeStoredFlag(storage, CVD_PANE_STORAGE_KEY, false);
  assert.equal(readStoredFlag(storage, CVD_PANE_STORAGE_KEY), false);
  writeStoredFlag({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  }, CVD_PANE_STORAGE_KEY, true);
  assert.equal(readStoredFlag(null, CVD_PANE_STORAGE_KEY, false), false);
});

test("stacks CVD above OI as TradingView-style extra panes under candles", () => {
  assert.deepEqual(indicatorPaneStack({ cvd: false, oi: false }), []);
  assert.deepEqual(indicatorPaneStack({ cvd: true, oi: false }), ["cvd"]);
  assert.deepEqual(indicatorPaneStack({ cvd: false, oi: true }), ["oi"]);
  assert.deepEqual(indicatorPaneStack({ cvd: true, oi: true }), ["cvd", "oi"]);
  assert.equal(indicatorPaneIndex("cvd", ["cvd", "oi"]), 1);
  assert.equal(indicatorPaneIndex("oi", ["cvd", "oi"]), 2);
  assert.equal(indicatorPaneIndex("oi", ["oi"]), 1);
  assert.equal(indicatorPaneIndex("cvd", ["oi"]), -1);
});

test("maps perp CVD bars onto a separate-pane series and falls back to spot", () => {
  const perp = computeCvdBook([
    { time: 1_700_000_000_000, price: 1, size: 2, side: "buy" },
    { time: 1_700_000_900_000, price: 1, size: 1, side: "sell" },
  ], "15", "perp");
  const spot = computeCvdBook([
    { time: 1_700_000_000_000, price: 1, size: 4, side: "sell" },
  ], "15", "spot");
  const model = cvdPaneModel({
    venue: "okx",
    symbol: "BTCUSDT",
    interval: "15",
    source: "official",
    perp,
    spot,
    comparison: { available: true, perpAggression: "buy", spotAggression: "sell", dominantBook: "perp", perpMinusSpotDelta: 1, interpretation: "ok" },
    notice: null,
    updatedAt: 1,
  });
  assert.equal(model.available, true);
  assert.equal(model.label, "CVD · Perp");
  assert.equal(model.points.length, 2);
  assert.equal(model.points[0].time, perp.bars[0].time);
  assert.equal(model.points.at(-1)?.value, perp.cvd);

  const spotOnly = cvdPaneModel({
    venue: "okx",
    symbol: "BTCUSDT",
    interval: "15",
    source: "official",
    perp: unavailableBook("perp", "Perp CVD unavailable."),
    spot,
    comparison: { available: false, perpAggression: "unknown", spotAggression: "sell", dominantBook: "spot", perpMinusSpotDelta: null, interpretation: "Spot selling." },
    notice: null,
    updatedAt: 1,
  });
  assert.equal(spotOnly.available, true);
  assert.equal(spotOnly.label, "CVD · Spot");
  assert.equal(spotOnly.points.at(-1)?.value, spot.cvd);
});

test("keeps CVD empty copy short and never overlays invented bars", () => {
  const empty = cvdPaneModel(null);
  assert.equal(empty.available, false);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.emptyNotice, CVD_PANE_EMPTY);
  const wall = cvdPaneModel({
    venue: "binance",
    symbol: "BTCUSDT",
    interval: "15",
    source: "official",
    perp: unavailableBook("perp", "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms."),
    spot: unavailableBook("spot", "blocked"),
    comparison: { available: false, perpAggression: "unknown", spotAggression: "unknown", dominantBook: "unknown", perpMinusSpotDelta: null, interpretation: "CVD unavailable." },
    notice: null,
    updatedAt: 1,
  });
  assert.equal(wall.available, false);
  assert.match(wall.emptyNotice, /blocked here/i);
  assert.doesNotMatch(wall.emptyNotice, /eligibility|https?:\/\//i);
});

test("plots OI in USD from history and merges the live pulse snapshot", () => {
  const model = oiPaneModel({
    history: {
      venue: "okx",
      symbol: "BTCUSDT",
      interval: "15",
      unit: "usd",
      points: [
        { time: 100, value: 1_000 },
        { time: 200, value: 1_100 },
      ],
      notice: null,
      updatedAt: 1,
    },
    liveValue: 1_250,
    liveTime: 300,
  });
  assert.equal(model.available, true);
  assert.equal(model.label, "OI · USD");
  assert.deepEqual(model.points.map((point) => point.value), [1_000, 1_100, 1_250]);
});

test("scales contract OI onto USD using the live pulse ratio and falls back honestly", () => {
  const scaled = oiPaneModel({
    history: {
      venue: "bybit",
      symbol: "BTCUSDT",
      interval: "15",
      unit: "base",
      points: [{ time: 10, value: 2 }],
      notice: null,
      updatedAt: 1,
    },
    liveAmount: 2,
    liveValue: 200_000,
    liveTime: 20,
  });
  assert.equal(scaled.available, true);
  assert.equal(scaled.points[0].value, 200_000);
  assert.equal(scaled.label, "OI · USD");

  const empty = oiPaneModel({});
  assert.equal(empty.available, false);
  assert.equal(empty.emptyNotice, OI_PANE_EMPTY);
  const blocked = shortPaneNotice("Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms.", OI_PANE_EMPTY);
  assert.match(blocked, /blocked here/i);
  assert.doesNotMatch(blocked, /eligibility|https?:\/\//i);
});

test("keeps indicator pointers on the candle pane and stretches extra panes", () => {
  assert.equal(pointerInMainPane(12, 100), true);
  assert.equal(pointerInMainPane(100, 100), true);
  assert.equal(pointerInMainPane(140, 100), false);
  assert.equal(pointerInMainPane(12, null), true);
  const stretch = [];
  applyIndicatorPaneStretch([
    { setStretchFactor: (value) => stretch.push(["main", value]) },
    { setStretchFactor: (value) => stretch.push(["cvd", value]) },
    { setStretchFactor: (value) => stretch.push(["oi", value]) },
  ]);
  assert.deepEqual(stretch, [["main", 1], ["cvd", INDICATOR_PANE_STRETCH], ["oi", INDICATOR_PANE_STRETCH]]);
  applyIndicatorPaneStretch([{ setStretchFactor() { throw new Error("no extra panes"); } }]);
});

test("normalizes line points and live OI merges onto the active bar", () => {
  assert.deepEqual(normalizeLinePoints([
    { time: 20, value: 2 },
    { time: 10, value: 1 },
    { time: 20, value: 3 },
    { time: Number.NaN, value: 9 },
  ]), [
    { time: 10, value: 1 },
    { time: 20, value: 3 },
  ]);
  assert.equal(toBarTimeSeconds(1_700_000_400_000, "15") % 900, 0);
  assert.equal(toBarTimeSeconds(1_700_000_400_000, "15"), Math.floor(1_700_000_400_000 / 900_000) * 900);
  assert.deepEqual(mergeLiveOiPoint([{ time: 10, value: 1 }], 20, 5), [
    { time: 10, value: 1 },
    { time: 20, value: 5 },
  ]);
});
