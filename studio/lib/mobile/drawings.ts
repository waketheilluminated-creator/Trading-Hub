/**
 * Mobile drawings: two-tap placement, per symbol+timeframe persistence, undo, screen hit testing.
 */
import { distanceToSegment } from "../drawings/geometry.ts";

export type MobilePoint = { time: number; price: number };
export type MobileTool =
  | "select"
  | "crosshair"
  | "rectangle"
  | "long"
  | "short"
  | "text"
  | "trend-line"
  | "horizontal-line"
  | "horizontal-ray"
  | "price-range";

type DrawingBase = { id: string; alert: boolean };
export type TrendDrawing = DrawingBase & { type: "trend-line"; ray: boolean; a: MobilePoint; b: MobilePoint };
export type HorizontalDrawing = DrawingBase & { type: "horizontal-line"; time: number; price: number };
export type RayDrawing = DrawingBase & { type: "horizontal-ray"; time: number; price: number; dir: "left" | "right" };
export type BoxDrawing = DrawingBase & { type: "rectangle" | "long" | "short" | "price-range"; a: MobilePoint; b: MobilePoint };
export type TextDrawing = DrawingBase & { type: "text"; time: number; price: number; text: string };
export type MobileDrawing = TrendDrawing | HorizontalDrawing | RayDrawing | BoxDrawing | TextDrawing;

export type MobileDraft = { tool: MobileTool; start: MobilePoint } | null;
export type DrawingHistory = { past: MobileDrawing[][]; present: MobileDrawing[]; future: MobileDrawing[][] };
export type HitPart = "body" | "p0" | "p1";
type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type ScreenPoint = { x: number; y: number };

const TWO_POINT: ReadonlySet<MobileTool> = new Set(["trend-line", "rectangle", "long", "short", "price-range", "horizontal-ray"]);
const BOX_TYPES = new Set(["rectangle", "long", "short", "price-range"]);

export function mobileDrawingKey(symbol: string, interval: string): string {
  return `th-mobile-drawings:v1:${symbol}:${interval}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is MobilePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return finite(point.time) && finite(point.price);
}

export function isMobileDrawing(value: unknown): value is MobileDrawing {
  if (!value || typeof value !== "object") return false;
  const drawing = value as Record<string, unknown>;
  if (typeof drawing.id !== "string" || drawing.id.length === 0 || typeof drawing.alert !== "boolean") return false;
  if (drawing.type === "trend-line") return drawing.ray === true || drawing.ray === false ? isPoint(drawing.a) && isPoint(drawing.b) : false;
  if (drawing.type === "horizontal-line") return finite(drawing.time) && finite(drawing.price);
  if (drawing.type === "horizontal-ray") return finite(drawing.time) && finite(drawing.price) && (drawing.dir === "left" || drawing.dir === "right");
  if (drawing.type === "text") return finite(drawing.time) && finite(drawing.price) && typeof drawing.text === "string" && drawing.text.trim().length > 0;
  return typeof drawing.type === "string" && BOX_TYPES.has(drawing.type) && isPoint(drawing.a) && isPoint(drawing.b);
}

export function loadMobileDrawings(storage: StorageLike, symbol: string, interval: string): MobileDrawing[] {
  try {
    const raw = storage.getItem(mobileDrawingKey(symbol, interval));
    if (raw == null) return [];
    const envelope = JSON.parse(raw) as { version?: unknown; drawings?: unknown };
    if (envelope.version !== 1 || !Array.isArray(envelope.drawings)) return [];
    return envelope.drawings.filter(isMobileDrawing);
  } catch {
    return [];
  }
}

export function saveMobileDrawings(storage: StorageLike, symbol: string, interval: string, drawings: readonly MobileDrawing[]): boolean {
  try {
    storage.setItem(mobileDrawingKey(symbol, interval), JSON.stringify({ version: 1, drawings: drawings.filter(isMobileDrawing) }));
    return true;
  } catch {
    return false;
  }
}

function cloneDrawings(drawings: readonly MobileDrawing[]): MobileDrawing[] {
  return drawings.map((drawing) => ({ ...drawing }));
}

export function historyInit(drawings: readonly MobileDrawing[]): DrawingHistory {
  return { past: [], present: cloneDrawings(drawings), future: [] };
}

export function historyCommit(history: DrawingHistory, next: readonly MobileDrawing[]): DrawingHistory {
  const present = cloneDrawings(next);
  if (JSON.stringify(history.present) === JSON.stringify(present)) return history;
  return { past: [...history.past, history.present].slice(-50), present, future: [] };
}

export function historyUndo(history: DrawingHistory): DrawingHistory {
  if (!history.past.length) return history;
  const present = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] };
}

export function historyRedo(history: DrawingHistory): DrawingHistory {
  if (!history.future.length) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present], present, future };
}

export function applyTap(
  tool: MobileTool,
  draft: MobileDraft,
  drawings: readonly MobileDrawing[],
  point: MobilePoint,
  now: number,
  id: string,
): { draft: MobileDraft; drawings: MobileDrawing[]; committed: boolean } {
  void now;
  if (tool === "select" || tool === "crosshair") return { draft: null, drawings: [...drawings], committed: false };
  if (!TWO_POINT.has(tool)) {
    const drawing: MobileDrawing = tool === "text"
      ? { id, type: "text", alert: false, time: point.time, price: point.price, text: "注" }
      : { id, type: "horizontal-line", alert: false, time: point.time, price: point.price };
    return { draft: null, drawings: [...drawings, drawing], committed: true };
  }
  if (!draft || draft.tool !== tool) return { draft: { tool, start: point }, drawings: [...drawings], committed: false };
  const start = draft.start;
  let created: MobileDrawing;
  if (tool === "trend-line") created = { id, type: "trend-line", alert: false, ray: false, a: start, b: point };
  else if (tool === "horizontal-ray") created = { id, type: "horizontal-ray", alert: false, time: start.time, price: start.price, dir: point.time >= start.time ? "right" : "left" };
  else if (tool === "rectangle" || tool === "long" || tool === "short" || tool === "price-range") created = { id, type: tool, alert: false, a: start, b: point };
  else return { draft: null, drawings: [...drawings], committed: false };
  return { draft: null, drawings: [...drawings, created], committed: true };
}

function near(at: ScreenPoint, point: ScreenPoint, tolerance: number): boolean {
  return Math.hypot(at.x - point.x, at.y - point.y) <= tolerance;
}

function rayEnd(start: ScreenPoint, end: ScreenPoint, paneWidth: number): ScreenPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return end;
  const height = 1_000_000;
  let maxT = Number.POSITIVE_INFINITY;
  if (dx > 0) maxT = Math.min(maxT, (paneWidth - start.x) / dx);
  else if (dx < 0) maxT = Math.min(maxT, (0 - start.x) / dx);
  if (dy > 0) maxT = Math.min(maxT, (height - start.y) / dy);
  else if (dy < 0) maxT = Math.min(maxT, (0 - start.y) / dy);
  const t = Math.max(1, Number.isFinite(maxT) ? maxT : 1);
  return { x: start.x + dx * t, y: start.y + dy * t };
}

export function hitMobileDrawing(
  drawing: MobileDrawing,
  at: ScreenPoint,
  project: (point: MobilePoint) => ScreenPoint | null,
  tolerance: number,
  paneWidth: number,
): { id: string; part: HitPart } | null {
  if (drawing.type === "horizontal-line" || drawing.type === "horizontal-ray" || drawing.type === "text") {
    const anchor = project({ time: drawing.time, price: drawing.price });
    if (!anchor) return null;
    if (near(at, anchor, tolerance)) return { id: drawing.id, part: "p0" };
    if (drawing.type === "text") return null;
    if (Math.abs(at.y - anchor.y) > tolerance) return null;
    if (drawing.type === "horizontal-line") return { id: drawing.id, part: "body" };
    const toward = drawing.dir === "left" ? at.x <= anchor.x + tolerance : at.x >= anchor.x - tolerance;
    return toward ? { id: drawing.id, part: "body" } : null;
  }
  const first = project(drawing.a);
  const second = project(drawing.b);
  if (!first || !second) return null;
  if (near(at, first, tolerance)) return { id: drawing.id, part: "p0" };
  if (near(at, second, tolerance)) return { id: drawing.id, part: "p1" };
  if (drawing.type === "trend-line") {
    const end = drawing.ray ? rayEnd(first, second, paneWidth) : second;
    return distanceToSegment(at, first, end) <= tolerance ? { id: drawing.id, part: "body" } : null;
  }
  const left = Math.min(first.x, second.x) - tolerance;
  const right = Math.max(first.x, second.x) + tolerance;
  const top = Math.min(first.y, second.y) - tolerance;
  const bottom = Math.max(first.y, second.y) + tolerance;
  return at.x >= left && at.x <= right && at.y >= top && at.y <= bottom ? { id: drawing.id, part: "body" } : null;
}
