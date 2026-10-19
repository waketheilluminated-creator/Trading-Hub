/** TH-FEAT-20: live + replay buckets at the Dongyi bin (0.19%), same-tier boxes, 中+ singles visible. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeReplayLiq, matchedReplayOiTotals, venueOiAt, scaleTierThresholds, riskOfUsd,
  REPLAY_BUCKET_PCT, DONGYI_REF_BIN_PCT, BTC_TIER_EXTREME_USD, BTC_TIER_HIGH_USD, BTC_TIER_MEDIUM_USD,
} from "../lib/replay/liq-replay.ts";
import { replayLiqZones, REPLAY_BTC_OI_WINDOW_MS } from "../lib/replay/service.ts";
import { clearReplayCache } from "../lib/replay/history.ts";
import {
  sanitizeLiqHeatmapSnapshot, sanitizeLiqZone, bandsOutsideZones, placeLiqZones, placeLiqHeatmapBands, liqZoneColors,
  liqZoneBorderWidth, alertableLiqZones, formatLiqRisk, LIQ_BAND_MAX, LIQ_ZONE_MAX, LIQ_LEGEND_RISK_MEDIUM,
} from "../lib/liq-heatmap.ts";
import { drawLiqZone } from "../lib/liq-heatmap-primitive.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);
function market(days = 4, base = 80_000) {
  const bars = [];
  let p = base;
  for (let i = 0; i < days * 1440; i += 1) {
    const t = T0 + i * MIN;
    const drift = (Math.sin(i / 180) * 18 + (i >= 2.5 * 1440 && i < 2.5 * 1440 + 30 ? -120 : 0)) * (base / 80_000);
    const open = p; p = Math.max(base / 80, p + drift);
    bars.push({ time: t, open, high: Math.max(open, p) + 8 * base / 80_000, low: Math.min(open, p) - 8 * base / 80_000, close: p });
  }
  const oi = { binance: [], bybit: [] };
  for (let i = 0; i <= days * 288; i += 1) {
    const ts = T0 + i * 5 * MIN;
    oi.binance.push({ ts, oiUsd: 7e9 + 4e8 * Math.sin(i / 20) + i * 1e6 });
    oi.bybit.push({ ts, oiUsd: 4e9 + 2e8 * Math.cos(i / 15) });
  }
  return { bars, oi };
}
const CUT = T0 + 3.2 * 86_400_000;

test("replay bucket = Dongyi bin; BTC cutoffs are the fixed floors (no bucket scaling)", () => {
  assert.equal(REPLAY_BUCKET_PCT, 0.19);
  assert.equal(REPLAY_BUCKET_PCT, DONGYI_REF_BIN_PCT);
  const m = market();
  const r = computeReplayLiq({ symbol: "BTCUSDT", cutoff: CUT, bars: m.bars, oi: m.oi, barMs: MIN });
  assert.ok(r.ok);
  assert.equal(r.snapshot.bucket_pct, 0.19);
  assert.deepEqual(r.tierThresholds, { extremeUsd: BTC_TIER_EXTREME_USD, highUsd: BTC_TIER_HIGH_USD, mediumUsd: BTC_TIER_MEDIUM_USD });
  const step = r.mark * 0.0019;
  for (const b of r.buckets) assert.ok(Math.abs(b.hi - b.lo - step) < 1e-6);
});

test("replay: every 中+ bin is a band, 低 never; zones are same-tier runs of ≥2 adjacent bins", () => {
  const m = market();
  const r = computeReplayLiq({ symbol: "BTCUSDT", cutoff: CUT, bars: m.bars, oi: m.oi, barMs: MIN });
  assert.ok(r.ok);
  const tiered = r.buckets.filter((b) => riskOfUsd(b.usd, r.tierThresholds) !== "低");
  assert.equal(r.snapshot.bands.length, tiered.length);
  assert.ok(r.snapshot.bands.every((b) => ["中", "高", "极高"].includes(b.risk)));
  assert.ok(r.snapshot.zones.length > 0);
  for (const z of r.snapshot.zones) {
    assert.ok(z.bucket_count >= 2 && z.band_idx && z.band_idx.length === z.bucket_count);
    for (const i of z.band_idx) assert.equal(r.snapshot.bands[i].risk, z.risk_max, "a box never mixes tiers");
  }
  // Isolated tiered bins (not in any box) remain visible as bands.
  assert.deepEqual(r.relativeFloorSides, []);
  const singles = bandsOutsideZones(r.snapshot.bands, r.snapshot.zones);
  assert.equal(singles.length + r.snapshot.zones.reduce((s, z) => s + z.bucket_count, 0), r.snapshot.bands.length);
});

test("matched OI totals: only shared venues count; deny paths", () => {
  assert.deepEqual(matchedReplayOiTotals({ binance: 5e9, bybit: 2e9, okx: 1e9 }, { binance: 10e9, okx: 4e9 }), { sym: 6e9, btc: 14e9 });
  assert.deepEqual(matchedReplayOiTotals({ binance: 5e9 }, { okx: 4e9 }), { sym: 5e9, btc: null });
  assert.deepEqual(matchedReplayOiTotals({ binance: 5e9 }, { binance: Number.NaN }), { sym: 5e9, btc: null });
  assert.deepEqual(matchedReplayOiTotals({ binance: 5e9, bybit: -1 }, { binance: 0, bybit: 3e9 }), { sym: 5e9, btc: null });
  assert.deepEqual(matchedReplayOiTotals({}, {}), { sym: 0, btc: null });
  // venueOiAt: last sample ≤ cutoff, not older than 1h, never from the future.
  const pts = [{ ts: 1000, oiUsd: 1 }, { ts: 2000, oiUsd: 2 }, { ts: 9e9, oiUsd: 99 }];
  assert.equal(venueOiAt(pts, 2500), 2);
  assert.equal(venueOiAt(pts, 2000 + 61 * MIN), null);
  assert.equal(venueOiAt([{ ts: 1, oiUsd: Number.NaN }], 2), null);
  assert.equal(venueOiAt(undefined, 2), null);
});

test("replay alts: BTC OI (same venues) scales the cutoffs; without it they stay at the BTC floors", () => {
  const m = market(4, 3000);
  const eth = { symbol: "ETHUSDT", cutoff: CUT, bars: m.bars, oi: m.oi, barMs: MIN };
  const plain = computeReplayLiq(eth);
  assert.ok(plain.ok);
  assert.equal(plain.tierThresholds.extremeUsd, BTC_TIER_EXTREME_USD);
  // BTC OI 2× on binance+bybit (+ an okx row the alt lacks → ignored).
  const btcOi = Object.fromEntries(Object.entries(m.oi).map(([v, pts]) => [v, pts.map((p) => ({ ts: p.ts, oiUsd: p.oiUsd * 2 }))]));
  btcOi.okx = [{ ts: CUT - MIN, oiUsd: 1e12 }];
  const scaled = computeReplayLiq({ ...eth, btcOi });
  assert.ok(scaled.ok);
  const sym = venueOiAt(m.oi.binance, CUT) + venueOiAt(m.oi.bybit, CUT);
  const expected = scaleTierThresholds(sym, sym * 2, REPLAY_BUCKET_PCT);
  assert.ok(Math.abs(scaled.tierThresholds.extremeUsd - expected.extremeUsd) < 1e-3);
  assert.ok(Math.abs(scaled.tierThresholds.extremeUsd - BTC_TIER_EXTREME_USD / 2) < 1);
  // Stale/future-only BTC samples are not used (no lookahead) → unscaled.
  const future = computeReplayLiq({ ...eth, btcOi: { binance: [{ ts: CUT + MIN, oiUsd: 1e12 }] } });
  assert.ok(future.ok);
  assert.equal(future.tierThresholds.extremeUsd, BTC_TIER_EXTREME_USD);
});

function mockExchange(log) {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    const sym = u.searchParams.get("symbol");
    const start = Number(u.searchParams.get("startTime")), end = Number(u.searchParams.get("endTime"));
    if (u.pathname === "/fapi/v1/klines") {
      const base = sym === "BTCUSDT" ? 80_000 : 3000;
      const rows = [];
      for (let t = start; t <= end && rows.length < 400; t += MIN) {
        const p = base * (1 + 0.01 * Math.sin(t / 3.6e6));
        rows.push([t, p, p * 1.001, p * 0.999, p, 1]);
      }
      return { ok: true, json: async () => rows };
    }
    if (u.pathname === "/futures/data/openInterestHist") {
      const rows = [];
      for (let t = Math.ceil(start / (5 * MIN)) * 5 * MIN; t <= end; t += 5 * MIN) rows.push({ timestamp: t, sumOpenInterestValue: sym === "BTCUSDT" ? 10e9 : 5e9 });
      return { ok: true, json: async () => rows };
    }
    return { ok: false, json: async () => ({}) };
  };
}

test("replay service: alts fetch BTC OI over the venues they used, in a short window ending at cutoff", async () => {
  clearReplayCache();
  const now = Date.UTC(2026, 9, 18, 0, 0, 0);
  const cutoff = now - 86_400_000;
  const log = [];
  const r = await replayLiqZones("ETHUSDT", cutoff, mockExchange(log), now);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.venuesUsed, ["binance"]);
  const btcOiUrls = log.filter((u) => u.includes("openInterestHist") && u.includes("symbol=BTCUSDT"));
  assert.ok(btcOiUrls.length >= 1 && btcOiUrls.length <= 2, "only the 2h window chunks");
  assert.ok(!log.some((u) => u.includes("bybit") && u.includes("BTCUSDT")), "BTC OI only for venues the alt used");
  for (const u of btcOiUrls) assert.ok(Number(new URL(u).searchParams.get("startTime")) >= cutoff - REPLAY_BTC_OI_WINDOW_MS - 6 * 3.6e6);
  // ETH 5B / BTC 10B on binance (same venue) → OI share 0.5 → every cutoff halves.
  assert.ok(Math.abs(r.tierThresholds.extremeUsd - BTC_TIER_EXTREME_USD / 2) < 1);
  assert.ok(Math.abs(r.tierThresholds.mediumUsd - BTC_TIER_MEDIUM_USD / 2) < 1);
  // BTC itself never fetches a second BTC OI series.
  clearReplayCache();
  const log2 = [];
  const b = await replayLiqZones("BTCUSDT", cutoff - 3_600_000, mockExchange(log2), now);
  assert.ok(b.ok);
  const fromTimes = log2.filter((u) => u.includes("openInterestHist")).map((u) => Number(new URL(u).searchParams.get("startTime")));
  assert.equal(new Set(fromTimes).size, fromTimes.length, "no duplicate BTC OI chunk fetches");
});

test("sanitizer: 中 bands/zones accepted, 低 rejected; zones still need ≥2 bins; bands capped", () => {
  const ok = { lo: 110, hi: 111, role: "resistance", liq_m: 1, risk_max: "中", dist_pct: 10, bucket_count: 2 };
  assert.equal(sanitizeLiqZone(ok, 100)?.risk_max, "中");
  assert.equal(sanitizeLiqZone({ ...ok, risk_max: "低" }, 100), null);
  assert.equal(sanitizeLiqZone({ ...ok, bucket_count: 1 }, 100), null);
  const base = { kind: "liq_heatmap_bands", venue: "multi", symbol: "BTCUSDT", mid: 100, markPrice: 100, bucket_pct: 0.19, updatedAt: 1, source: "oi_liq_estimator", unit: "usd_millions", schemaVersion: 1, zones: [] };
  const band = (i) => ({ lo: 101 + i * 0.19, hi: 101.19 + i * 0.19, side: "short", liq_m: 20, risk: "中", dist_pct: 1 });
  const many = sanitizeLiqHeatmapSnapshot({ ...base, bands: Array.from({ length: LIQ_BAND_MAX + 30 }, (_, i) => band(i)) });
  assert.ok(many.ok);
  assert.equal(many.snapshot.bands.length, LIQ_BAND_MAX);
  assert.equal(many.dropped, 30);
});

test("styling: 高/极高 unchanged; 中 lighter fill, no border, Medium label; alerts only on 高/极高", () => {
  assert.equal(liqZoneColors("support").fill, liqZoneColors("support", "高").fill);
  assert.match(liqZoneColors("support", "极高").fill, /, 0\.2\)$/);
  assert.match(liqZoneColors("resistance", "中").fill, /, 0\.1\)$/);
  assert.deepEqual([liqZoneBorderWidth("中"), liqZoneBorderWidth("高"), liqZoneBorderWidth("极高")], [0, 0, 2]);
  assert.deepEqual(["中", "高", "极高"].map(formatLiqRisk), ["Medium", "High", "Extreme"]);
  assert.equal(LIQ_LEGEND_RISK_MEDIUM, "中：浅填充");
  const zones = ["中", "高", "极高", "低", undefined].map((risk_max) => ({ risk_max }));
  assert.deepEqual(alertableLiqZones(zones).map((z) => z.risk_max), ["高", "极高"]);
  assert.deepEqual(alertableLiqZones(null), []);
  const src = readFileSync(new URL("../lib/alerts/zone-source.ts", import.meta.url), "utf8");
  assert.match(src, /normalizeZoneSpecs\(alertableLiqZones\(built\.body\.zones\)\)/);
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /liq-risk-medium[^>]*\/>\{LIQ_LEGEND_RISK_MEDIUM\}/);
});

function mockContext() {
  let ops = 0;
  return {
    get ops() { return ops; },
    fillRect() { ops += 1; }, strokeRect() { ops += 1; }, fillText() { ops += 1; },
    measureText(t) { return { width: t.length * 6 }; }, save() {}, restore() {},
    set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set font(_) {}, set textBaseline(_) {},
  };
}

test("render budget: ~2.6× more bins (cap-sized snapshot) places + paints well within a frame", () => {
  const n = LIQ_BAND_MAX;
  const bands = Array.from({ length: n }, (_, i) => ({ lo: 70_000 + i * 152, hi: 70_152 + i * 152, side: i < n / 2 ? "long" : "short", liq_m: 15 + (i % 120), risk: ["中", "高", "极高"][i % 3], dist_pct: 0 }));
  const zones = Array.from({ length: LIQ_ZONE_MAX }, (_, i) => ({ lo: 70_000 + i * 304, hi: 70_304 + i * 304, role: i < LIQ_ZONE_MAX / 2 ? "support" : "resistance", side: i < LIQ_ZONE_MAX / 2 ? "long" : "short", liq_m: 30 + i, risk_max: ["中", "高", "极高"][i % 3], dist_pct: 1, bucket_count: 2, band_idx: null }));
  const y = (p) => 800 - (p - 70_000) / 80;
  const ctx = mockContext();
  const frames = 60;
  const t0 = performance.now();
  for (let f = 0; f < frames; f += 1) {
    const placedBands = placeLiqHeatmapBands(bandsOutsideZones(bands, zones), y);
    for (const b of placedBands) ctx.fillRect(0, b.top, 100, b.height);
    for (const z of placeLiqZones(zones, y, 400, 1200)) drawLiqZone(ctx, z);
  }
  const perFrame = (performance.now() - t0) / frames;
  assert.ok(ctx.ops > 0);
  assert.ok(perFrame < 8, `per-frame overlay work ${perFrame.toFixed(2)}ms must stay < 8ms`);
});

test("live BTC 0.19% fixture (Beijing 2026-10-20 02:47): long 极高 box overlaps 东一 79,462–79,619", () => {
  const data = JSON.parse(readFileSync(new URL("./fixtures/liq_btc_s1020_0p19.json", import.meta.url), "utf8"));
  const thr = scaleTierThresholds(1, 1, data.bucket_width_pct * 100);
  assert.equal(thr.extremeUsd, BTC_TIER_EXTREME_USD);
  const ext = data.buckets.filter((r) => riskOfUsd(r.liq_usd, thr) === "极高" && r.side === "long" && Math.abs(r.price / data.mark - 1) < 0.05).sort((a, b) => a.lo - b.lo);
  const runs = [];
  for (const r of ext) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(r.lo - last.hi) < 1e-6 * data.mark) { last.hi = r.hi; last.n += 1; } else runs.push({ lo: r.lo, hi: r.hi, n: 1 });
  }
  const boxes = runs.filter((r) => r.n >= 2);
  assert.equal(boxes.length, 1, "one merged long 极高 box within ±5%");
  assert.ok(boxes[0].lo < 79_619 && boxes[0].hi > 79_462);
  assert.deepEqual([Math.round(boxes[0].lo), Math.round(boxes[0].hi), boxes[0].n], [78_508, 79_598, 7]);
});

// --- TH-FEAT-20b: small-OI alts never collapse to zero bands; empty refresh gets a notice ---
import { applyRelativeTierFloor, REL_FLOOR_HIGH, REL_FLOOR_MEDIUM } from "../lib/replay/liq-replay.ts";
import { liqRefreshEmptyNotice, LIQ_REFRESH_EMPTY_LABEL, LIQ_REFRESH_EMPTY_TITLE, LIQ_REFRESH_EMPTY_MS } from "../lib/liq-heatmap.ts";

test("relative floor: only a side with no 中+ bin is re-tiered; never 极高; deny paths", () => {
  assert.deepEqual([REL_FLOOR_HIGH, REL_FLOOR_MEDIUM], [0.8, 0.5]);
  const bins = [{ side: "long", usd: 100 }, { side: "long", usd: 85 }, { side: "long", usd: 60 }, { side: "long", usd: 10 }, { side: "short", usd: 2e8 }, { side: "short", usd: 1 }];
  const r = applyRelativeTierFloor(bins, ["低", "低", "低", "低", "中", "低"]);
  assert.deepEqual(r.tiers, ["高", "高", "中", "低", "中", "低"]);
  assert.deepEqual(r.sides, ["long"]);
  assert.deepEqual(applyRelativeTierFloor([], []), { tiers: [], sides: [] });
  assert.deepEqual(applyRelativeTierFloor([{ side: "long", usd: Number.NaN }, { side: "bid", usd: 5 }, { side: "short", usd: 0 }], ["低", "低", "低"]), { tiers: ["低", "低", "低"], sides: [] });
});

test("replay small-OI alt (huge BTC OI): absolute cutoffs alone would be empty, floor keeps its top bins", () => {
  const m = market(4, 0.072);
  // btcOiUsd=1 → OI ratio clamps to 100 → cutoffs ≫ any bin (worst case of the PYTH "no reaction").
  const r = computeReplayLiq({ symbol: "PYTHUSDT", cutoff: CUT, bars: m.bars, oi: m.oi, btcOiUsd: 1, barMs: MIN });
  assert.ok(r.ok);
  assert.ok(r.buckets.every((b) => riskOfUsd(b.usd, r.tierThresholds) === "低"), "absolute tiers yield nothing");
  assert.deepEqual(r.relativeFloorSides.sort(), ["long", "short"]);
  assert.ok(r.snapshot.bands.length > 0 && r.snapshot.bands.every((b) => b.risk === "高" || b.risk === "中"));
  for (const side of ["long", "short"]) assert.ok(r.snapshot.bands.some((b) => b.side === side && b.risk === "高"), side);
  // BTC keeps purely absolute tiers when they already produce bins.
  const b = computeReplayLiq({ symbol: "BTCUSDT", cutoff: CUT, bars: market().bars, oi: market().oi, barMs: MIN });
  assert.ok(b.ok);
  assert.deepEqual(b.relativeFloorSides, []);
});

test("refresh with zero zones → brief icon notice (minimal text + tooltip), wired in the workspace", () => {
  assert.equal(liqRefreshEmptyNotice({ zones: [] }), LIQ_REFRESH_EMPTY_LABEL);
  assert.equal(liqRefreshEmptyNotice({ zones: [{}] }), null);
  assert.equal(liqRefreshEmptyNotice(null), null);
  assert.ok(LIQ_REFRESH_EMPTY_LABEL.startsWith("∅") && LIQ_REFRESH_EMPTY_LABEL.length <= 8);
  assert.ok(LIQ_REFRESH_EMPTY_TITLE.length > 0 && LIQ_REFRESH_EMPTY_MS > 0 && LIQ_REFRESH_EMPTY_MS <= 10_000);
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /const empty = liqRefreshEmptyNotice\(result\.model\);/);
  assert.match(ws, /data-liq-refresh-empty title=\{LIQ_REFRESH_EMPTY_TITLE\}/);
  assert.match(ws, /setTimeout\(\(\) => setLiqEmpty\(null\), LIQ_REFRESH_EMPTY_MS\)/);
});
