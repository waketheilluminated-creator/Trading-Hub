import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fitChartView } from "../lib/chart-fit.ts";

function fakeChart(paneCount, { missingLeft = false } = {}) {
  const calls = [];
  const panes = Array.from({ length: paneCount }, (_, i) => ({
    priceScale(id) {
      if (missingLeft && id === "left") throw new Error("no left scale");
      return { applyOptions: (o) => calls.push({ pane: i, id, ...o }) };
    },
  }));
  let fitted = 0;
  return { calls, fitted: () => fitted, chart: { panes: () => panes, timeScale: () => ({ fitContent: () => { fitted += 1; } }) } };
}

test("TH-BUG-07: Fit re-enables price autoscale on every pane and fits the time range", () => {
  const f = fakeChart(3);
  fitChartView(f.chart);
  assert.equal(f.fitted(), 1);
  for (let pane = 0; pane < 3; pane += 1) {
    assert.ok(f.calls.some((c) => c.pane === pane && c.id === "right" && c.autoScale === true), `pane ${pane} right scale`);
  }
  assert.ok(f.calls.every((c) => c.autoScale === true && Object.keys(c).length === 3), "only autoScale is touched (no absolute ranges)");
});

test("TH-BUG-07: Fit tolerates a missing scale and a missing chart", () => {
  const f = fakeChart(1, { missingLeft: true });
  assert.doesNotThrow(() => fitChartView(f.chart));
  assert.equal(f.fitted(), 1);
  assert.doesNotThrow(() => fitChartView(null));
  assert.doesNotThrow(() => fitChartView(undefined));
});

test("TH-BUG-07: Fit is magnitude-independent (no absolute price ranges or epsilons)", () => {
  const src = readFileSync(new URL("../lib/chart-fit.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /setVisibleRange|setPriceRange|minValue|maxValue|1e-/, "no absolute price ranges / epsilons");
});

test("TH-BUG-07: toolbar Fit button uses fitChartView, not a bare timeScale().fitContent()", () => {
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  const button = /<button className="time-button"[^>]*onClick=\{([^}]*)\}\}?>Fit<\/button>/.exec(ws);
  assert.ok(button, "Fit button present");
  assert.match(button[1], /fitChartView\(chartRef\.current\)/);
});
