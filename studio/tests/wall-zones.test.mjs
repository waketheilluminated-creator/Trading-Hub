import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findWallZoneAt, formatWallZoneTooltip, mergeWallZones, placeWallZones, wallZoneColors, WALL_ZONE_MIN_HEIGHT_PX } from "../lib/wall-zones.ts";

const wall = (side, price, notional, half = 1) => ({ side, price, low: price - half, high: price + half, size: notional / price, notional });

test("adjacent same-side walls merge into one lo–hi box with summed notional and count", () => {
  const zones = mergeWallZones([wall("bid", 80_000, 2e6), wall("bid", 80_040, 3e6), wall("bid", 79_000, 1e6), wall("ask", 81_000, 4e6), wall("ask", 81_030, 1e6)], 10);
  assert.deepEqual(zones.map((z) => [z.side, z.lo, z.hi, z.notional, z.count]), [
    ["bid", 78_999, 79_001, 1e6, 1],
    ["bid", 79_999, 80_041, 5e6, 2],
    ["ask", 80_999, 81_031, 5e6, 2],
  ]);
});

test("bid and ask walls never merge with each other, even when touching", () => {
  const zones = mergeWallZones([wall("bid", 80_000, 1e6), wall("ask", 80_001, 1e6)], 50);
  assert.equal(zones.length, 2);
});

test("merge gap is configurable; 0 keeps separated walls apart", () => {
  const walls = [wall("ask", 100, 1e5, 0.01), wall("ask", 100.05, 1e5, 0.01)];
  assert.equal(mergeWallZones(walls, 0).length, 2);
  assert.equal(mergeWallZones(walls, 10).length, 1);
});

test("bad rows are dropped (non-finite, non-positive)", () => {
  const zones = mergeWallZones([wall("bid", Number.NaN, 1e6), wall("bid", -5, 1e6), wall("bid", 100, 0), { side: "bid", price: 100, low: Number.NaN, high: Number.NaN, size: 1, notional: 1e6 }]);
  assert.deepEqual(zones.map((z) => [z.lo, z.hi, z.count]), [[100, 100, 1]]);
});

test("boxes start at the latest candle and extend to the right edge; single walls get a thin box", () => {
  const zones = mergeWallZones([wall("bid", 100, 1e6, 0), wall("ask", 110, 1e6, 2)]);
  const priceToY = (p) => 1000 - p * 5;
  const placed = placeWallZones(zones, priceToY, 600, 900);
  assert.equal(placed.length, 2);
  for (const box of placed) {
    assert.equal(box.left, 600);
    assert.equal(box.width, 300);
  }
  assert.equal(placed[0].height, WALL_ZONE_MIN_HEIGHT_PX, "single-price wall is a thin box");
  assert.equal(placed[1].height, 20);
  assert.equal(placeWallZones(zones, priceToY, null, 900).length, 0, "no latest candle → nothing (no history segment)");
  assert.equal(placeWallZones(zones, priceToY, 950, 900).length, 0);
  assert.match(placed[0].fill, /83, 201, 144, 0\.2\)/, "bid = green, semi-transparent");
  assert.match(placed[1].fill, /231, 103, 112, 0\.2\)/, "ask = red, semi-transparent");
  assert.notEqual(wallZoneColors("bid").edge, wallZoneColors("ask").edge);
});

test("tooltip shows side, total notional, price range and wall count", () => {
  const [zone] = mergeWallZones([wall("ask", 81_000, 4e6), wall("ask", 81_030, 1.5e6)], 10);
  const text = formatWallZoneTooltip(zone);
  assert.match(text, /^Ask wall 卖墙 · /);
  assert.match(text, /\$5\.50M/);
  assert.match(text, /80,999.*81,031|80999.*81031/);
  assert.match(text, /2 walls$/);
  assert.equal(findWallZoneAt([zone], 81_010), zone);
  assert.equal(findWallZoneAt([zone], 82_000), null);
});

test("wiring: primitive draws zone boxes on top from the latest candle, throttled; workspace passes latest candle time", () => {
  const primitive = readFileSync(new URL("../lib/large-order-sr-primitive.ts", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(primitive, /zOrder\(\): "top"/);
  assert.match(primitive, /placeWallZones\(/);
  assert.match(primitive, /WALL_ZONE_REDRAW_MS/);
  assert.doesNotMatch(primitive, /drawWallBand|drawWallEdges/, "old full-width horizontal bands are gone");
  assert.match(workspace, /const wallAnchorTime = candles\.at\(-1\)\?\.time \?\? null;/);
  assert.match(workspace, /setWalls\(showLargeOrderSr \? displayedWalls : \[\], wallAnchorTime\)/);
  assert.match(workspace, /formatWallZoneTooltip\(zone, liqDecimalsRef\.current\)/);
});
