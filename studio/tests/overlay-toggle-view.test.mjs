import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");

// Extract every useEffect body whose dependency list mentions an overlay toggle.
function effectsDependingOn(name) {
  const out = [];
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/g;
  for (const m of src.matchAll(re)) if (new RegExp(`\\b${name}\\b`).test(m[2])) out.push(m[1]);
  return out;
}

test("TH-BUG-03: overlay toggles never touch the visible time range or price scale", () => {
  for (const toggle of ["showLargeOrderSr", "showLargeTrades", "showLiqHeatmap"]) {
    const bodies = effectsDependingOn(toggle);
    assert.ok(bodies.length > 0, `${toggle} drives at least one overlay effect`);
    for (const body of bodies) {
      assert.doesNotMatch(body, /setVisibleLogicalRange|setVisibleRange|fitContent|scrollToRealTime|scrollToPosition|resetTimeScale/, toggle);
      assert.doesNotMatch(body, /timeScale\(\)\.applyOptions|rightOffset/, toggle);
      assert.doesNotMatch(body, /priceScale\([^)]*\)\.applyOptions|autoScale/, toggle);
      assert.doesNotMatch(body, /addSeries|removeSeries/, `${toggle} must use primitives, not series that rescale`);
    }
  }
  assert.doesNotMatch(src, /zoneBoxesVisible/);
  assert.match(src, /rightOffset: LIQ_ZONE_RIGHT_OFFSET_BARS, barSpacing/);
});

test("overlay primitives do not contribute autoscale info (price range unchanged when shown)", () => {
  for (const f of ["../lib/large-order-sr-primitive.ts", "../lib/liq-heatmap-primitive.ts", "../lib/large-trade-markers-primitive.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /autoscaleInfo/, f);
  }
});

test("wall boxes are cleared when the walls toggle is off", () => {
  assert.match(src, /setWalls\(showLargeOrderSr \? displayedWalls : \[\], wallAnchorTime\)/);
});
