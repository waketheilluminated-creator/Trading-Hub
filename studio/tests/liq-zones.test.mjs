import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LIQ_ZONE_MAX,
  bandsOutsideZones,
  buildLiqHeatmapPayload,
  chartSupportsLiqSample,
  findLiqZoneAt,
  formatLiqZoneLabel,
  formatLiqZoneTooltip,
  liqLiveFixturePath,
  liqZoneColors,
  loadLiqHeatmapBands,
  placeLiqZones,
  sanitizeLiqHeatmapSnapshot,
  sanitizeLiqZone,
  selectLiqSnapshotSource,
} from "../lib/liq-heatmap.ts";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const zec = read("../fixtures/liq_heatmap_bands.ZECUSDT.json");
const pyth = read("../fixtures/liq_heatmap_bands.PYTHUSDT.json");
const legacy = read("../fixtures/liq_heatmap_bands.sample.json");
const synthetic = read("./fixtures/liq-zones.synthetic.json");

test("delivered ZEC and PYTH estimator snapshots sanitize with every zone and band intact", () => {
  for (const [raw, bands, zones, outside] of [[zec, 26, 3, 20], [pyth, 24, 6, 8]]) {
    const parsed = sanitizeLiqHeatmapSnapshot(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.equal(parsed.dropped, 0);
    assert.equal(parsed.droppedZones, 0);
    assert.equal(parsed.snapshot.schemaVersion, 1);
    assert.equal(parsed.snapshot.markPrice, raw.markPrice);
    assert.equal(parsed.snapshot.bands.length, bands);
    assert.equal(parsed.snapshot.zones.length, zones);
    assert.ok(parsed.snapshot.bands.some((band) => band.risk === "高") && parsed.snapshot.bands.some((band) => band.risk === "极高"));
    for (const zone of parsed.snapshot.zones) {
      assert.equal(zone.role === "support", zone.hi <= raw.markPrice * 1.0001 || zone.lo < raw.markPrice);
      assert.equal(zone.band_idx.length, zone.bucket_count);
    }
    // band_idx-covered buckets are hidden; isolated high/extreme buckets still render as bands.
    assert.equal(bandsOutsideZones(parsed.snapshot.bands, parsed.snapshot.zones).length, outside);
    assert.equal(zec.zoneRule.includes("Isolated"), true);
  }
});

test("legacy snapshots without zones (TH-FEAT-05 sample) still work", () => {
  const parsed = sanitizeLiqHeatmapSnapshot(legacy);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.snapshot.zones, []);
  assert.equal(parsed.snapshot.schemaVersion, null);
  assert.equal(parsed.snapshot.markPrice, legacy.mid);
  assert.equal(bandsOutsideZones(parsed.snapshot.bands, []).length, 13);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...legacy, zones: "nope" }).ok, true);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...legacy, zones: "nope" }).snapshot.zones.length, 0);
});

test("synthetic edge cases: bad zone rows are dropped, never repaired", () => {
  const parsed = sanitizeLiqHeatmapSnapshot(synthetic);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 2, "inverted band + risk 中 band dropped");
  assert.equal(parsed.snapshot.zones.length, 2);
  assert.equal(parsed.droppedZones, synthetic.zones.length - 2);
  const [support, resistance] = parsed.snapshot.zones;
  assert.equal(support.role, "support");
  // band_idx [0, 2] refers to raw rows; raw row 1 was dropped so raw 2 becomes sanitized 1.
  assert.deepEqual(support.band_idx, [0, 1]);
  assert.equal(resistance.band_idx, null);
  // Containment fallback hides the two resistance buckets; the isolated 90–90.5 band stays.
  assert.deepEqual(bandsOutsideZones(parsed.snapshot.bands, parsed.snapshot.zones).map((band) => band.lo), [90]);
  for (const zone of parsed.snapshot.zones) assert.deepEqual(Object.keys(zone).sort(), ["band_idx", "bucket_count", "dist_pct", "hi", "liq_m", "lo", "risk_max", "role", "side"]);
});

test("zone deny paths", () => {
  const ok = { lo: 110, hi: 111, role: "resistance", liq_m: 1, risk_max: "高", dist_pct: 10, bucket_count: 2 };
  assert.ok(sanitizeLiqZone(ok, 100));
  for (const bad of [
    { ...ok, lo: Number.NaN }, { ...ok, hi: Infinity }, { ...ok, lo: 111, hi: 110 }, { ...ok, lo: -1 },
    { ...ok, liq_m: 0 }, { ...ok, liq_m: "1" }, { ...ok, dist_pct: null }, { ...ok, bucket_count: 2.5 },
    { ...ok, bucket_count: 1 }, { ...ok, role: "Resistance" }, { ...ok, risk_max: "extreme" }, { ...ok, risk_max: "低" },
    { ...ok, hi: 99, lo: 98 }, { ...ok, role: "support" }, { ...ok, color: "blue" }, { ...ok, side: "ask" },
    { ...ok, band_idx: [0.5] }, { ...ok, band_idx: {} }, [], "zone", 7,
  ]) assert.equal(sanitizeLiqZone(bad, 100), null, JSON.stringify(bad));
  const many = { ...zec, zones: Array.from({ length: LIQ_ZONE_MAX + 50 }, () => zec.zones[0]) };
  const capped = sanitizeLiqHeatmapSnapshot(many);
  assert.equal(capped.ok && capped.snapshot.zones.length, LIQ_ZONE_MAX);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...zec, schemaVersion: 2 }).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...zec, markPrice: "1385" }).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...zec, boxStart: "first_candle" }).ok, false);
  const forged = sanitizeLiqHeatmapSnapshot({ ...zec, asOf: "<img src=x>", admin: true });
  assert.equal(forged.ok && forged.snapshot.asOf, null);
  assert.equal(forged.ok && "admin" in forged.snapshot, false);
});

test("zone boxes start at the latest bar and extend right only, green support / red resistance", () => {
  const zones = sanitizeLiqHeatmapSnapshot(pyth).snapshot.zones;
  const priceToY = (price) => 1000 - price * 10000;
  const placed = placeLiqZones(zones, priceToY, 700, 900);
  assert.equal(placed.length, 6);
  for (const box of placed) {
    assert.equal(box.left, 700);
    assert.equal(box.width, 200);
    assert.ok(box.height > 0);
  }
  assert.equal(placeLiqZones(zones, priceToY, null, 900).length, 0, "no latest bar → no box (never a historical segment)");
  assert.equal(placeLiqZones(zones, priceToY, 950, 900).length, 0, "latest bar off-screen right → nothing drawn");
  assert.equal(placeLiqZones(zones, priceToY, -50, 900)[0].left, 0);
  assert.match(liqZoneColors("support").edge, /83, 201, 144/);
  assert.match(liqZoneColors("resistance").edge, /231, 103, 112/);
});

test("zone label and tooltip show liq_m, risk_max and dist_pct", () => {
  const [support] = sanitizeLiqHeatmapSnapshot(zec).snapshot.zones;
  assert.equal(formatLiqZoneLabel(support), "$104.54m · Extreme · -3%");
  assert.equal(formatLiqZoneTooltip(support), "Support zone · $104.54m · risk Extreme (极高) · -3% · 1329.8688–1343.7216 · 2 buckets");
  assert.equal(findLiqZoneAt([support], 1335)?.liq_m, 104.54);
  assert.equal(findLiqZoneAt([support], 1300), null);
});

test("API fixture selection: live per-symbol files win; PYTH without a file is 404-ready", () => {
  const live = { "../../../fixtures/liq_heatmap_bands.ZECUSDT.json": zec, "../../../fixtures/liq_heatmap_bands.PYTHUSDT.json": pyth, "../../../fixtures/liq_heatmap_bands.EVILUSDT.json": zec };
  assert.equal(selectLiqSnapshotSource("ZEC", live, legacy).raw, zec);
  assert.equal(selectLiqSnapshotSource("PYTHUSDT", live, legacy).raw, pyth);
  assert.equal(selectLiqSnapshotSource("PYTHUSDT", {}, legacy), null);
  assert.equal(selectLiqSnapshotSource("ZECUSDT", {}, legacy).raw, legacy);
  assert.equal(selectLiqSnapshotSource("EVILUSDT", live, legacy).source, "sample", "unlisted symbols never pick up stray files");
  assert.equal(buildLiqHeatmapPayload("EVILUSDT", selectLiqSnapshotSource("EVILUSDT", live, legacy).raw).body.bands.length, 0);
  assert.equal(liqLiveFixturePath("pyth/usdt"), "studio/fixtures/liq_heatmap_bands.PYTHUSDT.json");
  assert.equal(chartSupportsLiqSample("PYTHUSDT"), true);
  assert.equal(chartSupportsLiqSample("BTCUSDT"), false);
});

test("client loader returns zones for PYTH and drops forged zone rows", async () => {
  const loaded = await loadLiqHeatmapBands("PYTHUSDT", async (url) => {
    assert.equal(url, "/api/liq-heatmap?symbol=PYTHUSDT");
    return Response.json({ ...pyth, zones: [...pyth.zones, { lo: 1, hi: 2, role: "admin" }] });
  });
  assert.equal(loaded.notice, null);
  assert.equal(loaded.zones.length, 6);
  const missing = await loadLiqHeatmapBands("PYTHUSDT", async () => Response.json({ error: "No liquidation snapshot is available for this market yet." }, { status: 404 }));
  assert.equal(missing.zones.length, 0);
  assert.match(missing.notice, /No liquidation snapshot/);
});

test("workspace hides zone-covered bands, draws zones from the latest candle and makes room for them", () => {
  const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /bandsOutsideZones\(liqForChart\?\.bands \?\? \[\], liqZones\)/);
  assert.match(workspace, /setZones\(showLiqHeatmap \? liqZones : \[\], latestCandleTime\)/);
  assert.match(workspace, /rightOffset: liqZonesVisible \? LIQ_ZONE_RIGHT_OFFSET_BARS : 8/);
  assert.match(workspace, /formatLiqZoneTooltip\(zone\)/);
});

test("zone boxes render on the candlestick pane above the candles, semi-transparent", () => {
  const primitive = readFileSync(new URL("../lib/liq-heatmap-primitive.ts", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(primitive, /class LiqZonePaneView[\s\S]*?zOrder\(\): "top"/);
  assert.match(workspace, /candleSeries\.attachPrimitive\(liqHeatmapPrimitive\)/, "same series / price axis as the candles");
  for (const role of ["support", "resistance"]) {
    const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(liqZoneColors(role).fill)[1]);
    assert.ok(alpha > 0 && alpha < 0.5, `${role} fill alpha ${alpha}`);
  }
});
