import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from "lightweight-charts";
import { priceChangeMetrics } from "../drawings/geometry.ts";
import type { MobileDrawing, MobilePoint } from "./drawings.ts";

type PriceToY = (price: number) => number | null;
type TimeToX = (time: Time) => number | null;

const PREVIEW = "__preview__";

class MobileDrawingRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly getDrawings: () => readonly MobileDrawing[],
    private readonly getSelected: () => string | null,
    private readonly getPreview: () => MobileDrawing | null,
    private readonly getPriceToY: () => PriceToY | null,
    private readonly getTimeToX: () => TimeToX | null,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    const priceToY = this.getPriceToY();
    const timeToX = this.getTimeToX();
    if (!priceToY || !timeToX) return;
    const drawings = this.getDrawings();
    const preview = this.getPreview();
    const selected = this.getSelected();
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const drawing of drawings) {
        trace(context, drawing, priceToY, timeToX, mediaSize.width, mediaSize.height, drawing.id === selected);
      }
      if (preview) trace(context, preview, priceToY, timeToX, mediaSize.width, mediaSize.height, false);
    });
  }
}

class MobileDrawingPaneView implements IPrimitivePaneView {
  constructor(private readonly paneRenderer: MobileDrawingRenderer) {}
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer { return this.paneRenderer; }
}

export class MobileDrawingPrimitive implements ISeriesPrimitive<Time> {
  private drawings: readonly MobileDrawing[] = [];
  private selectedId: string | null = null;
  private preview: MobileDrawing | null = null;
  private priceToY: PriceToY | null = null;
  private timeToX: TimeToX | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer = new MobileDrawingRenderer(
    () => this.drawings,
    () => this.selectedId,
    () => this.preview,
    () => this.priceToY,
    () => this.timeToX,
  );
  private readonly views = [new MobileDrawingPaneView(this.paneRenderer)];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.priceToY = (price) => series.priceToCoordinate(price);
    this.timeToX = (time) => chart.timeScale().timeToCoordinate(time);
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.priceToY = null;
    this.timeToX = null;
    this.requestUpdate = null;
  }

  setState(drawings: readonly MobileDrawing[], selectedId: string | null, preview: MobileDrawing | null): void {
    this.drawings = drawings;
    this.selectedId = selectedId;
    this.preview = preview;
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews() { return this.views; }
}

function xy(point: MobilePoint, priceToY: PriceToY, timeToX: TimeToX): { x: number; y: number } | null {
  const x = timeToX(point.time as Time);
  const y = priceToY(point.price);
  if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function extend(start: { x: number; y: number }, end: { x: number; y: number }, width: number, height: number): { x: number; y: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return end;
  let maxT = Number.POSITIVE_INFINITY;
  if (dx > 0) maxT = Math.min(maxT, (width - start.x) / dx);
  else if (dx < 0) maxT = Math.min(maxT, (0 - start.x) / dx);
  if (dy > 0) maxT = Math.min(maxT, (height - start.y) / dy);
  else if (dy < 0) maxT = Math.min(maxT, (0 - start.y) / dy);
  const t = Math.max(1, Number.isFinite(maxT) ? maxT : 1);
  return { x: start.x + dx * t, y: start.y + dy * t };
}

function trace(
  context: CanvasRenderingContext2D,
  drawing: MobileDrawing,
  priceToY: PriceToY,
  timeToX: TimeToX,
  width: number,
  height: number,
  selected: boolean,
): void {
  const ghost = drawing.id === PREVIEW;
  context.save();
  context.globalAlpha = ghost ? 0.55 : 1;
  context.lineWidth = selected ? 2.5 : 1.75;
  context.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textBaseline = "middle";
  switch (drawing.type) {
    case "trend-line": {
      const a = xy(drawing.a, priceToY, timeToX);
      const b = xy(drawing.b, priceToY, timeToX);
      if (!a || !b) break;
      const end = drawing.ray ? extend(a, b, width, height) : b;
      context.strokeStyle = "#089981";
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(end.x, end.y);
      context.stroke();
      if (selected) handles(context, [a, b]);
      break;
    }
    case "horizontal-line":
    case "horizontal-ray": {
      const y = priceToY(drawing.price);
      const x = timeToX(drawing.time as Time);
      if (y == null) break;
      context.strokeStyle = drawing.type === "horizontal-ray" ? "#f23645" : "#9c27b0";
      context.beginPath();
      if (drawing.type === "horizontal-line" || x == null) {
        context.moveTo(0, y);
        context.lineTo(width, y);
      } else if (drawing.dir === "left") {
        context.moveTo(x, y);
        context.lineTo(0, y);
      } else {
        context.moveTo(x, y);
        context.lineTo(width, y);
      }
      context.stroke();
      if (selected && x != null) handles(context, [{ x, y }]);
      break;
    }
    case "rectangle":
    case "long":
    case "short":
    case "price-range": {
      const a = xy(drawing.a, priceToY, timeToX);
      const b = xy(drawing.b, priceToY, timeToX);
      if (!a || !b) break;
      const left = Math.min(a.x, b.x);
      const top = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const fill = drawing.type === "long" ? "rgba(8,153,129,0.18)" : drawing.type === "short" ? "rgba(242,54,69,0.18)" : "rgba(41,98,255,0.12)";
      const edge = drawing.type === "long" ? "#089981" : drawing.type === "short" ? "#f23645" : "#2962ff";
      context.fillStyle = fill;
      context.strokeStyle = edge;
      context.setLineDash(drawing.type === "price-range" ? [4, 3] : []);
      context.fillRect(left, top, w, h);
      context.strokeRect(left, top, w, h);
      context.setLineDash([]);
      const label = drawing.type === "long" ? "L" : drawing.type === "short" ? "S" : drawing.type === "price-range" ? rangeLabel(drawing.a.price, drawing.b.price) : "";
      if (label) {
        context.fillStyle = edge;
        context.fillText(label, left + 6, top + 12);
      }
      if (selected) handles(context, [a, b]);
      break;
    }
    case "text": {
      const at = xy({ time: drawing.time, price: drawing.price }, priceToY, timeToX);
      if (!at) break;
      context.fillStyle = "#2962ff";
      context.fillText(drawing.text, at.x + 4, at.y);
      if (selected) handles(context, [at]);
      break;
    }
    default: {
      const neverDrawing: never = drawing;
      void neverDrawing;
    }
  }
  context.restore();
}

function handles(context: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#2962ff";
  context.lineWidth = 1.5;
  for (const point of points) {
    context.beginPath();
    context.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
}

function rangeLabel(start: number, end: number): string {
  const { absolute, percent } = priceChangeMetrics(start, end);
  const sign = absolute > 0 ? "+" : "";
  return `${sign}${absolute.toFixed(2)} (${sign}${percent.toFixed(2)}%)`;
}

export function previewDrawing(drawing: MobileDrawing): MobileDrawing {
  return { ...drawing, id: PREVIEW };
}
