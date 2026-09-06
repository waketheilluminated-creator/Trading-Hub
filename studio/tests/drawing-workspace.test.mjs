import assert from "node:assert/strict";
import test from "node:test";
import { CHART_MARKET_VENUE, chartDrawingMarket } from "../lib/drawings/workspace-market.ts";
import { loadDrawings, saveDrawings } from "../lib/drawings/store.ts";

const shortcuts = await import("../lib/drawings/workspace-shortcuts.ts").catch(() => ({}));

function escapeHarness(searchOpen) {
  const calls = [];
  const event = {
    preventDefault: () => calls.push("prevent"),
    stopImmediatePropagation: () => calls.push("stop"),
  };
  shortcuts.handleWorkspaceEscape?.({
    searchOpen,
    event,
    closeSearch: () => calls.push("close-search"),
    cancelDrawing: () => calls.push("cancel-drawing"),
  });
  return calls;
}

test("first Escape consumes symbol search closure before drawing cancellation", () => {
  assert.equal(typeof shortcuts.handleWorkspaceEscape, "function");
  assert.deepEqual(escapeHarness(true), ["prevent", "stop", "close-search"]);
});

test("Escape cancels drawing state when symbol search is already closed", () => {
  assert.equal(typeof shortcuts.handleWorkspaceEscape, "function");
  assert.deepEqual(escapeHarness(false), ["prevent", "stop", "cancel-drawing"]);
});

test("derivatives venue changes do not change the Bybit chart drawing collection", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const bybitDrawing = {
    id: "bybit-drawing",
    type: "trend-line",
    points: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
    style: { color: "#76e7a4", lineWidth: 2 },
    createdAt: 1,
    updatedAt: 1,
  };
  const okxDrawing = { ...bybitDrawing, id: "okx-drawing" };
  saveDrawings(storage, "bybit", "BTCUSDT", [bybitDrawing]);
  saveDrawings(storage, "okx", "BTCUSDT", [okxDrawing]);

  const before = chartDrawingMarket("BTCUSDT");
  let derivativesVenue = "bybit";
  derivativesVenue = "okx";
  const after = chartDrawingMarket("BTCUSDT");

  assert.equal(derivativesVenue, "okx");
  assert.equal(CHART_MARKET_VENUE, "bybit");
  assert.deepEqual(after, before);
  assert.deepEqual(loadDrawings(storage, after.venue, after.symbol), [bybitDrawing]);
});

test("user-selected chart venue remounts drawings; feed fallback does not", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const bybitDrawing = {
    id: "bybit-drawing",
    type: "trend-line",
    points: [{ time: 100, price: 10 }, { time: 200, price: 20 }],
    style: { color: "#76e7a4", lineWidth: 2 },
    createdAt: 1,
    updatedAt: 1,
  };
  const binanceDrawing = { ...bybitDrawing, id: "binance-drawing" };
  saveDrawings(storage, "bybit", "BTCUSDT", [bybitDrawing]);
  saveDrawings(storage, "binance", "BTCUSDT", [binanceDrawing]);

  const selected = chartDrawingMarket("BTCUSDT", "bybit");
  const liveFallbackVenue = "okx";
  assert.notEqual(liveFallbackVenue, selected.venue);
  assert.deepEqual(loadDrawings(storage, selected.venue, selected.symbol), [bybitDrawing]);

  const switched = chartDrawingMarket("BTCUSDT", "binance");
  assert.equal(switched.venue, "binance");
  assert.deepEqual(loadDrawings(storage, switched.venue, switched.symbol), [binanceDrawing]);
});
