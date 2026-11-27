import assert from "node:assert/strict";
import test from "node:test";
import { DRAWING_CATEGORIES, DRAWING_TOOL_CATALOG, groupedDrawingCatalog } from "../lib/drawings/catalog.ts";
import { initialDrawingModes, toggleDrawingMode } from "../lib/drawings/modes.ts";
import { REMOVAL_MENU, removableIndicatorIds, removalPrompt } from "../lib/drawings/removal.ts";

const LIBRARY_TOOLS = ["select", "crosshair", "trend-line", "horizontal-line", "text", "arrow"];

test("every library tool maps onto a TradingView category and empty sections stay hidden", () => {
  assert.deepEqual(DRAWING_CATEGORIES.map((category) => category.id), [
    "cursors", "lines", "channels", "fibonacci", "patterns", "shapes", "annotation", "arrows",
  ]);
  assert.deepEqual(DRAWING_TOOL_CATALOG.map((tool) => tool.tool), LIBRARY_TOOLS);
  for (const tool of DRAWING_TOOL_CATALOG) {
    assert.ok(DRAWING_CATEGORIES.some((category) => category.id === tool.category), tool.tool);
    assert.ok(tool.name.length > 0);
    assert.ok(tool.title.length > 0);
  }
  const grouped = groupedDrawingCatalog();
  assert.deepEqual(grouped.map((group) => group.id), ["cursors", "lines", "annotation", "arrows"]);
  assert.deepEqual(grouped.flatMap((group) => group.tools.map((tool) => tool.tool)), LIBRARY_TOOLS);
  assert.ok(grouped.every((group) => group.title && group.tools.length > 0));
});

test("drawing mode toggles do not disturb the other flags", () => {
  assert.deepEqual(initialDrawingModes, { magnet: false, continuous: false, locked: false, hidden: false });
  const magnet = toggleDrawingMode(initialDrawingModes, "magnet");
  assert.equal(magnet.magnet, true);
  assert.equal(magnet.continuous, false);
  assert.equal(toggleDrawingMode(magnet, "magnet").magnet, false);
  assert.equal(toggleDrawingMode(initialDrawingModes, "locked").locked, true);
  assert.equal(toggleDrawingMode(initialDrawingModes, "hidden").hidden, true);
  assert.equal(toggleDrawingMode(initialDrawingModes, "continuous").continuous, true);
});

test("removal menu labels and confirm prompts include the live counts", () => {
  assert.deepEqual(REMOVAL_MENU.map((item) => item.label), ["删除所有画线", "删除所有指标", "删除画线和指标"]);
  assert.deepEqual(REMOVAL_MENU.map((item) => item.kind), ["drawings", "indicators", "both"]);
  assert.equal(removalPrompt("drawings", 5, 2), "删除 5 条画线？");
  assert.equal(removalPrompt("indicators", 5, 3), "删除 3 个指标？");
  assert.equal(removalPrompt("both", 5, 3), "删除 5 条画线和 3 个指标？");
  assert.deepEqual(removableIndicatorIds({ ema9: true, ema21: false, cvd: true, oi: false, pine: true }), ["ema9", "cvd", "pine"]);
  assert.deepEqual(removableIndicatorIds({ ema9: false, ema21: false, cvd: false, oi: false, pine: false }), []);
});
