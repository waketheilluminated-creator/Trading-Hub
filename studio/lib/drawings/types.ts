import type { UTCTimestamp } from "lightweight-charts";

export type DrawingPoint = { time: UTCTimestamp; price: number };
export type DrawingStyle = { color: string; lineWidth: 1 | 2 | 3 | 4 };
export const DEFAULT_DRAWING_STYLE: DrawingStyle = { color: "#76e7a4", lineWidth: 2 };

export type DrawingType =
  | "trend-line" | "ray" | "info-line" | "extended-line" | "trend-angle"
  | "horizontal-line" | "horizontal-ray" | "vertical-line" | "cross-line"
  | "parallel-channel" | "regression-trend" | "flat-channel" | "disjoint-channel"
  | "fib-retracement" | "fib-extension" | "fib-channel" | "fib-time-zone"
  | "pitchfork" | "gann-fan"
  | "rectangle" | "rotated-rectangle" | "ellipse" | "circle" | "triangle" | "polyline" | "arc" | "brush"
  | "text" | "note" | "price-label" | "callout"
  | "abcd" | "xabcd" | "head-shoulders" | "elliott-impulse"
  | "long-position" | "short-position" | "price-range" | "date-range" | "date-price-range"
  | "arrow" | "arrow-up" | "arrow-down";

export type DrawingTool = "select" | "crosshair" | "price-change" | DrawingType;
export type CreationMode = "instant" | "pair" | "text" | "path" | "brush" | 3 | 4 | 5;

export const CREATION_MODE: Record<DrawingType, CreationMode> = {
  "trend-line": "pair",
  ray: "pair",
  "info-line": "pair",
  "extended-line": "pair",
  "trend-angle": "pair",
  "horizontal-line": "instant",
  "horizontal-ray": "instant",
  "vertical-line": "instant",
  "cross-line": "instant",
  "parallel-channel": 3,
  "regression-trend": "pair",
  "flat-channel": 3,
  "disjoint-channel": 4,
  "fib-retracement": "pair",
  "fib-extension": 3,
  "fib-channel": 3,
  "fib-time-zone": "pair",
  pitchfork: 3,
  "gann-fan": "pair",
  rectangle: "pair",
  "rotated-rectangle": 3,
  ellipse: "pair",
  circle: "pair",
  triangle: 3,
  polyline: "path",
  arc: 3,
  brush: "brush",
  text: "text",
  note: "instant",
  "price-label": "instant",
  callout: "pair",
  abcd: 4,
  xabcd: 5,
  "head-shoulders": 5,
  "elliott-impulse": 5,
  "long-position": "pair",
  "short-position": "pair",
  "price-range": "pair",
  "date-range": "pair",
  "date-price-range": "pair",
  arrow: "pair",
  "arrow-up": "instant",
  "arrow-down": "instant",
};

export const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236] as const;
export const FIB_TIME_ZONE_STEPS = [0, 1, 2, 3, 5, 8, 13, 21] as const;

type DrawingBase = { id: string; style: DrawingStyle; createdAt: number; updatedAt: number; text?: string };
export type Drawing = DrawingBase & { type: DrawingType; points: DrawingPoint[] };

export function isStoredTool(tool: DrawingTool): tool is DrawingType {
  return tool !== "select" && tool !== "crosshair" && tool !== "price-change";
}

export function creationMode(tool: DrawingTool): CreationMode | null {
  if (tool === "select" || tool === "crosshair" || tool === "price-change") return null;
  return CREATION_MODE[tool];
}

export function isPairTool(tool: DrawingTool): tool is DrawingType {
  return creationMode(tool) === "pair";
}

export function materializePoints(type: DrawingType, points: readonly DrawingPoint[]): DrawingPoint[] {
  if ((type === "long-position" || type === "short-position") && points.length === 2) {
    const entry = points[0];
    const target = points[1];
    return [entry, target, { time: target.time, price: entry.price * 2 - target.price }];
  }
  return [...points];
}

export function createStoredDrawing(type: DrawingType, points: readonly DrawingPoint[], id: string, now: number, text?: string): Drawing {
  const drawing: Drawing = {
    id,
    type,
    points: materializePoints(type, points),
    style: DEFAULT_DRAWING_STYLE,
    createdAt: now,
    updatedAt: now,
  };
  if (text !== undefined) drawing.text = text;
  else if (type === "note") drawing.text = "注释";
  else if (type === "price-label") drawing.text = drawing.points[0]?.price.toFixed(2) ?? "";
  else if (type === "callout") drawing.text = "标注";
  return drawing;
}

const isPoint = (value: unknown): value is DrawingPoint => {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.time === "number" && Number.isFinite(point.time)
    && typeof point.price === "number" && Number.isFinite(point.price);
};

function isDrawingType(value: unknown): value is DrawingType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREATION_MODE, value);
}

export function isDrawing(value: unknown): value is Drawing {
  if (!value || typeof value !== "object") return false;
  const drawing = value as Record<string, unknown>;
  const style = drawing.style as Record<string, unknown> | undefined;
  const points = drawing.points;
  if (typeof drawing.id !== "string" || !drawing.id || !Array.isArray(points)) return false;
  if (!style || typeof style.color !== "string" || ![1, 2, 3, 4].includes(style.lineWidth as number)) return false;
  if (typeof drawing.createdAt !== "number" || !Number.isFinite(drawing.createdAt)
    || typeof drawing.updatedAt !== "number" || !Number.isFinite(drawing.updatedAt)
    || points.some((point) => !isPoint(point))) return false;
  if (!isDrawingType(drawing.type)) return false;
  const mode = CREATION_MODE[drawing.type];
  const textOk = typeof drawing.text === "string" && drawing.text.trim().length > 0;
  if (mode === "instant") {
    if (points.length !== 1) return false;
    if (drawing.type === "note" || drawing.type === "price-label") return textOk;
    return true;
  }
  if (mode === "text") return points.length === 1 && textOk;
  if (mode === "pair") {
    if (drawing.type === "long-position" || drawing.type === "short-position") return points.length === 3;
    if (drawing.type === "callout") return points.length === 2 && textOk;
    return points.length === 2;
  }
  if (mode === "path" || mode === "brush") return points.length >= 2;
  return points.length === mode;
}

export function fibPrice(start: number, end: number, level: number): number {
  return start + (end - start) * level;
}

export function positionRisk(entry: number, target: number): { stop: number; reward: number; risk: number; ratio: number } {
  const stop = entry * 2 - target;
  const reward = Math.abs(target - entry);
  const risk = Math.abs(entry - stop);
  return { stop, reward, risk, ratio: risk === 0 ? 0 : reward / risk };
}
