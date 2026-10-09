import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDE_PANEL_COLLAPSED_KEY,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_WIDTH_KEY,
  clampSidePanelWidth,
  maxSidePanelWidth,
  readSidePanelPrefs,
  resolveSidePanelDrag,
  writeSidePanelPrefs,
} from "../lib/side-panel-layout.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

test("dragging the divider resizes the right panel within bounds", () => {
  assert.deepEqual(resolveSidePanelDrag(1600, 1600 - 360), { collapsed: false, width: 360 });
  assert.deepEqual(resolveSidePanelDrag(1600, 1600 - 180), { collapsed: false, width: SIDE_PANEL_MIN_WIDTH });
  assert.deepEqual(resolveSidePanelDrag(1600, 100), { collapsed: false, width: maxSidePanelWidth(1600) });
});

test("dragging the divider fully right collapses the panel", () => {
  assert.deepEqual(resolveSidePanelDrag(1600, 1600 - 40), { collapsed: true, width: null });
  assert.deepEqual(resolveSidePanelDrag(1600, 1600), { collapsed: true, width: null });
  assert.deepEqual(resolveSidePanelDrag(1600, Number.NaN), { collapsed: true, width: null });
});

test("width is clamped to half the viewport", () => {
  assert.equal(maxSidePanelWidth(800), 400);
  assert.equal(clampSidePanelWidth(9999, 800), 400);
  assert.equal(clampSidePanelWidth(10, 800), SIDE_PANEL_MIN_WIDTH);
  assert.equal(clampSidePanelWidth(Number.NaN, 800), SIDE_PANEL_DEFAULT_WIDTH);
});

test("prefs round-trip through storage and reject forged values", () => {
  const storage = memoryStorage();
  assert.deepEqual(readSidePanelPrefs(storage), { width: SIDE_PANEL_DEFAULT_WIDTH, collapsed: false });
  writeSidePanelPrefs(storage, { width: 333, collapsed: true });
  assert.deepEqual(readSidePanelPrefs(storage), { width: 333, collapsed: true });
  const forged = memoryStorage({ [SIDE_PANEL_WIDTH_KEY]: "1e9", [SIDE_PANEL_COLLAPSED_KEY]: "yes" });
  assert.deepEqual(readSidePanelPrefs(forged), { width: 640, collapsed: false });
  assert.deepEqual(readSidePanelPrefs(memoryStorage({ [SIDE_PANEL_WIDTH_KEY]: "abc" })).width, SIDE_PANEL_DEFAULT_WIDTH);
  assert.deepEqual(readSidePanelPrefs(null), { width: SIDE_PANEL_DEFAULT_WIDTH, collapsed: false });
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.deepEqual(readSidePanelPrefs(throwing), { width: SIDE_PANEL_DEFAULT_WIDTH, collapsed: false });
  assert.doesNotThrow(() => writeSidePanelPrefs(throwing, { width: 300, collapsed: false }));
});
