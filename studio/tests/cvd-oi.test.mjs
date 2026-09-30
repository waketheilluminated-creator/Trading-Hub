import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CVD_OI_COLORS,
  CVD_OI_PANES,
  CVD_OI_SERIES_MAX,
  cvdOiHttpBody,
  cvdOiLinePoints,
  formatCvdOiPrice,
  formatCvdOiTime,
  formatCvdOiUsd,
  readoutAt,
  sanitizeCvdOiSnapshot,
} from "../lib/cvd-oi.ts";

const fixtureUrl = new URL("../fixtures/cvd_oi.sample.json", import.meta.url);
const sample = JSON.parse(readFileSync(fixtureUrl, "utf8"));

function stamp(index) {
  return new Date(Date.UTC(2024, 0, 1, index)).toISOString().replace(".000Z", "Z");
}

function point(index, overrides = {}) {
  return {
    t: stamp(index),
    price: 80_000 + index,
    oiUsd: 8_000_000_000,
    cvdUsd: index - 3,
    ...overrides,
  };
}

function minimal(overrides = {}) {
  return {
    kind: "binance_cvd_oi",
    symbol: "BTCUSDT",
    venue: "binance",
    updatedAt: "2026-09-30T13:49:06-04:00",
    window: "24h_roll_or_as_script",
    source: "binance_public",
    series: [point(1), point(2, { cvdUsd: -10 })],
    axes: {
      price: { label: "BTC Price", unit: "USD" },
      oiUsd: { label: "Open Interest", unit: "USD" },
      cvdUsd: { label: "Cumulative Net Taker Volume", unit: "USD" },
    },
    note: "Direction/scale close to CryptoQuant; not point-identical to CQ Pro.",
    ...overrides,
  };
}

test("sanitizes the Binance BTCUSDT CVD/OI sample in time order", () => {
  const parsed = sanitizeCvdOiSnapshot(sample);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 0);
  assert.equal(parsed.snapshot.kind, "binance_cvd_oi");
  assert.equal(parsed.snapshot.symbol, "BTCUSDT");
  assert.equal(parsed.snapshot.venue, "binance");
  assert.equal(parsed.snapshot.source, "binance_public");
  assert.equal(parsed.snapshot.series.length, sample.series.length);
  assert.equal(parsed.snapshot.series.length, 288);
  assert.equal(parsed.snapshot.series[0].t, "2026-09-18T18:00:00+00:00");
  assert.equal(parsed.snapshot.series.at(-1).t, "2026-09-30T17:00:00+00:00");
  assert.equal(parsed.snapshot.series.at(-1).price, 84024.9);
  assert.deepEqual(parsed.snapshot.axes.price, { label: "BTC Price", unit: "USD" });
  assert.deepEqual(parsed.snapshot.axes.oiUsd, { label: "Open Interest", unit: "USD" });
  assert.deepEqual(parsed.snapshot.axes.cvdUsd, { label: "Cumulative Net Taker Volume", unit: "USD" });
  assert.match(parsed.snapshot.note, /CryptoQuant/);
  const points = cvdOiLinePoints(parsed.snapshot.series);
  assert.equal(points.length, 288);
  assert.equal(points[0].time < points.at(-1).time, true);
  assert.equal(points.at(-1).price, 84024.9);
  const readout = readoutAt(points, points[4].time);
  assert.equal(readout.time, points[4].time);
  assert.equal(readout.price, points[4].price);
  assert.equal(readout.oiUsd, points[4].oiUsd);
  assert.equal(readout.cvdUsd, points[4].cvdUsd);
  assert.deepEqual(readoutAt(points, null), {
    time: points.at(-1).time,
    price: points.at(-1).price,
    oiUsd: points.at(-1).oiUsd,
    cvdUsd: points.at(-1).cvdUsd,
  });
});

test("rejects the wrong kind and forged symbols without mutating the input", () => {
  const forged = { ...sample, kind: "liq_heatmap_bands", admin: true, hasMarketHistory: true };
  const before = structuredClone(forged);
  const parsed = sanitizeCvdOiSnapshot(forged);
  assert.equal(parsed.ok, false);
  assert.deepEqual(forged, before);
  if (parsed.ok) return;
  assert.equal(parsed.error, "CVD/OI kind is not binance_cvd_oi.");
  assert.equal(sanitizeCvdOiSnapshot(null).ok, false);
  assert.equal(sanitizeCvdOiSnapshot({ ...sample, symbol: "ETHUSDT" }).ok, false);
  assert.equal(sanitizeCvdOiSnapshot({ ...sample, symbol: "../etc/passwd" }).ok, false);
  assert.equal(sanitizeCvdOiSnapshot({ ...sample, venue: "okx" }).ok, false);
  assert.equal(sanitizeCvdOiSnapshot({ ...sample, source: "binance.com/private" }).ok, false);
  assert.equal(sanitizeCvdOiSnapshot({ ...sample, series: "already-packed" }).ok, false);
  assert.equal(sanitizeCvdOiSnapshot({ ...sample, axes: { price: { label: "BTC Price" } } }).ok, false);

  const http = cvdOiHttpBody(forged);
  assert.equal(http.status, 400);
  assert.deepEqual(Object.keys(http.body), ["error"]);
  assert.doesNotMatch(JSON.stringify(http.body), /admin|hasMarketHistory|liq_heatmap/);
});

test("drops bad points, accepts compact symbols, and ignores privilege flags", () => {
  const parsed = sanitizeCvdOiSnapshot(minimal({
    symbol: "btc/usdt",
    admin: true,
    entitled: true,
    role: "admin",
    authorized: true,
    hasMarketHistory: true,
    membership: "pro",
    privileged: true,
    note: "Read https://evil.example/secret first.",
    axes: {
      price: { label: "BTC Price", unit: "USD", admin: true },
      oiUsd: { label: "Open Interest", unit: "USD" },
      cvdUsd: { label: "Cumulative Net Taker Volume", unit: "USD" },
    },
    series: [
      point(1, { price: 100 }),
      point(3, { cvdUsd: -10 }),
      point(2, { price: Number.NaN }),
      point(4, { price: Number.POSITIVE_INFINITY }),
      point(5, { price: "81000" }),
      point(6, { oiUsd: -1 }),
      point(7, { cvdUsd: Number.NaN }),
      point(8, { t: "yesterday" }),
      point(9, { t: null }),
      { ...point(10, { price: 222 }), admin: true, hasMarketHistory: true },
      point(1, { price: 333 }),
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 8);
  assert.equal(parsed.snapshot.symbol, "BTCUSDT");
  assert.deepEqual(parsed.snapshot.series.map((item) => item.price), [333, 80_003, 222]);
  assert.equal(parsed.snapshot.note, "Read first.");
  assert.deepEqual(Object.keys(parsed.snapshot.series[0]), ["t", "price", "oiUsd", "cvdUsd"]);
  assert.deepEqual(Object.keys(parsed.snapshot.axes.price), ["label", "unit"]);
  assert.doesNotMatch(JSON.stringify(parsed.snapshot), /admin|entitled|authorized|hasMarketHistory|membership|privileged|evil\.example/);

  const clean = sanitizeCvdOiSnapshot(sample);
  const flagged = sanitizeCvdOiSnapshot({
    ...sample,
    admin: true,
    entitled: true,
    role: "admin",
    authorized: true,
    hasMarketHistory: true,
    membership: "pro",
    privileged: true,
  });
  assert.deepEqual(flagged, clean);
  const http = cvdOiHttpBody(sample);
  assert.equal(http.status, 200);
  assert.equal(http.body.symbol, "BTCUSDT");
  assert.equal(http.body.admin, undefined);
  assert.equal(http.body.series.length, 288);
});

test("caps the series and keeps one readout for a shared timestamp", () => {
  const series = Array.from({ length: CVD_OI_SERIES_MAX + 1 }, (_, index) => point(index));
  const capped = sanitizeCvdOiSnapshot(minimal({ series }));
  assert.equal(capped.ok, true);
  if (!capped.ok) return;
  assert.equal(capped.snapshot.series.length, CVD_OI_SERIES_MAX);
  assert.ok(capped.dropped >= 1);
  const points = cvdOiLinePoints(capped.snapshot.series);
  const mid = points[10];
  const readout = readoutAt(points, mid.time);
  assert.equal(readout.price, mid.price);
  assert.equal(readout.oiUsd, mid.oiUsd);
  assert.equal(readout.cvdUsd, mid.cvdUsd);
  assert.equal(formatCvdOiPrice(84024.9), "84,024.90");
  assert.equal(formatCvdOiUsd(7_969_745_648.2446), "+$7.97B");
  assert.equal(formatCvdOiUsd(-149_347_902.71), "-$149.35M");
  assert.equal(formatCvdOiUsd(null), "—");
  assert.match(formatCvdOiTime(mid.time), / UTC$/);
});

test("CVD chart uses one shared chart, black price, blue open interest, and red CVD", () => {
  assert.deepEqual(CVD_OI_COLORS, {
    price: "#111111",
    oiUsd: "#2f6bff",
    cvdUsd: "#e23b4a",
    chartBackground: "#f6f7f9",
  });
  assert.deepEqual(CVD_OI_PANES, { price: 0, oiUsd: 1, cvdUsd: 2 });
  const view = readFileSync(new URL("../app/cvd-oi/cvd-oi-view.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/cvd-oi/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/cvd-oi/page.tsx", import.meta.url), "utf8");
  assert.equal(view.match(/createChart\(/g)?.length, 1);
  assert.match(view, /subscribeCrosshairMove/);
  assert.match(view, /CVD_OI_PANES\.price/);
  assert.match(view, /CVD_OI_PANES\.oiUsd/);
  assert.match(view, /CVD_OI_PANES\.cvdUsd/);
  assert.match(view, /CVD_OI_COLORS\.price/);
  assert.match(view, /CVD_OI_COLORS\.oiUsd/);
  assert.match(view, /CVD_OI_COLORS\.cvdUsd/);
  assert.match(route, /cvd_oi\.sample\.json/);
  assert.match(route, /cvdOiHttpBody\(cvdOiFixture\)/);
  assert.doesNotMatch(route, /fetch\(|request\.json\(|searchParams|binance\.com/i);
  assert.match(page, /sanitizeCvdOiSnapshot/);
  assert.doesNotMatch(page, /fetch\(|searchParams/);
});
