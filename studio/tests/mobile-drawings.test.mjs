import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTap,
  historyCommit,
  historyInit,
  historyRedo,
  historyUndo,
  hitMobileDrawing,
  loadMobileDrawings,
  mobileDrawingKey,
  saveMobileDrawings,
} from "../lib/mobile/drawings.ts";

const point = (time, price) => ({ time, price });
const memory = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test("two taps place a trendline and a rectangle; one tap places a horizontal line", () => {
  let ids = 0;
  const nextId = () => `d-${++ids}`;
  const trend = applyTap("trend-line", null, [], point(10, 100), 1, nextId());
  assert.equal(trend.committed, false);
  assert.equal(trend.drawings.length, 0);
  const trendDone = applyTap("trend-line", trend.draft, trend.drawings, point(20, 110), 2, nextId());
  assert.equal(trendDone.committed, true);
  assert.equal(trendDone.drawings[0].type, "trend-line");
  assert.equal(trendDone.drawings[0].ray, false);
  assert.deepEqual(trendDone.drawings[0].a, point(10, 100));
  assert.deepEqual(trendDone.drawings[0].b, point(20, 110));

  const box = applyTap("rectangle", { tool: "rectangle", start: point(1, 5) }, [], point(4, 9), 3, nextId());
  assert.equal(box.drawings[0].type, "rectangle");
  assert.equal(box.drawings[0].alert, false);

  const flat = applyTap("horizontal-line", null, [], point(8, 42), 4, nextId());
  assert.equal(flat.committed, true);
  assert.equal(flat.drawings[0].type, "horizontal-line");
  assert.equal(flat.drawings[0].price, 42);
});

test("drawings persist per symbol and timeframe and drop forged rows", () => {
  const storage = memory();
  assert.equal(mobileDrawingKey("BTCUSDT", "30"), "th-mobile-drawings:v1:BTCUSDT:30");
  const drawings = [{
    id: "d-1", type: "horizontal-ray", alert: true, time: 10, price: 80, dir: "right",
  }];
  assert.equal(saveMobileDrawings(storage, "BTCUSDT", "30", drawings), true);
  assert.deepEqual(loadMobileDrawings(storage, "BTCUSDT", "30"), drawings);
  assert.deepEqual(loadMobileDrawings(storage, "ETHUSDT", "30"), []);
  storage.setItem(mobileDrawingKey("BTCUSDT", "30"), JSON.stringify({
    version: 1,
    drawings: [drawings[0], { id: "bad", type: "trend-line", alert: true }, { id: "", type: "text", text: "x", time: 1, price: 1 }],
  }));
  assert.deepEqual(loadMobileDrawings(storage, "BTCUSDT", "30").map((item) => item.id), ["d-1"]);
  storage.setItem(mobileDrawingKey("SOLUSDT", "1"), "{");
  assert.deepEqual(loadMobileDrawings(storage, "SOLUSDT", "1"), []);
});

test("undo and redo restore drawing snapshots", () => {
  const first = [{ id: "a", type: "text", alert: false, time: 1, price: 2, text: "A" }];
  const second = [...first, { id: "b", type: "text", alert: false, time: 3, price: 4, text: "B" }];
  let history = historyCommit(historyInit(first), second);
  history = historyUndo(history);
  assert.deepEqual(history.present, first);
  history = historyRedo(history);
  assert.deepEqual(history.present, second);
  assert.equal(historyRedo(history).present.length, 2);
});

test("screen hit prefers endpoints, hits a ray past the second anchor, and misses outside a segment", () => {
  const project = (p) => ({ x: p.time, y: 100 - p.price });
  const segment = {
    id: "seg", type: "trend-line", alert: false, ray: false,
    a: point(0, 0), b: point(100, 0),
  };
  assert.equal(hitMobileDrawing(segment, { x: 2, y: 99 }, project, 8, 400)?.part, "p0");
  assert.equal(hitMobileDrawing(segment, { x: 50, y: 98 }, project, 8, 400)?.part, "body");
  assert.equal(hitMobileDrawing(segment, { x: 180, y: 100 }, project, 8, 400), null);
  const ray = { ...segment, id: "ray", ray: true };
  assert.equal(hitMobileDrawing(ray, { x: 180, y: 100 }, project, 8, 400)?.part, "body");
  const box = {
    id: "box", type: "rectangle", alert: true,
    a: point(10, 10), b: point(80, 40),
  };
  assert.equal(hitMobileDrawing(box, { x: 40, y: 70 }, project, 6, 400)?.part, "body");
  assert.equal(hitMobileDrawing(box, { x: 200, y: 70 }, project, 6, 400), null);
});
