import assert from "node:assert/strict";
import test from "node:test";
import {
  beginCreate,
  blankDraft,
  centerPriceRange,
  deleteAlert,
  displayStatus,
  draftFromDrawing,
  evaluateAlertBook,
  expandAlert,
  filterAlerts,
  loadGlobalAlerts,
  openOrCreateLiq,
  pauseAlert,
  planAlertPolls,
  quoteKey,
  saveExpanded,
  saveGlobalAlerts,
  visibleAlerts,
} from "../lib/mobile/alerts.ts";

const memory = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
};

function bar(time, close, high = close, low = close) {
  return { time, open: close, high, low, close };
}

function horizontal(id, symbol, level, extra = {}) {
  return {
    id,
    symbol,
    interval: "30",
    kind: "horizontal",
    paused: false,
    triggerMode: "every",
    sound: true,
    notify: true,
    expiresAt: null,
    createdAt: 1,
    lastTriggeredAt: null,
    level,
    lo: null,
    hi: null,
    drawingId: id,
    a: null,
    b: null,
    anchorTime: 10,
    ray: false,
    support: null,
    resistance: null,
    ...extra,
  };
}

test("global alert storage keeps every symbol and drops forged rows", () => {
  const storage = memory();
  const saved = saveGlobalAlerts(storage, [
    horizontal("btc", "BTCUSDT", 81392, { createdAt: 3 }),
    horizontal("eth", "ETHUSDT", 2500, { createdAt: 2 }),
    horizontal("bad", "btc", 10),
    { ...horizontal("nan", "SOLUSDT", 100), level: Number.NaN },
  ]);
  assert.equal(saved, true);
  const loaded = loadGlobalAlerts(storage);
  assert.deepEqual(loaded.map((alert) => alert.symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(loadGlobalAlerts({ getItem: () => "{", setItem() {} }).length, 0);
});

test("a new alert is expanded at the top, then save collapses it into the list", () => {
  const eth = horizontal("eth", "ETHUSDT", 2500, { createdAt: 2 });
  const sol = horizontal("sol", "SOLUSDT", 140, { createdAt: 1 });
  const draft = blankDraft("BTCUSDT", "30", 81392, 30);
  let state = { alerts: [eth, sol], draft: null, edit: null, expandedId: null };
  state = beginCreate(state, draft);
  const open = visibleAlerts(state, "ALL", "active");
  assert.equal(state.expandedId, draft.id);
  assert.equal(open[0].id, draft.id);
  assert.equal(open[0].unsaved, true);
  assert.deepEqual(open.slice(1).map((alert) => alert.symbol), ["ETHUSDT", "SOLUSDT"]);
  state = saveExpanded(state);
  const collapsed = visibleAlerts(state, "ALL", "active");
  assert.equal(state.draft, null);
  assert.equal(state.expandedId, null);
  assert.equal(collapsed[0].symbol, "BTCUSDT");
  assert.equal(collapsed.every((alert) => alert.unsaved !== true), true);
  assert.deepEqual(collapsed.map((alert) => alert.symbol), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
});

test("invalid save stays expanded and a second create replaces the open draft", () => {
  const draft = blankDraft("BTCUSDT", "30", 0, 5);
  let state = beginCreate({ alerts: [], draft: null, edit: null, expandedId: null }, draft);
  const kept = saveExpanded(state);
  assert.equal(kept, state);
  assert.equal(kept.expandedId, draft.id);
  const next = blankDraft("ETHUSDT", "60", 2500, 6);
  state = beginCreate(state, next);
  assert.equal(state.expandedId, next.id);
  assert.equal(state.draft.symbol, "ETHUSDT");
});

test("filter by symbol, pause, and delete", () => {
  const btc = horizontal("btc", "BTCUSDT", 81392, { createdAt: 3 });
  const eth = horizontal("eth", "ETHUSDT", 2500, { createdAt: 2, lastTriggeredAt: 50 });
  let state = { alerts: [btc, eth], draft: null, edit: null, expandedId: null };
  assert.deepEqual(filterAlerts(state.alerts, "ETHUSDT", "active").map((alert) => alert.id), ["eth"]);
  assert.deepEqual(filterAlerts(state.alerts, "ALL", "triggered").map((alert) => alert.id), ["eth"]);
  state = pauseAlert(state, "btc");
  assert.equal(displayStatus(state.alerts[0], 100), "paused");
  assert.deepEqual(filterAlerts(state.alerts, "ALL", "active").map((alert) => alert.id), ["btc", "eth"]);
  state = pauseAlert(state, "btc");
  assert.equal(displayStatus(state.alerts[0], 100), "active");
  state = deleteAlert(state, "eth");
  assert.deepEqual(state.alerts.map((alert) => alert.id), ["btc"]);
});

test("evaluates an alert for a symbol that is not on screen", () => {
  const onScreen = "BTCUSDT";
  const btc = horizontal("btc", onScreen, 80000);
  const eth = horizontal("eth", "ETHUSDT", 2000, { interval: "15" });
  const quotes = {
    [quoteKey("ETHUSDT", "15")]: { prev: bar(1, 1900), bar: bar(2, 2100, 2110, 1890) },
  };
  const result = evaluateAlertBook({ alerts: [btc, eth], quotes, zones: {}, now: 1_000_000, cooldown: {} });
  assert.deepEqual(result.fired.map((fire) => fire.alert.symbol), ["ETHUSDT"]);
  assert.equal(result.fired[0].event.target, "horizontal");
  const polls = planAlertPolls(result.alerts, onScreen, "30", 1_000_000);
  assert.deepEqual(polls, [{ symbol: "ETHUSDT", interval: "15" }]);
});

test("cooldown dedupes a repeat touch and once-mode does not fire again", () => {
  const eth = horizontal("eth", "ETHUSDT", 2000);
  const quotes = { [quoteKey("ETHUSDT", "30")]: { prev: bar(1, 1900), bar: bar(2, 2100) } };
  const first = evaluateAlertBook({ alerts: [eth], quotes, zones: {}, now: 5_000, cooldown: {} });
  assert.equal(first.fired.length, 1);
  const second = evaluateAlertBook({ alerts: first.alerts, quotes, zones: {}, now: 5_000 + 1_000, cooldown: first.cooldown });
  assert.equal(second.fired.length, 0);
  assert.equal(second.cooldown[`alert:${eth.id}:draw:${eth.id}`], 5_000);
  const once = horizontal("once", "SOLUSDT", 100, { triggerMode: "once" });
  const solQuotes = { [quoteKey("SOLUSDT", "30")]: { prev: bar(1, 90), bar: bar(2, 110) } };
  const fired = evaluateAlertBook({ alerts: [once], quotes: solQuotes, zones: {}, now: 9_000, cooldown: {} });
  assert.equal(fired.fired.length, 1);
  assert.equal(displayStatus(fired.alerts[0], 80_000), "triggered");
  const later = evaluateAlertBook({ alerts: fired.alerts, quotes: solQuotes, zones: {}, now: 80_000, cooldown: {} });
  assert.equal(later.fired.length, 0);
});

test("liquidation alert rebinds to the nearest support and resistance", () => {
  const alert = {
    ...horizontal("liq:BTCUSDT", "BTCUSDT", 50, { kind: "liq", drawingId: null, triggerMode: "every" }),
    support: { lo: 1, hi: 2 },
    resistance: null,
  };
  const zones = {
    BTCUSDT: [
      { id: "s-far", role: "support", lo: 10, hi: 11, risk: "中", liq_m: 1 },
      { id: "s-near", role: "support", lo: 40, hi: 42, risk: "高", liq_m: 2 },
      { id: "r-near", role: "resistance", lo: 60, hi: 63, risk: "极高", liq_m: 4 },
      { id: "r-far", role: "resistance", lo: 90, hi: 95, risk: "高", liq_m: 1 },
    ],
  };
  const quotes = { [quoteKey("BTCUSDT", "30")]: { prev: bar(1, 50), bar: bar(2, 50) } };
  const result = evaluateAlertBook({ alerts: [alert], quotes, zones, now: 4_000, cooldown: {} });
  assert.equal(result.fired.length, 0);
  assert.deepEqual(result.alerts[0].support, { lo: 40, hi: 42 });
  assert.deepEqual(result.alerts[0].resistance, { lo: 60, hi: 63 });
});

test("tapping a saved row expands it in place and a second tap keeps a single editor", () => {
  const btc = horizontal("btc", "BTCUSDT", 81392, { createdAt: 3 });
  const eth = horizontal("eth", "ETHUSDT", 2500, { createdAt: 2 });
  let state = expandAlert({ alerts: [btc, eth], draft: null, edit: null, expandedId: null }, "eth");
  assert.deepEqual(visibleAlerts(state, "ALL", "active").map((alert) => alert.id), ["btc", "eth"]);
  assert.equal(state.expandedId, "eth");
  assert.equal(state.edit?.id, "eth");
  assert.equal(state.draft, null);
  state = expandAlert(state, "btc");
  assert.equal(state.expandedId, "btc");
  assert.equal(state.edit?.id, "btc");
  state = saveExpanded(state);
  assert.equal(state.expandedId, null);
  assert.deepEqual(state.alerts.map((alert) => alert.id), ["btc", "eth"]);
});

test("opening an existing liquidation alert expands it instead of stacking a second row", () => {
  const existing = horizontal("liq:ETHUSDT", "ETHUSDT", 2500, { kind: "liq", drawingId: null });
  const state = openOrCreateLiq({ alerts: [existing], draft: null, edit: null, expandedId: null }, "ETHUSDT", "30", 2500, 9);
  assert.equal(state.draft, null);
  assert.equal(state.expandedId, "liq:ETHUSDT");
  assert.equal(state.alerts.length, 1);
});

test("drawing create expands a new card and centers a positive level", () => {
  const drawing = { id: "t1", type: "trend-line", alert: false, ray: false, a: { time: 1, price: 100 }, b: { time: 2, price: 140 } };
  const draft = draftFromDrawing("BTCUSDT", "30", drawing, 12);
  assert.equal(draft.kind, "trendline");
  assert.equal(draft.unsaved, true);
  const state = beginCreate({ alerts: [horizontal("eth", "ETHUSDT", 1)], draft: null, edit: null, expandedId: null }, draft);
  assert.equal(visibleAlerts(state, "ALL", "active")[0].id, "draw:t1");
  assert.deepEqual(centerPriceRange(100), { from: 96, to: 104 });
  assert.equal(centerPriceRange(0), null);
  assert.equal(draftFromDrawing("BTCUSDT", "30", { id: "x", type: "text", alert: false, time: 1, price: 2, text: "注" }, 1), null);
});
