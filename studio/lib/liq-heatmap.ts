import { compactSymbol } from "./market-venues.ts";

export const LIQ_HEATMAP_KIND = "liq_heatmap_bands";
export const LIQ_HEATMAP_RISK = "极高";
export const LIQ_HEATMAP_SAMPLE_SYMBOL = "ZECUSDT";
export const LIQ_HEATMAP_STORAGE_KEY = "th-liq-heatmap";
export const LIQ_HEATMAP_SYMBOL_NOTICE = "Extreme liquidation bands match ZECUSDT only.";
export const LIQ_HEATMAP_UNAVAILABLE = "Extreme liquidation bands unavailable.";
export const LIQ_LONG_RGB = "231, 103, 112";
export const LIQ_SHORT_RGB = "83, 201, 144";

const MIN_LIQ_OPACITY = 0.16;
const MAX_LIQ_OPACITY = 0.46;
const SNAPSHOT_KEYS = ["kind", "venue", "symbol", "mid", "bucket_pct", "updatedAt", "source", "unit", "bands"] as const;

export type LiqSide = "long" | "short";

export type LiqBand = {
  lo: number;
  hi: number;
  side: LiqSide;
  liq_m: number;
  risk: typeof LIQ_HEATMAP_RISK;
  dist_pct: number;
};

export type LiqHeatmapSnapshot = {
  kind: typeof LIQ_HEATMAP_KIND;
  venue: "multi";
  symbol: string;
  mid: number;
  bucket_pct: number;
  updatedAt: number;
  source: "oi_liq_estimator";
  unit: "usd_millions";
  bands: LiqBand[];
};

export type LiqHeatmapPayload = LiqHeatmapSnapshot & { notice: string | null };

export type PlacedLiqBand = {
  index: number;
  band: LiqBand;
  top: number;
  height: number;
  fill: string;
  edge: string;
};

type QueryResult = { ok: true; symbol: string; sample: boolean } | { ok: false; error: string };
type SanitizeResult = { ok: true; snapshot: LiqHeatmapSnapshot; dropped: number } | { ok: false; error: string };

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function liqBase(symbol: string): string {
  return compactSymbol(symbol).replace(/(USDT|USDC|USD)$/, "");
}

export function liqSymbolsMatch(left: string, right: string): boolean {
  const a = liqBase(left);
  const b = liqBase(right);
  return a.length > 0 && a === b;
}

export function chartSupportsLiqSample(symbol: string): boolean {
  return liqSymbolsMatch(symbol, LIQ_HEATMAP_SAMPLE_SYMBOL);
}

export function parseLiqHeatmapQuery(url: URL): QueryResult {
  const symbol = compactSymbol(url.searchParams.get("symbol") || "");
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    return { ok: false, error: "Use a compact perpetual symbol such as ZECUSDT" };
  }
  return { ok: true, symbol, sample: url.searchParams.get("liqSample") === "1" };
}

function sanitizeBand(value: unknown): LiqBand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const lo = finiteNumber(raw.lo);
  const hi = finiteNumber(raw.hi);
  const liq = finiteNumber(raw.liq_m);
  const dist = finiteNumber(raw.dist_pct);
  if (lo == null || hi == null || !(lo > 0) || !(hi > lo)) return null;
  if (liq == null || !(liq > 0) || dist == null) return null;
  if (raw.side !== "long" && raw.side !== "short") return null;
  if (raw.risk !== LIQ_HEATMAP_RISK) return null;
  return { lo, hi, side: raw.side, liq_m: liq, risk: LIQ_HEATMAP_RISK, dist_pct: dist };
}

export function sanitizeLiqHeatmapSnapshot(input: unknown): SanitizeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Liquidation heatmap snapshot is invalid." };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== LIQ_HEATMAP_KIND) {
    return { ok: false, error: "Liquidation heatmap kind is not liq_heatmap_bands." };
  }
  const mid = finiteNumber(raw.mid);
  if (mid == null) return { ok: false, error: "Liquidation heatmap mid is not finite." };
  const bucket = finiteNumber(raw.bucket_pct);
  if (bucket == null || !(bucket > 0)) return { ok: false, error: "Liquidation heatmap bucket_pct is invalid." };
  const updatedAt = finiteNumber(raw.updatedAt);
  if (updatedAt == null) return { ok: false, error: "Liquidation heatmap updatedAt is not finite." };
  if (raw.venue !== "multi") return { ok: false, error: "Liquidation heatmap venue is invalid." };
  if (raw.source !== "oi_liq_estimator") return { ok: false, error: "Liquidation heatmap source is invalid." };
  if (raw.unit !== "usd_millions") return { ok: false, error: "Liquidation heatmap unit is invalid." };
  if (typeof raw.symbol !== "string") return { ok: false, error: "Liquidation heatmap symbol is invalid." };
  const symbol = compactSymbol(raw.symbol);
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { ok: false, error: "Liquidation heatmap symbol is invalid." };
  if (!Array.isArray(raw.bands)) return { ok: false, error: "Liquidation heatmap bands are missing." };

  const bands: LiqBand[] = [];
  let dropped = 0;
  for (const item of raw.bands) {
    const band = sanitizeBand(item);
    if (band) bands.push(band);
    else dropped += 1;
  }
  const snapshot: LiqHeatmapSnapshot = {
    kind: LIQ_HEATMAP_KIND,
    venue: "multi",
    symbol,
    mid,
    bucket_pct: bucket,
    updatedAt,
    source: "oi_liq_estimator",
    unit: "usd_millions",
    bands,
  };
  return { ok: true, snapshot, dropped };
}

export function buildLiqHeatmapPayload(requestedSymbol: string, raw: unknown):
  | { ok: true; status: 200; body: LiqHeatmapPayload }
  | { ok: false; status: 400; body: { error: string } } {
  const parsed = sanitizeLiqHeatmapSnapshot(raw);
  if (!parsed.ok) return { ok: false, status: 400, body: { error: parsed.error } };
  const requested = compactSymbol(requestedSymbol);
  if (!liqSymbolsMatch(requested, parsed.snapshot.symbol)) {
    return {
      ok: true,
      status: 200,
      body: { ...parsed.snapshot, bands: [], notice: LIQ_HEATMAP_SYMBOL_NOTICE },
    };
  }
  return { ok: true, status: 200, body: { ...parsed.snapshot, notice: null } };
}

export function resolveLiqHeatmapForChart(snapshot: LiqHeatmapSnapshot, chartSymbol: string): { bands: LiqBand[]; notice: string | null } {
  if (!liqSymbolsMatch(chartSymbol, snapshot.symbol) || !chartSupportsLiqSample(chartSymbol)) {
    return { bands: [], notice: LIQ_HEATMAP_SYMBOL_NOTICE };
  }
  return { bands: snapshot.bands, notice: null };
}

function publicNotice(value: unknown): string {
  if (typeof value !== "string") return LIQ_HEATMAP_UNAVAILABLE;
  const clean = value.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  return clean.slice(0, 180) || LIQ_HEATMAP_UNAVAILABLE;
}

export async function loadLiqHeatmapBands(
  chartSymbol: string,
  fetchImpl: typeof fetch = fetch,
  options: { sample?: boolean } = {},
): Promise<{ bands: LiqBand[]; notice: string | null }> {
  if (!chartSupportsLiqSample(chartSymbol)) {
    return { bands: [], notice: LIQ_HEATMAP_SYMBOL_NOTICE };
  }
  const compact = compactSymbol(chartSymbol);
  const sample = options.sample ? "&liqSample=1" : "";
  let response: Response;
  try {
    response = await fetchImpl(`/api/liq-heatmap?symbol=${encodeURIComponent(compact)}${sample}`);
  } catch {
    return { bands: [], notice: LIQ_HEATMAP_UNAVAILABLE };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { bands: [], notice: LIQ_HEATMAP_UNAVAILABLE };
  }
  if (!response.ok || !body || typeof body !== "object") {
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
    return { bands: [], notice: publicNotice(error) };
  }
  const parsed = sanitizeLiqHeatmapSnapshot(body);
  if (!parsed.ok) return { bands: [], notice: parsed.error };
  return resolveLiqHeatmapForChart(parsed.snapshot, compact);
}

export function liqBandOpacities(bands: readonly LiqBand[]): number[] {
  const positive = bands.map((band) => band.liq_m).filter((value) => value > 0);
  if (!positive.length) return bands.map(() => MIN_LIQ_OPACITY);
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  const logSpan = Math.log(max) - Math.log(min);
  return bands.map((band) => {
    if (!(band.liq_m > 0) || logSpan <= 0) return (MIN_LIQ_OPACITY + MAX_LIQ_OPACITY) / 2;
    const t = Math.min(1, Math.max(0, (Math.log(band.liq_m) - Math.log(min)) / logSpan));
    return Math.round((MIN_LIQ_OPACITY + t * (MAX_LIQ_OPACITY - MIN_LIQ_OPACITY)) * 1000) / 1000;
  });
}

export function liqBandFillStyle(side: LiqSide, opacity: number): string {
  const rgb = side === "long" ? LIQ_LONG_RGB : LIQ_SHORT_RGB;
  const alpha = Math.min(1, Math.max(0, opacity));
  return `rgba(${rgb}, ${alpha.toFixed(3)})`;
}

export function liqBandEdgeStyle(side: LiqSide): string {
  const rgb = side === "long" ? LIQ_LONG_RGB : LIQ_SHORT_RGB;
  return `rgba(${rgb}, 0.92)`;
}

export function liqBandDrawHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 0;
  return height < 1 ? 1 : height;
}

export function placeLiqHeatmapBands(
  bands: readonly LiqBand[],
  priceToY: (price: number) => number | null,
): PlacedLiqBand[] {
  const opacities = liqBandOpacities(bands);
  const placed: PlacedLiqBand[] = [];
  bands.forEach((band, index) => {
    const yLo = priceToY(band.lo);
    const yHi = priceToY(band.hi);
    if (yLo == null || yHi == null || !Number.isFinite(yLo) || !Number.isFinite(yHi)) return;
    const top = Math.min(yLo, yHi);
    const height = Math.abs(yHi - yLo);
    if (!(height > 0)) return;
    placed.push({
      index,
      band,
      top,
      height,
      fill: liqBandFillStyle(band.side, opacities[index] ?? MIN_LIQ_OPACITY),
      edge: liqBandEdgeStyle(band.side),
    });
  });
  return placed.sort((left, right) => left.band.liq_m - right.band.liq_m);
}

export function findLiqBandAtPrice(bands: readonly LiqBand[], price: number): LiqBand | null {
  if (!Number.isFinite(price)) return null;
  let best: LiqBand | null = null;
  for (const band of bands) {
    if (price < band.lo || price > band.hi) continue;
    if (!best || band.liq_m > best.liq_m) best = band;
  }
  return best;
}

export function liqSideLabel(side: LiqSide): string {
  return side === "long" ? "Long liquidation" : "Short liquidation";
}

export function formatLiqMillions(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const text = rounded.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return `$${text}m`;
}

export function formatDistPct(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const text = rounded.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return `${rounded > 0 ? "+" : ""}${text}%`;
}

export function formatLiqPrice(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded.toFixed(4).replace(/\.?0+$/, "");
}

export function formatLiqBandTooltip(band: LiqBand): string {
  return `${liqSideLabel(band.side)} · ${formatLiqMillions(band.liq_m)} · ${formatDistPct(band.dist_pct)} · ${formatLiqPrice(band.lo)}–${formatLiqPrice(band.hi)}`;
}

export function snapshotFieldNames(): readonly string[] {
  return SNAPSHOT_KEYS;
}
