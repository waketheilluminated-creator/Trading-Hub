import assert from "node:assert/strict";
import test from "node:test";
import { DrawingController, initialDrawingSession, reduceDrawingSession } from "../lib/drawings/controller.ts";

const p1 = { time: 100, price: 10 };
const p2 = { time: 200, price: 20 };
const trend = {
  id: "d-1", type: "trend-line", points: [p1, p2],
  style: { color: "#76e7a4", lineWidth: 2 }, createdAt: 1, updatedAt: 1,
};

test("creates a two-point preview then commits it", () => {
  let state = reduceDrawingSession(initialDrawingSession, { type: "BEGIN", tool: "trend-line", point: p1 });
  state = reduceDrawingSession(state, { type: "PREVIEW", point: p2 });
  assert.equal(state.phase, "previewing");
  const result = reduceDrawingSession(state, { type: "COMMIT", point: p2, id: "d-1", now: 5 });
  assert.equal(result.phase, "selected");
  assert.equal(result.committed?.id, "d-1");
  assert.deepEqual(result.committed?.points, [p1, p2]);
});

test("keeps a completed price-change measurement temporary in session state", () => {
  let state = reduceDrawingSession(initialDrawingSession, { type: "BEGIN", tool: "price-change", point: p1 });
  assert.deepEqual(state, { phase: "measuring", tool: "price-change", start: p1, preview: p1 });

  state = reduceDrawingSession(state, { type: "PREVIEW", point: p2 });
  assert.deepEqual(state, { phase: "measuring", tool: "price-change", start: p1, preview: p2 });

  state = reduceDrawingSession(state, { type: "MEASURE_END", point: p2 });
  assert.deepEqual(state, { phase: "measured", tool: "price-change", start: p1, end: p2 });
  assert.equal(state.committed, undefined);
});

test("commits horizontal line immediately and cancels transient state", () => {
  const result = reduceDrawingSession(initialDrawingSession, { type: "BEGIN", tool: "horizontal-line", point: p1, id: "d-2", now: 6 });
  assert.equal(result.committed?.type, "horizontal-line");
  assert.deepEqual(reduceDrawingSession(result, { type: "CANCEL" }), initialDrawingSession);
});

test("selects and clears a drawing", () => {
  const selected = reduceDrawingSession(initialDrawingSession, { type: "SELECT", drawingId: "d-1" });
  assert.deepEqual(selected, { phase: "selected", selectedId: "d-1" });
  assert.deepEqual(reduceDrawingSession(selected, { type: "CLEAR_SELECTION" }), initialDrawingSession);
});

test("Escape cancellation and pointer cancellation return to idle", () => {
  const preview = reduceDrawingSession(
    { phase: "placing-first", tool: "trend-line", start: p1 },
    { type: "PREVIEW", point: p2 },
  );
  assert.deepEqual(reduceDrawingSession(preview, { type: "CANCEL" }), initialDrawingSession);
  const dragging = { phase: "dragging", selectedId: "d-1", part: "body", origin: p1, original: trend };
  assert.deepEqual(reduceDrawingSession(dragging, { type: "CANCEL" }), { phase: "selected", selectedId: "d-1" });
});

test("blank text never creates a drawing", () => {
  const placing = reduceDrawingSession(initialDrawingSession, { type: "BEGIN", tool: "text", point: p1 });
  const result = reduceDrawingSession(placing, { type: "TEXT_COMMIT", text: "   ", id: "d-2", now: 6 });
  assert.equal(result.committed, undefined);
});

test("drag updates only the selected endpoint", () => {
  const dragging = reduceDrawingSession(
    { phase: "selected", selectedId: "d-1" },
    { type: "START_DRAG", drawing: trend, part: "point-1", point: p2 },
  );
  const result = reduceDrawingSession(dragging, { type: "DRAG", point: { time: 250, price: 25 }, now: 7 });
  assert.deepEqual(result.updated?.points, [p1, { time: 250, price: 25 }]);
});

function createController(tool) {
  const chartOptions = [];
  const controller = new DrawingController({
    chart: {
      applyOptions: (options) => chartOptions.push(options),
      timeScale: () => ({ coordinateToTime: (x) => x }),
    },
    series: { coordinateToPrice: (y) => y },
    getDrawings: () => [],
    replaceDrawings() {},
    getTool: () => tool.current,
    setTool: (next) => { tool.current = next; },
    requestRender() {},
    requestText() {},
    hitTest: () => null,
    createId: () => "d-test",
    now: () => 1,
  });
  return { chartOptions, controller };
}

function pointerEvent() {
  let prevented = false;
  return {
    clientX: 100,
    clientY: 10,
    pointerId: 1,
    preventDefault() { prevented = true; },
    get prevented() { return prevented; },
  };
}

function createControllerHarness({
  initialDrawings = [trend],
  initialTool = "select",
  hit = { drawingId: "d-1", part: "point-1" },
} = {}) {
  let drawings = [...initialDrawings];
  const tool = { current: initialTool };
  const changes = [];
  const chartOptions = [];
  const cancellations = [];
  const textRequests = [];
  const controller = new DrawingController({
    chart: {
      applyOptions: (options) => chartOptions.push(options),
      timeScale: () => ({ coordinateToTime: (x) => x }),
    },
    series: { coordinateToPrice: (y) => y },
    getDrawings: () => drawings,
    replaceDrawings(next, kind) {
      drawings = next;
      changes.push({ drawings: next, kind });
    },
    getTool: () => tool.current,
    setTool: (next) => { tool.current = next; },
    requestRender() {},
    requestText: (point) => textRequests.push(point),
    onCancel: () => cancellations.push("cancel"),
    hitTest: () => hit,
    createId: () => "d-new",
    now: () => 10,
  });
  return { cancellations, changes, chartOptions, controller, getDrawings: () => drawings, textRequests, tool };
}

function createMovedDragHarness() {
  const harness = createControllerHarness();
  harness.controller.onPointerDown(pointerEvent());
  harness.controller.onPointerMove({ ...pointerEvent(), clientX: 250, clientY: 25 });
  assert.deepEqual(harness.getDrawings()[0].points, [p1, { time: 250, price: 25 }]);
  return harness;
}

function createTextPlacementHarness() {
  const harness = createControllerHarness({ initialDrawings: [], initialTool: "text", hit: null });
  harness.controller.onPointerDown(pointerEvent());
  assert.equal(harness.controller.getSession().phase, "placing-first");
  assert.equal(harness.textRequests.length, 1);
  return harness;
}

test("changing to Crosshair cancels an active drawing and passes pointer movement through", () => {
  const tool = { current: "trend-line" };
  const { chartOptions, controller } = createController(tool);
  controller.onPointerDown(pointerEvent());
  assert.deepEqual(chartOptions, [{ handleScroll: false, handleScale: false }]);

  tool.current = "crosshair";
  const move = pointerEvent();
  controller.onPointerMove(move);

  assert.equal(move.prevented, false);
  assert.deepEqual(controller.getSession(), initialDrawingSession);
  assert.equal(tool.current, "crosshair");
  assert.deepEqual(chartOptions.at(-1), { handleScroll: true, handleScale: true });
});

test("changing to Select cancels an active drawing before an empty chart click", () => {
  const tool = { current: "arrow" };
  const { chartOptions, controller } = createController(tool);
  controller.onPointerDown(pointerEvent());
  assert.deepEqual(chartOptions, [{ handleScroll: false, handleScale: false }]);

  tool.current = "select";
  const down = pointerEvent();
  controller.onPointerDown(down);

  assert.equal(down.prevented, false);
  assert.deepEqual(controller.getSession(), initialDrawingSession);
  assert.deepEqual(chartOptions.at(-1), { handleScroll: true, handleScale: true });
});

test("first click starts a live price-change preview and second click completes it", () => {
  const h = createControllerHarness({ initialDrawings: [], initialTool: "price-change", hit: null });

  h.controller.onPointerDown(pointerEvent());
  h.controller.onPointerUp(pointerEvent());
  assert.deepEqual(h.controller.getSession(), {
    phase: "measuring",
    tool: "price-change",
    start: p1,
    preview: p1,
  });

  h.controller.onPointerMove({ ...pointerEvent(), clientX: 200, clientY: 20 });
  assert.deepEqual(h.controller.getSession(), {
    phase: "measuring",
    tool: "price-change",
    start: p1,
    preview: p2,
  });

  h.controller.onPointerDown({ ...pointerEvent(), clientX: 200, clientY: 20 });

  assert.deepEqual(h.controller.getSession(), {
    phase: "measured",
    tool: "price-change",
    start: p1,
    end: p2,
  });
  assert.deepEqual(h.getDrawings(), []);
  assert.deepEqual(h.changes, []);
  assert.deepEqual(h.chartOptions, [
    { handleScroll: false, handleScale: false },
    { handleScroll: true, handleScale: true },
  ]);
  assert.equal(h.tool.current, "price-change");
});

function createMutationController(initialDrawings = []) {
  let drawings = initialDrawings;
  const changes = [];
  const controller = new DrawingController({
    chart: {
      applyOptions() {},
      timeScale: () => ({ coordinateToTime: (x) => x }),
    },
    series: { coordinateToPrice: (y) => y },
    getDrawings: () => drawings,
    replaceDrawings(next, kind) {
      drawings = next;
      changes.push({ drawings: next, kind });
    },
    getTool: () => "select",
    setTool() {},
    requestRender() {},
    requestText() {},
    hitTest: () => null,
    createId: () => "d-new",
    now: () => 10,
  });
  return { changes, controller, getDrawings: () => drawings };
}

test("marks drag previews transient and commits the completed move once", () => {
  const { changes, controller, getDrawings } = createMutationController([trend]);
  controller.dispatch({ type: "START_DRAG", drawing: trend, part: "point-1", point: p2 });
  controller.dispatch({ type: "DRAG", point: { time: 250, price: 25 }, now: 7 });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "transient");

  controller.dispatch({ type: "END_DRAG" });

  assert.equal(changes.length, 2);
  assert.equal(changes[1].kind, "commit");
  assert.deepEqual(changes[1].drawings, getDrawings());
});

test("marks completed creates and deletes as commits", () => {
  const created = createMutationController();
  created.controller.dispatch({ type: "BEGIN", tool: "horizontal-line", point: p1, id: "d-new", now: 10 });
  assert.equal(created.changes.at(-1)?.kind, "commit");

  assert.equal(created.controller.deleteSelected(), true);
  assert.equal(created.changes.at(-1)?.kind, "commit");
  assert.deepEqual(created.getDrawings(), []);
});

test("cancelling a moved drag restores the original before a later commit", () => {
  const { changes, controller, getDrawings } = createControllerHarness();
  controller.dispatch({ type: "START_DRAG", drawing: trend, part: "point-1", point: p2 });
  controller.dispatch({ type: "DRAG", point: { time: 250, price: 25 }, now: 7 });
  assert.deepEqual(getDrawings()[0].points, [p1, { time: 250, price: 25 }]);

  controller.cancel();

  assert.deepEqual(getDrawings(), [trend]);
  assert.equal(changes.at(-1).kind, "transient");
  controller.dispatch({ type: "BEGIN", tool: "horizontal-line", point: p1, id: "d-new", now: 10 });
  assert.equal(changes.at(-1).kind, "commit");
  assert.deepEqual(changes.at(-1).drawings[0], trend);
});

for (const [name, trigger] of [
  ["Escape", (h) => h.controller.onKeyDown({ key: "Escape", preventDefault() {} })],
  ["pointer cancellation", (h) => h.controller.onPointerCancel({ pointerId: 1 })],
  ["window blur", (h) => h.controller.onWindowBlur()],
  ["toolbar tool change", (h) => h.controller.changeTool("crosshair")],
]) {
  test(`${name} rolls a drag back and unlocks chart interaction`, () => {
    const h = createMovedDragHarness();
    trigger(h);
    assert.deepEqual(h.getDrawings(), [trend]);
    assert.deepEqual(h.chartOptions.at(-1), { handleScroll: true, handleScale: true });
    assert.equal(h.cancellations.length, 1);
    assert.equal(h.changes.at(-1).kind, "transient");
  });
}

test("changeTool cancels text placement before activating the requested tool", () => {
  const h = createTextPlacementHarness();
  assert.deepEqual(h.chartOptions.at(-1), { handleScroll: false, handleScale: false });
  h.controller.changeTool("crosshair");
  assert.deepEqual(h.controller.getSession(), initialDrawingSession);
  assert.equal(h.tool.current, "crosshair");
  assert.equal(h.cancellations.length, 1);
  assert.deepEqual(h.chartOptions.at(-1), { handleScroll: true, handleScale: true });
});

test("blur and external tool reconciliation notify the text owner", () => {
  const blur = createTextPlacementHarness();
  blur.controller.onWindowBlur();
  assert.deepEqual(blur.cancellations, ["cancel"]);

  const reconciled = createTextPlacementHarness();
  reconciled.tool.current = "crosshair";
  reconciled.controller.onPointerMove(pointerEvent());
  assert.deepEqual(reconciled.cancellations, ["cancel"]);
  assert.deepEqual(reconciled.controller.getSession(), initialDrawingSession);
});

test("ignores drawing placement that starts on an indicator pane below the candles", () => {
  const tool = { current: "trend-line" };
  const controller = new DrawingController({
    chart: {
      applyOptions() {},
      timeScale: () => ({ coordinateToTime: (x) => x }),
      panes: () => [{ getHeight: () => 80 }],
    },
    series: { coordinateToPrice: (y) => y },
    getDrawings: () => [],
    replaceDrawings() { assert.fail("indicator pane clicks must not create drawings"); },
    getTool: () => tool.current,
    setTool: (next) => { tool.current = next; },
    requestRender() {},
    requestText() { assert.fail("indicator pane clicks must not request text"); },
    hitTest: () => null,
    createId: () => "d-test",
    now: () => 1,
  });
  controller.onPointerDown({ ...pointerEvent(), clientY: 140 });
  assert.deepEqual(controller.getSession(), initialDrawingSession);
});
