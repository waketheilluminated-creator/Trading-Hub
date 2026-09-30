// Allow: public read of the checked-in btc_cex_netflow fixture after sanitization.
// Deny: wrong kind, non-array series, non-finite numbers, malformed rows, and client privilege flags.
// No remote reserve fetch and no client-claimed admin or paid entitlement.

export const CEX_NETFLOW_KIND = "btc_cex_netflow" as const;
export const CEX_NETFLOW_SERIES_MAX = 2000;
export const CEX_NETFLOW_ZH_LABEL = "交易所净流/储备脉搏";
export const CEX_NETFLOW_EN_LABEL = "CEX reserve proxy (CoinMetrics)";
export const CEX_NETFLOW_WATERMARK = "non-CQ / experimental proxy";
export const CEX_NETFLOW_SIGNAL_RULE =
  "Bull when the 90-day average is present and the reserve level is at or above that average; otherwise bear.";

export const CEX_NETFLOW_COLORS = {
  flow: "#2f6bff",
  ma: "#2f6bff",
  price: "#111111",
  bull: "rgba(186, 220, 176, 0.72)",
  bear: "rgba(244, 186, 186, 0.72)",
  chartBackground: "#f6f7f9",
} as const;

const LEVEL_ABS_MAX = 1e12;
const COPY_MAX = 600;
const METRIC_NAMES = new Set(["SplyExNtv", "PriceUSD", "FlowInExNtv", "FlowOutExNtv"]);

export type CexNetflowSignal = "bull" | "bear";
export type CexNetflowAxis = { label: string; unit: string };

export type CexNetflowPoint = {
  t: string;
  flowBtc: number;
  flowMa90: number | null;
  priceUsd: number | null;
  signal: CexNetflowSignal;
  dailyNetBtc?: number;
};

export type CexNetflowMeta = {
  start: string | null;
  end: string | null;
  nSeries: number;
  maReadyFrom: string | null;
  metrics: string[];
};

export type CexNetflowSnapshot = {
  kind: typeof CEX_NETFLOW_KIND;
  title: string;
  updatedAt: string | null;
  source: string;
  maWindowDays: 90;
  disclaimer: string;
  series: CexNetflowPoint[];
  axes: { flowBtc: CexNetflowAxis; priceUsd: CexNetflowAxis };
  signalRule: typeof CEX_NETFLOW_SIGNAL_RULE;
  meta: CexNetflowMeta;
};

export type CexNetflowChartPoint = {
  time: number;
  date: string;
  flowBtc: number;
  flowMa90: number | null;
  priceUsd: number | null;
  signal: CexNetflowSignal;
};

export type CexNetflowLinePoint = { time: number; value: number };

export type RegimeBand = {
  from: number;
  to: number | null;
  signal: CexNetflowSignal;
};

export type CexNetflowReadout = {
  time: number | null;
  date: string | null;
  flowBtc: number | null;
  flowMa90: number | null;
  priceUsd: number | null;
  signal: CexNetflowSignal | null;
};

export type CexNetflowSanitizeResult =
  | { ok: true; snapshot: CexNetflowSnapshot; dropped: number }
  | { ok: false; error: string };

export type CexNetflowHttpResult =
  | { status: 200; body: CexNetflowSnapshot }
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

function publicCopy(value: unknown, max: number): string {
  return cleanCopy(value, max).replace(/CryptoQuant|Inter-exchange Flow Pulse|\bIFP\b/g, "").replace(/\s+/g, " ").trim();
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? value : null;
}

function finiteNumber(value: unknown, allowNegative: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > LEVEL_ABS_MAX) return null;
  if (!allowNegative && value < 0) return null;
  return value;
}

function nullableLevel(raw: Record<string, unknown>, key: string): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] == null) return null;
  return finiteNumber(raw[key], false) ?? undefined;
}

function signalFor(flowBtc: number, flowMa90: number | null): CexNetflowSignal {
  if (flowMa90 == null) return "bear";
  return flowBtc >= flowMa90 ? "bull" : "bear";
}

function sanitizePoint(value: unknown): CexNetflowPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const t = isoDate(raw.t);
  const flowBtc = finiteNumber(raw.flowBtc, false);
  if (!t || flowBtc == null) return null;
  const flowMa90 = nullableLevel(raw, "flowMa90");
  const priceUsd = nullableLevel(raw, "priceUsd");
  if (flowMa90 === undefined || priceUsd === undefined) return null;
  const point: CexNetflowPoint = {
    t,
    flowBtc,
    flowMa90,
    priceUsd,
    signal: signalFor(flowBtc, flowMa90),
  };
  if (Object.prototype.hasOwnProperty.call(raw, "dailyNetBtc") && raw.dailyNetBtc != null) {
    const dailyNetBtc = finiteNumber(raw.dailyNetBtc, true);
    if (dailyNetBtc == null) return null;
    point.dailyNetBtc = dailyNetBtc;
  }
  return point;
}

function sanitizeAxis(value: unknown, fallbackUnit: string): CexNetflowAxis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const label = publicCopy(raw.label, 80);
  if (!label) return null;
  const unit = publicCopy(raw.unit, 12) || fallbackUnit;
  return { label, unit };
}

function sanitizeAxes(value: unknown): CexNetflowSnapshot["axes"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const flowBtc = sanitizeAxis(raw.flowBtc, "BTC");
  const priceUsd = sanitizeAxis(raw.priceUsd, "USD");
  if (!flowBtc || !priceUsd) return null;
  return { flowBtc, priceUsd };
}

function sanitizeMetrics(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const metrics = (value as Record<string, unknown>).metrics;
  if (!Array.isArray(metrics)) return [];
  const kept: string[] = [];
  for (const item of metrics) {
    if (typeof item !== "string" || !METRIC_NAMES.has(item)) continue;
    if (kept.includes(item)) continue;
    kept.push(item);
  }
  return kept;
}

export function sanitizeCexNetflowSnapshot(input: unknown): CexNetflowSanitizeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Exchange net flow snapshot is invalid." };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== CEX_NETFLOW_KIND) return { ok: false, error: "Exchange net flow kind is not btc_cex_netflow." };
  if (!Array.isArray(raw.series)) return { ok: false, error: "Exchange net flow series is missing." };
  if (raw.maWindowDays !== 90) return { ok: false, error: "Exchange net flow moving-average window is invalid." };
  const title = publicCopy(raw.title, 140);
  if (!title) return { ok: false, error: "Exchange net flow title is missing." };
  const disclaimer = cleanCopy(raw.disclaimer, COPY_MAX);
  if (!disclaimer) return { ok: false, error: "Exchange net flow disclaimer is missing." };
  const source = publicCopy(raw.source, 160);
  if (!source) return { ok: false, error: "Exchange net flow source is missing." };
  const axes = sanitizeAxes(raw.axes);
  if (!axes) return { ok: false, error: "Exchange net flow axes are invalid." };

  const byDate = new Map<string, CexNetflowPoint>();
  let dropped = 0;
  for (const item of raw.series) {
    const point = sanitizePoint(item);
    if (!point) {
      dropped += 1;
      continue;
    }
    if (byDate.has(point.t)) dropped += 1;
    if (byDate.size >= CEX_NETFLOW_SERIES_MAX && !byDate.has(point.t)) {
      dropped += 1;
      continue;
    }
    byDate.set(point.t, point);
  }
  const series = [...byDate.values()].sort((left, right) => left.t.localeCompare(right.t));
  const metrics = sanitizeMetrics(raw.meta);
  return {
    ok: true,
    dropped,
    snapshot: {
      kind: CEX_NETFLOW_KIND,
      title,
      updatedAt: isoTimestamp(raw.updatedAt),
      source,
      maWindowDays: 90,
      disclaimer,
      series,
      axes,
      signalRule: CEX_NETFLOW_SIGNAL_RULE,
      meta: {
        start: series[0]?.t ?? null,
        end: series.at(-1)?.t ?? null,
        nSeries: series.length,
        maReadyFrom: series.find((point) => point.flowMa90 != null)?.t ?? null,
        metrics,
      },
    },
  };
}

export function cexNetflowHttpBody(raw: unknown): CexNetflowHttpResult {
  const parsed = sanitizeCexNetflowSnapshot(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  return { status: 200, body: parsed.snapshot };
}

export function showProxyWatermark(input: { title: string; source: string }): boolean {
  return /proxy/i.test(input.title) || /proxy/i.test(input.source);
}

export function cexNetflowChartPoints(series: readonly CexNetflowPoint[]): CexNetflowChartPoint[] {
  const byTime = new Map<number, CexNetflowChartPoint>();
  for (const point of series) {
    const ms = Date.parse(`${point.t}T00:00:00Z`);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const time = Math.floor(ms / 1000);
    byTime.set(time, {
      time,
      date: point.t,
      flowBtc: point.flowBtc,
      flowMa90: point.flowMa90,
      priceUsd: point.priceUsd,
      signal: point.signal,
    });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function flowLineData(points: readonly CexNetflowChartPoint[]): CexNetflowLinePoint[] {
  return points.map((point) => ({ time: point.time, value: point.flowBtc }));
}

export function maLineData(points: readonly CexNetflowChartPoint[]): CexNetflowLinePoint[] {
  return points.flatMap((point) => (point.flowMa90 == null ? [] : [{ time: point.time, value: point.flowMa90 }]));
}

export function priceLineData(points: readonly CexNetflowChartPoint[]): CexNetflowLinePoint[] {
  return points.flatMap((point) => (point.priceUsd == null ? [] : [{ time: point.time, value: point.priceUsd }]));
}

export function regimeBands(points: readonly CexNetflowChartPoint[]): RegimeBand[] {
  if (points.length === 0) return [];
  const bands: RegimeBand[] = [];
  let start = 0;
  for (let index = 1; index <= points.length; index += 1) {
    const changed = index === points.length || points[index].signal !== points[start].signal;
    if (!changed) continue;
    const last = index === points.length;
    bands.push({
      from: points[start].time,
      to: last ? null : points[index].time,
      signal: points[start].signal,
    });
    start = index;
  }
  return bands;
}

export function readoutAt(points: readonly CexNetflowChartPoint[], time: number | null): CexNetflowReadout {
  const selected = time == null ? points[points.length - 1] : points.find((point) => point.time === time);
  if (!selected) return { time, date: null, flowBtc: null, flowMa90: null, priceUsd: null, signal: null };
  return {
    time: selected.time,
    date: selected.date,
    flowBtc: selected.flowBtc,
    flowMa90: selected.flowMa90,
    priceUsd: selected.priceUsd,
    signal: selected.signal,
  };
}

export function formatReserveBtc(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(3)}M BTC`;
  return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })} BTC`;
}

export function formatBtcPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSignal(signal: CexNetflowSignal | null): string {
  if (signal === "bull") return "Bull";
  if (signal === "bear") return "Bear";
  return "—";
}

export function formatUpdatedAt(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, " UTC");
}
