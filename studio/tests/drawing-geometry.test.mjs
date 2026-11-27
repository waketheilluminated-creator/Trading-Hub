import assert from "node:assert/strict";
import test from "node:test";
import { arrowHead, buildScreenDrawings, distanceToSegment, hitTestDrawing, translateDrawing } from "../lib/drawings/geometry.ts";
import * as drawingGeometry from "../lib/drawings/geometry.ts";
import { DrawingPrimitive } from "../lib/drawings/primitive.ts";

function attachPrimitive(primitive, requestUpdate = () => {}) {
  primitive.attached({
    chart: {
      timeScale: () => ({
        timeToCoordinate: (time) => time / 10,
        coordinateToTime: (x) => x * 10,
      }),
    },
    series: {
      priceToCoordinate: (price) => price,
      coordinateToPrice: (y) => y,
    },
    requestUpdate,
  });
}

test("measures segment distance and clamps beyond endpoints", () => {
  assert.equal(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});

test("calculates signed absolute and percentage price change", () => {
  assert.equal(typeof drawingGeometry.priceChangeMetrics, "function");
  assert.deepEqual(drawingGeometry.priceChangeMetrics(100, 112.5), { absolute: 12.5, percent: 12.5 });
  assert.deepEqual(drawingGeometry.priceChangeMetrics(100, 80), { absolute: -20, percent: -20 });
});

test("prefers endpoint handles over a line body", () => {
  const screen = { id: "d-1", type: "trend-line", points: [{ x: 10, y: 10 }, { x: 100, y: 100 }] };
  assert.deepEqual(hitTestDrawing(screen, { x: 12, y: 11 }, 8), { drawingId: "d-1", part: "point-0" });
  assert.deepEqual(hitTestDrawing(screen, { x: 55, y: 54 }, 8), { drawingId: "d-1", part: "body" });
});

test("builds a finite arrow head and translates all anchors", () => {
  assert.equal(arrowHead({ x: 0, y: 0 }, { x: 20, y: 0 }, 8).length, 3);
  const moved = translateDrawing({ points: [{ time: 100, price: 10 }, { time: 200, price: 20 }] }, 30, 5);
  assert.deepEqual(moved.points, [{ time: 130, price: 15 }, { time: 230, price: 25 }]);
});

test("omits unresolvable drawings and preserves front-to-back order", () => {
  const drawings = [
    { id: "back", type: "trend-line", points: [{ time: 100, price: 10 }, { time: 200, price: 20 }], style: { color: "#fff", lineWidth: 2 }, createdAt: 1, updatedAt: 1 },
    { id: "invalid", type: "horizontal-line", points: [{ time: 100, price: -1 }], style: { color: "#fff", lineWidth: 2 }, createdAt: 1, updatedAt: 1 },
    { id: "front", type: "horizontal-line", points: [{ time: 200, price: 30 }], style: { color: "#fff", lineWidth: 2 }, createdAt: 1, updatedAt: 1 },
  ];
  const mockApi = {
    timeToCoordinate: (time) => time / 10,
    priceToCoordinate: (price) => price < 0 ? null : price,
  };

  const scene = buildScreenDrawings(drawings, [100, 200], mockApi);

  assert.deepEqual(scene.map((item) => item.id), ["back", "front"]);
  assert.deepEqual(scene.map((item) => item.points), [
    [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    [{ x: 20, y: 30 }],
  ]);
});

test("uses the frontmost shared scene hit and preserves controller hit parts", () => {
  const primitive = new DrawingPrimitive();
  attachPrimitive(primitive);
  const drawings = ["back", "front"].map((id) => ({
    id,
    type: "trend-line",
    points: [{ time: 100, price: 10 }, { time: 1000, price: 100 }],
    style: { color: "#fff", lineWidth: 2 },
    createdAt: 1,
    updatedAt: 1,
  }));
  primitive.setState(drawings, { phase: "selected", selectedId: "front" }, [100, 1000]);

  assert.deepEqual(primitive.hitTestDrawing({ x: 10, y: 10 }), { drawingId: "front", part: "point-0" });
  assert.deepEqual(primitive.hitTest(10, 10), {
    externalId: "drawing:front:point-0",
    cursorStyle: "grab",
    zOrder: "top",
  });
  assert.equal(primitive.hitTest(55, 55)?.cursorStyle, "move");

  primitive.setState(drawings, { phase: "idle" }, [100, 1000]);
  assert.equal(primitive.hitTest(55, 55)?.cursorStyle, "pointer");
});

test("rebuilds cached state when attached and clears hits when detached", () => {
  const primitive = new DrawingPrimitive();
  const drawing = {
    id: "line",
    type: "horizontal-line",
    points: [{ time: 100, price: 10 }],
    style: { color: "#fff", lineWidth: 2 },
    createdAt: 1,
    updatedAt: 1,
  };
  primitive.setState([drawing], { phase: "idle" }, [100]);
  assert.equal(primitive.hitTestDrawing({ x: 10, y: 10 }), null);

  let updates = 0;
  attachPrimitive(primitive, () => { updates += 1; });
  assert.deepEqual(primitive.hitTestDrawing({ x: 80, y: 10 }), { drawingId: "line", part: "body" });
  assert.equal(primitive.paneViews()[0].zOrder(), "top");
  assert.equal(updates, 1);

  primitive.detached();
  assert.equal(primitive.hitTestDrawing({ x: 80, y: 10 }), null);
});

test("renders arrows labels and selected handles in media coordinates", () => {
  const primitive = new DrawingPrimitive();
  attachPrimitive(primitive);
  primitive.setState([
    {
      id: "arrow",
      type: "arrow",
      points: [{ time: 100, price: 10 }, { time: 1000, price: 100 }],
      style: { color: "#0f0", lineWidth: 2 },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "label",
      type: "text",
      points: [{ time: 200, price: 30 }],
      text: "Breakout",
      style: { color: "#fff", lineWidth: 2 },
      createdAt: 1,
      updatedAt: 1,
    },
  ], { phase: "selected", selectedId: "arrow" }, [100, 200, 1000]);

  const calls = [];
  const context = new Proxy({}, {
    get: (_target, property) => (...args) => { calls.push([property, ...args]); },
    set: () => true,
  });
  let usedMediaCoordinates = false;
  primitive.paneViews()[0].renderer().draw({
    useMediaCoordinateSpace(callback) {
      usedMediaCoordinates = true;
      callback({ context, mediaSize: { width: 400, height: 200 } });
    },
  });

  assert.equal(usedMediaCoordinates, true);
  assert.ok(calls.some(([method]) => method === "roundRect"));
  assert.ok(calls.some(([method]) => method === "fillText"));
  assert.ok(calls.filter(([method]) => method === "arc").length >= 2);
  assert.ok(calls.filter(([method]) => method === "fill").length >= 2);
});

test("renders temporary price-change measurement values from its session", () => {
  const primitive = new DrawingPrimitive();
  attachPrimitive(primitive);
  primitive.setState([], {
    phase: "measured",
    tool: "price-change",
    start: { time: 100, price: 10 },
    end: { time: 200, price: 20 },
  }, [100, 200]);

  const calls = [];
  const context = new Proxy({}, {
    get: (_target, property) => (...args) => { calls.push([property, ...args]); },
    set: () => true,
  });
  primitive.paneViews()[0].renderer().draw({
    useMediaCoordinateSpace(callback) {
      callback({ context, mediaSize: { width: 400, height: 200 } });
    },
  });

  const labels = calls.filter(([method]) => method === "fillText").map(([, label]) => label);
  assert.ok(labels.some((label) => label.includes("+100.00%")));
  assert.ok(labels.some((label) => label.includes("10.00 → 20.00")));
  assert.ok(calls.some(([method]) => method === "fillRect"));
});

test("rubber-band preview draws an anchor dot and the live segment", () => {
  const primitive = new DrawingPrimitive();
  attachPrimitive(primitive);
  const draw = () => {
    const calls = [];
    const context = new Proxy({}, {
      get: (_target, property) => (...args) => { calls.push([property, ...args]); },
      set: (_target, property, value) => { calls.push(["set", property, value]); return true; },
    });
    primitive.paneViews()[0].renderer().draw({
      useMediaCoordinateSpace(callback) {
        callback({ context, mediaSize: { width: 400, height: 200 } });
      },
    });
    return calls;
  };

  primitive.setState([], {
    phase: "previewing",
    tool: "trend-line",
    start: { time: 100, price: 10 },
    preview: { time: 100, price: 10 },
  }, [100]);
  assert.ok(draw().some(([method]) => method === "arc"), "anchor dot");

  primitive.setState([], {
    phase: "previewing",
    tool: "trend-line",
    start: { time: 100, price: 10 },
    preview: { time: 1000, price: 80 },
  }, [100, 1000]);
  const live = draw();
  assert.ok(live.some(([method, x, y]) => method === "lineTo" && x === 100 && y === 80));
});

test("hiding drawings drops them from hit testing and hover highlights a visible line", () => {
  const primitive = new DrawingPrimitive();
  attachPrimitive(primitive);
  const drawing = {
    id: "line",
    type: "horizontal-line",
    points: [{ time: 100, price: 10 }],
    style: { color: "#fff", lineWidth: 2 },
    createdAt: 1,
    updatedAt: 1,
  };
  primitive.setState([drawing], { phase: "idle" }, [100]);
  assert.deepEqual(primitive.hitTestDrawing({ x: 40, y: 10 }), { drawingId: "line", part: "body" });
  primitive.setHidden(true);
  assert.equal(primitive.hitTestDrawing({ x: 40, y: 10 }), null);
  primitive.setHidden(false);
  primitive.setHovered("line");
  const calls = [];
  const context = new Proxy({}, {
    get: (_target, property) => (...args) => { calls.push([property, ...args]); },
    set: (_target, property, value) => { calls.push(["set", property, value]); return true; },
  });
  primitive.paneViews()[0].renderer().draw({
    useMediaCoordinateSpace(callback) {
      callback({ context, mediaSize: { width: 400, height: 200 } });
    },
  });
  assert.ok(calls.some(([kind, prop, value]) => kind === "set" && prop === "globalAlpha" && value === 0.22));
});
