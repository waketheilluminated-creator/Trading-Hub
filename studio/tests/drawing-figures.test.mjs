import assert from "node:assert/strict";
import test from "node:test";
import { buildFigure, extendedSegment, raySegment, regressionFit } from "../lib/drawings/figures.ts";
import { createStoredDrawing, fibPrice, isDrawing, positionRisk, FIB_RETRACEMENT_LEVELS } from "../lib/drawings/types.ts";
import { parseDrawingCollection } from "../lib/drawings/store.ts";

const p = (time, price) => ({ time, price });

test("fib retracement uses TradingView levels including extensions", () => {
  assert.deepEqual([...FIB_RETRACEMENT_LEVELS], [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236]);
  assert.equal(fibPrice(100, 200, 0.5), 150);
  assert.ok(Math.abs(fibPrice(100, 200, 1.618) - 261.8) < 1e-9);
  const figure = buildFigure("fib-retracement", [{ x: 10, y: 80 }, { x: 40, y: 20 }], [p(1, 100), p(2, 200)], { width: 100, height: 100 });
  assert.ok(figure.lines.length >= FIB_RETRACEMENT_LEVELS.length);
  assert.ok(figure.labels.some((label) => label.text.startsWith("0.618")));
});

test("extended lines and rays clip to the pane", () => {
  const extended = extendedSegment({ x: 10, y: 10 }, { x: 20, y: 10 }, { width: 100, height: 80 });
  assert.deepEqual(extended, [{ x: 0, y: 10, t: -1 }, { x: 100, y: 10, t: 9 }].map(({ x, y }) => ({ x, y })));
  const ray = raySegment({ x: 10, y: 10 }, { x: 20, y: 10 }, { width: 100, height: 80 });
  assert.equal(ray[0].x, 10);
  assert.equal(ray[1].x, 100);
});

test("parallel channel, flat channel and pitchfork keep their anchors", () => {
  const channel = buildFigure(
    "parallel-channel",
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }],
    [p(0, 0), p(10, 0), p(0, 5)],
    { width: 100, height: 100 },
  );
  assert.ok(channel.lines.length >= 2);
  const flat = buildFigure("flat-channel", [{ x: 0, y: 10 }, { x: 20, y: 0 }, { x: 10, y: 30 }], [p(0, 10), p(20, 0), p(10, 4)], { width: 40, height: 40 });
  assert.equal(flat.lines.length, 2);
  const fork = buildFigure("pitchfork", [{ x: 50, y: 80 }, { x: 20, y: 20 }, { x: 80, y: 20 }], [p(1, 1), p(2, 2), p(3, 2)], { width: 100, height: 100 });
  assert.equal(fork.lines.length, 3);
});

test("long position stores a mirrored stop and reports R:R", () => {
  assert.deepEqual(positionRisk(100, 110), { stop: 90, reward: 10, risk: 10, ratio: 1 });
  const drawing = createStoredDrawing("long-position", [p(10, 100), p(20, 130)], "pos", 1);
  assert.equal(drawing.points.length, 3);
  assert.equal(drawing.points[2].price, 70);
  assert.equal(isDrawing(drawing), true);
  const figure = buildFigure("long-position", [{ x: 10, y: 40 }, { x: 50, y: 10 }, { x: 50, y: 70 }], drawing.points, { width: 80, height: 80 });
  assert.ok(figure.labels.some((label) => label.text.includes("R:R 1.00")));
});

test("rectangle, circle and polyline serialize and round-trip", () => {
  const rectangle = createStoredDrawing("rectangle", [p(1, 10), p(2, 12)], "r", 3);
  const path = createStoredDrawing("polyline", [p(1, 1), p(2, 2), p(3, 1)], "path", 4);
  const circle = createStoredDrawing("circle", [p(1, 5), p(2, 6)], "c", 5);
  const legacy = createStoredDrawing("trend-line", [p(1, 1), p(2, 2)], "old", 6);
  const raw = JSON.stringify({ version: 1, drawings: [rectangle, path, circle, legacy, { id: "nope", type: "not-a-tool", points: [], style: { color: "#fff", lineWidth: 2 }, createdAt: 1, updatedAt: 1 }] });
  const loaded = parseDrawingCollection(raw);
  assert.deepEqual(loaded.map((item) => item.type), ["rectangle", "polyline", "circle", "trend-line"]);
  assert.equal(isDrawing({ ...rectangle, points: [p(1, 1)] }), false);
});

test("regression uses closes inside the time window", () => {
  const fit = regressionFit([
    { time: 1, close: 10 },
    { time: 2, close: 20 },
    { time: 3, close: 30 },
    { time: 9, close: 0 },
  ], 1, 3);
  assert.ok(fit);
  assert.ok(Math.abs(fit.slope - 10) < 1e-9);
  assert.equal(regressionFit([{ time: 1, close: 10 }], 1, 3), null);
});
