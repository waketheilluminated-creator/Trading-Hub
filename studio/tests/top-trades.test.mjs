import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXECUTED_TRADES_FLOOR_USD,
  TOP_TRADES_LIMIT,
  mergeTradeHistory,
  topTradeEntries,
  topTradesInRange,
  visibleRangeMs,
} from "../lib/market-trades.ts";

const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const tr = (min, notional, side = "buy", venue = "bybit") => ({ time: T0 + min * 60_000, price: 80_000, size: notional / 80_000, notional, side, venue });

test("ranks by USD notional, largest first, and keeps only the top 10", () => {
  const trades = Array.from({ length: 15 }, (_, i) => tr(i, 100_000 + i * 10_000, i % 2 ? "sell" : "buy"));
  const top = topTradesInRange(trades, null);
  assert.equal(top.length, TOP_TRADES_LIMIT);
  assert.deepEqual(top.map((t) => t.notional), [240_000, 230_000, 220_000, 210_000, 200_000, 190_000, 180_000, 170_000, 160_000, 150_000]);
  // ties: newest first
  const tied = topTradesInRange([tr(1, 500_000), tr(5, 500_000)], null);
  assert.deepEqual(tied.map((t) => t.time), [T0 + 5 * 60_000, T0 + 60_000]);
});

test("buys and sells are mixed in one list with their side preserved", () => {
  const top = topTradesInRange([tr(0, 300_000, "sell"), tr(1, 900_000, "buy"), tr(2, 600_000, "sell"), tr(3, 50_000, "buy")], null);
  assert.deepEqual(top.map((t) => t.side), ["buy", "sell", "sell", "buy"]);
  const rows = topTradeEntries(top);
  assert.deepEqual(rows.map((r) => r.side), ["buy", "sell", "sell", "buy"]);
  assert.equal(rows[0].venue, "bybit");
  assert.equal(rows[0].notionalLabel.startsWith("$"), true);
  assert.ok(rows[0].qtyLabel && rows[0].priceLabel && rows[0].timeLabel);
  assert.equal(rows[0].barPct, 100);
});

test("only trades inside the visible chart range count; last bar extends one interval (live prints)", () => {
  const trades = [tr(-30, 5_000_000), tr(0, 200_000), tr(10, 300_000, "sell"), tr(14, 150_000), tr(16, 9_000_000)];
  // visible bars 12:00 .. 12:00 (15m) → [12:00, 12:15)
  const range = visibleRangeMs({ from: T0 / 1000, to: T0 / 1000 }, 15 * 60_000);
  assert.deepEqual(range, { fromMs: T0, toMs: T0 + 15 * 60_000 });
  const top = topTradesInRange(trades, range);
  assert.deepEqual(top.map((t) => t.notional), [300_000, 200_000, 150_000]);
  // panning right to include 12:15 brings in the 9M print; zooming out further brings in the -30m one
  assert.equal(topTradesInRange(trades, visibleRangeMs({ from: T0 / 1000, to: T0 / 1000 + 900 }, 900_000))[0].notional, 9_000_000);
  assert.equal(topTradesInRange(trades, visibleRangeMs({ from: T0 / 1000 - 3600, to: T0 / 1000 + 900 }, 900_000)).length, 5);
  assert.equal(visibleRangeMs(null, 900_000), null);
});

test("history merge dedupes, applies the internal floor and caps size", () => {
  const a = tr(0, 400_000);
  const merged = mergeTradeHistory([a], [a, tr(1, EXECUTED_TRADES_FLOOR_USD - 1), tr(2, 600_000, "sell")]);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((t) => t.notional >= EXECUTED_TRADES_FLOOR_USD));
  const many = Array.from({ length: 50 }, (_, i) => tr(i, 100_000));
  const capped = mergeTradeHistory([], many, 20);
  assert.equal(capped.length, 20);
  assert.equal(capped[0].time, T0 + 49 * 60_000, "keeps the newest");
});

test("executed table has no Min $ buckets; chart dots still get the trade history", () => {
  const dock = readFileSync(new URL("../components/large-order-dock.tsx", import.meta.url), "utf8");
  assert.match(dock, /\{section === "unfilled" && <SrWallControls/);
  assert.match(dock, /topTradeEntries\(trades\)/);
  assert.match(dock, /<span>USD<\/span><span>Qty<\/span><span>Price<\/span><span>Time<\/span><span>Venue<\/span>/);
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /minNotional: EXECUTED_TRADES_FLOOR_USD/);
  assert.match(ws, /largeTradePrimitiveRef\.current\?\.setTrades\(showLargeTrades \? largeTrades : \[\], interval\)/);
  assert.match(ws, /trades=\{topTrades\}/);
  assert.match(ws, /subscribeVisibleTimeRangeChange\(schedule\)/);
});
