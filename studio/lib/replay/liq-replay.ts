/**
 * TH-FEAT-17 Bar Replay: liquidation zones computed ON DEMAND as of a replay candle from historical open interest
 * and historical price. Nothing is persisted; callers may keep a small in-memory cache.
 *
 * Model (same idea as the oi_liq estimator, simplified and fully deterministic):
 *  1. Every OI increase ΔOI (USD) between two 5m samples opens a cohort at that sample's price,
 *     split 50/50 long/short and across leverage tiers.
 *  2. OI decreases close existing cohorts proportionally.
 *  3. Liquidation price: long p·(1 − 1/L + mm), short p·(1 + 1/L − mm).
 *  4. A cohort level already reached by the later price path (5m low/high up to the cutoff) is swept.
 * * 5. Remaining levels are bucketed around the mark (close of the replay candle); the top percentile tiers (P85/P95) become
 *     bands (高/极高) and ≥2 adjacent same-side high/extreme buckets merge into a zone.
 * No lookahead: every input is cut at `cutoff` before any computation, so passing future bars/OI cannot change the result.
 */
import { LIQ_HEATMAP_KIND, sanitizeLiqHeatmapSnapshot, type LiqHeatmapSnapshot } from "../liq-heatmap.ts";

export const REPLAY_HISTORY_MS = 30 * 24 * 60 * 60 * 1000; // Binance openInterestHist keeps ~30 days
export const REPLAY_COHORT_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
export const REPLAY_BUCKET_PCT = 0.25;
export const REPLAY_RANGE_PCT = 12;
export const REPLAY_LEVERAGE_TIERS: readonly { lev: number; weight: number }[] = [
  { lev: 10, weight: 0.3 }, { lev: 25, weight: 0.3 }, { lev: 50, weight: 0.25 }, { lev: 100, weight: 0.15 },
];
export const REPLAY_MAINT_MARGIN = 0.005;
export const REPLAY_OUT_OF_RANGE = "超出可回溯范围";

export type OiPoint = { ts: number; oiUsd: number };
export type PriceBar = { time: number; open: number; high: number; low: number; close: number }; // time = open, ms
export type ReplayInput = {
  symbol: string;
  /** Close time (ms) of the replay candle: the latest instant whose data is visible. */
  cutoff: number;
  /** Price bars, barMs apart (1m from the service; any range; cut here). */
  bars: readonly PriceBar[];
  /** OI history per venue (any range; cut here). Missing/empty = unavailable venue. */
  oi: Readonly<Record<string, readonly OiPoint[]>>;
  barMs?: number;
  lookbackMs?: number;
  bucketPct?: number;
};
export type ReplayLevel = { venue: string; side: "long" | "short"; price: number; usd: number; openedAt: number; openPrice: number; lev: number };
export type ReplayResult = {
  ok: true; snapshot: LiqHeatmapSnapshot; mark: number; venuesUsed: string[]; venuesUnavailable: string[]; levels: ReplayLevel[];
  buckets: { idx: number; lo: number; hi: number; side: "long" | "short"; usd: number }[];
} | { ok: false; error: string };

export function longLiqPrice(p: number, lev: number, mm = REPLAY_MAINT_MARGIN): number { return p * (1 - 1 / lev + mm); }
export function shortLiqPrice(p: number, lev: number, mm = REPLAY_MAINT_MARGIN): number { return p * (1 + 1 / lev - mm); }

/** Cut every series at the cutoff (bars must have CLOSED by then; OI samples at or before it). */
export function truncateReplayInput(input: ReplayInput): ReplayInput {
  const barMs = input.barMs ?? 5 * 60_000;
  const oi: Record<string, OiPoint[]> = {};
  for (const [venue, points] of Object.entries(input.oi)) oi[venue] = points.filter((p) => p.ts <= input.cutoff).sort((a, b) => a.ts - b.ts);
  return { ...input, bars: input.bars.filter((b) => b.time + barMs <= input.cutoff).sort((a, b) => a.time - b.time), oi };
}

export function computeReplayLiq(raw: ReplayInput): ReplayResult {
  const input = truncateReplayInput(raw);
  const barMs = input.barMs ?? 5 * 60_000;
  const lookback = input.lookbackMs ?? REPLAY_COHORT_LOOKBACK_MS;
  const bucketPct = input.bucketPct ?? REPLAY_BUCKET_PCT;
  const bars = input.bars.filter((b) => b.time >= input.cutoff - lookback - barMs);
  if (bars.length < 60) return { ok: false, error: REPLAY_OUT_OF_RANGE };
  const mark = bars[bars.length - 1].close;
  const barTimes = bars.map((b) => b.time);
  // suffix min/max of the path after bar i (inclusive) for sweeping
  const sufMin = new Array<number>(bars.length + 1).fill(Infinity);
  const sufMax = new Array<number>(bars.length + 1).fill(-Infinity);
  for (let i = bars.length - 1; i >= 0; i -= 1) { sufMin[i] = Math.min(sufMin[i + 1], bars[i].low); sufMax[i] = Math.max(sufMax[i + 1], bars[i].high); }
  const barIndexAt = (ts: number): number => {
    // the bar containing ts (open <= ts < open+barMs); -1 if none
    let lo = 0, hi = barTimes.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (barTimes[mid] <= ts) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 && ts < barTimes[found] + barMs ? found : -1;
  };

  const levels: ReplayLevel[] = [];
  const venuesUsed: string[] = [];
  const venuesUnavailable: string[] = [];
  for (const [venue, allPoints] of Object.entries(input.oi)) {
    const points = allPoints.filter((p) => p.ts >= input.cutoff - lookback && Number.isFinite(p.oiUsd) && p.oiUsd > 0);
    // Need coverage reaching the replay candle (within 1h) and a meaningful history.
    if (points.length < 12 || input.cutoff - points[points.length - 1].ts > 60 * 60_000) { venuesUnavailable.push(venue); continue; }
    venuesUsed.push(venue);
    type Cohort = { openedAt: number; price: number; usd: number; barIdx: number };
    let cohorts: Cohort[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const delta = points[i].oiUsd - points[i - 1].oiUsd;
      const barIdx = barIndexAt(points[i].ts - 1); // the bar that ended at this sample
      if (barIdx < 0) continue;
      if (delta > 0) cohorts.push({ openedAt: points[i].ts, price: bars[barIdx].close, usd: delta, barIdx });
      else if (delta < 0) {
        const total = cohorts.reduce((sum, c) => sum + c.usd, 0);
        if (total > 0) { const keep = Math.max(0, 1 + delta / total); cohorts = cohorts.map((c) => ({ ...c, usd: c.usd * keep })); }
      }
    }
    for (const c of cohorts) {
      const after = c.barIdx + 1; // path strictly after the cohort opened
      const pathMin = Math.min(sufMin[after], mark);
      const pathMax = Math.max(sufMax[after], mark);
      for (const tier of REPLAY_LEVERAGE_TIERS) {
        const half = (c.usd * tier.weight) / 2;
        const lp = longLiqPrice(c.price, tier.lev);
        const sp = shortLiqPrice(c.price, tier.lev);
        if (pathMin > lp) levels.push({ venue, side: "long", price: lp, usd: half, openedAt: c.openedAt, openPrice: c.price, lev: tier.lev });
        if (pathMax < sp) levels.push({ venue, side: "short", price: sp, usd: half, openedAt: c.openedAt, openPrice: c.price, lev: tier.lev });
      }
    }
  }
  if (!venuesUsed.length) return { ok: false, error: REPLAY_OUT_OF_RANGE };

  // Bucket around the mark: bucket k covers [mark·(1 + k·b), mark·(1 + (k+1)·b)).
  const step = (mark * bucketPct) / 100;
  const map = new Map<string, { idx: number; side: "long" | "short"; usd: number }>();
  for (const level of levels) {
    if (Math.abs(level.price - mark) / mark * 100 > REPLAY_RANGE_PCT) continue;
    const idx = Math.floor((level.price - mark) / step);
    const key = `${level.side}:${idx}`;
    const entry = map.get(key) ?? { idx, side: level.side, usd: 0 };
    entry.usd += level.usd;
    map.set(key, entry);
  }
  const buckets = [...map.values()]
    .map((b) => ({ ...b, lo: mark + b.idx * step, hi: mark + (b.idx + 1) * step }))
    // a long bucket must sit fully below the mark, a short one fully above (invariant)
    .filter((b) => (b.side === "long" ? b.hi <= mark : b.lo >= mark))
    .sort((a, b) => a.lo - b.lo);
  // Top two volume-percentile tiers (as in the estimator): ≥P95 = 极高 (extreme), ≥P85 = 高 (high).
  const sorted = buckets.map((b) => b.usd).filter((v) => v > 0).sort((x, y) => x - y);
  const pct = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : Infinity);
  const p95 = pct(0.95), p85 = pct(0.85);
  const riskOf = (usd: number): "高" | "极高" | null => (!(usd > 0) ? null : usd >= p95 ? "极高" : usd >= p85 ? "高" : null);
  const decimals = mark >= 1000 ? 1 : mark >= 1 ? 4 : 6;
  // Round away from the mark so rounding can never put a long level above price (or a short one below).
  const scale = Math.pow(10, decimals);
  const px = (v: number, side: "long" | "short") => (side === "long" ? Math.floor(v * scale) : Math.ceil(v * scale)) / scale;
  const distPct = (lo: number, hi: number) => Number(((((lo + hi) / 2) - mark) / mark * 100).toFixed(2));
  const bands = buckets.flatMap((b) => {
    const risk = riskOf(b.usd);
    return risk ? [{ lo: px(b.lo, b.side), hi: px(b.hi, b.side), side: b.side, liq_m: Number((b.usd / 1e6).toFixed(2)), risk, dist_pct: distPct(b.lo, b.hi) }] : [];
  });
  const zones: unknown[] = [];
  for (let i = 0; i < bands.length;) {
    let j = i;
    const adjacent = (a: { hi: number }, b: { lo: number }) => Math.abs(b.lo - a.hi) <= step * 0.01 + Math.pow(10, -decimals);
    while (j + 1 < bands.length && bands[j + 1].side === bands[i].side && adjacent(bands[j], bands[j + 1])) j += 1;
    if (j > i) {
      const group = bands.slice(i, j + 1);
      const lo = group[0].lo, hi = group[group.length - 1].hi;
      zones.push({
        lo, hi, role: bands[i].side === "long" ? "support" : "resistance", side: bands[i].side,
        liq_m: Number(group.reduce((s, b) => s + b.liq_m, 0).toFixed(2)),
        risk_max: group.some((b) => b.risk === "极高") ? "极高" : "高",
        dist_pct: distPct(lo, hi), bucket_count: group.length,
        band_idx: group.map((_, k) => i + k),
      });
    }
    i = j + 1;
  }
  const rawSnapshot = {
    kind: LIQ_HEATMAP_KIND, venue: "multi", symbol: raw.symbol, mid: mark, markPrice: mark, bucket_pct: bucketPct,
    updatedAt: input.cutoff, source: "oi_liq_estimator/replay", unit: "usd_millions", schemaVersion: 1,
    asOf: new Date(input.cutoff).toISOString().replace(/\.\d{3}Z$/, "Z"), bands, zones,
    venuesFailed: venuesUnavailable, priceDecimals: decimals,
  };
  const parsed = sanitizeLiqHeatmapSnapshot(rawSnapshot);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, snapshot: parsed.snapshot, mark, venuesUsed, venuesUnavailable, levels, buckets };
}
