/**
 * Mobile touch alerts: trendline interpolation, wick/cross detection, liquidation box rebinding.
 * Pure — no I/O. Overlay toggles must not call any of this to move a chart scale.
 */
import type { LiqBand, LiqZone, LiqZoneRisk } from "../liq-heatmap.ts";

export const MOBILE_TOUCH_COOLDOWN_MS = 60_000;

export type TouchBar = { time: number; open: number; high: number; low: number; close: number };
export type TouchPoint = { time: number; price: number };
export type TouchKind = "up" | "down" | "wick";
export type TouchTarget = "trendline" | "horizontal" | "ray" | "rectangle" | "support" | "resistance";

export type TouchDrawing = {
  id: string;
  type: string;
  alert?: boolean;
  ray?: boolean;
  a?: TouchPoint;
  b?: TouchPoint;
  time?: number;
  price?: number;
  dir?: "left" | "right";
};

export type MobileLiqBox = {
  id: string;
  role: "support" | "resistance";
  lo: number;
  hi: number;
  risk: LiqZoneRisk;
  liq_m: number;
};

export type TouchFire = {
  id: string;
  kind: TouchKind;
  target: TouchTarget;
  price: number;
  lo: number | null;
  hi: number | null;
  message: string;
};

export type CooldownBook = Record<string, number>;

const RISKS = new Set<LiqZoneRisk>(["中", "高", "极高"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** p(t) = p1 + (p2 - p1) * (t - t1) / (t2 - t1). Vertical lines have no price. */
export function trendlinePriceAt(t: number, p1: number, t1: number, p2: number, t2: number): number | null {
  if (!finite(t) || !finite(p1) || !finite(t1) || !finite(p2) || !finite(t2) || t2 === t1) return null;
  return p1 + ((p2 - p1) * (t - t1)) / (t2 - t1);
}

/** A segment is closed [t1, t2]. A ray starts at t1, passes through t2, and continues. */
export function trendlineDomain(t: number, t1: number, t2: number, ray: boolean): boolean {
  if (!finite(t) || !finite(t1) || !finite(t2)) return false;
  if (ray) return t2 >= t1 ? t >= t1 : t <= t1;
  return t >= Math.min(t1, t2) && t <= Math.max(t1, t2);
}

export function defaultTouchTolerance(price: number): number {
  if (!finite(price) || price <= 0) return 0;
  return price * 0.0002;
}

export function formatAlertPrice(value: number): string {
  if (!finite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

export function formatTouchMessage(event: { target: TouchTarget | string; price: number; lo: number | null; hi: number | null }): string {
  if (event.target === "support" && event.lo != null && event.hi != null) {
    return `触碰清算支撑区 $${formatAlertPrice(event.lo)}–$${formatAlertPrice(event.hi)}`;
  }
  if (event.target === "resistance" && event.lo != null && event.hi != null) {
    return `触碰清算阻力区 $${formatAlertPrice(event.lo)}–$${formatAlertPrice(event.hi)}`;
  }
  if (event.target === "trendline") return `触碰趋势线 @ $${formatAlertPrice(event.price)}`;
  if (event.target === "rectangle") return `触碰矩形 @ $${formatAlertPrice(event.price)}`;
  return `触碰水平线 @ $${formatAlertPrice(event.price)}`;
}

/**
 * Cross uses the previous close versus this bar's close. A wick touch is a range intersection
 * that does not close through the level. The first sample (no previous close) never fires.
 */
export function classifyLevelTouch(prevClose: number | null, bar: Pick<TouchBar, "high" | "low" | "close">, level: number, tolerance: number): TouchKind | null {
  if (!finite(level) || !finite(bar.high) || !finite(bar.low) || !finite(bar.close)) return null;
  const tol = finite(tolerance) && tolerance > 0 ? tolerance : 0;
  if (prevClose == null || !finite(prevClose)) return null;
  if (prevClose < level - tol && bar.close >= level - tol) return "up";
  if (prevClose > level + tol && bar.close <= level + tol) return "down";
  const overlaps = bar.high >= level - tol && bar.low <= level + tol;
  return overlaps ? "wick" : null;
}

function zoneTouch(prevClose: number | null, bar: Pick<TouchBar, "high" | "low" | "close">, lo: number, hi: number, tolerance: number): TouchKind | null {
  if (!finite(lo) || !finite(hi) || hi < lo) return null;
  const tol = finite(tolerance) && tolerance > 0 ? tolerance : 0;
  const overlaps = bar.high >= lo - tol && bar.low <= hi + tol;
  if (!overlaps || prevClose == null || !finite(prevClose)) return null;
  const prevInside = prevClose >= lo - tol && prevClose <= hi + tol;
  if (prevInside) return null;
  const closeInside = bar.close >= lo - tol && bar.close <= hi + tol;
  if (prevClose < lo - tol && (closeInside || bar.high >= lo - tol)) return "up";
  if (prevClose > hi + tol && (closeInside || bar.low <= hi + tol)) return "down";
  return "wick";
}

function drawingLevel(drawing: TouchDrawing, time: number): { level: number; target: TouchTarget } | null {
  if (drawing.type === "trend-line" && drawing.a && drawing.b) {
    if (!trendlineDomain(time, drawing.a.time, drawing.b.time, drawing.ray === true)) return null;
    const level = trendlinePriceAt(time, drawing.a.price, drawing.a.time, drawing.b.price, drawing.b.time);
    return level == null ? null : { level, target: "trendline" };
  }
  if (drawing.type === "horizontal-line" && finite(drawing.price)) return { level: drawing.price, target: "horizontal" };
  if (drawing.type === "horizontal-ray" && finite(drawing.price) && finite(drawing.time)) {
    const dir = drawing.dir === "left" ? "left" : "right";
    const inside = dir === "right" ? time >= drawing.time : time <= drawing.time;
    return inside ? { level: drawing.price, target: "ray" } : null;
  }
  return null;
}

function consider(
  fired: TouchFire[],
  cooldown: CooldownBook,
  key: string,
  kind: TouchKind | null,
  target: TouchTarget,
  price: number,
  lo: number | null,
  hi: number | null,
  now: number,
  cooldownMs: number,
): void {
  if (!kind) return;
  const last = cooldown[key];
  if (typeof last === "number" && now - last < cooldownMs) return;
  cooldown[key] = now;
  const event: TouchFire = { id: key, kind, target, price, lo, hi, message: "" };
  event.message = formatTouchMessage(event);
  fired.push(event);
}

export function rebindCooldown(book: CooldownBook, ids: readonly string[]): CooldownBook {
  const next: CooldownBook = {};
  for (const id of ids) {
    const at = book[id];
    if (typeof at === "number" && Number.isFinite(at)) next[id] = at;
  }
  return next;
}

export function evaluateTouches(input: {
  prev: TouchBar | null;
  bar: TouchBar;
  drawings: readonly TouchDrawing[];
  zones: readonly MobileLiqBox[];
  cooldown: CooldownBook;
  now: number;
  cooldownMs?: number;
  tolerance?: number;
  alertsArmed: boolean;
}): { fired: TouchFire[]; cooldown: CooldownBook } {
  const cooldownMs = input.cooldownMs ?? MOBILE_TOUCH_COOLDOWN_MS;
  const tolerance = input.tolerance ?? defaultTouchTolerance(input.bar.close);
  if (!input.alertsArmed) return { fired: [], cooldown: { ...input.cooldown } };
  const live = [
    ...input.drawings.filter((drawing) => drawing.alert).map((drawing) => `draw:${drawing.id}`),
    ...input.zones.map((zone) => zone.id),
  ];
  const cooldown = rebindCooldown(input.cooldown, live);
  const fired: TouchFire[] = [];
  const prevClose = input.prev?.close ?? null;
  for (const drawing of input.drawings) {
    if (!drawing.alert) continue;
    if (drawing.type === "rectangle" && drawing.a && drawing.b) {
      if (!trendlineDomain(input.bar.time, drawing.a.time, drawing.b.time, false)) continue;
      const lo = Math.min(drawing.a.price, drawing.b.price);
      const hi = Math.max(drawing.a.price, drawing.b.price);
      consider(fired, cooldown, `draw:${drawing.id}`, zoneTouch(prevClose, input.bar, lo, hi, tolerance), "rectangle", input.bar.close, lo, hi, input.now, cooldownMs);
      continue;
    }
    const level = drawingLevel(drawing, input.bar.time);
    if (!level) continue;
    consider(
      fired, cooldown, `draw:${drawing.id}`,
      classifyLevelTouch(prevClose, input.bar, level.level, tolerance),
      level.target, level.level, null, null, input.now, cooldownMs,
    );
  }
  for (const zone of input.zones) {
    consider(
      fired, cooldown, zone.id,
      zoneTouch(prevClose, input.bar, zone.lo, zone.hi, tolerance),
      zone.role === "support" ? "support" : "resistance",
      input.bar.close, zone.lo, zone.hi, input.now, cooldownMs,
    );
  }
  return { fired, cooldown };
}

function asRisk(value: unknown): LiqZoneRisk | null {
  return typeof value === "string" && RISKS.has(value as LiqZoneRisk) ? value as LiqZoneRisk : null;
}

function boxFromRange(role: "support" | "resistance", lo: number, hi: number, risk: LiqZoneRisk, liq: number): MobileLiqBox | null {
  if (!(lo > 0) || !(hi > lo) || !(liq > 0)) return null;
  return { id: `liq:${role}:${lo}:${hi}`, role, lo, hi, risk, liq_m: liq };
}

/** Adjacent 极高 bins of the same role collapse into one bordered box. 高 and 中 stay separate. */
export function mergeAdjacentExtreme(boxes: readonly MobileLiqBox[]): MobileLiqBox[] {
  const sorted = [...boxes].sort((a, b) => (a.role === b.role ? a.lo - b.lo : a.role === "support" ? -1 : 1));
  const out: MobileLiqBox[] = [];
  for (const box of sorted) {
    const prev = out[out.length - 1];
    const gap = prev ? Math.max(1e-9, prev.hi * 1e-6) : 0;
    if (prev && prev.role === box.role && prev.risk === "极高" && box.risk === "极高" && box.lo <= prev.hi + gap) {
      const hi = Math.max(prev.hi, box.hi);
      const liq = prev.liq_m + box.liq_m;
      out[out.length - 1] = { id: `liq:${prev.role}:${prev.lo}:${hi}`, role: prev.role, lo: prev.lo, hi, risk: "极高", liq_m: liq };
    } else {
      out.push({ ...box });
    }
  }
  return out;
}

type ZoneLike = Pick<LiqZone, "lo" | "hi" | "role" | "liq_m"> & { risk_max?: unknown; risk?: unknown; side?: unknown };
type BandLike = Pick<LiqBand, "lo" | "hi" | "side" | "liq_m"> & { risk?: unknown };

/**
 * Short liquidations (resistance) only above the live price. Long liquidations (support) only below it.
 * Empty input yields an empty list so the chart can show ∅ instead of failing.
 */
export function selectMobileLiqBoxes(zones: readonly ZoneLike[], bands: readonly BandLike[], price: number): MobileLiqBox[] {
  if (!finite(price) || !(price > 0)) return [];
  const fromZones: MobileLiqBox[] = [];
  for (const zone of zones) {
    const risk = asRisk(zone.risk_max ?? zone.risk);
    if (!risk || !finite(zone.lo) || !finite(zone.hi) || !finite(zone.liq_m)) continue;
    if (zone.side === "long" && zone.role !== "support") continue;
    if (zone.side === "short" && zone.role !== "resistance") continue;
    if (zone.role === "support" && zone.side !== "short" && zone.hi <= price) {
      const box = boxFromRange("support", zone.lo, zone.hi, risk, zone.liq_m);
      if (box) fromZones.push(box);
    } else if (zone.role === "resistance" && zone.side !== "long" && zone.lo >= price) {
      const box = boxFromRange("resistance", zone.lo, zone.hi, risk, zone.liq_m);
      if (box) fromZones.push(box);
    }
  }
  const fromBands: MobileLiqBox[] = [];
  for (const band of bands) {
    const risk = asRisk(band.risk);
    if (!risk || !finite(band.lo) || !finite(band.hi) || !finite(band.liq_m)) continue;
    const covered = fromZones.some((zone) => band.lo >= zone.lo && band.hi <= zone.hi && (
      (band.side === "long" && zone.role === "support") || (band.side === "short" && zone.role === "resistance")
    ));
    if (covered) continue;
    if (band.side === "long" && band.hi <= price) {
      const box = boxFromRange("support", band.lo, band.hi, risk, band.liq_m);
      if (box) fromBands.push(box);
    } else if (band.side === "short" && band.lo >= price) {
      const box = boxFromRange("resistance", band.lo, band.hi, risk, band.liq_m);
      if (box) fromBands.push(box);
    }
  }
  return mergeAdjacentExtreme([...fromZones, ...fromBands]);
}

/** Push badge anchors apart so price-axis labels do not stack on the same pixel. */
export function stackBadgeYs(ys: readonly number[], gap: number, min: number, max: number): number[] {
  const out: number[] = [];
  let cursor = min;
  for (const y of ys) {
    const desired = finite(y) ? y : cursor;
    const placed = Math.min(max, Math.max(desired, cursor, min));
    out.push(placed);
    cursor = placed + (finite(gap) && gap > 0 ? gap : 0);
  }
  return out;
}
