import { intervalDurationMs, sanitizeMarketCopy, type ChartInterval } from "./market-venues.ts";
import type { CvdBar, CvdSnapshot } from "./market-cvd.ts";
import type { OiHistorySnapshot, OiPoint } from "./market-oi.ts";

export const CVD_PANE_STORAGE_KEY = "th-pane-cvd";
export const OI_PANE_STORAGE_KEY = "th-pane-oi";
export const INDICATOR_PANE_STRETCH = 0.42;
export const CVD_PANE_EMPTY = "CVD series unavailable.";
export const OI_PANE_EMPTY = "Open interest series unavailable.";

export type IndicatorPaneId = "cvd" | "oi";
export type PaneLinePoint = { time: number; value: number };
export type IndicatorPaneModel = {
  available: boolean;
  label: string;
  unit: string | null;
  points: PaneLinePoint[];
  emptyNotice: string | null;
};

type FlagStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function readStoredFlag(storage: FlagStorage | null | undefined, key: string, fallback = false): boolean {
  if (!storage) return fallback;
  try {
    const stored = storage.getItem(key)?.trim().toLowerCase();
    if (stored === "0" || stored === "off" || stored === "false" || stored === "no") return false;
    if (stored === "1" || stored === "on" || stored === "true" || stored === "yes") return true;
  } catch {
    return fallback;
  }
  return fallback;
}

export function writeStoredFlag(storage: FlagStorage | null | undefined, key: string, value: boolean): void {
  try {
    storage?.setItem(key, value ? "1" : "0");
  } catch {
    // Quota / private mode should not break chart toggles.
  }
}

const PANE_PREFS_EVENT = "th-pane-prefs";
let panePrefsLive = false;

export function panePrefsAreLive(): boolean {
  return panePrefsLive;
}

export function readClientPaneFlag(storage: FlagStorage | null | undefined, key: string, fallback = false): boolean {
  if (typeof window !== "undefined" && !panePrefsLive) return false;
  return readStoredFlag(storage, key, fallback);
}

export function subscribePanePrefs(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(PANE_PREFS_EVENT, onChange);
  if (!panePrefsLive) {
    const enable = () => {
      panePrefsLive = true;
      window.dispatchEvent(new Event(PANE_PREFS_EVENT));
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(enable);
    else setTimeout(enable, 0);
  }
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PANE_PREFS_EVENT, onChange);
  };
}

export function notifyPanePrefs(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PANE_PREFS_EVENT));
}

export function indicatorPaneStack(flags: { cvd: boolean; oi: boolean }): IndicatorPaneId[] {
  const stack: IndicatorPaneId[] = [];
  if (flags.cvd) stack.push("cvd");
  if (flags.oi) stack.push("oi");
  return stack;
}

export function indicatorPaneIndex(id: IndicatorPaneId, stack: readonly IndicatorPaneId[]): number {
  const index = stack.indexOf(id);
  return index === -1 ? -1 : index + 1;
}

export function pointerInMainPane(y: number, paneHeight: number | null | undefined): boolean {
  if (paneHeight == null || !Number.isFinite(paneHeight) || paneHeight <= 0) return true;
  return y >= 0 && y <= paneHeight;
}

export function normalizeLinePoints(points: readonly PaneLinePoint[]): PaneLinePoint[] {
  const byTime = new Map<number, number>();
  for (const point of points) {
    const time = Number(point.time);
    const value = Number(point.value);
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(value)) continue;
    byTime.set(time, value);
  }
  return [...byTime.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([time, value]) => ({ time, value }));
}

export function cvdPaneModel(snapshot: CvdSnapshot | null | undefined): IndicatorPaneModel {
  const perp = snapshot?.perp;
  const spot = snapshot?.spot;
  const book = perp?.available && perp.bars.length
    ? { source: "perp" as const, book: perp }
    : spot?.available && spot.bars.length
      ? { source: "spot" as const, book: spot }
      : null;
  if (!book) {
    const reason = shortPaneNotice(perp?.reason || spot?.reason || snapshot?.notice, CVD_PANE_EMPTY);
    return { available: false, label: "CVD", unit: null, points: [], emptyNotice: reason };
  }
  return {
    available: true,
    label: book.source === "perp" ? "CVD · Perp" : "CVD · Spot",
    unit: book.book.unit,
    points: cvdBarsToPoints(book.book.bars),
    emptyNotice: null,
  };
}

export function cvdBarsToPoints(bars: readonly CvdBar[]): PaneLinePoint[] {
  return normalizeLinePoints(bars.map((bar) => ({ time: bar.time, value: bar.cvd })));
}

export function oiPaneModel(input: {
  history?: OiHistorySnapshot | null;
  liveValue?: number | null;
  liveTime?: number | null;
  liveAmount?: number | null;
}): IndicatorPaneModel {
  const historyPoints = scaleOiPointsToUsd(
    input.history?.points ?? [],
    input.history?.unit ?? "usd",
    input.liveAmount ?? null,
    input.liveValue ?? null,
  );
  const livePoint = liveOiPoint(input.liveTime, input.liveValue);
  const points = normalizeLinePoints(livePoint ? [...historyPoints, livePoint] : historyPoints);
  if (!points.length) {
    return {
      available: false,
      label: "OI",
      unit: null,
      points: [],
      emptyNotice: shortPaneNotice(input.history?.notice, OI_PANE_EMPTY),
    };
  }
  const unit = input.history?.unit === "contracts" && !canScaleOiToUsd(input.liveAmount, input.liveValue)
    ? "contracts"
    : "usd";
  return {
    available: true,
    label: unit === "usd" ? "OI · USD" : "OI · contracts",
    unit,
    points,
    emptyNotice: null,
  };
}

export function mergeLiveOiPoint(points: readonly PaneLinePoint[], time: number | null | undefined, value: number | null | undefined): PaneLinePoint[] {
  const live = liveOiPoint(time, value);
  if (!live) return normalizeLinePoints(points);
  return normalizeLinePoints([...points, live]);
}

export function toBarTimeSeconds(timeMs: number, interval: ChartInterval): number {
  const duration = intervalDurationMs(interval);
  const ms = timeMs > 10_000_000_000 ? timeMs : timeMs * 1000;
  return Math.floor(ms / duration) * (duration / 1000);
}

export function applyIndicatorPaneStretch(panes: ReadonlyArray<{ setStretchFactor?(value: number): void }>): void {
  if (panes.length < 2) return;
  panes[0]?.setStretchFactor?.(1);
  for (let index = 1; index < panes.length; index += 1) {
    panes[index]?.setStretchFactor?.(INDICATOR_PANE_STRETCH);
  }
}

export function shortPaneNotice(value: string | null | undefined, fallback: string): string {
  return sanitizeMarketCopy(value) || fallback;
}

function liveOiPoint(time: number | null | undefined, value: number | null | undefined): PaneLinePoint | null {
  if (time == null || value == null || !Number.isFinite(time) || !Number.isFinite(value)) return null;
  return { time, value };
}

function scaleOiPointsToUsd(
  points: readonly OiPoint[],
  unit: OiHistorySnapshot["unit"],
  liveAmount: number | null,
  liveValue: number | null,
): PaneLinePoint[] {
  if (unit === "usd") return points.map((point) => ({ time: point.time, value: point.value }));
  if (!canScaleOiToUsd(liveAmount, liveValue) || liveAmount == null || liveValue == null) {
    return points.map((point) => ({ time: point.time, value: point.value }));
  }
  const multiplier = liveValue / liveAmount;
  return points.map((point) => ({ time: point.time, value: point.value * multiplier }));
}

function canScaleOiToUsd(liveAmount: number | null | undefined, liveValue: number | null | undefined): boolean {
  return liveAmount != null && liveValue != null && Number.isFinite(liveAmount) && liveAmount > 0 && Number.isFinite(liveValue);
}
