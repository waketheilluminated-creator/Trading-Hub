import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { STUDY_CATALOG, filterStudyCatalog, legendEntries, studyDefinition } from "../lib/chart-studies.ts";

const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
const primitive = readFileSync(new URL("../lib/pivot-points-primitive.ts", import.meta.url), "utf8");
const legend = readFileSync(new URL("../components/chart-study-legend.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../components/pivot-points-settings.tsx", import.meta.url), "utf8");

function effectsDependingOn(name) {
  const out = [];
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\);/g;
  for (const match of workspace.matchAll(re)) {
    if (new RegExp(`\\b${name}\\b`).test(match[2])) out.push(match[1]);
  }
  return out;
}

test("Pivot Points High Low is an overlay study, added by default, with its own storage keys", () => {
  const study = studyDefinition("pivotsHl");
  assert.equal(study.name, "Pivot Points High Low");
  assert.equal(study.placement, "overlay");
  assert.equal(study.defaultAdded, true);
  assert.equal(study.addedKey, "th-study-pivots-hl");
  assert.equal(study.hiddenKey, "th-study-pivots-hl-hidden");
  assert.notEqual(studyDefinition("ema9").defaultAdded, true);
  assert.notEqual(studyDefinition("ema21").defaultAdded, true);
  assert.ok(STUDY_CATALOG.findIndex((item) => item.id === "ema21") < STUDY_CATALOG.findIndex((item) => item.id === "pivotsHl"));
  assert.deepEqual(filterStudyCatalog("pivot").map((item) => item.id), ["pivotsHl"]);
  const [row] = legendEntries({ pivotsHl: { added: true, hidden: false } });
  assert.equal(row.id, "pivotsHl");
  assert.equal(row.visible, true);
  assert.equal(row.title, "Pivot Points High Low");
});

test("the chart toggle persists with a default-on flag and an eye, without a server-rendered legend", () => {
  assert.match(workspace, /useStoredFlagDefault\(studyDefinition\("pivotsHl"\)\.addedKey, studyDefinition\("pivotsHl"\)\.defaultAdded === true\)/);
  assert.match(workspace, /\[pivotsHidden, setPivotsHidden\] = useStoredFlag\(studyDefinition\("pivotsHl"\)\.hiddenKey\)/);
  assert.match(workspace, /function useStoredFlagDefault\(key: string, fallback: boolean\)/);
  const hook = /function useStoredFlagDefault[\s\S]*?\n\}/.exec(workspace)?.[0] ?? "";
  assert.match(hook, /\(\) => false/);
  assert.match(legend, /data-icon=\{open \? "eye" : "eye-off"\}/);
  assert.match(legend, /title="Lengths"/);
  assert.doesNotMatch(settings, /<label\b/);
  assert.match(settings, /title=\{label\}/);
  assert.match(settings, /aria-label=\{label\}/);
  assert.match(settings, /label="Pivot high left bars"/);
  assert.match(settings, /label="Pivot low right bars"/);
});

test("showing pivot labels never rescales the chart and the primitive contributes no autoscale", () => {
  for (const toggle of ["showPivots", "pivotsHidden"]) {
    const bodies = effectsDependingOn(toggle);
    assert.equal(bodies.length, 1, toggle);
    for (const body of bodies) {
      assert.doesNotMatch(body, /setVisibleLogicalRange|setVisibleRange|fitContent|scrollToRealTime|scrollToPosition|resetTimeScale/, toggle);
      assert.doesNotMatch(body, /timeScale\(\)\.applyOptions|rightOffset/, toggle);
      assert.doesNotMatch(body, /priceScale\([^)]*\)\.applyOptions|autoScale/, toggle);
      assert.doesNotMatch(body, /addSeries|removeSeries|attachPrimitive/, toggle);
      assert.match(body, /setLabels\(showPivots && !pivotsHidden \? pivotLabels : \[\]\)/);
    }
  }
  assert.doesNotMatch(primitive, /autoscaleInfo|addSeries|setVisibleRange|fitContent/);
  assert.match(workspace, /attachPrimitive\(pivotPrimitive\)/);
  assert.match(workspace, /data-pivot-points=/);
});
