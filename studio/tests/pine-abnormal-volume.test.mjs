import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { transpile } from "../lib/pine/transpiler.js";
import { buildPineRenderModel, describePineModel, pineModelHasOutput, pineModelNeedsStudyPane } from "../lib/pine-chart-model.ts";

const SOURCE = readFileSync(new URL("./fixtures/abnormal-volume-range-boxes.pine", import.meta.url), "utf8");

// Deterministic bars: quiet volume with scheduled abnormal-volume candles so the
// script produces big buys, big sells, H/L breaks, backgrounds and range boxes.
function syntheticBars(n = 320) {
  const bars = { open: [], high: [], low: [], close: [], volume: [], time: [] };
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const phase = Math.floor(i / 40) % 2 === 0 ? 1 : -1;
    const spike = i > 100 && i % 20 === 0;
    const spikeSide = Math.floor(i / 20) % 2 === 0 ? 1 : -1;
    const close = spike ? open + spikeSide * 3 : open + phase * 0.4 + Math.sin(i / 3) * 0.2;
    bars.open.push(open);
    bars.close.push(close);
    bars.high.push(Math.max(open, close) + 0.5);
    bars.low.push(Math.min(open, close) - 0.5);
    bars.volume.push(spike ? 5000 : 1000 + (i % 7) * 10);
    bars.time.push((1_700_000_000 + i * 900) * 1000);
    price = close;
  }
  return bars;
}

async function runFixture(bars = syntheticBars()) {
  const result = transpile(SOURCE);
  assert.equal(result.success, true, `transpile failed: ${result.error}`);
  const dir = mkdtempSync(join(tmpdir(), "pine-fixture-"));
  const file = join(dir, "script.mjs");
  writeFileSync(file, result.code);
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return { runtime: mod.run(bars), bars };
}

test("abnormal-volume fixture transpiles and records overlay=false study metadata", async () => {
  const { runtime } = await runFixture();
  assert.equal(runtime.indicator.title, "地藏经 - Abnormal Volume Range Boxes");
  assert.equal(runtime.indicator.overlay, false);
});

test("named plot arguments keep separate titled series with styles and per-bar colors", async () => {
  const { runtime, bars } = await runFixture();
  assert.deepEqual(Object.keys(runtime.plots), ["Volume", "Volume EMA", "H", "L"]);
  const volume = runtime.plots.Volume;
  assert.equal(volume.style, "columns");
  assert.equal(volume.forceOverlay, false);
  assert.equal(volume.data.length, bars.close.length);
  assert.equal(volume.data[5], bars.volume[5]);
  // Normal bars are faded (transp 88); abnormal-volume bars are opaque.
  assert.match(volume.colors[5], /rgba\(\d+, \d+, \d+, 0\.12\)/);
  assert.ok(volume.colors.some((c) => /, 1\)$/.test(c ?? "")), "abnormal bars should be opaque");
  assert.equal(runtime.plots["Volume EMA"].color, "rgba(255, 152, 0, 1)", "color.orange must resolve");
  assert.equal(runtime.plots["Volume EMA"].linewidth, 2);
  for (const key of ["H", "L"]) {
    assert.equal(runtime.plots[key].forceOverlay, true);
    assert.equal(runtime.plots[key].style, "stepline");
    assert.ok(runtime.plots[key].data.some((v) => Number.isFinite(v)), `${key} should have values`);
  }
});

test("force_overlay bgcolor, plotshape and boxes are captured for the price pane", async () => {
  const { runtime } = await runFixture();
  const bg = runtime.bgcolors["Big Buy / Big Sell Background"];
  assert.ok(bg, "bgcolor should be recorded");
  assert.equal(bg.forceOverlay, true);
  assert.ok(bg.data.filter(Boolean).length > 0, "big buy/sell bars should tint the background");
  const above = runtime.plotshapes["First Close Above H"];
  assert.equal(above.forceOverlay, true);
  assert.equal(above.style, "triangleup");
  assert.equal(above.location, "belowbar");
  const below = runtime.plotshapes["First Close Below L"];
  assert.equal(below.style, "triangledown");
  assert.equal(below.location, "abovebar");
  assert.ok(above.data.some(Boolean) || below.data.some(Boolean), "an H/L break should fire on the fixture bars");
  assert.ok(runtime.boxes.length > 0, "range boxes should be created");
  for (const box of runtime.boxes) {
    assert.equal(box.forceOverlay, true);
    assert.ok(box.left <= box.right);
    assert.ok(box.top >= box.bottom);
    assert.match(box.bgcolor, /0\.12\)$/);
  }
});

test("render model splits the study pane from force_overlay drawings", async () => {
  const { runtime, bars } = await runFixture();
  const times = bars.time.map((t) => t / 1000);
  const model = buildPineRenderModel(runtime, times);
  assert.equal(pineModelHasOutput(model), true);
  assert.equal(pineModelNeedsStudyPane(model), true);
  const byTitle = Object.fromEntries(model.series.map((s) => [s.title, s]));
  assert.equal(byTitle.Volume.pane, "study");
  assert.equal(byTitle.Volume.kind, "histogram");
  assert.equal(byTitle["Volume EMA"].pane, "study");
  assert.equal(byTitle.H.pane, "price");
  assert.equal(byTitle.H.stepped, true);
  assert.equal(byTitle.L.pane, "price");
  assert.equal(byTitle.Volume.points.length, times.length);
  assert.ok(model.backgrounds.every((b) => b.pane === "price"));
  assert.ok(model.boxes.length > 0 && model.boxes.every((b) => b.pane === "price" && b.leftTime <= b.rightTime));
  assert.ok(model.markers.every((m) => m.pane === "price"));
  assert.match(describePineModel(model, times.length), /in pane/);
});

test("render model keeps overlay=true scripts on the price pane and drops forged box indexes", () => {
  const model = buildPineRenderModel({
    indicator: { title: "EMA", overlay: true },
    plots: { EMA: { title: "EMA", data: [1, null, 3], colors: ["#fff", null, "#fff"], style: "line" } },
    boxes: [
      { left: 0, right: 2, top: 5, bottom: 1, xloc: "bar_index", borderColor: "red", borderWidth: 1, bgcolor: null },
      { left: -5, right: 999, top: 5, bottom: 1, xloc: "bar_index" },
      { left: 0, right: 1, top: Number.NaN, bottom: 1 },
    ],
  }, [10, 20, 30]);
  assert.equal(model.series[0].pane, "price");
  assert.deepEqual(model.series[0].points[1], { time: 20 }, "na values become whitespace gaps");
  assert.equal(model.boxes.length, 1);
  assert.deepEqual([model.boxes[0].leftTime, model.boxes[0].rightTime], [10, 30]);
});

test("empty runtime yields no output and default study title", () => {
  const model = buildPineRenderModel(null, [1, 2]);
  assert.equal(pineModelHasOutput(model), false);
  assert.equal(model.title, "Pine script");
});

test("TH-FEAT-09: fixture computes over 5000 bars within a time budget", async () => {
  const bars = syntheticBars(5000);
  const started = performance.now();
  const { runtime } = await runFixture(bars);
  const model = buildPineRenderModel(runtime, bars.time.map((ms) => ms / 1000));
  const elapsed = performance.now() - started;
  assert.equal(runtime.plots.Volume.data.length, 5000);
  assert.equal(runtime.plots["Volume EMA"].data.length, 5000);
  assert.ok(Number.isFinite(runtime.plots["Volume EMA"].data[4999]));
  assert.ok(pineModelHasOutput(model));
  // Generous ceiling for slow CI boxes; measured locally in the PR description.
  assert.ok(elapsed < 4000, `5000-bar Pine run took ${elapsed.toFixed(0)}ms`);
});
