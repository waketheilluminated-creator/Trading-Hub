/**
 * TradingView built-in "Pivot Points High Low" (ta.pivothigh / ta.pivotlow).
 *
 * A pivot high is confirmed only once `right` bars exist after it. Equals on
 * the left are allowed, so a flat top resolves to its rightmost bar. An equal
 * or higher value on the right rejects the candidate. Pivot lows mirror that
 * rule. Bars that do not yet have a full right window are omitted, which is
 * the non-repainting confirmation delay.
 */
import { formatPriceWithPrecision } from "./price-precision.ts";

export const PIVOT_BARS_DEFAULT = 10;
export const PIVOT_BARS_MIN = 1;
export const PIVOT_BARS_MAX = 500;
export const PIVOT_HIGH_COLOR = "#f23645";
export const PIVOT_LOW_COLOR = "#089981";
export const PIVOT_LABEL_TEXT = "#ffffff";
export const PIVOT_LABEL_HEIGHT = 16;
export const PIVOT_LABEL_ARROW = 5;
export const PIVOT_LABEL_PAD_X = 5;
export const PIVOT_POINTS_SETTINGS_KEY = "th-study-pivots-hl-lengths";

export type PivotPointsHighLowSettings = {
  highLeft: number;
  highRight: number;
  lowLeft: number;
  lowRight: number;
};

export const DEFAULT_PIVOT_POINTS_HIGH_LOW: PivotPointsHighLowSettings = Object.freeze({
  highLeft: PIVOT_BARS_DEFAULT,
  highRight: PIVOT_BARS_DEFAULT,
  lowLeft: PIVOT_BARS_DEFAULT,
  lowRight: PIVOT_BARS_DEFAULT,
});

export type PivotKind = "high" | "low";
export type PivotLabelSide = "above" | "below";

export type PivotBar = {
  high: number;
  low: number;
  time?: number;
};

export type PivotPoint = {
  index: number;
  time: number | null;
  price: number;
  kind: PivotKind;
};

export type PivotLabelModel = {
  time: number;
  price: number;
  text: string;
  side: PivotLabelSide;
  kind: PivotKind;
  color: string;
};

export type PivotLabelLayout = {
  side: PivotLabelSide;
  anchorX: number;
  anchorY: number;
  left: number;
  top: number;
  width: number;
  height: number;
  tipY: number;
};

type SettingsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const PARSED_SETTINGS = new Map<string, PivotPointsHighLowSettings>();

export function pivotPointsHighLow(
  bars: readonly PivotBar[],
  settings?: Partial<PivotPointsHighLowSettings> | null,
): PivotPoint[] {
  const lengths = normalizePivotPointsSettings(settings);
  const points: PivotPoint[] = [];
  for (let index = 0; index < bars.length; index += 1) {
    if (isPivot(bars, index, lengths.highLeft, lengths.highRight, "high")) {
      points.push(pivotPoint(bars, index, "high"));
    }
    if (isPivot(bars, index, lengths.lowLeft, lengths.lowRight, "low")) {
      points.push(pivotPoint(bars, index, "low"));
    }
  }
  return points;
}

export function pivotLabelModels(
  bars: readonly PivotBar[],
  settings: Partial<PivotPointsHighLowSettings> | null | undefined,
  precision: number | null,
): PivotLabelModel[] {
  const labels: PivotLabelModel[] = [];
  for (const point of pivotPointsHighLow(bars, settings)) {
    if (point.time == null) continue;
    labels.push({
      time: point.time,
      price: point.price,
      text: formatPriceWithPrecision(point.price, precision),
      side: pivotSide(point.kind),
      kind: point.kind,
      color: pivotColor(point.kind),
    });
  }
  return labels;
}

/** Pixel box around a price anchor. The anchor price is not changed. */
export function layoutPivotLabel(side: PivotLabelSide, anchorX: number, anchorY: number, textWidth: number): PivotLabelLayout {
  const width = Math.max(0, textWidth) + PIVOT_LABEL_PAD_X * 2;
  const height = PIVOT_LABEL_HEIGHT;
  return {
    side,
    anchorX,
    anchorY,
    left: anchorX - width / 2,
    top: labelTop(side, anchorY, height),
    width,
    height,
    tipY: anchorY,
  };
}

export function pivotPointsParamsLabel(settings: Partial<PivotPointsHighLowSettings> | null | undefined): string {
  const lengths = normalizePivotPointsSettings(settings);
  return `${lengths.highLeft} ${lengths.highRight} ${lengths.lowLeft} ${lengths.lowRight}`;
}

export function normalizePivotPointsSettings(input: unknown): PivotPointsHighLowSettings {
  const source = plainRecord(input);
  return {
    highLeft: clampPivotBars(own(source, "highLeft"), PIVOT_BARS_DEFAULT),
    highRight: clampPivotBars(own(source, "highRight"), PIVOT_BARS_DEFAULT),
    lowLeft: clampPivotBars(own(source, "lowLeft"), PIVOT_BARS_DEFAULT),
    lowRight: clampPivotBars(own(source, "lowRight"), PIVOT_BARS_DEFAULT),
  };
}

export function readPivotPointsSettings(storage: SettingsStorage | null | undefined): PivotPointsHighLowSettings {
  if (!storage) return DEFAULT_PIVOT_POINTS_HIGH_LOW;
  let raw: string | null;
  try {
    raw = storage.getItem(PIVOT_POINTS_SETTINGS_KEY);
  } catch {
    return DEFAULT_PIVOT_POINTS_HIGH_LOW;
  }
  if (raw == null || raw.trim() === "") return DEFAULT_PIVOT_POINTS_HIGH_LOW;
  const cached = PARSED_SETTINGS.get(raw);
  if (cached) return cached;
  try {
    const normalized = normalizePivotPointsSettings(JSON.parse(raw));
    PARSED_SETTINGS.set(raw, normalized);
    return normalized;
  } catch {
    return DEFAULT_PIVOT_POINTS_HIGH_LOW;
  }
}

export function writePivotPointsSettings(
  storage: SettingsStorage | null | undefined,
  settings: Partial<PivotPointsHighLowSettings> | null | undefined,
): void {
  if (!storage) return;
  try {
    const normalized = normalizePivotPointsSettings(settings);
    const raw = JSON.stringify(normalized);
    storage.setItem(PIVOT_POINTS_SETTINGS_KEY, raw);
    PARSED_SETTINGS.set(raw, normalized);
  } catch {
    // Quota or private mode must not break the chart.
  }
}

function pivotPoint(bars: readonly PivotBar[], index: number, kind: PivotKind): PivotPoint {
  return { index, time: finiteTime(bars[index]?.time), price: seriesValue(bars, index, kind), kind };
}

function isPivot(bars: readonly PivotBar[], index: number, left: number, right: number, kind: PivotKind): boolean {
  if (index < left || index + right >= bars.length) return false;
  const candidate = seriesValue(bars, index, kind);
  if (!Number.isFinite(candidate)) return false;
  for (let cursor = index - left; cursor < index; cursor += 1) {
    const other = seriesValue(bars, cursor, kind);
    if (!Number.isFinite(other) || losesOnLeft(kind, candidate, other)) return false;
  }
  for (let cursor = index + 1; cursor <= index + right; cursor += 1) {
    const other = seriesValue(bars, cursor, kind);
    if (!Number.isFinite(other) || losesOnRight(kind, candidate, other)) return false;
  }
  return true;
}

/** Left side is non-strict: an equal extreme further left does not reject. */
function losesOnLeft(kind: PivotKind, candidate: number, other: number): boolean {
  switch (kind) {
    case "high":
      return other > candidate;
    case "low":
      return other < candidate;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** Right side is strict: an equal extreme still ahead means the run has not ended. */
function losesOnRight(kind: PivotKind, candidate: number, other: number): boolean {
  switch (kind) {
    case "high":
      return other >= candidate;
    case "low":
      return other <= candidate;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function seriesValue(bars: readonly PivotBar[], index: number, kind: PivotKind): number {
  const bar = bars[index];
  if (!bar) return Number.NaN;
  switch (kind) {
    case "high":
      return bar.high;
    case "low":
      return bar.low;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function pivotSide(kind: PivotKind): PivotLabelSide {
  switch (kind) {
    case "high":
      return "above";
    case "low":
      return "below";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function pivotColor(kind: PivotKind): string {
  switch (kind) {
    case "high":
      return PIVOT_HIGH_COLOR;
    case "low":
      return PIVOT_LOW_COLOR;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function labelTop(side: PivotLabelSide, anchorY: number, height: number): number {
  switch (side) {
    case "above":
      return anchorY - PIVOT_LABEL_ARROW - height;
    case "below":
      return anchorY + PIVOT_LABEL_ARROW;
    default: {
      const unreachable: never = side;
      return unreachable;
    }
  }
}

function finiteTime(time: number | undefined): number | null {
  return typeof time === "number" && Number.isFinite(time) ? time : null;
}

function plainRecord(input: unknown): Record<string, unknown> | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function own(source: Record<string, unknown> | null, key: string): unknown {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return source[key];
}

function clampPivotBars(value: unknown, fallback: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(PIVOT_BARS_MAX, Math.max(PIVOT_BARS_MIN, Math.trunc(numeric)));
}
