import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

function effectsDependingOn(src, name) {
  const out = [];
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/g;
  for (const match of src.matchAll(re)) if (new RegExp(`\\b${name}\\b`).test(match[2])) out.push(match[1]);
  return out;
}

test("mobile page is an installable standalone PWA without Pine", () => {
  const page = read("../app/mobile/page.tsx");
  const manifest = JSON.parse(read("../public/manifest.webmanifest"));
  const worker = read("../public/sw.js");
  assert.match(page, /appleWebApp:\s*\{[^}]*capable:\s*true/);
  assert.match(page, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(page, /viewportFit:\s*"cover"/);
  assert.doesNotMatch(page, /pine/i);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/mobile");
  assert.match(worker, /showNotification/);
  assert.match(worker, /addEventListener\("push"/);
  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
});

test("mobile overlay toggles never rescale the chart", () => {
  const src = read("../app/mobile/mobile-chart.tsx");
  assert.match(src, /fitChartView\(/);
  for (const toggle of ["showLiq", "showDrawings", "alertsOn"]) {
    const bodies = effectsDependingOn(src, toggle);
    assert.ok(bodies.length > 0, `${toggle} drives an effect`);
    for (const body of bodies) {
      assert.doesNotMatch(body, /setVisibleLogicalRange|setVisibleRange|fitContent|fitChartView|scrollToRealTime|scrollToPosition|resetTimeScale/, toggle);
      assert.doesNotMatch(body, /timeScale\(\)\.applyOptions|rightOffset/, toggle);
      assert.doesNotMatch(body, /priceScale\([^)]*\)\.applyOptions|autoScale/, toggle);
      assert.doesNotMatch(body, /addSeries|removeSeries/, toggle);
    }
  }
  assert.doesNotMatch(read("../lib/mobile/drawing-primitive.ts"), /autoscaleInfo/);
  assert.doesNotMatch(read("../lib/liq-heatmap-primitive.ts"), /autoscaleInfo/);
});
