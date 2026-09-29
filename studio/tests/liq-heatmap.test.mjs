import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readStoredFlag, writeStoredFlag } from "../lib/chart-indicator-panes.ts";
import {
  LIQ_HEATMAP_STORAGE_KEY,
  LIQ_HEATMAP_SYMBOL_NOTICE,
  LIQ_LONG_RGB,
  LIQ_SHORT_RGB,
  buildLiqHeatmapPayload,
  chartSupportsLiqSample,
  findLiqBandAtPrice,
  formatLiqBandTooltip,
  liqBandFillStyle,
  liqBandOpacities,
  liqSymbolsMatch,
  loadLiqHeatmapBands,
  parseLiqHeatmapQuery,
  placeLiqHeatmapBands,
  sanitizeLiqHeatmapSnapshot,
  snapshotFieldNames,
} from "../lib/liq-heatmap.ts";
import { MIN_WALL_CENTER_GAP_PX, layoutSeparatedWalls, visualWallBands, wallFillStyle } from "../lib/market-depth.ts";

const fixtureUrl = new URL("../fixtures/liq_heatmap_bands.sample.json", import.meta.url);
const sample = JSON.parse(readFileSync(fixtureUrl, "utf8"));

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
  };
}

test("sanitizes the canonical ZEC extreme-liquidation sample", () => {
  const parsed = sanitizeLiqHeatmapSnapshot(sample);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 0);
  assert.equal(parsed.snapshot.kind, "liq_heatmap_bands");
  assert.equal(parsed.snapshot.venue, "multi");
  assert.equal(parsed.snapshot.symbol, "ZECUSDT");
  assert.equal(parsed.snapshot.mid, 1385.28);
  assert.equal(parsed.snapshot.bucket_pct, 0.5);
  assert.equal(parsed.snapshot.source, "oi_liq_estimator");
  assert.equal(parsed.snapshot.unit, "usd_millions");
  assert.equal(parsed.snapshot.bands.length, 13);
  assert.deepEqual(Object.keys(parsed.snapshot), [...snapshotFieldNames()]);
  assert.ok(parsed.snapshot.bands.every((band) => band.risk === "极高"));
  assert.deepEqual(parsed.snapshot.bands.map((band) => band.side).sort(), [
    "long", "long", "long", "long", "long", "long",
    "short", "short", "short", "short", "short", "short", "short",
  ]);
  const longTip = formatLiqBandTooltip(parsed.snapshot.bands[1]);
  assert.equal(longTip, "Long liquidation · $219.87m · -9.75% · 1246.752–1253.6784");
  const shortTip = formatLiqBandTooltip(parsed.snapshot.bands[0]);
  assert.equal(shortTip, "Short liquidation · $234.04m · +10.25% · 1523.808–1530.7344");
});

test("rejects the wrong kind, non-finite mid, and forged privilege flags without keeping them", () => {
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...sample, kind: "order_walls" }).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...sample, kind: "liq_heatmap_bands", mid: Number.NaN }).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...sample, mid: Number.POSITIVE_INFINITY }).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...sample, mid: "1385.28" }).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot(null).ok, false);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...sample, bands: "already-packed" }).ok, false);

  const flagged = sanitizeLiqHeatmapSnapshot({
    ...sample,
    admin: true,
    entitled: true,
    role: "admin",
    authorized: true,
    hasMarketHistory: true,
    membership: "pro",
    notice: "client claims history",
  });
  assert.equal(flagged.ok, true);
  if (!flagged.ok) return;
  const plain = sanitizeLiqHeatmapSnapshot(sample);
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  assert.deepEqual(flagged.snapshot, plain.snapshot);
  assert.doesNotMatch(JSON.stringify(flagged.snapshot), /admin|entitled|authorized|hasMarketHistory|membership/);
});

test("drops bad bands and keeps the remaining extreme zones", () => {
  const parsed = sanitizeLiqHeatmapSnapshot({
    ...sample,
    bands: [
      sample.bands[0],
      { lo: 10, hi: 10, side: "long", liq_m: 10, risk: "极高", dist_pct: 0 },
      { lo: 12, hi: 9, side: "long", liq_m: 10, risk: "极高", dist_pct: 0 },
      { lo: Number.NaN, hi: 11, side: "long", liq_m: 10, risk: "极高", dist_pct: 0 },
      { lo: 10, hi: 11, side: "bid", liq_m: 10, risk: "极高", dist_pct: 0 },
      { lo: 10, hi: 11, side: "long", liq_m: 10, risk: "高", dist_pct: 0 },
      { lo: 10, hi: 11, side: "LONG", liq_m: 10, risk: "极高", dist_pct: 0 },
      { lo: 10, hi: 11, side: "long", liq_m: Number.POSITIVE_INFINITY, risk: "极高", dist_pct: 0 },
      { lo: 10, hi: 11, side: "short", liq_m: 4, risk: "极高", dist_pct: 1, color: "green", admin: true },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 7);
  assert.equal(parsed.snapshot.bands.length, 2);
  assert.equal(parsed.snapshot.bands[0].side, "short");
  assert.equal(parsed.snapshot.bands[1].side, "short");
  assert.equal(parsed.snapshot.bands[1].liq_m, 4);
  assert.deepEqual(Object.keys(parsed.snapshot.bands[1]), ["lo", "hi", "side", "liq_m", "risk", "dist_pct"]);
});

test("ignores privilege query flags and withholds bands when the symbol does not match", () => {
  const forged = parseLiqHeatmapQuery(new URL("http://localhost/api/liq-heatmap?symbol=../etc/passwd&admin=1"));
  assert.deepEqual(forged, { ok: false, error: "Use a compact perpetual symbol such as ZECUSDT" });
  const missing = parseLiqHeatmapQuery(new URL("http://localhost/api/liq-heatmap?admin=1"));
  assert.equal(missing.ok, false);

  const plain = parseLiqHeatmapQuery(new URL("http://localhost/api/liq-heatmap?symbol=ZECUSDT"));
  const flagged = parseLiqHeatmapQuery(new URL("http://localhost/api/liq-heatmap?symbol=ZEC/USDT&admin=1&entitled=true&role=admin&hasMarketHistory=1&liqSample=1"));
  assert.deepEqual(plain, { ok: true, symbol: "ZECUSDT", sample: false });
  assert.deepEqual(flagged, { ok: true, symbol: "ZECUSDT", sample: true });
  assert.equal(JSON.stringify(flagged).includes("admin"), false);

  const mismatch = buildLiqHeatmapPayload("BTCUSDT", { ...sample, admin: true, role: "admin" });
  assert.equal(mismatch.ok, true);
  if (!mismatch.ok) return;
  assert.equal(mismatch.status, 200);
  assert.deepEqual(mismatch.body.bands, []);
  assert.equal(mismatch.body.notice, LIQ_HEATMAP_SYMBOL_NOTICE);
  assert.equal(mismatch.body.admin, undefined);

  const matched = buildLiqHeatmapPayload("ZEC", { ...sample, entitled: true, hasMarketHistory: true });
  assert.equal(matched.ok, true);
  if (!matched.ok) return;
  assert.equal(matched.body.bands.length, 13);
  assert.equal(matched.body.symbol, "ZECUSDT");
  assert.equal(matched.body.notice, null);
  assert.equal(matched.body.entitled, undefined);
  assert.equal(buildLiqHeatmapPayload("ZECUSDT", { ...sample, kind: "walls" }).ok, false);
});

test("matches ZEC compact symbols and refuses other charts before any fetch", async () => {
  assert.equal(chartSupportsLiqSample("ZECUSDT"), true);
  assert.equal(chartSupportsLiqSample("zec/usdt"), true);
  assert.equal(chartSupportsLiqSample("ZEC-USDT-SWAP"), true);
  assert.equal(chartSupportsLiqSample("ZEC"), true);
  assert.equal(liqSymbolsMatch("ZEC", "ZECUSDT"), true);
  assert.equal(chartSupportsLiqSample("BTCUSDT"), false);
  assert.equal(chartSupportsLiqSample("ZEC1USDT"), false);

  let calls = 0;
  const skipped = await loadLiqHeatmapBands("BTCUSDT", async () => {
    calls += 1;
    throw new Error("fetch should not run");
  }, { sample: true });
  assert.equal(calls, 0);
  assert.deepEqual(skipped.bands, []);
  assert.equal(skipped.notice, LIQ_HEATMAP_SYMBOL_NOTICE);

  const loaded = await loadLiqHeatmapBands("ZEC", async (url) => {
    calls += 1;
    assert.equal(url, "/api/liq-heatmap?symbol=ZEC&liqSample=1");
    assert.equal(String(url).includes("admin"), false);
    return Response.json({
      ...sample,
      admin: true,
      role: "admin",
      bands: [
        ...sample.bands,
        { lo: 1, hi: 2, side: "ask", liq_m: 9, risk: "极高", dist_pct: 0 },
      ],
    });
  }, { sample: true });
  assert.equal(calls, 1);
  assert.equal(loaded.bands.length, 13);
  assert.equal(loaded.notice, null);
  assert.ok(loaded.bands.every((band) => band.risk === "极高" && (band.side === "long" || band.side === "short")));

  const relabeled = await loadLiqHeatmapBands("ZECUSDT", async () => Response.json({
    ...sample,
    symbol: "BTCUSDT",
    admin: true,
  }));
  assert.deepEqual(relabeled.bands, []);
  assert.equal(relabeled.notice, LIQ_HEATMAP_SYMBOL_NOTICE);

  const rejected = await loadLiqHeatmapBands("ZECUSDT", async () => Response.json({ ...sample, kind: "client_pack" }));
  assert.deepEqual(rejected.bands, []);
  assert.match(rejected.notice, /kind/);
});

test("pins heatmap zones to true lo/hi and does not apply the wall pixel-gap shifter", () => {
  const bands = [
    { lo: 100, hi: 101, side: "long", liq_m: 10, risk: "极高", dist_pct: -1 },
    { lo: 101, hi: 102, side: "short", liq_m: 40, risk: "极高", dist_pct: 1 },
  ];
  const priceToY = (price) => 1000 - price;
  const placed = placeLiqHeatmapBands(bands, priceToY);
  assert.equal(placed.length, 2);
  const longBand = placed.find((band) => band.band.side === "long");
  const shortBand = placed.find((band) => band.band.side === "short");
  assert.ok(longBand && shortBand);
  assert.equal(longBand.top, priceToY(101));
  assert.equal(longBand.height, 1);
  assert.equal(shortBand.top, priceToY(102));
  assert.equal(shortBand.height, 1);
  const centerGap = Math.abs((longBand.top + longBand.height / 2) - (shortBand.top + shortBand.height / 2));
  assert.equal(centerGap, 1);
  assert.ok(centerGap < MIN_WALL_CENTER_GAP_PX);

  const shifted = layoutSeparatedWalls(visualWallBands([
    { side: "bid", price: 100.5, low: 100, high: 101, size: 1, notional: 10 },
    { side: "ask", price: 101.5, low: 101, high: 102, size: 1, notional: 40 },
  ]), priceToY);
  const shiftedGap = Math.abs(shifted[0].centerY - shifted[1].centerY);
  assert.ok(shiftedGap >= MIN_WALL_CENTER_GAP_PX);
  assert.notEqual(shiftedGap, centerGap);

  const zoomed = placeLiqHeatmapBands([bands[0]], (price) => 1000 - price * 4);
  assert.equal(zoomed[0].top, 1000 - 101 * 4);
  assert.equal(zoomed[0].height, 4);
  assert.equal(placeLiqHeatmapBands(bands, () => null).length, 0);
});

test("colors long liquidation red and short liquidation green, with log opacity", () => {
  assert.ok(liqBandFillStyle("long", 0.2).includes(LIQ_LONG_RGB));
  assert.ok(liqBandFillStyle("short", 0.2).includes(LIQ_SHORT_RGB));
  assert.doesNotMatch(liqBandFillStyle("long", 0.2), /83,\s*201,\s*144/);
  assert.doesNotMatch(liqBandFillStyle("short", 0.2), /231,\s*103,\s*112/);
  assert.notEqual(liqBandFillStyle("long", 0.2), wallFillStyle({ side: "bid", opacity: 0.2 }));
  assert.notEqual(liqBandFillStyle("short", 0.2), wallFillStyle({ side: "ask", opacity: 0.2 }));

  const parsed = sanitizeLiqHeatmapSnapshot(sample);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const opacities = liqBandOpacities(parsed.snapshot.bands);
  const ranked = parsed.snapshot.bands.map((band, index) => ({ liq: band.liq_m, opacity: opacities[index] }))
    .sort((left, right) => left.liq - right.liq);
  for (let index = 1; index < ranked.length; index += 1) {
    assert.ok(ranked[index].opacity >= ranked[index - 1].opacity);
  }
  assert.ok(ranked.at(-1).opacity > ranked[0].opacity);
  assert.ok(ranked[0].opacity >= 0.16 && ranked.at(-1).opacity <= 0.46);
  const hit = findLiqBandAtPrice(parsed.snapshot.bands, 1523.808);
  assert.equal(hit?.liq_m, 234.04);
  assert.equal(hit?.side, "short");
});

test("keeps the heatmap toggle independent and off until the user enables it", () => {
  const storage = memoryStorage({ [LIQ_HEATMAP_STORAGE_KEY]: "0", "th-large-order-sr": "1", "th-large-trades": "1" });
  assert.equal(readStoredFlag(storage, LIQ_HEATMAP_STORAGE_KEY, false), false);
  assert.equal(readStoredFlag(storage, "th-large-order-sr", false), true);
  writeStoredFlag(storage, LIQ_HEATMAP_STORAGE_KEY, true);
  assert.equal(readStoredFlag(storage, LIQ_HEATMAP_STORAGE_KEY), true);
  assert.equal(storage.getItem("th-large-order-sr"), "1");

  const workspace = readFileSync(fileURLToPath(new URL("../app/trading-workspace.tsx", import.meta.url)), "utf8");
  const toolbar = readFileSync(fileURLToPath(new URL("../components/drawing-toolbar.tsx", import.meta.url)), "utf8");
  const primitive = readFileSync(fileURLToPath(new URL("../lib/liq-heatmap-primitive.ts", import.meta.url)), "utf8");
  const route = readFileSync(fileURLToPath(new URL("../app/api/liq-heatmap/route.ts", import.meta.url)), "utf8");
  assert.match(toolbar, /data-icon="liq-heatmap"/);
  assert.match(toolbar, /Show liquidation heatmap/);
  assert.match(toolbar, /Hide liquidation heatmap/);
  assert.doesNotMatch(toolbar.slice(toolbar.indexOf("data-icon=\"liq-heatmap\""), toolbar.indexOf("Chart settings")), /data-icon="large-order-sr"|data-icon="large-trades"/);
  assert.match(workspace, /LIQ_HEATMAP_STORAGE_KEY/);
  assert.match(workspace, /onLiqHeatmapToggle=\{\(\) => setShowLiqHeatmap\(\(value\) => !value\)\}/);
  assert.match(workspace, /data-liq-heatmap=/);
  assert.match(workspace, /LiqHeatmapPrimitive/);
  assert.match(workspace, /loadLiqHeatmapBands\(symbol, fetch, \{ sample \}\)/);
  assert.match(workspace, /liqSample/);
  assert.match(workspace, /if \(!showLiqHeatmap\) return;/);
  assert.match(workspace, /liqSymbolsMatch\(liqModel\.symbol, symbol\)/);
  assert.doesNotMatch(primitive, /layoutSeparatedWalls|market-depth/);
  assert.match(primitive, /priceToCoordinate/);
  assert.match(primitive, /placeLiqHeatmapBands/);
  assert.match(route, /liq_heatmap_bands\.sample\.json/);
  assert.doesNotMatch(route, /fetch\(|request\.json\(/);
});
