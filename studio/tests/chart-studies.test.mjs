import assert from "node:assert/strict";
import test from "node:test";
import { STUDY_CATALOG, filterStudyCatalog, isStudyId, legendEntries, studyLegendLabel } from "../lib/chart-studies.ts";

test("legend lists only added studies, keeping hidden ones marked invisible", () => {
  const entries = legendEntries({ ema9: { added: true, hidden: false }, cvd: { added: true, hidden: true }, oi: { added: false, hidden: false } });
  assert.deepEqual(entries.map((e) => [e.id, e.visible]), [["ema9", true], ["cvd", false]]);
  assert.equal(studyLegendLabel(entries[0]), "EMA 9 close");
});

test("legend titles can be overridden with live labels", () => {
  const [entry] = legendEntries({ cvd: { added: true, hidden: false } }, { cvd: "CVD · Spot" });
  assert.equal(entry.title, "CVD · Spot");
});

test("catalog search matches name, params and description", () => {
  assert.deepEqual(filterStudyCatalog("").length, STUDY_CATALOG.length);
  assert.deepEqual(filterStudyCatalog("ema").map((s) => s.id), ["ema9", "ema21"]);
  assert.deepEqual(filterStudyCatalog("open interest").map((s) => s.id), ["oi"]);
  assert.deepEqual(filterStudyCatalog("nope"), []);
});

test("CVD and OI keep their existing pane storage keys", () => {
  assert.equal(STUDY_CATALOG.find((s) => s.id === "cvd").addedKey, "th-pane-cvd");
  assert.equal(STUDY_CATALOG.find((s) => s.id === "oi").addedKey, "th-pane-oi");
  assert.equal(isStudyId("cvd"), true);
  assert.equal(isStudyId("__proto__"), false);
});
