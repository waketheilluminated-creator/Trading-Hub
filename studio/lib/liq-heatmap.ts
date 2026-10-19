import { compactSymbol } from "./market-venues.ts";

export const LIQ_HEATMAP_KIND = "liq_heatmap_bands";
export const LIQ_HEATMAP_RISK = "极高";
export const LIQ_HEATMAP_SAMPLE_SYMBOL = "ZECUSDT";
/** Charts that may request a liquidation snapshot. A symbol shows bands only once its fixture exists server-side. */
export const LIQ_HEATMAP_SYMBOLS = ["ZECUSDT", "PYTHUSDT"] as const;
export const LIQ_ZONE_MAX = 200;
/** Bands and zones carry only the top two volume-percentile tiers (TRADINGHUB.md): 高 = high, 极高 = extreme. */
export const LIQ_ZONE_RISKS = ["高", "极高"] as const;
export const LIQ_BAND_RISKS = LIQ_ZONE_RISKS;
export const LIQ_HEATMAP_NO_SNAPSHOT = "尚未计算，点刷新生成";
/** TH-FEAT-12: any USDT perpetual, strict format (leading digits allowed: 1000PEPEUSDT ≠ PEPEUSDT). */
export const LIQ_SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;
export const LIQ_UNLISTED_NOTICE = "该币种暂无交易所永续合约";

/** Exact-string check (no case folding or trimming) — used for anything that reaches argv or a file name. */
export function isLiqSymbol(value: unknown): value is string {
  return typeof value === "string" && LIQ_SYMBOL_PATTERN.test(value);
}
export const LIQ_HEATMAP_STORAGE_KEY = "th-liq-heatmap";
export const LIQ_HEATMAP_SYMBOL_NOTICE = "Liquidation zones are available for USDT perpetuals only.";
export const LIQ_HEATMAP_UNAVAILABLE = "Extreme liquidation bands unavailable.";
/**
 * TH-BUG-05: colour by where the liquidations sit relative to price. Long liquidations are BELOW price
 * (support, green); short liquidations are ABOVE price (resistance, red). Bands and zone boxes share it.
 */
export const LIQ_LONG_RGB = "38, 166, 154";
export const LIQ_SHORT_RGB = "239, 83, 80";
export const LIQ_LEGEND_BELOW = "下方：多头清算 / 支撑";
export const LIQ_LEGEND_ABOVE = "上方：空头清算 / 阻力";

/**
 * Invariant: a long position liquidates when price FALLS to its level, a short when price RISES to it.
 * A long-liq bucket above the mark (or a short-liq bucket below it) was already swept by price and is dropped.
 */
export function liqSideConsistent(side: LiqSide, lo: number, hi: number, mark: number): boolean {
  const center = (lo + hi) / 2;
  return side === "long" ? center < mark : center > mark;
}

const MIN_LIQ_OPACITY = 0.16;
const MAX_LIQ_OPACITY = 0.46;
const SNAPSHOT_KEYS = ["kind", "venue", "symbol", "mid", "bucket_pct", "updatedAt", "source", "unit", "schemaVersion", "asOf", "markPrice", "bands", "zones", "venuesFailed", "priceDecimals", "tickSize"] as const;

export type LiqSide = "long" | "short";

export type LiqBand = {
  lo: number;
  hi: number;
  side: LiqSide;
  liq_m: number;
  risk: (typeof LIQ_BAND_RISKS)[number];
  dist_pct: number;
};

export type LiqZoneRole = "support" | "resistance";
export type LiqZoneRisk = (typeof LIQ_ZONE_RISKS)[number];

/** ≥2 adjacent high/extreme buckets merged upstream; drawn as a box from the latest bar to the right edge. */
export type LiqZone = {
  lo: number;
  hi: number;
  role: LiqZoneRole;
  liq_m: number;
  risk_max: LiqZoneRisk;
  dist_pct: number;
  bucket_count: number;
  side: LiqSide | null;
  /** Indexes into the sanitized bands[] for buckets merged into this zone (null when the source had none). */
  band_idx: number[] | null;
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
  schemaVersion: number | null;
  asOf: string | null;
  markPrice: number;
  bands: LiqBand[];
  zones: LiqZone[];
  /** Venues the estimator could not reach (TH-FEAT-11); empty when all answered. */
  venuesFailed?: string[];
  /** Price rounding the estimator used (ZEC→2, PYTH→6); null when absent. */
  priceDecimals?: number | null;
  /** Exchange tick size the estimator used for price rounding (TH-FEAT-12); null when absent. */
  tickSize?: number | null;
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
type SanitizeResult = { ok: true; snapshot: LiqHeatmapSnapshot; dropped: number; droppedZones: number } | { ok: false; error: string };

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
  return isLiqSymbol(compactSymbol(symbol));
}

/**
 * The flame toggle defaults ON for symbols that already have a snapshot (bundled ZEC/PYTH fixtures, or one the
 * server has cached from a refresh) until the user saves a choice. `hasSnapshot` comes from a GET probe.
 */
export function liqHeatmapDefaultOn(symbol: string, hasSnapshot: boolean | null = null): boolean {
  if (!chartSupportsLiqSample(symbol)) return false;
  if (hasSnapshot != null) return hasSnapshot;
  return LIQ_HEATMAP_SYMBOLS.some((bundled) => liqSymbolsMatch(symbol, bundled));
}

export function parseLiqHeatmapQuery(url: URL): QueryResult {
  const symbol = compactSymbol(url.searchParams.get("symbol") || "");
  if (!isLiqSymbol(symbol)) {
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
  if (!(LIQ_BAND_RISKS as readonly unknown[]).includes(raw.risk)) return null;
  return { lo, hi, side: raw.side, liq_m: liq, risk: raw.risk as LiqBand["risk"], dist_pct: dist };
}

/**
 * Zone rows are validated field by field; any bad row is dropped (never repaired). Role must agree with
 * the snapshot mid: support sits below price, resistance above.
 */
export function sanitizeLiqZone(value: unknown, mid: number, bandIndexMap: ReadonlyMap<number, number> | null = null): LiqZone | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const lo = finiteNumber(raw.lo);
  const hi = finiteNumber(raw.hi);
  const liq = finiteNumber(raw.liq_m);
  const dist = finiteNumber(raw.dist_pct);
  const count = finiteNumber(raw.bucket_count);
  if (lo == null || hi == null || !(lo > 0) || !(hi > lo)) return null;
  if (liq == null || !(liq > 0) || dist == null) return null;
  if (count == null || !Number.isInteger(count) || count < 2 || count > 1000) return null;
  if (raw.role !== "support" && raw.role !== "resistance") return null;
  if (!(LIQ_ZONE_RISKS as readonly unknown[]).includes(raw.risk_max)) return null;
  if (raw.role === "support" && lo >= mid) return null;
  if (raw.role === "resistance" && hi <= mid) return null;
  if (raw.color != null && raw.color !== (raw.role === "support" ? "green" : "red")) return null;
  if (raw.side != null && raw.side !== "long" && raw.side !== "short") return null;
  // TH-BUG-05: support is made of long liquidations, resistance of short liquidations.
  if (raw.side === "long" && raw.role !== "support") return null;
  if (raw.side === "short" && raw.role !== "resistance") return null;
  let bandIdx: number[] | null = null;
  if (raw.band_idx != null) {
    if (!Array.isArray(raw.band_idx) || raw.band_idx.length > 1000) return null;
    const mapped = new Set<number>();
    for (const item of raw.band_idx) {
      if (typeof item !== "number" || !Number.isInteger(item) || item < 0) return null;
      // Source indexes refer to the raw bands[]; remap past any rows the sanitizer dropped.
      const next = bandIndexMap ? bandIndexMap.get(item) : item;
      if (next != null) mapped.add(next);
    }
    bandIdx = [...mapped].sort((a, b) => a - b);
  }
  return {
    lo, hi, role: raw.role, liq_m: liq, risk_max: raw.risk_max as LiqZoneRisk, dist_pct: dist, bucket_count: count,
    side: raw.side === "long" || raw.side === "short" ? raw.side : null,
    band_idx: bandIdx,
  };
}

/** Estimator venues_failed[]: venue names (or {venue}) the estimator could not reach. */
export function sanitizeVenuesFailed(value: unknown, unlisted: unknown = null): string[] {
  const names = Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? (item as { venue?: unknown }).venue : null))
    : value && typeof value === "object" ? Object.keys(value) : [];
  // "Not listed on this venue" is expected (e.g. bitmex/deribit for ZEC), not a failure worth a warning.
  const skip = new Set(Array.isArray(unlisted) ? unlisted.filter((item): item is string => typeof item === "string") : []);
  const out: string[] = [];
  for (const name of names.slice(0, 20)) {
    if (typeof name === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(name) && !skip.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
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
  if (typeof raw.source !== "string" || !/^oi_liq_estimator(?:\/[a-z_]{1,32})?$/.test(raw.source)) return { ok: false, error: "Liquidation heatmap source is invalid." };
  if (raw.unit !== "usd_millions") return { ok: false, error: "Liquidation heatmap unit is invalid." };
  if (typeof raw.symbol !== "string") return { ok: false, error: "Liquidation heatmap symbol is invalid." };
  const symbol = compactSymbol(raw.symbol);
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { ok: false, error: "Liquidation heatmap symbol is invalid." };
  if (!Array.isArray(raw.bands)) return { ok: false, error: "Liquidation heatmap bands are missing." };

  // Optional schemaVersion-1 metadata; when present it must be well-formed.
  let schemaVersion: number | null = null;
  if (raw.schemaVersion != null) {
    if (raw.schemaVersion !== 1) return { ok: false, error: "Liquidation heatmap schemaVersion is unsupported." };
    schemaVersion = 1;
  }
  let markPrice = mid;
  if (raw.markPrice != null) {
    const mark = finiteNumber(raw.markPrice);
    if (mark == null || !(mark > 0)) return { ok: false, error: "Liquidation heatmap markPrice is not finite." };
    markPrice = mark;
  }
  const bands: LiqBand[] = [];
  const bandIndexMap = new Map<number, number>();
  let dropped = 0;
  raw.bands.forEach((item, rawIndex) => {
    const band = sanitizeBand(item);
    // TH-BUG-05: drop already-swept buckets (long above mark / short below mark).
    if (band && liqSideConsistent(band.side, band.lo, band.hi, markPrice)) { bandIndexMap.set(rawIndex, bands.length); bands.push(band); }
    else dropped += 1;
  });
  // boxStart is informational only: the shell anchors zone boxes at the candle containing asOf (TH-FEAT-11).
  if (raw.boxStart != null && raw.boxStart !== "latest_candle" && raw.boxStart !== "asOf") return { ok: false, error: "Liquidation heatmap boxStart is unsupported." };
  const asOf = typeof raw.asOf === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.asOf) ? raw.asOf : null;
  // zones[] is optional: snapshots from before TH-FEAT-10 have none.
  const zones: LiqZone[] = [];
  let droppedZones = 0;
  const rawZones = raw.zones == null ? [] : Array.isArray(raw.zones) ? raw.zones : null;
  if (rawZones == null) droppedZones += 1;
  for (const item of (rawZones ?? []).slice(0, LIQ_ZONE_MAX)) {
    const zone = sanitizeLiqZone(item, markPrice, bandIndexMap);
    if (zone) zones.push(zone);
    else droppedZones += 1;
  }
  if (rawZones && rawZones.length > LIQ_ZONE_MAX) droppedZones += rawZones.length - LIQ_ZONE_MAX;
  const snapshot: LiqHeatmapSnapshot = {
    kind: LIQ_HEATMAP_KIND,
    venue: "multi",
    symbol,
    mid,
    bucket_pct: bucket,
    updatedAt,
    source: "oi_liq_estimator",
    unit: "usd_millions",
    schemaVersion,
    asOf,
    markPrice,
    bands,
    zones,
    venuesFailed: sanitizeVenuesFailed(raw.venues_failed, raw.venues_unlisted),
    priceDecimals: Number.isInteger(raw.priceDecimals) && (raw.priceDecimals as number) >= 0 && (raw.priceDecimals as number) <= 10 ? (raw.priceDecimals as number) : null,
    tickSize: typeof raw.tickSize === "number" && Number.isFinite(raw.tickSize) && raw.tickSize > 0 && raw.tickSize < 1e6 ? raw.tickSize : null,
  };
  return { ok: true, snapshot, dropped, droppedZones };
}

export function buildLiqHeatmapPayload(requestedSymbol: string, raw: unknown, presanitized: LiqHeatmapSnapshot | null = null):
  | { ok: true; status: 200; body: LiqHeatmapPayload }
  | { ok: false; status: 400; body: { error: string } } {
  const parsed: SanitizeResult = presanitized ? { ok: true, snapshot: presanitized, dropped: 0, droppedZones: 0 } : sanitizeLiqHeatmapSnapshot(raw);
  if (!parsed.ok) return { ok: false, status: 400, body: { error: parsed.error } };
  const requested = compactSymbol(requestedSymbol);
  if (!liqSymbolsMatch(requested, parsed.snapshot.symbol)) {
    return {
      ok: true,
      status: 200,
      body: { ...parsed.snapshot, bands: [], zones: [], notice: LIQ_HEATMAP_SYMBOL_NOTICE },
    };
  }
  return { ok: true, status: 200, body: { ...parsed.snapshot, notice: null } };
}

export type LiqHeatmapChartModel = {
  bands: LiqBand[];
  zones: LiqZone[];
  notice: string | null;
  asOf?: string | null;
  venuesFailed?: string[];
  priceDecimals?: number | null;
};

export function resolveLiqHeatmapForChart(snapshot: LiqHeatmapSnapshot, chartSymbol: string): LiqHeatmapChartModel {
  if (!liqSymbolsMatch(chartSymbol, snapshot.symbol) || !chartSupportsLiqSample(chartSymbol)) {
    return { bands: [], zones: [], notice: LIQ_HEATMAP_SYMBOL_NOTICE };
  }
  return {
    bands: snapshot.bands,
    zones: snapshot.zones,
    notice: null,
    asOf: snapshot.asOf,
    venuesFailed: snapshot.venuesFailed ?? [],
    priceDecimals: snapshot.priceDecimals ?? null,
  };
}

/** "更新于 HH:MM" from the snapshot asOf, in the viewer's time zone (or an explicit one for tests). */
export function formatLiqUpdatedAt(asOf: string | null | undefined, timeZone?: string): string | null {
  if (!asOf) return null;
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime())) return null;
  const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(date);
  return `更新于 ${hhmm}`;
}

export type LiqRefreshClientResult =
  | { ok: true; model: LiqHeatmapChartModel; cooldownSec: number }
  | { ok: false; error: string; retryAfterSec: number | null };

export const LIQ_REFRESH_DEFAULT_COOLDOWN_SEC = 30;

/** Click-only refresh: POST /api/liq-zones/refresh, then validate the returned snapshot client-side too. */
export async function requestLiqRefresh(chartSymbol: string, fetchImpl: typeof fetch = fetch): Promise<LiqRefreshClientResult> {
  if (!chartSupportsLiqSample(chartSymbol)) return { ok: false, error: LIQ_HEATMAP_SYMBOL_NOTICE, retryAfterSec: null };
  const compact = compactSymbol(chartSymbol);
  let response: Response;
  try {
    response = await fetchImpl(`/api/liq-zones/refresh?symbol=${encodeURIComponent(compact)}`, { method: "POST", credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, error: "刷新失败：网络错误", retryAfterSec: null };
  }
  const header = Number(response.headers.get("retry-after"));
  const retryAfterSec = Number.isFinite(header) && header > 0 ? Math.min(3600, Math.ceil(header)) : null;
  let body: unknown = null;
  try { body = await response.json(); } catch { /* handled below */ }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!response.ok || record.ok !== true) {
    const error = typeof record.error === "string" ? record.error.slice(0, 200) : `刷新失败 (HTTP ${response.status})`;
    return { ok: false, error, retryAfterSec };
  }
  const parsed = sanitizeLiqHeatmapSnapshot(record.snapshot);
  if (!parsed.ok) return { ok: false, error: parsed.error, retryAfterSec: null };
  const cooldown = Number(record.cooldownSec);
  return {
    ok: true,
    model: resolveLiqHeatmapForChart(parsed.snapshot, compact),
    cooldownSec: Number.isFinite(cooldown) && cooldown > 0 ? Math.min(3600, Math.ceil(cooldown)) : LIQ_REFRESH_DEFAULT_COOLDOWN_SEC,
  };
}

/** True when the zone fully contains the band's price range (bands carry no zone index). */
export function liqZoneCoversBand(zone: LiqZone, band: LiqBand): boolean {
  const eps = Math.max(1e-9, (zone.hi - zone.lo) * 1e-6);
  return band.lo >= zone.lo - eps && band.hi <= zone.hi + eps;
}

/**
 * Isolated high/extreme buckets keep the horizontal band rendering; bands merged into a zone are hidden.
 * Uses the zone's band_idx[] when present, else price-range containment.
 */
export function bandsOutsideZones(bands: readonly LiqBand[], zones: readonly LiqZone[]): LiqBand[] {
  if (!zones.length) return [...bands];
  const covered = new Set<number>();
  for (const zone of zones) {
    if (zone.band_idx) for (const index of zone.band_idx) covered.add(index);
    else bands.forEach((band, index) => { if (liqZoneCoversBand(zone, band)) covered.add(index); });
  }
  return bands.filter((_, index) => !covered.has(index));
}

export const LIQ_SUPPORT_RGB = LIQ_LONG_RGB;
export const LIQ_RESISTANCE_RGB = LIQ_SHORT_RGB;

export function liqZoneColors(role: LiqZoneRole): { fill: string; edge: string; text: string } {
  const rgb = role === "support" ? LIQ_SUPPORT_RGB : LIQ_RESISTANCE_RGB;
  return { fill: `rgba(${rgb}, 0.2)`, edge: `rgba(${rgb}, 0.9)`, text: `rgba(${rgb}, 1)` };
}

/**
 * Zone box border by risk: 高 (high) = fill only, no border; 极高 (extreme) = fill + 2px border in the solid side colour.
 * Same in live and replay, both themes.
 */
export const LIQ_ZONE_BORDER_PX: Record<LiqZoneRisk, number> = { 高: 0, 极高: 2 };
export function liqZoneBorderWidth(risk: LiqZoneRisk): number {
  return LIQ_ZONE_BORDER_PX[risk] ?? 0;
}
export function liqZoneBorderColor(role: LiqZoneRole): string {
  return `rgb(${role === "support" ? LIQ_SUPPORT_RGB : LIQ_RESISTANCE_RGB})`;
}
export const LIQ_LEGEND_RISK_HIGH = "高：仅填充";
export const LIQ_LEGEND_RISK_EXTREME = "极高：填充 + 边框";

export type PlacedLiqZone = { zone: LiqZone; left: number; top: number; width: number; height: number; borderWidth: number } & ReturnType<typeof liqZoneColors>;

/** Boxes start at the latest bar's x and extend to the pane's right edge only — no historical segment. */
/**
 * TH-BUG-03: left edge for the heatmap bands. Like the zone boxes they start at the asOf anchor candle and
 * extend right (a snapshot says nothing about earlier bars). Only when no anchor can be resolved yet
 * (no candles / chart not attached) do they fall back to the full pane width.
 */
export function liqOverlayLeft(anchorX: number | null, paneWidth: number): number {
  if (anchorX == null || !Number.isFinite(anchorX)) return 0;
  return Math.max(0, Math.min(paneWidth, anchorX));
}

export function placeLiqZones(
  zones: readonly LiqZone[],
  priceToY: (price: number) => number | null,
  latestX: number | null,
  paneWidth: number,
): PlacedLiqZone[] {
  if (latestX == null || !Number.isFinite(latestX) || !(paneWidth > 0)) return [];
  const left = Math.max(0, Math.min(paneWidth, latestX));
  const width = paneWidth - left;
  if (!(width > 0)) return [];
  const placed: PlacedLiqZone[] = [];
  for (const zone of zones) {
    const yLo = priceToY(zone.lo);
    const yHi = priceToY(zone.hi);
    if (yLo == null || yHi == null || !Number.isFinite(yLo) || !Number.isFinite(yHi)) continue;
    const top = Math.min(yLo, yHi);
    const height = Math.max(1, Math.abs(yHi - yLo));
    placed.push({ zone, left, top, width, height, ...liqZoneColors(zone.role), edge: liqZoneBorderColor(zone.role), borderWidth: liqZoneBorderWidth(zone.risk_max) });
  }
  return placed.sort((a, b) => a.zone.liq_m - b.zone.liq_m);
}

/**
 * TH-FEAT-11 anchor: zone boxes start at the bar whose open <= asOf < next open (for the loaded interval).
 * asOf older than the loaded data clamps to the first bar; newer than the latest bar (or missing) uses the latest bar.
 * `barTimes` are ascending bar open times in UNIX seconds.
 */
export function liqZoneAnchorTime(barTimes: readonly number[], asOf: string | null | undefined): number | null {
  if (!barTimes.length) return null;
  const last = barTimes[barTimes.length - 1];
  const ms = asOf ? Date.parse(asOf) : Number.NaN;
  if (!Number.isFinite(ms)) return last;
  const at = ms / 1000;
  if (at < barTimes[0]) return barTimes[0];
  if (at >= last) return last;
  let lo = 0;
  let hi = barTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (barTimes[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return barTimes[lo];
}

/** 「计算于 HH:MM」 marker for the anchor line (viewer's time zone unless one is given). */
export function formatLiqComputedAt(asOf: string | null | undefined, timeZone?: string): string | null {
  const label = formatLiqUpdatedAt(asOf, timeZone);
  return label ? label.replace("更新于", "计算于") : null;
}

export function findLiqZoneAt(zones: readonly LiqZone[], price: number): LiqZone | null {
  if (!Number.isFinite(price)) return null;
  let best: LiqZone | null = null;
  for (const zone of zones) {
    if (price < zone.lo || price > zone.hi) continue;
    if (!best || zone.liq_m > best.liq_m) best = zone;
  }
  return best;
}

export function formatLiqRisk(risk: LiqZoneRisk): string {
  return risk === "极高" ? "Extreme" : "High";
}

/** Compact on-box label: liq_m · risk_max · dist_pct. */
export function formatLiqZoneLabel(zone: LiqZone): string {
  return `${formatLiqMillions(zone.liq_m)} · ${formatLiqRisk(zone.risk_max)} · ${formatDistPct(zone.dist_pct)}`;
}

export function formatLiqZoneTooltip(zone: LiqZone, decimals: number | null = null): string {
  return `${zone.role === "support" ? "Support" : "Resistance"} zone · ${formatLiqMillions(zone.liq_m)} · risk ${formatLiqRisk(zone.risk_max)} (${zone.risk_max}) · ${formatDistPct(zone.dist_pct)} · ${formatLiqPrice(zone.lo, decimals)}–${formatLiqPrice(zone.hi, decimals)} · ${zone.bucket_count} buckets`;
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
): Promise<LiqHeatmapChartModel> {
  if (!chartSupportsLiqSample(chartSymbol)) {
    return { bands: [], zones: [], notice: LIQ_HEATMAP_SYMBOL_NOTICE };
  }
  const compact = compactSymbol(chartSymbol);
  const sample = options.sample ? "&liqSample=1" : "";
  let response: Response;
  try {
    response = await fetchImpl(`/api/liq-heatmap?symbol=${encodeURIComponent(compact)}${sample}`);
  } catch {
    return { bands: [], zones: [], notice: LIQ_HEATMAP_UNAVAILABLE };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { bands: [], zones: [], notice: LIQ_HEATMAP_UNAVAILABLE };
  }
  if (!response.ok || !body || typeof body !== "object") {
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
    return { bands: [], zones: [], notice: publicNotice(error) };
  }
  const parsed = sanitizeLiqHeatmapSnapshot(body);
  if (!parsed.ok) return { bands: [], zones: [], notice: parsed.error };
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

export function formatLiqPrice(value: number, decimals: number | null = null): string {
  if (decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 10) return value.toFixed(decimals);
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded.toFixed(4).replace(/\.?0+$/, "");
}

export function formatLiqBandTooltip(band: LiqBand, decimals: number | null = null): string {
  return `${liqSideLabel(band.side)} · ${formatLiqMillions(band.liq_m)} · ${formatDistPct(band.dist_pct)} · ${formatLiqPrice(band.lo, decimals)}–${formatLiqPrice(band.hi, decimals)}`;
}

export function snapshotFieldNames(): readonly string[] {
  return SNAPSHOT_KEYS;
}

/** Live snapshot files 订单流研发 drops into studio/fixtures/ (one per symbol, kind liq_heatmap_bands). */
export const LIQ_LIVE_FIXTURE_PATTERN = /(?:^|\/)liq_heatmap_bands\.([A-Z0-9]{2,20}USDT)\.json$/;

export function liqLiveFixturePath(symbol: string): string {
  return `studio/fixtures/liq_heatmap_bands.${compactSymbol(symbol)}.json`;
}

/**
 * Pick the snapshot for a request: a live per-symbol file wins; supported symbols without one get null
 * (route answers 404 "no snapshot yet"); other symbols fall back to the bundled ZEC sample, which the
 * payload builder then withholds with the symbol-mismatch notice.
 */
export function selectLiqSnapshotSource(
  requestedSymbol: string,
  liveFiles: Readonly<Record<string, unknown>>,
  sample: unknown,
): { source: "live" | "sample"; raw: unknown } | null {
  const requested = compactSymbol(requestedSymbol);
  for (const [path, raw] of Object.entries(liveFiles)) {
    const match = LIQ_LIVE_FIXTURE_PATTERN.exec(path);
    if (match && isLiqSymbol(match[1]) && match[1] === requested) {
      return { source: "live", raw };
    }
  }
  // Any valid USDT perpetual without a file has no snapshot yet (→ 404 「尚未计算，点刷新生成」); ZEC keeps the legacy sample.
  if (isLiqSymbol(requested) && requested !== LIQ_HEATMAP_SAMPLE_SYMBOL) return null;
  return { source: "sample", raw: sample };
}
