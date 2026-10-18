import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { replayStepFromKey, stepReplayCursor, sliceReplayCandles } from "../lib/replay/replay-state.ts";

const key = (k, mods = {}) => ({ key: k, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test("Shift+→ steps forward, Shift+← steps back (replay active, not typing)", () => {
  assert.equal(replayStepFromKey(key("ArrowRight"), true, false), 1);
  assert.equal(replayStepFromKey(key("ArrowLeft"), true, false), -1);
});

test("ignored: replay inactive, typing in input/textarea/contenteditable, no Shift, extra modifiers, other keys", () => {
  assert.equal(replayStepFromKey(key("ArrowRight"), false, false), null, "live mode");
  assert.equal(replayStepFromKey(key("ArrowRight"), true, true), null, "focus in an editable");
  assert.equal(replayStepFromKey(key("ArrowRight", { shiftKey: false }), true, false), null, "plain arrow");
  for (const m of ["ctrlKey", "metaKey", "altKey"]) assert.equal(replayStepFromKey(key("ArrowLeft", { [m]: true }), true, false), null, m);
  for (const k of ["ArrowUp", "ArrowDown", "Right", "l", "Enter"]) assert.equal(replayStepFromKey(key(k), true, false), null, k);
});

test("stepping is clamped at the first and last candle; one step = exactly one bar", () => {
  const candles = [100, 160, 220, 280].map((time) => ({ time }));
  assert.equal(stepReplayCursor(candles, 160, 1), 220);
  assert.equal(stepReplayCursor(candles, 160, -1), 100);
  assert.equal(stepReplayCursor(candles, 280, 1), 280, "end of data");
  assert.equal(stepReplayCursor(candles, 100, -1), 100, "start of data");
  let cursor = 100;
  for (let i = 0; i < 10; i += 1) cursor = stepReplayCursor(candles, cursor, 1);
  assert.equal(cursor, 280);
  assert.equal(sliceReplayCandles(candles, stepReplayCursor(candles, 160, 1)).length, 3, "one more bar visible");
});

test("workspace wiring: capture-phase listener only while replay is active; editable check; preventDefault; same stepReplay as the buttons", () => {
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  const block = ws.match(/useEffect\(\(\) => \{\n\s+if \(!replayActive\) return;[\s\S]*?\}, \[replayActive, stepReplay\]\);/)?.[0];
  assert.ok(block, "listener effect gated on replayActive");
  assert.match(block, /replayStepFromKey\(event, true, isTextEditingElement\(event\.target\) \|\| isTextEditingElement\(document\.activeElement\)\)/);
  assert.match(block, /if \(direction == null\) return;\s+event\.preventDefault\(\);/);
  assert.match(block, /stepReplay\(direction\)/);
  assert.match(block, /addEventListener\("keydown", onKey, true\)/);
  assert.match(block, /removeEventListener\("keydown", onKey, true\)/);
  assert.doesNotMatch(block, /timeScale|setVisible|fitContent|scrollTo/, "stepping never touches zoom/position");
  assert.match(ws, /const nextTime = stepReplayCursor\(candlesRef\.current, current\.cursor, direction\);/);
  assert.match(ws, /isContentEditable \|\| target\.tagName === "INPUT" \|\| target\.tagName === "TEXTAREA"/);
});
