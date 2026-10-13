import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { liqOverlayLeft, liqZoneAnchorTime, placeLiqHeatmapBands, placeLiqZones, sanitizeLiqHeatmapSnapshot } from "../lib/liq-heatmap.ts";

// Real output of `refresh_liq.py --symbol BTCUSDT` (TH-FEAT-12 any-symbol refresh path): 15 bands, 2 zones,
// asOf with a local UTC offset ("…T11:03:00-04:00"), boxStart "latest_candle".
const btc = JSON.parse(readFileSync(new URL("./fixtures/liq-any-symbol.BTCUSDT.json", import.meta.url), "utf8"));

test("TH-BUG-03: any-symbol BTC refresh snapshot anchors bands AND zones at the asOf candle, not the pane's left edge", () => {
  const result = sanitizeLiqHeatmapSnapshot(btc);
  assert.equal(result.ok, true);
  const snap = result.snapshot;
  assert.equal(snap.asOf, btc.asOf, "offset-form asOf survives sanitizing");
  assert.ok(snap.bands.length >= 10 && snap.zones.length >= 1);

  const asOfSec = Math.floor(Date.parse(btc.asOf) / 1000);
  const latest = Math.floor(asOfSec / 900) * 900 + 4 * 900;
  const bars = Array.from({ length: 200 }, (_, i) => latest - (199 - i) * 900); // 15m bars, seconds
  const anchor = liqZoneAnchorTime(bars, snap.asOf);
  assert.equal(anchor, Math.floor(asOfSec / 900) * 900, "anchor is the 15m bar containing asOf (seconds, not ms)");

  // Simulate the pane: bar i sits at x = i * 5px in a 1000px pane.
  const paneWidth = 1000;
  const anchorX = bars.indexOf(anchor) * 5;
  assert.ok(anchorX > 900, "anchor near the right side of the pane");
  const left = liqOverlayLeft(anchorX, paneWidth);
  assert.equal(left, anchorX, "bands start at the asOf candle");
  const priceToY = (p) => 500 - (p - snap.mid) / 10;
  assert.ok(placeLiqHeatmapBands(snap.bands, priceToY).length > 0);
  for (const zone of placeLiqZones(snap.zones, priceToY, anchorX, paneWidth)) {
    assert.equal(zone.left, anchorX);
    assert.equal(zone.width, paneWidth - anchorX);
  }
});

test("liqOverlayLeft clamps, and only falls back to full width without an anchor", () => {
  assert.equal(liqOverlayLeft(null, 800), 0);
  assert.equal(liqOverlayLeft(Number.NaN, 800), 0);
  assert.equal(liqOverlayLeft(-30, 800), 0);
  assert.equal(liqOverlayLeft(900, 800), 800);
  assert.equal(liqOverlayLeft(412.5, 800), 412.5);
});

test("band renderer and hit-test use the anchor instead of x = 0", () => {
  const src = readFileSync(new URL("../lib/liq-heatmap-primitive.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fillRect\(0,/);
  assert.match(src, /const left = liqOverlayLeft\(this\.getLatestX\(\), mediaSize\.width\);/);
  assert.match(src, /if \(left != null && x < left\) return null;\s*const band = bandAtY/);
});
