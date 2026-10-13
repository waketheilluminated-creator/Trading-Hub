import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CrosshairMode } from "lightweight-charts";

test("main chart uses the free (Normal) crosshair, not magnet snapping", () => {
  const src = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(src, /crosshair: \{ mode: CrosshairMode\.Normal,/);
  assert.doesNotMatch(src, /CrosshairMode\.Magnet/);
  assert.equal(CrosshairMode.Normal, 0);
});
