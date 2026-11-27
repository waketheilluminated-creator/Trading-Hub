import assert from "node:assert/strict";
import test from "node:test";
import { constrainToOctant, MAGNET_X_PX, MAGNET_Y_PX, snapToOhlc } from "../lib/drawings/gestures.ts";
import { nextBarSpacing, applyBarSpacingZoom, MIN_BAR_SPACING, MAX_BAR_SPACING } from "../lib/drawings/zoom.ts";

test("Shift constraint snaps the free end onto 45-degree steps", () => {
  const snapped = constrainToOctant({ x: 100, y: 10 }, { x: 200, y: 80 });
  assert.ok(Math.abs(snapped.x - 186.312) < 0.05);
  assert.ok(Math.abs(snapped.y - 96.312) < 0.05);
  assert.deepEqual(constrainToOctant({ x: 0, y: 0 }, { x: 0, y: 0 }), { x: 0, y: 0 });
  const flat = constrainToOctant({ x: 0, y: 0 }, { x: 40, y: 1 });
  assert.ok(Math.abs(flat.y) < 0.01);
  assert.ok(Math.abs(flat.x - 40.012) < 0.05 || Math.abs(flat.x - Math.hypot(40, 1)) < 0.02);
});

test("weak magnet snaps to the nearest OHLC of the bar under the cursor", () => {
  const candles = [{ time: 100, open: 10, high: 14, low: 8, close: 12 }];
  const project = { timeToX: (time) => time, priceToY: (price) => price };
  assert.deepEqual(snapToOhlc({ x: 100, y: 13.2 }, candles, project), { time: 100, price: 14 });
  assert.equal(snapToOhlc({ x: 100, y: 40 }, candles, project), null);
  assert.equal(snapToOhlc({ x: 100 + MAGNET_X_PX + 5, y: 14 }, candles, project), null);
  assert.equal(snapToOhlc({ x: 100, y: 14 + MAGNET_Y_PX + 1 }, candles, project), null);
  assert.equal(snapToOhlc({ x: 100, y: 14 }, [], project), null);
});

test("zoom changes bar spacing only and stays inside the chart limits", () => {
  assert.equal(nextBarSpacing(8, "in"), 10);
  assert.equal(nextBarSpacing(8, "out"), 6.4);
  assert.equal(nextBarSpacing(MIN_BAR_SPACING, "out"), MIN_BAR_SPACING);
  assert.equal(nextBarSpacing(MAX_BAR_SPACING, "in"), MAX_BAR_SPACING);
  const calls = [];
  applyBarSpacingZoom({
    timeScale: () => ({
      options: () => ({ barSpacing: 8, rightOffset: 12 }),
      applyOptions: (options) => calls.push(options),
    }),
  }, "in");
  assert.deepEqual(calls, [{ barSpacing: 10 }]);
  applyBarSpacingZoom(null, "out");
});
