// Allow: the checked-in Binance BTCUSDT price / OI / rolling CVD fixture, with bad points dropped.
// Deny: wrong kind, non-finite numbers, malformed points, and client privilege flags. No live Binance fetch.

import { compactSymbol } from "./market-venues.ts";

export const CVD_OI_KIND = "binance_cvd_oi" as const;
export const CVD_OI_SYMBOL = "BTCUSDT";
export const CVD_OI_SERIES_MAX = 2000;

export const CVD_OI_COLORS = {
  price: "#111111",
  oiUsd: "#2f6bff",
  cvdUsd: "#e23b4a",
  chartBackground: "#f6f7f9",
} as const;

export const CVD_OI_PANES = {
  price: 0,
  oiUsd: 1,
  cvdUsd: 2,
} as const;

const SERIES_ABS_MAX = 1e15;

export type CvdOiAxis = { label: string; unit: string };
export type CvdOiPoint = { t: string; price: number; oiUsd: number; cvdUsd: number };
export type CvdOiChartPoint = { time: number; price: number; oiUsd: number; cvdUsd: number };
export type CvdOiReadout = { time: number | null; price: number | null; oiUsd: number | null; cvdUsd: number | null };

export type CvdOiSnapshot = {
  kind: typeof CVD_OI_KIND;
  symbol: typeof CVD_OI_SYMBOL;
  venue: "binance";
  updatedAt: string | null;
  window: string | null;
  source: "binance_public";
  series: CvdOiPoint[];
  axes: { price: CvdOiAxis; oiUsd: CvdOiAxis; cvdUsd: CvdOiAxis };
  note: string;
};

export type CvdOiSanitizeResult =
  | { ok: true; snapshot: CvdOiSnapshot; dropped: number }
  | { ok: false; error: string };

export type CvdOiHttpResult =
  | { status: 200; body: CvdOiSnapshot }
  | { status: 400; body: { error: string } };

function cleanCopy(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    text += code <= 31 || code === 127 ? " " : char;
  }
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanLabel(value: unknown, max: number): string | null {
  const clean = cleanCopy(value, max);
  return clean || null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? value : null;
}

function seriesNumber(value: unknown, allowNegative: boolean, allowZero: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > SERIES_ABS_MAX) return null;
  if (!allowNegative && value < 0) return null;
  if (!allowZero && value === 0) return null;
  return value;
}

function sanitizePoint(value: unknown): CvdOiPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const t = isoTimestamp(raw.t);
  const price = seriesNumber(raw.price, false, false);
  const oiUsd = seriesNumber(raw.oiUsd, false, true);
  const cvdUsd = seriesNumber(raw.cvdUsd, true, true);
  if (!t || price == null || oiUsd == null || cvdUsd == null) return null;
  return { t, price, oiUsd, cvdUsd };
}

function sanitizeAxis(value: unknown): CvdOiAxis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const label = cleanLabel(raw.label, 80);
  if (!label) return null;
  return { label, unit: cleanLabel(raw.unit, 12) ?? "USD" };
}

function sanitizeAxes(value: unknown): CvdOiSnapshot["axes"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const price = sanitizeAxis(raw.price);
  const oiUsd = sanitizeAxis(raw.oiUsd);
  const cvdUsd = sanitizeAxis(raw.cvdUsd);
  if (!price || !oiUsd || !cvdUsd) return null;
  return { price, oiUsd, cvdUsd };
}

export function sanitizeCvdOiSnapshot(input: unknown): CvdOiSanitizeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "CVD/OI snapshot is invalid." };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== CVD_OI_KIND) return { ok: false, error: "CVD/OI kind is not binance_cvd_oi." };
  if (typeof raw.symbol !== "string" || compactSymbol(raw.symbol) !== CVD_OI_SYMBOL) {
    return { ok: false, error: "CVD/OI symbol is invalid." };
  }
  if (raw.venue !== "binance") return { ok: false, error: "CVD/OI venue is invalid." };
  if (raw.source !== "binance_public") return { ok: false, error: "CVD/OI source is invalid." };
  if (!Array.isArray(raw.series)) return { ok: false, error: "CVD/OI series is missing." };
  const axes = sanitizeAxes(raw.axes);
  if (!axes) return { ok: false, error: "CVD/OI axes are invalid." };

  const byTime = new Map<string, CvdOiPoint>();
  let dropped = 0;
  for (const item of raw.series) {
    const point = sanitizePoint(item);
    if (!point) {
      dropped += 1;
      continue;
    }
    if (byTime.has(point.t)) dropped += 1;
    if (byTime.size >= CVD_OI_SERIES_MAX && !byTime.has(point.t)) {
      dropped += 1;
      continue;
    }
    byTime.set(point.t, point);
  }
  const series = [...byTime.values()].sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
  return {
    ok: true,
    dropped,
    snapshot: {
      kind: CVD_OI_KIND,
      symbol: CVD_OI_SYMBOL,
      venue: "binance",
      updatedAt: isoTimestamp(raw.updatedAt),
      window: cleanLabel(raw.window, 64),
      source: "binance_public",
      series,
      axes,
      note: cleanCopy(raw.note, 240),
    },
  };
}

export function cvdOiHttpBody(raw: unknown): CvdOiHttpResult {
  const parsed = sanitizeCvdOiSnapshot(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  return { status: 200, body: parsed.snapshot };
}

export function cvdOiLinePoints(series: readonly CvdOiPoint[]): CvdOiChartPoint[] {
  const byTime = new Map<number, CvdOiChartPoint>();
  for (const point of series) {
    const ms = Date.parse(point.t);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const time = Math.floor(ms / 1000);
    byTime.set(time, { time, price: point.price, oiUsd: point.oiUsd, cvdUsd: point.cvdUsd });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function readoutAt(points: readonly CvdOiChartPoint[], time: number | null): CvdOiReadout {
  const selected = time == null ? points[points.length - 1] : points.find((point) => point.time === time);
  if (!selected) return { time, price: null, oiUsd: null, cvdUsd: null };
  return { time: selected.time, price: selected.price, oiUsd: selected.oiUsd, cvdUsd: selected.cvdUsd };
}

export function formatCvdOiPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatCvdOiUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatCvdOiTime(time: number | null): string {
  if (time == null || !Number.isFinite(time)) return "—";
  return `${new Date(time * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
