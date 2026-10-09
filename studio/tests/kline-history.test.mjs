import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CHART_BARS, MAX_KLINE_BARS, fetchVenueKlineHistory, klinePageUrl, mergeCandles, parseKlineQuery, withRateLimitRetry } from "../lib/kline-history.ts";
import { loadChartHistory, loadOlderCandles, mergeLiveCandle, normalizeBarCount, prependOlderCandles } from "../lib/market-feed.ts";
import { parseBarCountPref } from "../lib/bar-count-pref.ts";

const STEP = 900; // 15m in seconds
const LATEST = 1_790_000_100 - (1_790_000_100 % STEP);
const noSleep = async () => {};

// Simulated venue with `total` bars ending at LATEST. Returns rows in the venue's native shape/order.
function venueSim(venue, { total = 20_000, failAtCall = -1, rateLimitAtCall = -1, okxRecentOnly = 300, bitgetRecentWindow = Infinity } = {}) {
  const calls = [];
  const oldest = LATEST - (total - 1) * STEP;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const n = calls.length - 1;
    if (n === failAtCall) return new Response("upstream down", { status: 502 });
    if (n === rateLimitAtCall) return new Response("Too Many Requests", { status: 429 });
    const p = url.searchParams;
    const limit = Number(p.get("limit"));
    let endSec;
    if (venue === "okx") endSec = p.get("after") ? Math.floor((Number(p.get("after")) - 1) / 1000) : LATEST;
    else if (venue === "bitget") endSec = p.get("endTime") ? Math.ceil(Number(p.get("endTime")) / 1000) - 1 : LATEST; // exclusive
    else { const e = p.get("end") ?? p.get("endTime"); endSec = e ? Math.floor(Number(e) / 1000) : LATEST; }
    let top = Math.min(LATEST, endSec - (((endSec - oldest) % STEP) + STEP) % STEP);
    const isOkxRecent = venue === "okx" && url.pathname.endsWith("/candles");
    const isBitgetRecent = venue === "bitget" && url.pathname.endsWith("/candles");
    const rows = [];
    for (let t = top; t >= oldest && rows.length < limit; t -= STEP) {
      if (isOkxRecent && t <= LATEST - okxRecentOnly * STEP) break;
      if (isBitgetRecent && t <= LATEST - bitgetRecentWindow * STEP) break;
      rows.push([String(t * 1000), "1", "2", "0.5", "1.5", "10"]);
    }
    if (venue === "bybit") return Response.json({ retCode: 0, result: { list: rows } });
    if (venue === "okx") return Response.json({ code: "0", data: rows });
    if (venue === "bitget") return Response.json({ code: "00000", data: rows.reverse() });
    return Response.json(rows.reverse().map((r) => [Number(r[0]), ...r.slice(1)]));
  };
  return { calls, fetchImpl, oldest };
}

function assertContiguous(candles) {
  for (let i = 1; i < candles.length; i += 1) assert.equal(candles[i].time - candles[i - 1].time, STEP, `gap at ${i}`);
}

for (const venue of ["bybit", "binance", "okx", "bitget"]) {
  test(`${venue}: paginates to 5000 contiguous, deduped, ascending bars`, async () => {
    const sim = venueSim(venue, { bitgetRecentWindow: 1500 });
    const result = await fetchVenueKlineHistory(venue, "BTCUSDT", "15", { limit: 5000 }, sim.fetchImpl, noSleep);
    assert.equal(result.candles.length, 5000);
    assert.equal(result.candles.at(-1).time, LATEST);
    assertContiguous(result.candles);
    assert.equal(result.partial, false);
    assert.equal(result.exhausted, false);
    assert.ok(sim.calls.length <= Math.ceil(5000 / 200) + 2, `${sim.calls.length} calls`);
  });

  test(`${venue}: stops and flags exhausted when the venue has fewer bars`, async () => {
    const sim = venueSim(venue, { total: 1234, bitgetRecentWindow: 600, okxRecentOnly: 300 });
    const result = await fetchVenueKlineHistory(venue, "BTCUSDT", "15", { limit: 5000 }, sim.fetchImpl, noSleep);
    assert.equal(result.candles.length, 1234);
    assert.equal(result.candles[0].time, sim.oldest);
    assertContiguous(result.candles);
    assert.equal(result.exhausted, true);
  });

  test(`${venue}: honours an inclusive end bound for lazy-loading older bars`, async () => {
    const sim = venueSim(venue);
    const end = LATEST - 3000 * STEP;
    const result = await fetchVenueKlineHistory(venue, "BTCUSDT", "15", { limit: 1000, endTime: end }, sim.fetchImpl, noSleep);
    assert.equal(result.candles.length, 1000);
    assert.equal(result.candles.at(-1).time, end);
    assertContiguous(result.candles);
  });
}

test("a later page failure returns the bars already loaded as partial", async () => {
  const sim = venueSim("bybit", { failAtCall: 2 });
  const result = await fetchVenueKlineHistory("bybit", "BTCUSDT", "15", { limit: 5000 }, sim.fetchImpl, noSleep);
  assert.equal(result.candles.length, 2000);
  assert.equal(result.partial, true);
  assert.match(result.warning, /Loaded 2000 bars/);
  assertContiguous(result.candles);
});

test("a first-page failure throws so the client can fall back to another venue", async () => {
  const sim = venueSim("bybit", { failAtCall: 0 });
  await assert.rejects(fetchVenueKlineHistory("bybit", "BTCUSDT", "15", { limit: 5000 }, sim.fetchImpl, noSleep), (error) => error.status === 502 && error.venue === "bybit");
});

test("HTTP 429 pages are retried with backoff instead of truncating history", async () => {
  const sim = venueSim("bitget", { rateLimitAtCall: 3, bitgetRecentWindow: 1000 });
  const waits = [];
  const result = await fetchVenueKlineHistory("bitget", "BTCUSDT", "15", { limit: 5000 }, sim.fetchImpl, async (ms) => { waits.push(ms); });
  assert.equal(result.candles.length, 5000);
  assert.equal(result.partial, false);
  assert.ok(waits.includes(500));
  let attempts = 0;
  await assert.rejects(withRateLimitRetry(async () => { attempts += 1; throw Object.assign(new Error("x"), { status: 429 }); }, noSleep));
  assert.equal(attempts, 3);
});

test("limit is capped at MAX_KLINE_BARS even if a caller asks for more", async () => {
  const sim = venueSim("binance");
  const result = await fetchVenueKlineHistory("binance", "BTCUSDT", "15", { limit: 999_999 }, sim.fetchImpl, noSleep);
  assert.equal(result.candles.length, MAX_KLINE_BARS);
  assert.ok(sim.calls.every((url) => Number(new URL(url).searchParams.get("limit")) <= 1000));
});

test("page URLs use each venue's pagination parameter", () => {
  assert.match(klinePageUrl("bybit", "BTCUSDT", "15", 1000, 1700000000000), /&limit=1000&end=1700000000000$/);
  assert.match(klinePageUrl("binance", "BTCUSDT", "15", 1000, 1700000000000), /fapi\/v1\/klines\?.*&endTime=1700000000000$/);
  assert.match(klinePageUrl("binance", "BTCUSDT", "15", 1000, null, { host: "public-mirror" }), /data-api\.binance\.vision/);
  assert.match(klinePageUrl("okx", "BTCUSDT", "15", 300, null), /\/market\/candles\?instId=BTC-USDT-SWAP&bar=15m&limit=300$/);
  assert.match(klinePageUrl("okx", "BTCUSDT", "15", 300, 1700000000000), /\/market\/history-candles\?.*&after=1700000000001$/);
  assert.match(klinePageUrl("bitget", "BTCUSDT", "15", 200, 1700000000000, { mode: "history" }), /\/mix\/market\/history-candles\?.*&endTime=1700000000000$/);
});

test("parseKlineQuery validates limit and end strictly", () => {
  const now = 1_790_000_000;
  const q = (s) => parseKlineQuery(new URLSearchParams(s), now);
  assert.deepEqual(q(""), { limit: 300, endTime: null });
  assert.deepEqual(q("limit=5000"), { limit: 5000, endTime: null });
  assert.deepEqual(q("limit=9000"), { limit: MAX_KLINE_BARS, endTime: null });
  assert.deepEqual(q("limit=0"), { limit: 1, endTime: null });
  for (const bad of ["limit=-5", "limit=1e4", "limit=abc", "limit=50%26x=1", "limit=1.5", "limit=9999999"]) assert.ok("error" in q(bad), bad);
  assert.deepEqual(q("limit=1000&end=1700000000"), { limit: 1000, endTime: 1700000000 });
  for (const bad of ["end=1700000000000000", "end=abc", "end=-1", `end=${now + 2 * 86400}`, "end=17e8"]) assert.ok("error" in q(bad), bad);
});

test("klines route validates with parseKlineQuery and uses the paginated fetcher", () => {
  const route = readFileSync(new URL("../app/api/klines/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseKlineQuery\(url\.searchParams\)/);
  assert.match(route, /fetchVenueKlineHistory\(/);
  assert.match(route, /status: 400/);
});

test("client helpers: live merge keeps deep history, prepend dedupes, bar count is clamped", () => {
  const bars = Array.from({ length: 5000 }, (_, i) => ({ time: i * STEP }));
  const next = mergeLiveCandle(bars, { time: 5000 * STEP });
  assert.equal(next.length, 5001, "live ticks must not trim history back to 500");
  assert.equal(mergeLiveCandle(bars, { time: 5000 * STEP }, 100).length, 100);
  const merged = prependOlderCandles(bars.slice(10), [...bars.slice(0, 12)].reverse());
  assert.equal(merged.length, 5000);
  assert.deepEqual(merged.slice(0, 3).map((b) => b.time), [0, STEP, 2 * STEP]);
  assert.equal(prependOlderCandles(bars, [{ time: -STEP }], 1000).length, 1000);
  assert.equal(normalizeBarCount(undefined), DEFAULT_CHART_BARS);
  assert.equal(normalizeBarCount("abc"), DEFAULT_CHART_BARS);
  assert.equal(normalizeBarCount(99999), MAX_KLINE_BARS);
  assert.equal(normalizeBarCount(2000), 2000);
  assert.equal(parseBarCountPref("2000"), 2000);
  assert.equal(parseBarCountPref("1234"), DEFAULT_CHART_BARS);
  assert.equal(parseBarCountPref(null), DEFAULT_CHART_BARS);
  assert.deepEqual(mergeCandles([{ time: 2, close: 1 }], [{ time: 1 }, { time: 2, close: 9 }]), [{ time: 1 }, { time: 2, close: 9 }]);
});

test("loadChartHistory requests 5000 bars by default and forwards the bar setting", async () => {
  const urls = [];
  const fetchImpl = async (input) => {
    urls.push(String(input));
    return Response.json({ exchange: "bybit", source: "official", exhausted: false, candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] });
  };
  await loadChartHistory("bybit", "BTCUSDT", "15", fetchImpl);
  await loadChartHistory("bybit", "BTCUSDT", "15", fetchImpl, { limit: 2000 });
  assert.match(urls[0], /limit=5000/);
  assert.match(urls[1], /limit=2000/);
});

test("loadOlderCandles asks for bars strictly before the oldest loaded bar", async () => {
  let requested = "";
  const fetchImpl = async (input) => {
    requested = String(input);
    return Response.json({ candles: [{ time: 100 }, { time: 200 }, { time: 50 }], exhausted: false });
  };
  const result = await loadOlderCandles("okx", "BTCUSDT", "15", 200, 1000, fetchImpl);
  assert.match(requested, /exchange=okx&symbol=BTCUSDT&interval=15&limit=1000&end=199$/);
  assert.deepEqual(result.candles.map((c) => c.time), [50, 100]);
  assert.equal(result.exhausted, false);
  const empty = await loadOlderCandles("okx", "BTCUSDT", "15", 200, 1000, async () => Response.json({ candles: [] }));
  assert.equal(empty.exhausted, true);
});

test("workspace wires the bar setting, lazy-load and live merge cap", () => {
  const source = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /loadChartHistory\(chartVenue, symbol, interval, fetch, \{ limit: barCount \}\)/);
  assert.match(source, /subscribeVisibleLogicalRangeChange\(onRange\)/);
  assert.match(source, /unsubscribeVisibleLogicalRangeChange\(onRange\)/);
  assert.match(source, /aria-label="History bars"/);
  assert.match(source, /\}, \[symbol, interval, chartVenue, barCount\]\);/);
});
