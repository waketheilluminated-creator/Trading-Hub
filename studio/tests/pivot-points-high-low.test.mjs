import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PIVOT_POINTS_HIGH_LOW,
  PIVOT_BARS_DEFAULT,
  PIVOT_BARS_MAX,
  PIVOT_BARS_MIN,
  PIVOT_HIGH_COLOR,
  PIVOT_LABEL_ARROW,
  PIVOT_LABEL_HEIGHT,
  PIVOT_LOW_COLOR,
  PIVOT_POINTS_SETTINGS_KEY,
  layoutPivotLabel,
  normalizePivotPointsSettings,
  pivotLabelModels,
  pivotPointsHighLow,
  pivotPointsParamsLabel,
  readPivotPointsSettings,
  writePivotPointsSettings,
} from "../lib/pivot-points-high-low.ts";

function bars(highs, lows, start = 1_700_000_000) {
  return highs.map((high, index) => ({
    high,
    low: lows ? lows[index] : high - 1,
    time: start + index * 60,
  }));
}

function highsOnly(points, kind) {
  return points.filter((point) => point.kind === kind);
}

const LEN_1 = { highLeft: 1, highRight: 1, lowLeft: 1, lowRight: 1 };

test("pivot high and pivot low use strict dominance on the right and land on the pivot bar", () => {
  const points = pivotPointsHighLow(bars(
    [1, 2, 9, 3, 2, 4, 1],
    [4, 3, 2, 0, 2, 3, 4],
  ), { highLeft: 2, highRight: 2, lowLeft: 1, lowRight: 1 });
  const high = highsOnly(points, "high");
  const low = highsOnly(points, "low");
  assert.deepEqual(high.map((point) => point.index), [2]);
  assert.equal(high[0].price, 9);
  assert.equal(high[0].time, 1_700_000_000 + 2 * 60);
  assert.deepEqual(low.map((point) => [point.index, point.price]), [[3, 0]]);
});

test("equal highs: the rightmost bar of a flat top is the pivot; an equal high to the right is not", () => {
  const points = highsOnly(pivotPointsHighLow(bars([1, 5, 5, 5, 2]), LEN_1), "high");
  assert.deepEqual(points.map((point) => [point.index, point.price]), [[3, 5]]);
});

test("equal lows: the rightmost bar of a flat bottom is the pivot; an equal low to the right is not", () => {
  const points = highsOnly(pivotPointsHighLow(bars(
    [6, 6, 6, 6, 6],
    [5, 1, 1, 1, 4],
  ), LEN_1), "low");
  assert.deepEqual(points.map((point) => [point.index, point.price]), [[3, 1]]);
});

test("an equal extreme on the left does not block the pivot, and a stricter extreme on the left does", () => {
  const allowed = highsOnly(pivotPointsHighLow(bars([1, 5, 5, 3]), LEN_1), "high");
  assert.deepEqual(allowed.map((point) => point.index), [2]);
  const blocked = pivotPointsHighLow(bars([9, 4, 4, 1]), { highLeft: 2, highRight: 1, lowLeft: 2, lowRight: 1 });
  assert.deepEqual(highsOnly(blocked, "high"), []);
  const lowBlocked = pivotPointsHighLow(bars(
    [3, 3, 3, 3],
    [0, 3, 1, 4],
  ), { highLeft: 2, highRight: 1, lowLeft: 2, lowRight: 1 });
  assert.deepEqual(highsOnly(lowBlocked, "low"), []);
});

test("bars at the start lack leftBars and bars near the end lack rightBars, so they are not confirmed", () => {
  assert.deepEqual(pivotPointsHighLow(bars([10, 1, 2, 3]), { highLeft: 2, highRight: 1, lowLeft: 2, lowRight: 1 }), []);
  assert.deepEqual(pivotPointsHighLow(bars([1, 2, 10, 3]), { highLeft: 1, highRight: 2, lowLeft: 1, lowRight: 2 }), []);
  const confirmed = highsOnly(pivotPointsHighLow(bars([1, 10, 3, 2]), { highLeft: 1, highRight: 2, lowLeft: 1, lowRight: 2 }), "high");
  assert.deepEqual(confirmed.map((point) => point.index), [1]);
});

test("the same bar can be a pivot high and a pivot low, high first", () => {
  const points = pivotPointsHighLow(bars(
    [1, 1, 5, 1, 1],
    [3, 3, 0, 3, 3],
  ), { highLeft: 2, highRight: 2, lowLeft: 2, lowRight: 2 });
  assert.deepEqual(points.map((point) => [point.kind, point.index, point.price]), [
    ["high", 2, 5],
    ["low", 2, 0],
  ]);
});

test("high and low lengths are independent", () => {
  const points = pivotPointsHighLow(bars(
    [1, 3, 2],
    [5, 0, 4],
  ), { highLeft: 1, highRight: 1, lowLeft: 2, lowRight: 2 });
  assert.deepEqual(points.map((point) => point.kind), ["high"]);
});

test("defaults are TradingView's 10/10 and only confirmed pivots inside that window are returned", () => {
  assert.equal(PIVOT_BARS_DEFAULT, 10);
  assert.deepEqual(DEFAULT_PIVOT_POINTS_HIGH_LOW, { highLeft: 10, highRight: 10, lowLeft: 10, lowRight: 10 });
  const count = 5000;
  const highs = Array.from({ length: count }, () => 1);
  const lows = Array.from({ length: count }, () => 2);
  highs[100] = 10;
  lows[120] = 0;
  highs[4000] = 20;
  lows[4200] = -1;
  highs[4990] = 30;
  lows[4991] = -5;
  const points = pivotPointsHighLow(bars(highs, lows));
  assert.deepEqual(points.map((point) => [point.kind, point.index]), [
    ["high", 100],
    ["low", 120],
    ["high", 4000],
    ["low", 4200],
  ]);
});

test("lazy back-loaded history keeps pivots already confirmed and reveals seam pivots once leftBars exist", () => {
  const older = bars([1, 2], [2, 2], 1_000);
  const recent = bars([9, 3, 1, 4, 8, 2, 1, 3], [4, 2, 0.5, 1, 3, 0.4, 0.2, 1], 1_000 + 2 * 60);
  const lengths = { highLeft: 2, highRight: 2, lowLeft: 2, lowRight: 2 };
  const recentPoints = pivotPointsHighLow(recent, lengths);
  const fullPoints = pivotPointsHighLow([...older, ...recent], lengths);
  assert.deepEqual(recentPoints.map((point) => [point.kind, point.time, point.price]), [
    ["low", 1_000 + 4 * 60, 0.5],
    ["high", 1_000 + 6 * 60, 8],
  ]);
  for (const point of recentPoints) {
    const match = fullPoints.find((candidate) => candidate.kind === point.kind && candidate.time === point.time);
    assert.ok(match, `${point.kind} at ${point.time} survived the prepend`);
    assert.equal(match.price, point.price);
    assert.equal(match.index, point.index + older.length);
  }
  const seam = fullPoints.find((point) => point.time === recent[0].time && point.kind === "high");
  assert.ok(seam, "the leading high becomes a pivot once older left bars arrive");
  assert.equal(seam.price, 9);
  assert.equal(recentPoints.some((point) => point.time === recent[0].time), false);
});

test("appending bars confirms a pending pivot in place and does not move pivots already confirmed", () => {
  const lengths = { highLeft: 2, highRight: 2, lowLeft: 2, lowRight: 2 };
  const recent = bars([9, 3, 1, 4, 8, 2, 1, 3], [4, 2, 0.5, 1, 3, 0.4, 0.2, 1], 5_000);
  const before = pivotPointsHighLow(recent, lengths);
  const extended = [...recent, { high: 2, low: 1, time: 5_000 + recent.length * 60 }];
  const after = pivotPointsHighLow(extended, lengths);
  for (const point of before) {
    const match = after.find((candidate) => candidate.kind === point.kind && candidate.time === point.time);
    assert.ok(match);
    assert.equal(match.index, point.index);
    assert.equal(match.price, point.price);
  }
  const confirmed = after.find((point) => point.time === recent[6].time && point.kind === "low");
  assert.ok(confirmed);
  assert.equal(confirmed.index, 6);
  assert.equal(confirmed.price, 0.2);
  assert.equal(before.some((point) => point.time === recent[6].time), false);
  assert.equal(after.some((point) => point.index >= extended.length - lengths.lowRight), false);
});

test("a still-forming right-window bar can invalidate a pivot, matching ta.pivothigh realtime updates", () => {
  const open = bars([1, 5, 2]);
  assert.deepEqual(highsOnly(pivotPointsHighLow(open, LEN_1), "high").map((point) => point.index), [1]);
  assert.deepEqual(highsOnly(pivotPointsHighLow(bars([1, 5, 5]), LEN_1), "high"), []);
  assert.deepEqual(highsOnly(pivotPointsHighLow(bars([1, 5, 6]), LEN_1), "high"), []);
  const settled = highsOnly(pivotPointsHighLow(bars([1, 5, 5, 2]), LEN_1), "high");
  assert.deepEqual(settled.map((point) => [point.index, point.price]), [[2, 5]]);
});

test("non-finite prices are not pivots and do not confirm a neighbor", () => {
  assert.deepEqual(pivotPointsHighLow([
    { high: 1, low: 1 },
    { high: Number.NaN, low: 1 },
    { high: 5, low: 1 },
    { high: 1, low: 1 },
    { high: 1, low: 1 },
  ], { highLeft: 2, highRight: 2, lowLeft: 2, lowRight: 2 }), []);
  assert.deepEqual(pivotPointsHighLow([], LEN_1), []);
  assert.deepEqual(pivotPointsHighLow(bars([3]), LEN_1), []);
});

test("detection does not mutate its inputs", () => {
  const input = Object.freeze(bars([1, 5, 5, 2]).map((bar) => Object.freeze(bar)));
  pivotPointsHighLow(input, LEN_1);
  assert.deepEqual(input.map((bar) => bar.high), [1, 5, 5, 2]);
});

test("labels sit above pivot highs and below pivot lows and show the tick price", () => {
  const labels = pivotLabelModels(bars([1, 2, 9, 3, 1, 2], [4, 3, 2, 0, 3, 2]), { highLeft: 2, highRight: 2, lowLeft: 2, lowRight: 2 }, 2);
  const high = labels.find((label) => label.kind === "high");
  const low = labels.find((label) => label.kind === "low");
  assert.equal(high.side, "above");
  assert.equal(high.color, PIVOT_HIGH_COLOR);
  assert.equal(high.text, "9.00");
  assert.equal(low.side, "below");
  assert.equal(low.color, PIVOT_LOW_COLOR);
  assert.equal(low.text, "0.00");
  assert.equal(pivotLabelModels([{ high: 1, low: 0, time: Number.NaN }, { high: 3, low: 0 }, { high: 1, low: 0 }], LEN_1, 2).length, 0);
});

test("label geometry is a pixel offset around the price anchor, so it cannot change the price scale", () => {
  const above = layoutPivotLabel("above", 80, 40, 36);
  const below = layoutPivotLabel("below", 80, 40, 36);
  assert.equal(above.tipY, 40);
  assert.equal(below.tipY, 40);
  assert.ok(above.top + above.height <= above.anchorY - PIVOT_LABEL_ARROW + 0.001);
  assert.ok(below.top >= below.anchorY + PIVOT_LABEL_ARROW - 0.001);
  assert.equal(above.height, PIVOT_LABEL_HEIGHT);
  assert.equal(above.left + above.width / 2, above.anchorX);
  assert.equal(layoutPivotLabel("above", 80, 40, 80).anchorY, 40);
});

test("length settings clamp forged input and persist only the four integers", () => {
  assert.deepEqual(normalizePivotPointsSettings(null), DEFAULT_PIVOT_POINTS_HIGH_LOW);
  assert.deepEqual(normalizePivotPointsSettings(["10", "10"]), DEFAULT_PIVOT_POINTS_HIGH_LOW);
  const forged = JSON.parse('{"highLeft":-4,"highRight":"nope","lowLeft":4.9,"lowRight":99999,"extra":"x","__proto__":{"polluted":true}}');
  assert.deepEqual(normalizePivotPointsSettings(forged), {
    highLeft: PIVOT_BARS_MIN,
    highRight: PIVOT_BARS_DEFAULT,
    lowLeft: 4,
    lowRight: PIVOT_BARS_MAX,
  });
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(pivotPointsParamsLabel({ highLeft: 12, highRight: 8, lowLeft: 10, lowRight: 11 }), "12 8 10 11");

  const storage = new Map();
  const memory = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  assert.equal(readPivotPointsSettings(memory), DEFAULT_PIVOT_POINTS_HIGH_LOW);
  assert.equal(readPivotPointsSettings(null), DEFAULT_PIVOT_POINTS_HIGH_LOW);
  writePivotPointsSettings(memory, { highLeft: 3, evil: "<script>", highRight: 4, lowLeft: 5, lowRight: 6 });
  const raw = JSON.parse(storage.get(PIVOT_POINTS_SETTINGS_KEY));
  assert.deepEqual(Object.keys(raw).sort(), ["highLeft", "highRight", "lowLeft", "lowRight"]);
  const read = readPivotPointsSettings(memory);
  assert.equal(read, readPivotPointsSettings(memory));
  assert.deepEqual(read, { highLeft: 3, highRight: 4, lowLeft: 5, lowRight: 6 });
  assert.doesNotThrow(() => writePivotPointsSettings(null, LEN_1));
  assert.doesNotThrow(() => writePivotPointsSettings({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  }, LEN_1));
  assert.equal(readPivotPointsSettings({ getItem() { throw new Error("blocked"); } }), DEFAULT_PIVOT_POINTS_HIGH_LOW);
  assert.equal(readPivotPointsSettings({ getItem: () => "not-json" }), DEFAULT_PIVOT_POINTS_HIGH_LOW);
});
