import type { DrawingPoint, DrawingType } from "./types.ts";
import { FIB_RETRACEMENT_LEVELS, FIB_TIME_ZONE_STEPS, positionRisk } from "./types.ts";
import type { ScreenPoint } from "./geometry.ts";

export type FigureLine = { points: ScreenPoint[]; closed?: boolean; color?: string; fill?: string };
export type FigureCircle = { x: number; y: number; rx: number; ry: number; color?: string; fill?: string };
export type FigureLabel = { x: number; y: number; text: string; color?: string };
export type Figure = { lines: FigureLine[]; circles: FigureCircle[]; labels: FigureLabel[] };

export type PaneSize = { width: number; height: number };
export type FigureCandle = { time: number; close: number };

const FIB_COLORS = ["#ef5350", "#ff9800", "#ffeb3b", "#4caf50", "#26a69a", "#2196f3", "#9c27b0", "#e91e63", "#ff5722", "#795548", "#607d8b"];

export function emptyFigure(): Figure {
  return { lines: [], circles: [], labels: [] };
}

function scaleFrom(source: readonly DrawingPoint[], screen: readonly ScreenPoint[]) {
  const a = source[0];
  const b = source[1] ?? source[0];
  const sa = screen[0];
  const sb = screen[1] ?? screen[0];
  if (!a || !sa) return { x: () => 0, y: () => 0 };
  const dt = (b?.time ?? a.time) - a.time || 1;
  const dp = (b?.price ?? a.price) - a.price || 1;
  const bx = sb?.x ?? sa.x;
  const by = sb?.y ?? sa.y;
  return {
    x: (time: number) => sa.x + ((bx - sa.x) * (time - a.time)) / dt,
    y: (price: number) => sa.y + ((by - sa.y) * (price - a.price)) / dp,
  };
}

function pushEdge(hits: { x: number; y: number; t: number }[], x: number, y: number, t: number, width: number, height: number) {
  if (x >= -1 && x <= width + 1 && y >= -1 && y <= height + 1) hits.push({ x, y, t });
}

export function lineHits(a: ScreenPoint, b: ScreenPoint, width: number, height: number): { x: number; y: number; t: number }[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const hits: { x: number; y: number; t: number }[] = [];
  if (dx !== 0) {
    for (const x of [0, width]) pushEdge(hits, x, a.y + ((x - a.x) / dx) * dy, (x - a.x) / dx, width, height);
  }
  if (dy !== 0) {
    for (const y of [0, height]) pushEdge(hits, a.x + ((y - a.y) / dy) * dx, y, (y - a.y) / dy, width, height);
  }
  hits.sort((left, right) => left.t - right.t);
  const unique: typeof hits = [];
  for (const hit of hits) {
    if (!unique.some((item) => Math.abs(item.t - hit.t) < 1e-6)) unique.push(hit);
  }
  return unique;
}

export function extendedSegment(a: ScreenPoint, b: ScreenPoint, pane: PaneSize): [ScreenPoint, ScreenPoint] | null {
  const hits = lineHits(a, b, pane.width, pane.height);
  if (hits.length < 2) return null;
  const start = hits[0];
  const end = hits[hits.length - 1];
  return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
}

export function raySegment(a: ScreenPoint, b: ScreenPoint, pane: PaneSize): [ScreenPoint, ScreenPoint] | null {
  const hits = lineHits(a, b, pane.width, pane.height).filter((hit) => hit.t >= -1e-6);
  const end = hits[hits.length - 1];
  return end ? [a, { x: end.x, y: end.y }] : [a, b];
}

export function regressionFit(candles: readonly FigureCandle[], start: number, end: number): { slope: number; intercept: number; deviation: number } | null {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const rows = candles.filter((candle) => candle.time >= lo && candle.time <= hi && Number.isFinite(candle.close));
  if (rows.length < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const row of rows) {
    sx += row.time;
    sy += row.close;
    sxx += row.time * row.time;
    sxy += row.time * row.close;
  }
  const n = rows.length;
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  let error = 0;
  for (const row of rows) {
    const delta = row.close - (slope * row.time + intercept);
    error += delta * delta;
  }
  return { slope, intercept, deviation: Math.sqrt(error / n) };
}

function formatSigned(value: number, digits = 2): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

function durationLabel(seconds: number): string {
  const span = Math.abs(seconds);
  if (span >= 86400) return `${(span / 86400).toFixed(span % 86400 === 0 ? 0 : 1)}d`;
  if (span >= 3600) return `${(span / 3600).toFixed(span % 3600 === 0 ? 0 : 1)}h`;
  if (span >= 60) return `${Math.round(span / 60)}m`;
  return `${Math.round(span)}s`;
}

function screenAngle(a: ScreenPoint, b: ScreenPoint): number {
  return Math.atan2(-(b.y - a.y), b.x - a.x) * 180 / Math.PI;
}

function addLine(figure: Figure, points: ScreenPoint[], color?: string, fill?: string, closed = false) {
  if (points.length < 2) return;
  figure.lines.push({ points, color, fill, closed });
}

export function buildFigure(
  type: DrawingType,
  screen: readonly ScreenPoint[],
  source: readonly DrawingPoint[],
  pane: PaneSize,
  candles: readonly FigureCandle[] = [],
): Figure {
  const figure = emptyFigure();
  const a = screen[0];
  const b = screen[1];
  const c = screen[2];
  const d = screen[3];
  const p0 = source[0];
  const p1 = source[1];
  const p2 = source[2];
  if (!a || !p0) return figure;
  const map = scaleFrom(source, screen);

  const hLine = (price: number, x0: number, x1: number, color?: string) => {
    addLine(figure, [{ x: x0, y: map.y(price) }, { x: x1, y: map.y(price) }], color);
  };

  if (type === "ray" && b) {
    const ray = raySegment(a, b, pane);
    if (ray) addLine(figure, [ray[0], ray[1]]);
  } else if (type === "extended-line" && b) {
    const span = extendedSegment(a, b, pane);
    if (span) addLine(figure, [span[0], span[1]]);
  } else if ((type === "trend-line" || type === "arrow" || type === "info-line" || type === "trend-angle") && b && p1) {
    addLine(figure, [a, b]);
    if (type === "info-line" || type === "trend-angle") {
      const delta = p1.price - p0.price;
      const percent = p0.price === 0 ? 0 : (delta / p0.price) * 100;
      const angle = screenAngle(a, b);
      const text = type === "trend-angle"
        ? `∠ ${angle.toFixed(1)}°`
        : `${formatSigned(delta)} (${formatSigned(percent)}%)  ∠ ${angle.toFixed(1)}°  ${durationLabel(p1.time - p0.time)}`;
      figure.labels.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 10, text });
    }
  } else if (type === "horizontal-ray") {
    addLine(figure, [a, { x: pane.width, y: a.y }]);
  } else if (type === "vertical-line") {
    addLine(figure, [{ x: a.x, y: 0 }, { x: a.x, y: pane.height }]);
  } else if (type === "cross-line") {
    addLine(figure, [{ x: 0, y: a.y }, { x: pane.width, y: a.y }]);
    addLine(figure, [{ x: a.x, y: 0 }, { x: a.x, y: pane.height }]);
  } else if (type === "parallel-channel" && b && c && p1 && p2) {
    const slope = p1.time === p0.time ? 0 : (p1.price - p0.price) / (p1.time - p0.time);
    const times = [p0.time, p1.time, p2.time];
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const base = (time: number) => p0.price + slope * (time - p0.time);
    const parallel = (time: number) => p2.price + slope * (time - p2.time);
    addLine(figure, [{ x: map.x(t0), y: map.y(base(t0)) }, { x: map.x(t1), y: map.y(base(t1)) }]);
    addLine(figure, [{ x: map.x(t0), y: map.y(parallel(t0)) }, { x: map.x(t1), y: map.y(parallel(t1)) }]);
    addLine(figure, [
      { x: map.x(t0), y: map.y(base(t0)) },
      { x: map.x(t1), y: map.y(base(t1)) },
      { x: map.x(t1), y: map.y(parallel(t1)) },
      { x: map.x(t0), y: map.y(parallel(t0)) },
    ], undefined, "rgba(118,231,164,0.12)", true);
  } else if (type === "flat-channel" && b && c && p1 && p2) {
    addLine(figure, [a, b]);
    const x0 = Math.min(a.x, b.x, c.x);
    const x1 = Math.max(a.x, b.x, c.x);
    hLine(p2.price, x0, x1);
  } else if (type === "disjoint-channel" && b && c && d) {
    addLine(figure, [a, b]);
    addLine(figure, [c, d]);
  } else if (type === "regression-trend" && b && p1) {
    const fit = regressionFit(candles, p0.time, p1.time);
    if (!fit) addLine(figure, [a, b]);
    else {
      const yAt = (time: number) => map.y(fit.slope * time + fit.intercept);
      const upper = (time: number) => map.y(fit.slope * time + fit.intercept + fit.deviation);
      const lower = (time: number) => map.y(fit.slope * time + fit.intercept - fit.deviation);
      addLine(figure, [{ x: a.x, y: yAt(p0.time) }, { x: b.x, y: yAt(p1.time) }]);
      addLine(figure, [{ x: a.x, y: upper(p0.time) }, { x: b.x, y: upper(p1.time) }], "#7eb6ff");
      addLine(figure, [{ x: a.x, y: lower(p0.time) }, { x: b.x, y: lower(p1.time) }], "#7eb6ff");
    }
  } else if ((type === "fib-retracement" || type === "fib-extension") && b && p1) {
    const base = type === "fib-extension" && p2 ? p2.price : p0.price;
    const delta = p1.price - p0.price;
    const x0 = Math.min(a.x, b.x, c?.x ?? b.x);
    const x1 = type === "fib-retracement" ? pane.width : Math.max(a.x, b.x, c?.x ?? b.x, pane.width * 0.72);
    const levels = FIB_RETRACEMENT_LEVELS.map((level, index) => ({
      level,
      price: base + delta * level,
      color: FIB_COLORS[index % FIB_COLORS.length],
    }));
    for (let index = 0; index < levels.length - 1; index += 1) {
      const top = levels[index];
      const bottom = levels[index + 1];
      addLine(figure, [
        { x: x0, y: map.y(top.price) },
        { x: x1, y: map.y(top.price) },
        { x: x1, y: map.y(bottom.price) },
        { x: x0, y: map.y(bottom.price) },
      ], top.color, `${top.color}22`, true);
    }
    for (const level of levels) {
      hLine(level.price, x0, x1, level.color);
      figure.labels.push({ x: x0 + 4, y: map.y(level.price) - 2, text: `${level.level}  ${level.price.toFixed(2)}`, color: level.color });
    }
  } else if (type === "fib-channel" && b && c && p1 && p2) {
    const slope = p1.time === p0.time ? 0 : (p1.price - p0.price) / (p1.time - p0.time);
    const t0 = Math.min(p0.time, p1.time, p2.time);
    const t1 = Math.max(p0.time, p1.time, p2.time);
    const at = (time: number, ratio: number) => {
      const base = p0.price + slope * (time - p0.time);
      const parallel = p2.price + slope * (time - p2.time);
      return base + (parallel - base) * ratio;
    };
    FIB_RETRACEMENT_LEVELS.forEach((level, index) => {
      const color = FIB_COLORS[index % FIB_COLORS.length];
      addLine(figure, [
        { x: map.x(t0), y: map.y(at(t0, level)) },
        { x: map.x(t1), y: map.y(at(t1, level)) },
      ], color);
    });
  } else if (type === "fib-time-zone" && b && p1) {
    const step = p1.time - p0.time || 1;
    for (const multiple of FIB_TIME_ZONE_STEPS) {
      const time = p0.time + step * multiple;
      const x = map.x(time);
      addLine(figure, [{ x, y: 0 }, { x, y: pane.height }], "#7eb6ff");
      figure.labels.push({ x: x + 4, y: 14, text: String(multiple), color: "#7eb6ff" });
    }
  } else if (type === "pitchfork" && b && c) {
    const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
    const median = raySegment(a, mid, pane);
    if (median) addLine(figure, [median[0], median[1]]);
    const dx = mid.x - a.x;
    const dy = mid.y - a.y;
    const upper = raySegment(b, { x: b.x + dx, y: b.y + dy }, pane);
    const lower = raySegment(c, { x: c.x + dx, y: c.y + dy }, pane);
    if (upper) addLine(figure, [upper[0], upper[1]]);
    if (lower) addLine(figure, [lower[0], lower[1]]);
  } else if (type === "gann-fan" && b) {
    const dx = b.x - a.x || 1;
    const dy = b.y - a.y || 1;
    for (const ratio of [8, 4, 3, 2, 1, 0.5, 1 / 3, 0.25, 0.125]) {
      const ray = raySegment(a, { x: a.x + dx, y: a.y + dy * ratio }, pane);
      if (ray) addLine(figure, [ray[0], ray[1]], ratio === 1 ? "#76e7a4" : "#7eb6ff");
      if (ratio !== 1) {
        const reciprocal = raySegment(a, { x: a.x + dx * ratio, y: a.y + dy }, pane);
        if (reciprocal) addLine(figure, [reciprocal[0], reciprocal[1]], "#7eb6ff");
      }
    }
  } else if (type === "rectangle" && b) {
    addLine(figure, [
      { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
    ], undefined, "rgba(118,231,164,0.12)", true);
  } else if (type === "rotated-rectangle" && b && c) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const width = (c.x - a.x) * nx + (c.y - a.y) * ny;
    const p = { x: a.x + nx * width, y: a.y + ny * width };
    const q = { x: b.x + nx * width, y: b.y + ny * width };
    addLine(figure, [a, b, q, p], undefined, "rgba(118,231,164,0.12)", true);
  } else if (type === "ellipse" && b) {
    figure.circles.push({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      rx: Math.max(1, Math.abs(b.x - a.x) / 2),
      ry: Math.max(1, Math.abs(b.y - a.y) / 2),
      fill: "rgba(118,231,164,0.12)",
    });
  } else if (type === "circle" && b) {
    const radius = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    figure.circles.push({ x: a.x, y: a.y, rx: radius, ry: radius, fill: "rgba(118,231,164,0.12)" });
  } else if (type === "triangle" && b && c) {
    addLine(figure, [a, b, c], undefined, "rgba(118,231,164,0.12)", true);
  } else if (type === "arc" && b && c) {
    addLine(figure, arcPoints(a, b, c));
  } else if (type === "polyline" || type === "brush" || type === "abcd" || type === "xabcd" || type === "head-shoulders" || type === "elliott-impulse") {
    addLine(figure, [...screen]);
    const labels = type === "xabcd" ? ["X", "A", "B", "C", "D"]
      : type === "abcd" ? ["A", "B", "C", "D"]
      : type === "head-shoulders" ? ["LS", "N", "H", "N", "RS"]
      : type === "elliott-impulse" ? ["1", "2", "3", "4", "5"]
      : [];
    labels.forEach((text, index) => {
      const point = screen[index];
      if (point) figure.labels.push({ x: point.x + 6, y: point.y - 6, text });
    });
  } else if ((type === "long-position" || type === "short-position") && b && p1) {
    const risk = positionRisk(p0.price, p1.price);
    const stopPrice = p2?.price ?? risk.stop;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const entryY = map.y(p0.price);
    const targetY = map.y(p1.price);
    const stopY = map.y(stopPrice);
    const profit = type === "short-position" ? "#e76770" : "#53c990";
    const loss = type === "short-position" ? "#53c990" : "#e76770";
    addLine(figure, [{ x: x0, y: entryY }, { x: x1, y: entryY }, { x: x1, y: targetY }, { x: x0, y: targetY }], profit, `${profit}33`, true);
    addLine(figure, [{ x: x0, y: entryY }, { x: x1, y: entryY }, { x: x1, y: stopY }, { x: x0, y: stopY }], loss, `${loss}33`, true);
    figure.labels.push({ x: x1 + 6, y: targetY, text: `TP ${p1.price.toFixed(2)}`, color: profit });
    figure.labels.push({ x: x1 + 6, y: entryY, text: `Entry ${p0.price.toFixed(2)}` });
    figure.labels.push({ x: x1 + 6, y: stopY, text: `SL ${stopPrice.toFixed(2)}  R:R ${risk.ratio.toFixed(2)}`, color: loss });
  } else if (type === "price-range" && b && p1) {
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const x0 = 0;
    const x1 = pane.width;
    addLine(figure, [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], undefined, "rgba(118,231,164,0.10)", true);
    const delta = p1.price - p0.price;
    const percent = p0.price === 0 ? 0 : (delta / p0.price) * 100;
    figure.labels.push({ x: 8, y: (y0 + y1) / 2, text: `${formatSigned(delta)} (${formatSigned(percent)}%)` });
  } else if (type === "date-range" && b && p1) {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    addLine(figure, [{ x: x0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: pane.height }, { x: x0, y: pane.height }], undefined, "rgba(126,182,255,0.10)", true);
    const inside = candles.filter((candle) => candle.time >= Math.min(p0.time, p1.time) && candle.time <= Math.max(p0.time, p1.time)).length;
    figure.labels.push({ x: (x0 + x1) / 2, y: 16, text: `${durationLabel(p1.time - p0.time)}${inside ? ` · ${inside} bars` : ""}` });
  } else if (type === "date-price-range" && b && p1) {
    addLine(figure, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], undefined, "rgba(118,231,164,0.12)", true);
    const delta = p1.price - p0.price;
    const percent = p0.price === 0 ? 0 : (delta / p0.price) * 100;
    figure.labels.push({ x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 8, text: `${formatSigned(delta)} (${formatSigned(percent)}%) · ${durationLabel(p1.time - p0.time)}` });
  } else if (type === "note" || type === "price-label") {
    figure.labels.push({ x: a.x + 8, y: a.y, text: type === "price-label" ? p0.price.toFixed(2) : "注释" });
  } else if (type === "callout" && b) {
    addLine(figure, [a, b]);
    figure.labels.push({ x: b.x + 8, y: b.y, text: "标注" });
  } else if (type === "arrow-up" || type === "arrow-down") {
    const dir = type === "arrow-up" ? -1 : 1;
    addLine(figure, [
      { x: a.x, y: a.y + dir * 10 },
      { x: a.x - 6, y: a.y },
      { x: a.x + 6, y: a.y },
    ], undefined, "#76e7a4", true);
  } else if (b) {
    addLine(figure, [a, b]);
  }
  return figure;
}

function arcPoints(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): ScreenPoint[] {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return [a, b, c];
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const radius = Math.hypot(a.x - ux, a.y - uy);
  const start = Math.atan2(a.y - uy, a.x - ux);
  const mid = Math.atan2(b.y - uy, b.x - ux);
  const end = Math.atan2(c.y - uy, c.x - ux);
  const sweep = normalizeSweep(start, mid, end);
  const steps = 24;
  const points: ScreenPoint[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + sweep * (index / steps);
    points.push({ x: ux + Math.cos(angle) * radius, y: uy + Math.sin(angle) * radius });
  }
  return points;
}

function normalizeSweep(start: number, mid: number, end: number): number {
  const forward = (angle: number) => {
    let delta = angle - start;
    while (delta < 0) delta += Math.PI * 2;
    while (delta >= Math.PI * 2) delta -= Math.PI * 2;
    return delta;
  };
  const midDelta = forward(mid);
  const endDelta = forward(end);
  return midDelta <= endDelta ? endDelta : endDelta - Math.PI * 2;
}

export function hitFigure(
  anchors: readonly ScreenPoint[],
  figure: Figure,
  point: ScreenPoint,
  tolerance: number,
): "body" | `point-${number}` | null {
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    if (anchor && Math.hypot(point.x - anchor.x, point.y - anchor.y) <= tolerance) return `point-${index}`;
  }
  for (const circle of figure.circles) {
    const nx = circle.rx === 0 ? 0 : (point.x - circle.x) / circle.rx;
    const ny = circle.ry === 0 ? 0 : (point.y - circle.y) / circle.ry;
    if (nx * nx + ny * ny <= 1) return "body";
  }
  for (const line of figure.lines) {
    if (line.closed && pointInPolygon(point, line.points)) return "body";
    for (let index = 1; index < line.points.length; index += 1) {
      if (distanceToSegment(point, line.points[index - 1], line.points[index]) <= tolerance) return "body";
    }
    if (line.closed && line.points.length > 2 && distanceToSegment(point, line.points[line.points.length - 1], line.points[0]) <= tolerance) return "body";
  }
  return null;
}

function distanceToSegment(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function pointInPolygon(point: ScreenPoint, polygon: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const intersect = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
