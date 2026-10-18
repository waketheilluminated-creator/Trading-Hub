import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REPLAY_EXIT_LABEL, REPLAY_PICK_HINT, REPLAY_TOOLTIP, REPLAY_TOOLTIP_ON } from "../lib/replay/replay-state.ts";

const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("../components/replay-icons.tsx", import.meta.url), "utf8");
const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);
const buttonFor = (label) => ws.match(new RegExp(`<button[^\\n]*?aria-label=${label}[^\\n]*?["}]>([^\\n]*?)</button>`));

test("toolbar replay button is icon-only: SVG child, no text label, Chinese tooltip, aria-label", () => {
  const m = buttonFor('"Bar replay"');
  assert.ok(m, "replay button");
  assert.equal(m[1].trim(), "<ReplayIcon />", "only the icon inside");
  assert.match(m[0], /title=\{replay \? REPLAY_TOOLTIP_ON : REPLAY_TOOLTIP\}/);
  assert.ok(hasCjk(REPLAY_TOOLTIP) && hasCjk(REPLAY_TOOLTIP_ON));
  assert.doesNotMatch(ws, /> Replay<\/button>|⏪/);
});

test("replay controls are icon-first: every button holds an icon, has an aria-label and a Chinese tooltip", () => {
  const cases = [['"Step back"', "<StepBackIcon />", "后退一根"], ['"Step forward"', "<StepForwardIcon />", "前进一根"], ['"Exit replay"', "<ExitReplayIcon />", null]];
  for (const [label, icon, tip] of cases) {
    const m = buttonFor(label);
    assert.ok(m, label);
    assert.equal(m[1].trim(), icon, `${label} content`);
    if (tip) assert.match(m[0], new RegExp(`title="${tip}`));
  }
  assert.match(buttonFor('"Exit replay"')[0], /title=\{REPLAY_EXIT_LABEL\}/);
  assert.equal(REPLAY_EXIT_LABEL, "回到实时");
  const play = ws.match(/<button[^\n]*?aria-label=\{replay\.playing \? "Pause replay" : "Play replay"\}[^\n]*?\}\)\}>([^\n]*?)<\/button>/);
  assert.ok(play);
  assert.equal(play[1].trim(), "{replay.playing ? <PauseIcon /> : <PlayIcon />}");
  assert.match(play[0], /title=\{replay\.playing \? "暂停" : "播放"\}/);
  assert.match(ws, /<select aria-label="Replay speed" title="回放速度"/);
  const controls = ws.match(/<div className="replay-controls"[\s\S]*?\n\s+<\/div>\}/)?.[0];
  assert.ok(controls, "replay controls block");
  assert.doesNotMatch(controls, /REPLAY · |[⏮⏭▶]|❚❚|Exit replay<|Replay</, "no text/emoji glyphs left in replay controls");
  assert.ok(!/Click a candle/.test(REPLAY_PICK_HINT) && hasCjk(REPLAY_PICK_HINT), "hint is Chinese only");
});

test("icons: decorative SVGs (aria-hidden, currentColor) so the button aria-label is the accessible name", () => {
  for (const name of ["ReplayIcon", "StepBackIcon", "StepForwardIcon", "PlayIcon", "PauseIcon", "ExitReplayIcon"]) assert.match(icons, new RegExp(`export const ${name} = `));
  assert.match(icons, /aria-hidden="true"/);
  assert.match(icons, /stroke="currentColor"/);
});
