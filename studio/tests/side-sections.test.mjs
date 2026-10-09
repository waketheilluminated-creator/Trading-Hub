import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("all right-panel sections use the shared collapsible SideSection", () => {
  const start = workspace.indexOf('<aside className="right-panel"');
  assert.notEqual(start, -1);
  const panel = workspace.slice(start, workspace.indexOf("</aside>", start));
  for (const [title, key] of [["Derivatives pulse", "DERIVATIVES_SECTION_KEY"], ["Order flow", "ORDER_FLOW_SECTION_KEY"], ["Alerts", "ALERTS_SECTION_KEY"]]) {
    assert.match(panel, new RegExp(`<SideSection[\\s\\S]{0,40}title="${title}"[\\s\\S]{0,40}storageKey=\\{${key}\\}`), title);
  }
  assert.doesNotMatch(panel, /<section className="side-section"/, "no hand-rolled, non-collapsible sections");
  assert.match(workspace, /const ALERTS_SECTION_KEY = "th-section-alerts-open"/);
});

test("section open state is SSR-safe and persisted through the pane-prefs store", () => {
  assert.match(workspace, /useSyncExternalStore\(subscribePanePrefs, \(\) => readLiveSectionOpen\(storageKey\), \(\) => true\)/);
  assert.match(workspace, /if \(!panePrefsAreLive\(\)\) return true;/);
  assert.match(workspace, /writeStoredFlag\(window\.localStorage, storageKey, !readStoredFlag\(window\.localStorage, storageKey, true\)\)/);
  assert.doesNotMatch(workspace, /useState\(\(\) => readSectionOpen/, "lazy useState read caused hydration mismatches");
});

test("toggle is a real button with aria-expanded/aria-controls, the body is hidden when collapsed", () => {
  assert.match(workspace, /<button type="button" className="section-toggle" aria-expanded=\{open\} aria-controls=\{panelId\}/);
  assert.match(workspace, /<div id=\{panelId\} hidden=\{!open\}>/);
  assert.match(css, /\.section-chevron\.open \{ transform:rotate\(90deg\); \}/);
  assert.match(css, /\.section-toggle:focus-visible \{ outline:2px solid var\(--accent\)/);
  // Theme-neutral: toggle colours only use tokens, so light/dark both apply.
  const toggleRules = css.split("\n").filter((line) => /^\.section-(toggle|badge|chevron)/.test(line));
  for (const rule of toggleRules) assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgba?\(/i, rule);
});
