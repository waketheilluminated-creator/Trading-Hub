import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolbar = readFileSync(new URL("../components/drawing-toolbar.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");

test("the left rail is one library button, scrolling favorites, and a pinned utility group", () => {
  assert.match(toolbar, /aria-label="Drawing tools"/);
  assert.match(toolbar, /title="画线工具"/);
  assert.match(toolbar, /className="rail-top"/);
  assert.match(toolbar, /className="rail-favorites"/);
  assert.match(toolbar, /favorites\.map/);
  assert.match(toolbar, /className="rail-bottom"/);
  assert.match(toolbar, /role="dialog"/);
  assert.match(toolbar, /aria-label="画线工具库"/);
  assert.match(toolbar, /title="测量"/);
  assert.match(toolbar, /title="放大"/);
  assert.match(toolbar, /title="缩小"/);
  assert.match(toolbar, /title="磁铁：吸附到开高低收"/);
  assert.match(toolbar, /title="连续画线"/);
  assert.match(toolbar, /锁定全部画线/);
  assert.match(toolbar, /隐藏全部画线/);
  assert.match(toolbar, /REMOVAL_MENU\.map/);
  assert.match(toolbar, /removalPrompt\(/);
  assert.match(toolbar, /最多收藏 \{MAX_DRAWING_FAVORITES\} 个/);
  assert.match(toolbar, /MAX_DRAWING_FAVORITES/);
  assert.doesNotMatch(toolbar, /同步画线|Link drawings|sync drawings/);
  assert.match(css, /\.rail-bottom\s*\{[^}]*margin-top:\s*auto/);
  assert.match(css, /\.rail-favorites\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(workspace, /applyBarSpacingZoom/);
  assert.doesNotMatch(readFileSync(new URL("../lib/drawings/zoom.ts", import.meta.url), "utf8"), /fitContent|setVisibleLogicalRange|priceScale|autoScale/);
  const removal = workspace.slice(workspace.indexOf("const removeChartItems"), workspace.indexOf("const removeChartItems") + 700);
  assert.match(removal, /replaceDrawingsRef\.current\(\[\], "commit"\)/);
  assert.doesNotMatch(removal, /fitChartView|setVisibleLogicalRange|setVisibleRange|autoScale|barSpacing/);
});
