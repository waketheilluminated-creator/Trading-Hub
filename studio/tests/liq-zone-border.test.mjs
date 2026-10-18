import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LIQ_LEGEND_RISK_EXTREME, LIQ_LEGEND_RISK_HIGH, LIQ_LONG_RGB, LIQ_SHORT_RGB, liqZoneBorderWidth, liqZoneColors, liqZoneBorderColor } from "../lib/liq-heatmap.ts";
import { drawLiqZone } from "../lib/liq-heatmap-primitive.ts";

/** Recording 2D context: captures fill/stroke calls with the lineWidth/strokeStyle in effect. */
function recorder() {
  const calls = [];
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textBaseline: "",
    fillRect: (...a) => calls.push({ op: "fillRect", a, fill: ctx.fillStyle }),
    strokeRect: (...a) => calls.push({ op: "strokeRect", a, lineWidth: ctx.lineWidth, stroke: ctx.strokeStyle }),
    fillText: () => {}, measureText: (t) => ({ width: t.length * 6 }),
  };
  return { ctx, calls };
}
const zone = (role, risk) => ({ lo: 1, hi: 2, role, liq_m: 500, risk_max: risk, dist_pct: 1, bucket_count: 3, side: role === "support" ? "long" : "short", band_idx: null });
const placed = (z) => ({ zone: z, left: 100, top: 40, width: 300, height: 30, ...liqZoneColors(z.role), edge: liqZoneBorderColor(z.role), borderWidth: liqZoneBorderWidth(z.risk_max) });

for (const role of ["support", "resistance"]) {
  test(`render: ${role} 高 (high) = fill only, no border`, () => {
    const { ctx, calls } = recorder();
    drawLiqZone(ctx, placed(zone(role, "高")));
    assert.equal(calls.filter((c) => c.op === "strokeRect").length, 0);
    assert.equal(calls.filter((c) => c.op === "fillRect").length, 1);
  });
  test(`render: ${role} 极高 (extreme) = fill + 2px border in the side colour, inside the box`, () => {
    const { ctx, calls } = recorder();
    drawLiqZone(ctx, placed(zone(role, "极高")));
    const strokes = calls.filter((c) => c.op === "strokeRect");
    assert.equal(strokes.length, 1);
    assert.equal(strokes[0].lineWidth, 2);
    assert.equal(strokes[0].stroke, `rgb(${role === "support" ? LIQ_LONG_RGB : LIQ_SHORT_RGB})`);
    const [x, y, w, h] = strokes[0].a;
    assert.ok(x - 1 >= 100 && y - 1 >= 40 && x + w + 1 <= 400 && y + h + 1 <= 70, "border stays within lo/hi box");
  });
}

test("border width by risk; legend matches; same primitive in live and replay, both themes", () => {
  assert.equal(liqZoneBorderWidth("高"), 0);
  assert.equal(liqZoneBorderWidth("极高"), 2);
  assert.equal(LIQ_LEGEND_RISK_HIGH, "高：仅填充");
  assert.equal(LIQ_LEGEND_RISK_EXTREME, "极高：填充 + 边框");
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /data-liq-legend-risk/);
  assert.match(ws, /data-border-px=\{liqZoneBorderWidth\("极高"\)\}/);
  const prim = readFileSync(new URL("../lib/liq-heatmap-primitive.ts", import.meta.url), "utf8");
  assert.doesNotMatch(prim, /theme/i, "zone styling does not branch on theme");
});
