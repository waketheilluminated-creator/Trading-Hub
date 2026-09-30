import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CEX_NETFLOW_COLORS,
  CEX_NETFLOW_EN_LABEL,
  CEX_NETFLOW_SERIES_MAX,
  CEX_NETFLOW_SIGNAL_RULE,
  CEX_NETFLOW_WATERMARK,
  CEX_NETFLOW_ZH_LABEL,
  cexNetflowChartPoints,
  cexNetflowHttpBody,
  flowLineData,
  formatBtcPrice,
  formatReserveBtc,
  formatSignal,
  formatUpdatedAt,
  maLineData,
  priceLineData,
  readoutAt,
  regimeBands,
  sanitizeCexNetflowSnapshot,
  showProxyWatermark,
} from "../lib/cex-netflow.ts";

const BANNED = /CryptoQuant|Inter-exchange Flow Pulse|\bIFP\b/;
const fixtureUrl = new URL("../fixtures/cex_netflow.sample.json", import.meta.url);
const sample = JSON.parse(readFileSync(fixtureUrl, "utf8"));

function day(index) {
  return new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
}

function point(date, overrides = {}) {
  return {
    t: date,
    flowBtc: 2_700_000,
    flowMa90: 2_680_000,
    priceUsd: 80_000,
    signal: "bear",
    dailyNetBtc: 10,
    ...overrides,
  };
}

function minimal(overrides = {}) {
  return {
    kind: "btc_cex_netflow",
    title: "Bitcoin: Exchange Net Flow Pulse (proxy)",
    updatedAt: "2026-09-30T19:05:35Z",
    source: "coinmetrics_community:SplyExNtv+PriceUSD",
    maWindowDays: 90,
    disclaimer: "Aggregate CEX reserve proxy only.",
    series: [point("2026-09-28", { flowBtc: 2_600_000, flowMa90: null, signal: "bull" }), point("2026-09-29")],
    axes: {
      flowBtc: { label: "CEX net flow / reserve proxy", unit: "BTC", meaning: "not IFP" },
      priceUsd: { label: "BTC Price", unit: "USD" },
    },
    signalRule: "mirrors IFP-style CryptoQuant shading",
    meta: { provider: "https://community-api.coinmetrics.io/v4", metrics: ["SplyExNtv", "nope", "PriceUSD"] },
    ...overrides,
  };
}

test("sanitizes the exchange reserve sample and recomputes the regime", () => {
  const parsed = sanitizeCexNetflowSnapshot(sample);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 0);
  assert.equal(parsed.snapshot.kind, "btc_cex_netflow");
  assert.equal(parsed.snapshot.title, "Bitcoin: Exchange Net Flow Pulse (proxy)");
  assert.equal(parsed.snapshot.updatedAt, "2026-09-30T19:05:35Z");
  assert.equal(parsed.snapshot.source, "coinmetrics_community:SplyExNtv+PriceUSD");
  assert.equal(parsed.snapshot.maWindowDays, 90);
  assert.equal(parsed.snapshot.disclaimer, sample.disclaimer);
  assert.match(parsed.snapshot.disclaimer, /Not CryptoQuant Inter-exchange Flow Pulse\./);
  assert.equal(parsed.snapshot.signalRule, CEX_NETFLOW_SIGNAL_RULE);
  assert.notEqual(parsed.snapshot.signalRule, sample.signalRule);
  assert.deepEqual(parsed.snapshot.axes.flowBtc, { label: "CEX net flow / reserve proxy", unit: "BTC" });
  assert.deepEqual(parsed.snapshot.axes.priceUsd, { label: "BTC Price", unit: "USD" });
  assert.equal("meaning" in parsed.snapshot.axes.flowBtc, false);
  assert.equal(parsed.snapshot.series.length, 303);
  assert.equal(parsed.snapshot.series[0].t, "2025-12-01");
  assert.equal(parsed.snapshot.series[0].flowMa90, null);
  assert.equal(parsed.snapshot.series[0].signal, "bear");
  assert.equal(parsed.snapshot.series.at(-1).t, "2026-09-29");
  assert.equal(parsed.snapshot.series.at(-1).flowBtc, 2686232.3669);
  assert.equal(parsed.snapshot.series.at(-1).flowMa90, 2685686.3964);
  assert.equal(parsed.snapshot.series.at(-1).priceUsd, 83674.66);
  assert.equal(parsed.snapshot.series.at(-1).signal, "bull");
  assert.equal(parsed.snapshot.series.at(-1).dailyNetBtc, 1869.0399);
  assert.deepEqual(parsed.snapshot.meta, {
    start: "2025-12-01",
    end: "2026-09-29",
    nSeries: 303,
    maReadyFrom: "2026-02-28",
    metrics: ["SplyExNtv", "PriceUSD", "FlowInExNtv", "FlowOutExNtv"],
  });
  assert.equal(parsed.snapshot.meta.provider, undefined);
  const { disclaimer, ...rest } = parsed.snapshot;
  assert.equal(disclaimer, sample.disclaimer);
  assert.doesNotMatch(JSON.stringify(rest), BANNED);
  assert.doesNotMatch(JSON.stringify(parsed.snapshot), /https?:\/\/|community-api/);

  const points = cexNetflowChartPoints(parsed.snapshot.series);
  assert.equal(points.length, 303);
  assert.equal(points[0].time < points.at(-1).time, true);
  assert.equal(points.at(-1).date, "2026-09-29");
  assert.equal(flowLineData(points).at(-1).value, 2686232.3669);
  assert.equal(maLineData(points)[0].value, points.find((point) => point.date === "2026-02-28").flowMa90);
  assert.equal(maLineData(points).length, points.filter((point) => point.flowMa90 != null).length);
  assert.equal(priceLineData(points).at(-1).value, 83674.66);
  assert.equal(JSON.stringify(flowLineData(points)).includes("dailyNet"), false);
  assert.equal(JSON.stringify(maLineData(points)).includes("dailyNet"), false);
  assert.equal(JSON.stringify(priceLineData(points)).includes("dailyNet"), false);
  const bands = regimeBands(points);
  const byTime = new Map(points.map((point) => [point.time, point.date]));
  assert.deepEqual(bands.map((band) => [byTime.get(band.from), band.signal]), [
    ["2025-12-01", "bear"],
    ["2026-02-28", "bull"],
    ["2026-03-02", "bear"],
    ["2026-05-22", "bull"],
    ["2026-09-26", "bear"],
    ["2026-09-29", "bull"],
  ]);
  assert.equal(bands.at(-1).to, null);
  for (let index = 1; index < bands.length; index += 1) assert.equal(bands[index].from, bands[index - 1].to);
  const readout = readoutAt(points, null);
  assert.equal(readout.signal, "bull");
  assert.equal(readout.flowBtc, 2686232.3669);
  assert.equal(formatReserveBtc(readout.flowBtc), "2.686M BTC");
  assert.equal(formatBtcPrice(readout.priceUsd), "$83,674.66");
  assert.equal(formatSignal("bull"), "Bull");
  assert.equal(formatSignal("bear"), "Bear");
  assert.equal(formatSignal(null), "—");
  assert.equal(formatUpdatedAt(parsed.snapshot.updatedAt), "2026-09-30 19:05:35 UTC");
  assert.equal(showProxyWatermark(parsed.snapshot), true);
  assert.equal(CEX_NETFLOW_ZH_LABEL, "交易所净流/储备脉搏");
  assert.equal(CEX_NETFLOW_EN_LABEL, "CEX reserve proxy (CoinMetrics)");
  assert.equal(CEX_NETFLOW_WATERMARK, "non-CQ / experimental proxy");
});

test("rejects the wrong kind and malformed snapshots without mutating the input", () => {
  const forged = { ...sample, kind: "btc_ifp", admin: true, entitled: true, hasMarketHistory: true };
  const before = structuredClone(forged);
  const parsed = sanitizeCexNetflowSnapshot(forged);
  assert.equal(parsed.ok, false);
  assert.deepEqual(forged, before);
  if (parsed.ok) return;
  assert.equal(parsed.error, "Exchange net flow kind is not btc_cex_netflow.");
  assert.doesNotMatch(parsed.error, BANNED);
  assert.equal(sanitizeCexNetflowSnapshot(null).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot([]).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, kind: "CryptoQuant" }).ok, false);
  assert.doesNotMatch(sanitizeCexNetflowSnapshot({ ...sample, kind: "CryptoQuant" }).error, BANNED);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, series: "already-packed" }).error, "Exchange net flow series is missing.");
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, series: { admin: true } }).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, maWindowDays: 30 }).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, maWindowDays: "90" }).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, title: "IFP" }).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, disclaimer: "   " }).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, source: "https://evil.example/secret" }).ok, false);
  assert.equal(sanitizeCexNetflowSnapshot({ ...sample, axes: { flowBtc: { label: "CEX net flow / reserve proxy" } } }).ok, false);

  const http = cexNetflowHttpBody(forged);
  assert.equal(http.status, 400);
  assert.deepEqual(Object.keys(http.body), ["error"]);
  assert.doesNotMatch(JSON.stringify(http.body), BANNED);
  assert.doesNotMatch(JSON.stringify(http.body), /admin|btc_ifp|hasMarketHistory/);
  assert.equal(cexNetflowHttpBody(null).status, 400);
});

test("drops bad rows, corrects forged regimes, and ignores privilege flags", () => {
  const parsed = sanitizeCexNetflowSnapshot(minimal({
    admin: true,
    entitled: true,
    role: "admin",
    authorized: true,
    hasMarketHistory: true,
    membership: "pro",
    privileged: true,
    title: "Exchange IFP Pulse (proxy)",
    source: "coinmetrics_community:SplyExNtv+PriceUSD",
    disclaimer: "See https://evil.example/secret before close.",
    series: [
      point("2026-09-29", { signal: "bear", admin: true, flowBtc: 2_700_000, flowMa90: 2_680_000 }),
      point("2026-09-28", { flowMa90: null, signal: "bull", priceUsd: null, dailyNetBtc: undefined }),
      point("2026-09-27", { flowBtc: Number.NaN }),
      point("2026-09-26", { flowBtc: Number.POSITIVE_INFINITY }),
      point("2026-09-25", { flowBtc: "2700000" }),
      point("2026-09-24", { flowBtc: -1 }),
      point("2026-09-23", { flowMa90: "nope" }),
      point("2026-09-22", { priceUsd: Number.NaN }),
      point("2026-09-21", { dailyNetBtc: Number.NaN }),
      point("2026-09-20", { dailyNetBtc: "12" }),
      point("2026-02-31"),
      point("09-19-2026"),
      { flowBtc: 1, flowMa90: 1, priceUsd: 1 },
      null,
      ["2026-09-18"],
      point("2026-09-29", { flowBtc: 2_710_000, priceUsd: 81_000, dailyNetBtc: -4 }),
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 14);
  assert.equal(parsed.snapshot.title, "Exchange Pulse (proxy)");
  assert.equal(parsed.snapshot.disclaimer, "See before close.");
  assert.doesNotMatch(parsed.snapshot.disclaimer, /https?:\/\/|evil\.example/);
  assert.deepEqual(parsed.snapshot.series.map((item) => item.t), ["2026-09-28", "2026-09-29"]);
  assert.equal(parsed.snapshot.series[0].signal, "bear");
  assert.equal(parsed.snapshot.series[0].flowMa90, null);
  assert.equal(parsed.snapshot.series[0].priceUsd, null);
  assert.equal(parsed.snapshot.series[0].dailyNetBtc, undefined);
  assert.equal(parsed.snapshot.series[1].signal, "bull");
  assert.equal(parsed.snapshot.series[1].flowBtc, 2_710_000);
  assert.equal(parsed.snapshot.series[1].dailyNetBtc, -4);
  assert.deepEqual(Object.keys(parsed.snapshot.series[1]), ["t", "flowBtc", "flowMa90", "priceUsd", "signal", "dailyNetBtc"]);
  assert.deepEqual(parsed.snapshot.axes.flowBtc, { label: "CEX net flow / reserve proxy", unit: "BTC" });
  assert.deepEqual(parsed.snapshot.meta.metrics, ["SplyExNtv", "PriceUSD"]);
  assert.equal(parsed.snapshot.meta.nSeries, 2);
  assert.doesNotMatch(JSON.stringify(parsed.snapshot), /admin|entitled|authorized|hasMarketHistory|membership|privileged|evil\.example|\bIFP\b|CryptoQuant/);
  assert.equal(showProxyWatermark({ title: "Reserve", source: "desk" }), false);
  assert.equal(priceLineData(cexNetflowChartPoints(parsed.snapshot.series)).length, 1);

  const clean = sanitizeCexNetflowSnapshot(sample);
  const flagged = sanitizeCexNetflowSnapshot({
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
  const http = cexNetflowHttpBody(parsed.snapshot);
  assert.equal(http.status, 200);
  assert.equal(http.body.admin, undefined);
  assert.equal(http.body.series.length, 2);
  assert.equal(http.body.series.at(-1).signal, "bull");
});

test("keeps the latest duplicate day and caps the series", () => {
  const replaced = sanitizeCexNetflowSnapshot(minimal({
    series: [point("2026-09-29", { flowBtc: 1 }), point("2026-09-29", { flowBtc: 9, flowMa90: 4 })],
  }));
  assert.equal(replaced.ok, true);
  if (!replaced.ok) return;
  assert.equal(replaced.dropped, 1);
  assert.equal(replaced.snapshot.series.length, 1);
  assert.equal(replaced.snapshot.series[0].flowBtc, 9);
  assert.equal(replaced.snapshot.series[0].signal, "bull");

  const series = Array.from({ length: CEX_NETFLOW_SERIES_MAX + 2 }, (_, index) => point(day(index), { flowBtc: index + 1 }));
  series.push(point(day(0), { flowBtc: 42, flowMa90: 10 }));
  const capped = sanitizeCexNetflowSnapshot(minimal({ series }));
  assert.equal(capped.ok, true);
  if (!capped.ok) return;
  assert.equal(capped.snapshot.series.length, CEX_NETFLOW_SERIES_MAX);
  assert.ok(capped.dropped >= 2);
  assert.equal(capped.snapshot.series[0].t, day(0));
  assert.equal(capped.snapshot.series[0].flowBtc, 42);
  assert.equal(capped.snapshot.series[0].t < capped.snapshot.series.at(-1).t, true);
  assert.equal(regimeBands([]).length, 0);
  assert.equal(formatReserveBtc(null), "—");
  assert.equal(formatBtcPrice(null), "—");
});

test("chart page and route read only the sanitized reserve fixture", () => {
  assert.deepEqual(CEX_NETFLOW_COLORS, {
    flow: "#2f6bff",
    ma: "#2f6bff",
    price: "#111111",
    bull: "rgba(186, 220, 176, 0.72)",
    bear: "rgba(244, 186, 186, 0.72)",
    chartBackground: "#f6f7f9",
  });
  const view = readFileSync(new URL("../app/cex-netflow/cex-netflow-view.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/cex-netflow/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/cex-netflow/page.tsx", import.meta.url), "utf8");
  const bands = readFileSync(new URL("../lib/cex-netflow-bands.ts", import.meta.url), "utf8");
  const header = readFileSync(new URL("../components/desk-header.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../lib/cex-netflow.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const source of [view, route, page, bands, header, home, css]) {
    assert.doesNotMatch(source, BANNED);
    assert.doesNotMatch(source, /ifp\.sample|btc_ifp|href="\/ifp"/);
  }
  assert.match(lib, /function publicCopy/);
  assert.doesNotMatch(lib, /ifp\.sample|btc_ifp|href="\/ifp"/);
  assert.equal(view.match(/addSeries\(LineSeries/g)?.length, 3);
  assert.equal(view.match(/createChart\(/g)?.length, 1);
  assert.match(view, /LineStyle\.Dashed/);
  assert.match(view, /LineStyle\.Solid/);
  assert.match(view, /priceScaleId: "left"/);
  assert.match(view, /priceScaleId: "right"/);
  assert.match(view, /leftPriceScale/);
  assert.match(view, /rightPriceScale/);
  assert.match(view, /RegimeBandPrimitive/);
  assert.match(view, /regimeBands\(points\)/);
  assert.match(view, /flowLineData\(points\)/);
  assert.match(view, /maLineData\(points\)/);
  assert.match(view, /priceLineData\(points\)/);
  assert.match(view, /snapshot\.disclaimer/);
  assert.match(view, /snapshot\.axes\.flowBtc\.label/);
  assert.match(view, /snapshot\.axes\.priceUsd\.label/);
  assert.match(view, /\$\{snapshot\.maWindowDays\}d MA/);
  assert.match(view, /CEX_NETFLOW_ZH_LABEL/);
  assert.match(view, /CEX_NETFLOW_EN_LABEL/);
  assert.match(view, /CEX_NETFLOW_WATERMARK/);
  assert.match(view, /subscribeCrosshairMove/);
  assert.doesNotMatch(view, /dailyNetBtc|fetch\(|searchParams/);
  assert.match(route, /cex_netflow\.sample\.json/);
  assert.match(route, /cexNetflowHttpBody\(cexNetflowFixture\)/);
  assert.doesNotMatch(route, /fetch\(|request\.json\(|searchParams|coinmetrics\.io/i);
  assert.match(page, /sanitizeCexNetflowSnapshot/);
  assert.doesNotMatch(page, /fetch\(|searchParams/);
  assert.match(bands, /drawBackground/);
  assert.match(bands, /CEX_NETFLOW_COLORS\.bull/);
  assert.match(bands, /CEX_NETFLOW_COLORS\.bear/);
  assert.match(bands, /zOrder\(\): "bottom"/);
  assert.match(header, /\/cex-netflow/);
  assert.match(home, /href="\/cex-netflow"/);
  assert.match(home, /Exchange Net Flow Pulse \(proxy\)/);
});
