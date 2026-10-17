import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { LIQ_LONG_RGB, LIQ_SHORT_RGB, LIQ_SUPPORT_RGB, LIQ_RESISTANCE_RGB, LIQ_LEGEND_ABOVE, LIQ_LEGEND_BELOW, liqBandFillStyle, liqSideConsistent, liqZoneColors, sanitizeLiqHeatmapSnapshot } from "../lib/liq-heatmap.ts";

const base = { kind: "liq_heatmap_bands", venue: "multi", symbol: "BTCUSDT", mid: 81583, markPrice: 81583, bucket_pct: 0.5, updatedAt: 1, source: "oi_liq_estimator/refresh_liq", unit: "usd_millions", schemaVersion: 1 };

test("invariant: every long-liq bucket sits below mark and every short-liq bucket above (all fixtures)", () => {
  const dir = new URL("../fixtures/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^liq_heatmap_bands\..+\.json$/.test(f));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const parsed = sanitizeLiqHeatmapSnapshot(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    assert.equal(parsed.ok, true, file);
    const { markPrice, bands, zones } = parsed.snapshot;
    for (const b of bands) {
      const center = (b.lo + b.hi) / 2;
      if (b.side === "long") assert.ok(center < markPrice, `${file}: long ${b.lo}-${b.hi} above mark ${markPrice}`);
      else assert.ok(center > markPrice, `${file}: short ${b.lo}-${b.hi} below mark ${markPrice}`);
    }
    for (const z of zones) {
      if (z.role === "support") assert.ok(z.hi <= markPrice * 1.0001 || z.lo < markPrice, file);
      if (z.side === "long") assert.equal(z.role, "support", file);
      if (z.side === "short") assert.equal(z.role, "resistance", file);
    }
  }
});

test("real BTC estimator output (2026-10-17): the swept long bucket at +0.75% is dropped", () => {
  const parsed = sanitizeLiqHeatmapSnapshot({
    ...base,
    bands: [
      { lo: 79543.4, hi: 79951.3, side: "long", liq_m: 3020.88, risk: "极高", dist_pct: -2.25 },
      { lo: 84438.4, hi: 84846.3, side: "short", liq_m: 2500.36, risk: "极高", dist_pct: 3.75 },
      { lo: 81990.9, hi: 82398.8, side: "long", liq_m: 1097.21, risk: "极高", dist_pct: 0.75 },
      { lo: 80000, hi: 80400, side: "short", liq_m: 10, risk: "高", dist_pct: -1.7 },
    ],
    zones: [],
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.snapshot.bands.map((b) => `${b.side}:${b.lo}`), ["long:79543.4", "short:84438.4"]);
  assert.equal(parsed.dropped, 2);
});

test("zones: side must match role (long→support below, short→resistance above); band_idx remapped", () => {
  const parsed = sanitizeLiqHeatmapSnapshot({
    ...base,
    bands: [
      { lo: 82000, hi: 82400, side: "long", liq_m: 5, risk: "高", dist_pct: 0.7 }, // swept → dropped
      { lo: 79000, hi: 79400, side: "long", liq_m: 5, risk: "高", dist_pct: -3 },
      { lo: 79400, hi: 79800, side: "long", liq_m: 5, risk: "高", dist_pct: -2.5 },
    ],
    zones: [
      { lo: 79000, hi: 79800, role: "support", side: "long", liq_m: 10, risk_max: "高", dist_pct: -2.7, bucket_count: 2, band_idx: [1, 2] },
      { lo: 83000, hi: 83800, role: "resistance", side: "long", liq_m: 10, risk_max: "高", dist_pct: 2, bucket_count: 2 },
      { lo: 78000, hi: 78800, role: "support", side: "short", liq_m: 10, risk_max: "高", dist_pct: -4, bucket_count: 2 },
    ],
  });
  assert.equal(parsed.snapshot.zones.length, 1);
  assert.deepEqual(parsed.snapshot.zones[0].band_idx, [0, 1]);
  assert.equal(parsed.droppedZones, 2);
});

test("colours: below/long/support = green, above/short/resistance = red; legend says so", () => {
  assert.equal(LIQ_LONG_RGB, "38, 166, 154"); // green
  assert.equal(LIQ_SHORT_RGB, "239, 83, 80"); // red
  assert.equal(LIQ_SUPPORT_RGB, LIQ_LONG_RGB);
  assert.equal(LIQ_RESISTANCE_RGB, LIQ_SHORT_RGB);
  assert.ok(liqBandFillStyle("long", 0.3).includes(LIQ_SUPPORT_RGB));
  assert.ok(liqZoneColors("resistance").fill.includes(LIQ_SHORT_RGB));
  assert.equal(LIQ_LEGEND_BELOW, "下方：多头清算 / 支撑");
  assert.equal(LIQ_LEGEND_ABOVE, "上方：空头清算 / 阻力");
  assert.equal(liqSideConsistent("long", 1, 2, 3), true);
  assert.equal(liqSideConsistent("long", 4, 5, 3), false);
  assert.equal(liqSideConsistent("short", 4, 5, 3), true);
  assert.equal(liqSideConsistent("short", 1, 2, 3), false);
  const src = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(src, /LIQ_LEGEND_ABOVE/);
  assert.doesNotMatch(src, />Long liq</);
});
