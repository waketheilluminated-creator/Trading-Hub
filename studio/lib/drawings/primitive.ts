import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { toScreenPoint, type DrawingCoordinateAdapter } from "./coordinates.ts";
import type { DrawingSession } from "./controller.ts";
import {
  arrowHead,
  buildScreenDrawings,
  hitTestDrawing as hitTestScreenDrawing,
  priceChangeMetrics,
  type DrawingHit,
  type ScreenDrawing,
  type ScreenPoint,
} from "./geometry.ts";
import { DEFAULT_DRAWING_STYLE, type Drawing } from "./types.ts";

const HIT_TOLERANCE = 8;
const HANDLE_RADIUS = 4;
const PREVIEW_ID = "__drawing-preview__";

type PriceChangeMeasurement = {
  start: ScreenPoint;
  end: ScreenPoint;
  startPrice: number;
  endPrice: number;
};

function selectedIdFor(session: DrawingSession): string | null {
  return session.phase === "selected" || session.phase === "dragging" ? session.selectedId : null;
}

function previewDrawingFor(session: DrawingSession): Drawing | null {
  if (session.phase !== "previewing") return null;
  return {
    id: PREVIEW_ID,
    type: session.tool,
    points: [session.start, session.preview],
    style: DEFAULT_DRAWING_STYLE,
    createdAt: 0,
    updatedAt: 0,
  };
}

function traceDrawing(
  context: CanvasRenderingContext2D,
  drawing: ScreenDrawing,
  paneWidth: number,
): void {
  const first = drawing.points[0];
  if (!first) return;
  context.beginPath();
  if (drawing.type === "horizontal-line") {
    context.moveTo(0, first.y);
    context.lineTo(paneWidth, first.y);
    return;
  }
  const second = drawing.points[1];
  if (!second) return;
  context.moveTo(first.x, first.y);
  context.lineTo(second.x, second.y);
}

function drawSelectionHighlight(
  context: CanvasRenderingContext2D,
  drawing: ScreenDrawing,
  paneWidth: number,
): void {
  const color = drawing.style?.color ?? DEFAULT_DRAWING_STYLE.color;
  context.save();
  context.globalAlpha = 0.22;
  if (drawing.type === "text" && drawing.textBounds) {
    const { x, y, width, height } = drawing.textBounds;
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(x - 3, y - 3, width + 6, height + 6, 6);
    context.fill();
  } else {
    context.strokeStyle = color;
    context.lineWidth = (drawing.style?.lineWidth ?? DEFAULT_DRAWING_STYLE.lineWidth) + 6;
    context.lineCap = "round";
    context.lineJoin = "round";
    traceDrawing(context, drawing, paneWidth);
    context.stroke();
  }
  context.restore();
}

function drawText(context: CanvasRenderingContext2D, drawing: ScreenDrawing): void {
  if (!drawing.text || !drawing.textBounds) return;
  const { x, y, width, height } = drawing.textBounds;
  context.fillStyle = "rgba(15, 23, 42, 0.94)";
  context.beginPath();
  context.roundRect(x, y, width, height, 4);
  context.fill();
  context.fillStyle = "#f8fafc";
  context.font = "12px ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(drawing.text, x + 8, y + height / 2);
}

function drawArrowHead(context: CanvasRenderingContext2D, drawing: ScreenDrawing): void {
  const [start, end] = drawing.points;
  if (!start || !end) return;
  const head = arrowHead(start, end, 9 + (drawing.style?.lineWidth ?? DEFAULT_DRAWING_STYLE.lineWidth));
  context.beginPath();
  context.moveTo(head[0].x, head[0].y);
  context.lineTo(head[1].x, head[1].y);
  context.lineTo(head[2].x, head[2].y);
  context.closePath();
  context.fill();
}

function drawHandles(context: CanvasRenderingContext2D, drawing: ScreenDrawing): void {
  if (drawing.points.length < 2) return;
  for (const point of drawing.points.slice(0, 2)) {
    context.beginPath();
    context.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
    context.fillStyle = drawing.style?.color ?? DEFAULT_DRAWING_STYLE.color;
    context.fill();
    context.strokeStyle = "#f8fafc";
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawAnchorDot(context: CanvasRenderingContext2D, point: ScreenPoint, color: string): void {
  context.beginPath();
  context.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function drawScreenDrawing(
  context: CanvasRenderingContext2D,
  drawing: ScreenDrawing,
  paneWidth: number,
  selected: boolean,
  hovered: boolean,
): void {
  context.save();
  if (selected || hovered) drawSelectionHighlight(context, drawing, paneWidth);
  if (drawing.type === "text") {
    drawText(context, drawing);
  } else {
    const color = drawing.style?.color ?? DEFAULT_DRAWING_STYLE.color;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = drawing.style?.lineWidth ?? DEFAULT_DRAWING_STYLE.lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    traceDrawing(context, drawing, paneWidth);
    context.stroke();
    if (drawing.type === "arrow") drawArrowHead(context, drawing);
    if (drawing.id === PREVIEW_ID && drawing.points[0]) drawAnchorDot(context, drawing.points[0], color);
  }
  if (selected) drawHandles(context, drawing);
  context.restore();
}

function formatMeasurementPrice(value: number): string {
  const magnitude = Math.abs(value);
  return value.toFixed(magnitude > 0 && magnitude < 1 ? 6 : 2);
}

function drawPriceChangeMeasurement(
  context: CanvasRenderingContext2D,
  measurement: PriceChangeMeasurement,
  paneWidth: number,
  paneHeight: number,
): void {
  const { start, end, startPrice, endPrice } = measurement;
  const metrics = priceChangeMetrics(startPrice, endPrice);
  const positive = metrics.absolute >= 0;
  const color = positive ? "#53c990" : "#e76770";
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.max(1, Math.abs(end.x - start.x));
  const height = Math.max(1, Math.abs(end.y - start.y));
  const signedPercent = `${metrics.percent >= 0 ? "+" : ""}${metrics.percent.toFixed(2)}%`;
  const signedAbsolute = `${metrics.absolute >= 0 ? "+" : ""}${formatMeasurementPrice(metrics.absolute)}`;
  const primaryLabel = `${signedPercent}  ${signedAbsolute}`;
  const priceLabel = `${formatMeasurementPrice(startPrice)} → ${formatMeasurementPrice(endPrice)}`;
  const labelWidth = 176;
  const labelHeight = 42;
  const labelX = Math.max(4, Math.min(paneWidth - labelWidth - 4, (start.x + end.x) / 2 - labelWidth / 2));
  const labelY = Math.max(4, Math.min(paneHeight - labelHeight - 4, top - labelHeight - 8));

  context.save();
  context.globalAlpha = 0.13;
  context.fillStyle = color;
  context.fillRect(left, top, width, height);
  context.restore();

  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.setLineDash([5, 4]);
  context.strokeRect(left, top, width, height);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "rgba(11, 16, 23, 0.96)";
  context.beginPath();
  context.roundRect(labelX, labelY, labelWidth, labelHeight, 5);
  context.fill();
  context.strokeStyle = color;
  context.stroke();
  context.fillStyle = color;
  context.font = "600 12px ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(primaryLabel, labelX + labelWidth / 2, labelY + 13);
  context.fillStyle = "#b8c1cf";
  context.font = "11px ui-monospace, SFMono-Regular, monospace";
  context.fillText(priceLabel, labelX + labelWidth / 2, labelY + 30);
  context.restore();
}

class DrawingPaneRenderer implements IPrimitivePaneRenderer {
  private readonly getScene: () => readonly ScreenDrawing[];
  private readonly getSelectedId: () => string | null;
  private readonly getHoveredId: () => string | null;
  private readonly getMeasurement: () => PriceChangeMeasurement | null;

  constructor(
    getScene: () => readonly ScreenDrawing[],
    getSelectedId: () => string | null,
    getHoveredId: () => string | null,
    getMeasurement: () => PriceChangeMeasurement | null,
  ) {
    this.getScene = getScene;
    this.getSelectedId = getSelectedId;
    this.getHoveredId = getHoveredId;
    this.getMeasurement = getMeasurement;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const selectedId = this.getSelectedId();
      const hoveredId = this.getHoveredId();
      for (const drawing of this.getScene()) {
        drawScreenDrawing(context, drawing, mediaSize.width, drawing.id === selectedId, drawing.id === hoveredId);
      }
      const measurement = this.getMeasurement();
      if (measurement) drawPriceChangeMeasurement(context, measurement, mediaSize.width, mediaSize.height);
    });
  }
}

class DrawingPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: DrawingPaneRenderer;

  constructor(paneRenderer: DrawingPaneRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class DrawingPrimitive implements ISeriesPrimitive<Time> {
  private drawings: readonly Drawing[] = [];
  private session: DrawingSession = { phase: "idle" };
  private candleTimes: readonly number[] = [];
  private coordinateAdapter: DrawingCoordinateAdapter | null = null;
  private requestUpdate: (() => void) | null = null;
  private scene: readonly ScreenDrawing[] = [];
  private measurement: PriceChangeMeasurement | null = null;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private hidden = false;
  private readonly paneRenderer = new DrawingPaneRenderer(
    () => this.scene,
    () => this.selectedId,
    () => this.hoveredId,
    () => this.measurement,
  );
  private readonly views: readonly IPrimitivePaneView[] = [new DrawingPaneView(this.paneRenderer)];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, "Candlestick">): void {
    const timeScale = chart.timeScale();
    this.coordinateAdapter = {
      timeToCoordinate: (time) => timeScale.timeToCoordinate(time),
      coordinateToTime: (x) => timeScale.coordinateToTime(x),
      priceToCoordinate: (price) => series.priceToCoordinate(price),
      coordinateToPrice: (y) => series.coordinateToPrice(y),
    };
    this.requestUpdate = requestUpdate;
    this.rebuildScene();
    requestUpdate();
  }

  detached(): void {
    this.coordinateAdapter = null;
    this.requestUpdate = null;
    this.scene = [];
    this.measurement = null;
  }

  setState(drawings: readonly Drawing[], session: DrawingSession, candleTimes: readonly number[]): void {
    this.drawings = drawings;
    this.session = session;
    this.candleTimes = candleTimes;
    this.selectedId = selectedIdFor(session);
    this.rebuildScene();
    this.requestUpdate?.();
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (hidden) this.hoveredId = null;
    this.rebuildScene();
    this.requestUpdate?.();
  }

  setHovered(id: string | null): void {
    if (this.hidden) id = null;
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    this.rebuildScene();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  hitTestDrawing(point: ScreenPoint): DrawingHit | null {
    for (let index = this.scene.length - 1; index >= 0; index -= 1) {
      const drawing = this.scene[index];
      if (drawing.interactive === false) continue;
      const hit = hitTestScreenDrawing(drawing, point, HIT_TOLERANCE);
      if (hit) return hit;
    }
    return null;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const hit = this.hitTestDrawing({ x, y });
    if (!hit) return null;
    const selected = hit.drawingId === this.selectedId;
    return {
      externalId: `drawing:${hit.drawingId}:${hit.part}`,
      cursorStyle: selected ? (hit.part === "body" ? "move" : "grab") : "pointer",
      zOrder: "top",
    };
  }

  private rebuildScene(): void {
    if (!this.coordinateAdapter) {
      this.scene = [];
      this.measurement = null;
      return;
    }
    const scene = buildScreenDrawings(this.hidden ? [] : this.drawings, this.candleTimes, this.coordinateAdapter);
    const preview = previewDrawingFor(this.session);
    if (preview) {
      scene.push(...buildScreenDrawings([preview], this.candleTimes, this.coordinateAdapter).map((drawing) => ({
        ...drawing,
        interactive: false,
      })));
    }
    this.measurement = this.buildMeasurement();
    this.scene = scene;
  }

  private buildMeasurement(): PriceChangeMeasurement | null {
    if (!this.coordinateAdapter || (this.session.phase !== "measuring" && this.session.phase !== "measured")) return null;
    const startPoint = this.session.start;
    const endPoint = this.session.phase === "measuring" ? this.session.preview : this.session.end;
    const start = toScreenPoint(startPoint, this.candleTimes, this.coordinateAdapter);
    const end = toScreenPoint(endPoint, this.candleTimes, this.coordinateAdapter);
    if (!start || !end) return null;
    return { start, end, startPrice: startPoint.price, endPrice: endPoint.price };
  }
}
