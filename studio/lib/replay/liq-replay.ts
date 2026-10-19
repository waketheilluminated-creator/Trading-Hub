/**
 * TH-FEAT-19 / TH-FEAT-17 Bar Replay: H2 Dongyi-replica liquidation zones,
 * computed ON DEMAND as of a replay candle. Nothing is persisted.
 *
 * H2 (validated OOS against Youtube东一 Model2 | 7d):
 *  1. Sum each venue's last one-sided OI sample at or before cutoff.
 *  2. Distribute that total over the last 7d of 1h entries, weighted by quote volume
 *     (1h bars are aggregated from the 1m series the service already loads).
 *  3. Leverage 10/25/50/100× @ 0.30/0.30/0.25/0.15, 50/50 long/short, 0.5% MM.
 *  4. Drop levels the post-entry price path has already crossed (TH-BUG-05).
 *  5. Bucket around mark at the Dongyi bin (0.19%, TH-FEAT-20); fixed-dollar tiers (BTC: 极高≥$100M /
 *     高≥$70M / 中≥$15M), scaled for alts by symbol_OI/btc_OI over the SAME venues; every 中+ bin is a band
 *     and ≥2 adjacent bins of the same tier merge into a zone.
 * No lookahead: every input is cut at `cutoff` before any computation.
 */
import { LIQ_HEATMAP_KIND, sanitizeLiqHeatmapSnapshot, type LiqHeatmapSnapshot } from "../liq-heatmap.ts";

export const REPLAY_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
export const REPLAY_COHORT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // H2: 7d
export const REPLAY_BUCKET_PCT = 0.19; // % of mid — Dongyi BTC bin (TH-FEAT-20), same as live
export const REPLAY_RANGE_PCT = 12;
export const REPLAY_LEVERAGE_TIERS: readonly { lev: number; weight: number }[] = [
  { lev: 10, weight: 0.3 }, { lev: 25, weight: 0.3 }, { lev: 50, weight: 0.25 }, { lev: 100, weight: 0.15 },
];
export const REPLAY_MAINT_MARGIN = 0.005;
export const REPLAY_OUT_OF_RANGE = "超出可回溯范围";

/** BTC fixed-dollar tier floors (USD). Alts scale via {@link scaleTierThresholds}. */
export const BTC_TIER_EXTREME_USD = 100_000_000;
export const BTC_TIER_HIGH_USD = 70_000_000;
export const BTC_TIER_MEDIUM_USD = 15_000_000;
/** Bin width (% of price) the floors were calibrated on: Dongyi BTC rows ≈ 0.19% apart (TH-BUG-06). */
export const DONGYI_REF_BIN_PCT = 0.19;
const BUCKET_FACTOR_MIN = 0.05;
const BUCKET_FACTOR_MAX = 50;

export type OiPoint = { ts: number; oiUsd: number };
export type PriceBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type ReplayInput = {
  symbol: string;
  cutoff: number;
  bars: readonly PriceBar[]; // 1m (or any); aggregated to 1h for entry weights
  oi: Readonly<Record<string, readonly OiPoint[]>>;
  /** Optional BTC one-sided OI at cutoff for alt tier scaling (explicit total; wins over btcOi). */
  btcOiUsd?: number;
  /** Optional BTC OI history per venue; summed over the venues the symbol also used (TH-FEAT-20). */
  btcOi?: Readonly<Record<string, readonly OiPoint[]>>;
  barMs?: number;
  lookbackMs?: number;
  bucketPct?: number;
};
export type ReplayLevel = { venue: string; side: "long" | "short"; price: number; usd: number; openedAt: number; openPrice: number; lev: number };
export type ReplayResult = {
  ok: true; snapshot: LiqHeatmapSnapshot; mark: number; venuesUsed: string[]; venuesUnavailable: string[]; levels: ReplayLevel[];
  buckets: { idx: number; lo: number; hi: number; side: "long" | "short"; usd: number }[];
  tierThresholds: TierThresholds;
  relativeFloorSides: string[];
} | { ok: false; error: string };

export function longLiqPrice(p: number, lev: number, mm = REPLAY_MAINT_MARGIN): number { return p * (1 - 1 / lev + mm); }
export function shortLiqPrice(p: number, lev: number, mm = REPLAY_MAINT_MARGIN): number { return p * (1 + 1 / lev - mm); }

export type TierThresholds = { extremeUsd: number; highUsd: number; mediumUsd: number };

/** bucketPct / Dongyi reference bin, clamped; missing or non-finite/non-positive → 1 (reference bin). */
function bucketFactor(bucketPct: number | undefined | null): number {
  if (bucketPct == null || !Number.isFinite(bucketPct) || bucketPct <= 0) return 1;
  return Math.max(BUCKET_FACTOR_MIN, Math.min(BUCKET_FACTOR_MAX, bucketPct / DONGYI_REF_BIN_PCT));
}

/**
 * Scale BTC fixed-dollar tiers by symbolOi/btcOi (clamped) and by bucket width (% of price; floors are per
 * Dongyi ~0.19% bin, so a 0.5% bucket scales them ×2.63). High/extreme ratio unchanged.
 * Same contract as oi_liq/h2.scale_tier_thresholds.
 */
export function scaleTierThresholds(symbolOiUsd: number, btcOiUsd: number | undefined | null, bucketPct?: number | null): TierThresholds {
  let ratio = 1;
  if (btcOiUsd && btcOiUsd > 0 && symbolOiUsd > 0) {
    const r = symbolOiUsd / btcOiUsd;
    if (Math.abs(r - 1) >= 0.05) ratio = Math.max(1e-4, Math.min(1e2, r));
  }
  const k = ratio * bucketFactor(bucketPct);
  return { extremeUsd: BTC_TIER_EXTREME_USD * k, highUsd: BTC_TIER_HIGH_USD * k, mediumUsd: BTC_TIER_MEDIUM_USD * k };
}

export function riskOfUsd(usd: number, t: TierThresholds): "极高" | "高" | "中" | "低" {
  if (usd >= t.extremeUsd) return "极高";
  if (usd >= t.highUsd) return "高";
  if (usd >= t.mediumUsd) return "中";
  return "低";
}

export function truncateReplayInput(input: ReplayInput): ReplayInput {
  const barMs = input.barMs ?? 60_000;
  const oi: Record<string, OiPoint[]> = {};
  for (const [venue, points] of Object.entries(input.oi)) oi[venue] = points.filter((p) => p.ts <= input.cutoff).sort((a, b) => a.ts - b.ts);
  return { ...input, bars: input.bars.filter((b) => b.time + barMs <= input.cutoff).sort((a, b) => a.time - b.time), oi };
}

/** Aggregate 1m (or finer) bars into 1h OHLCV with quote-volume proxy (close * base volume when available, else 1). */
export function aggregateTo1h(bars: readonly PriceBar[], lookbackStart: number, cutoff: number): { ts: number; open: number; high: number; low: number; close: number; quoteVol: number }[] {
  const HOUR = 3_600_000;
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; quoteVol: number }>();
  for (const b of bars) {
    if (b.time < lookbackStart || b.time > cutoff) continue;
    const hour = Math.floor(b.time / HOUR) * HOUR;
    if (hour + HOUR > cutoff) continue; // only fully closed 1h bars
    const q = (b.volume ?? 1) * b.close;
    const cur = buckets.get(hour);
    if (!cur) buckets.set(hour, { open: b.open, high: b.high, low: b.low, close: b.close, quoteVol: q });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.quoteVol += q;
    }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts, ...v }));
}

/** Venue OI at cutoff = last finite positive sample in [cutoff − lookback, cutoff] no older than 1h; else null. */
export function venueOiAt(points: readonly OiPoint[] | undefined, cutoff: number, lookbackMs = REPLAY_COHORT_LOOKBACK_MS): number | null {
  if (!points) return null;
  let last: OiPoint | null = null;
  for (const p of points) {
    if (p.ts > cutoff || p.ts < cutoff - lookbackMs || !Number.isFinite(p.oiUsd) || !(p.oiUsd > 0)) continue;
    if (!last || p.ts >= last.ts) last = p;
  }
  return last && cutoff - last.ts <= 60 * 60_000 ? last.oiUsd : null;
}

/**
 * Same-venue OI totals for the alt/BTC tier ratio (TS twin of oi_liq/h2.matched_oi_totals): sum only venues
 * present (finite, >0) in both maps. No overlap → btc null (caller falls back to unscaled floors).
 */
export function matchedReplayOiTotals(symByVenue: Readonly<Record<string, number>>, btcByVenue: Readonly<Record<string, number>>): { sym: number; btc: number | null } {
  let sym = 0, btc = 0, n = 0;
  for (const [venue, value] of Object.entries(symByVenue)) {
    const b = btcByVenue[venue];
    if (!(Number.isFinite(value) && value > 0 && Number.isFinite(b) && b > 0)) continue;
    sym += value; btc += b; n += 1;
  }
  const symTotal = Object.values(symByVenue).reduce((s, v) => (Number.isFinite(v) && v > 0 ? s + v : s), 0);
  return n ? { sym, btc } : { sym: symTotal, btc: null };
}

/** TH-FEAT-20b relative floor (twin of oi_liq/h2.apply_relative_tier_floor). */
export const REL_FLOOR_HIGH = 0.8;
export const REL_FLOOR_MEDIUM = 0.5;
type Tier = "极高" | "高" | "中" | "低";
/**
 * Only on a side where no bin reached 中: re-tier that side against its own max bin (≥0.8×max → 高,
 * ≥0.5×max → 中). Never produces 极高; sides that already have a 中+ bin are untouched.
 * Returns the tiers (same order as `bins`) and the sides the floor was applied to.
 */
export function applyRelativeTierFloor(bins: readonly { side: string; usd: number }[], tiers: readonly Tier[]): { tiers: Tier[]; sides: string[] } {
  const out = [...tiers];
  const sides: string[] = [];
  for (const side of ["long", "short"]) {
    const idx = bins.map((b, i) => i).filter((i) => bins[i].side === side && Number.isFinite(bins[i].usd) && bins[i].usd > 0);
    if (!idx.length || idx.some((i) => out[i] !== "低")) continue;
    const peak = Math.max(...idx.map((i) => bins[i].usd));
    for (const i of idx) {
      if (bins[i].usd >= REL_FLOOR_HIGH * peak) out[i] = "高";
      else if (bins[i].usd >= REL_FLOOR_MEDIUM * peak) out[i] = "中";
    }
    sides.push(side);
  }
  return { tiers: out, sides };
}

export function computeReplayLiq(raw: ReplayInput): ReplayResult {
  const input = truncateReplayInput(raw);
  const barMs = input.barMs ?? 60_000;
  const lookback = input.lookbackMs ?? REPLAY_COHORT_LOOKBACK_MS;
  const bucketPct = input.bucketPct ?? REPLAY_BUCKET_PCT;
  const bars1m = input.bars.filter((b) => b.time >= input.cutoff - lookback - barMs);
  if (bars1m.length < 60) return { ok: false, error: REPLAY_OUT_OF_RANGE };
  const mark = bars1m[bars1m.length - 1].close;

  // Venue current OI at cutoff = last sample ≤ cutoff within lookback.
  const venuesUsed: string[] = [];
  const venuesUnavailable: string[] = [];
  let totalOi = 0;
  const symByVenue: Record<string, number> = {};
  for (const [venue, allPoints] of Object.entries(input.oi)) {
    const points = allPoints.filter((p) => p.ts >= input.cutoff - lookback && Number.isFinite(p.oiUsd) && p.oiUsd > 0);
    if (points.length < 1 || input.cutoff - points[points.length - 1].ts > 60 * 60_000) {
      venuesUnavailable.push(venue);
      continue;
    }
    venuesUsed.push(venue);
    totalOi += points[points.length - 1].oiUsd;
    symByVenue[venue] = points[points.length - 1].oiUsd;
  }
  if (!venuesUsed.length || !(totalOi > 0)) return { ok: false, error: REPLAY_OUT_OF_RANGE };

  const hours = aggregateTo1h(bars1m, input.cutoff - lookback, input.cutoff);
  if (hours.length < 6) return { ok: false, error: REPLAY_OUT_OF_RANGE };

  // Suffix min/max of 1h path after hour i (and 1m path is approximated by 1h OHLC — sufficient for H2).
  const n = hours.length;
  const sufMin = new Array<number>(n + 1).fill(Infinity);
  const sufMax = new Array<number>(n + 1).fill(-Infinity);
  for (let i = n - 1; i >= 0; i -= 1) {
    sufMin[i] = Math.min(sufMin[i + 1], hours[i].low);
    sufMax[i] = Math.max(sufMax[i + 1], hours[i].high);
  }
  const volSum = hours.reduce((s, h) => s + Math.max(0, h.quoteVol), 0) || hours.length;

  const levels: ReplayLevel[] = [];
  for (let i = 0; i < n; i += 1) {
    const h = hours[i];
    const weight = (h.quoteVol > 0 ? h.quoteVol : volSum / n) / volSum;
    const entryOi = totalOi * weight;
    if (!(entryOi > 0) || !(h.close > 0)) continue;
    const pathMin = Math.min(sufMin[i + 1], mark);
    const pathMax = Math.max(sufMax[i + 1], mark);
    for (const tier of REPLAY_LEVERAGE_TIERS) {
      const half = (entryOi * tier.weight) / 2;
      const lp = longLiqPrice(h.close, tier.lev);
      const sp = shortLiqPrice(h.close, tier.lev);
      if (pathMin > lp && lp < mark) {
        levels.push({ venue: "multi", side: "long", price: lp, usd: half, openedAt: h.ts, openPrice: h.close, lev: tier.lev });
      }
      if (pathMax < sp && sp > mark) {
        levels.push({ venue: "multi", side: "short", price: sp, usd: half, openedAt: h.ts, openPrice: h.close, lev: tier.lev });
      }
    }
  }

  const step = (mark * bucketPct) / 100;
  const map = new Map<string, { idx: number; side: "long" | "short"; usd: number }>();
  for (const level of levels) {
    if ((Math.abs(level.price - mark) / mark) * 100 > REPLAY_RANGE_PCT) continue;
    const idx = Math.floor((level.price - mark) / step);
    const lo = mark + idx * step, hi = lo + step;
    if (level.side === "long" && hi >= mark) continue;
    if (level.side === "short" && lo <= mark) continue;
    const key = `${level.side}:${idx}`;
    const entry = map.get(key) ?? { idx, side: level.side, usd: 0 };
    entry.usd += level.usd;
    map.set(key, entry);
  }
  const buckets = [...map.values()]
    .map((b) => ({ ...b, lo: mark + b.idx * step, hi: mark + (b.idx + 1) * step }))
    .filter((b) => (b.side === "long" ? b.hi < mark : b.lo > mark))
    .sort((a, b) => a.lo - b.lo);

  let thresholds: TierThresholds;
  if (input.btcOiUsd != null) thresholds = scaleTierThresholds(totalOi, input.btcOiUsd, bucketPct);
  else if (raw.symbol.startsWith("BTC")) thresholds = scaleTierThresholds(totalOi, totalOi, bucketPct);
  else if (input.btcOi) {
    const btcByVenue: Record<string, number> = {};
    for (const [venue, points] of Object.entries(input.btcOi)) {
      const v = venueOiAt(points, input.cutoff, lookback);
      if (v != null) btcByVenue[venue] = v;
    }
    const matched = matchedReplayOiTotals(symByVenue, btcByVenue);
    thresholds = scaleTierThresholds(matched.sym, matched.btc, bucketPct);
  } else thresholds = scaleTierThresholds(totalOi, undefined, bucketPct);
  // TH-FEAT-20: every bin tiered 中 or above is drawn (Dongyi shows isolated rows); 低 is not.
  const floored = applyRelativeTierFloor(buckets, buckets.map((b) => riskOfUsd(b.usd, thresholds) as Tier));
  const riskAt = (i: number) => {
    const r = floored.tiers[i];
    return r === "极高" || r === "高" || r === "中" ? r : null;
  };
  const decimals = mark >= 1000 ? 1 : mark >= 1 ? 4 : 6;
  const scale = Math.pow(10, decimals);
  const px = (v: number, side: "long" | "short") => (side === "long" ? Math.floor(v * scale) : Math.ceil(v * scale)) / scale;
  const distPct = (lo: number, hi: number) => Number(((((lo + hi) / 2) - mark) / mark * 100).toFixed(2));
  const bands = buckets.flatMap((b, i) => {
    const risk = riskAt(i);
    return risk ? [{ lo: px(b.lo, b.side), hi: px(b.hi, b.side), side: b.side, liq_m: Number((b.usd / 1e6).toFixed(2)), risk, dist_pct: distPct(b.lo, b.hi) }] : [];
  });
  const zones: unknown[] = [];
  for (let i = 0; i < bands.length;) {
    let j = i;
    const adjacent = (a: { hi: number }, b: { lo: number }) => Math.abs(b.lo - a.hi) <= step * 0.01 + Math.pow(10, -decimals);
    // Same side AND same tier only (TH-FEAT-20): consecutive 极高 bins become one box; 高 next to 极高 does not.
    while (j + 1 < bands.length && bands[j + 1].side === bands[i].side && bands[j + 1].risk === bands[i].risk && adjacent(bands[j], bands[j + 1])) j += 1;
    if (j > i) {
      const group = bands.slice(i, j + 1);
      const lo = group[0].lo, hi = group[group.length - 1].hi;
      if (bands[i].side === "long" ? hi < mark : lo > mark) {
        zones.push({
          lo, hi, role: bands[i].side === "long" ? "support" : "resistance", side: bands[i].side,
          liq_m: Number(group.reduce((s, b) => s + b.liq_m, 0).toFixed(2)),
          risk_max: bands[i].risk,
          dist_pct: distPct(lo, hi), bucket_count: group.length,
          band_idx: group.map((_, k) => i + k),
        });
      }
    }
    i = j + 1;
  }
  const rawSnapshot = {
    kind: LIQ_HEATMAP_KIND, venue: "multi", symbol: raw.symbol, mid: mark, markPrice: mark, bucket_pct: bucketPct,
    updatedAt: input.cutoff, source: "oi_liq_estimator", unit: "usd_millions", schemaVersion: 1,
    asOf: new Date(input.cutoff).toISOString().replace(/\.\d{3}Z$/, "Z"), bands, zones,
    venuesFailed: venuesUnavailable, priceDecimals: decimals,
  };
  const parsed = sanitizeLiqHeatmapSnapshot(rawSnapshot);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, snapshot: parsed.snapshot, mark, venuesUsed, venuesUnavailable, levels, buckets, tierThresholds: thresholds, relativeFloorSides: floored.sides };
}
