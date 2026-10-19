import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computeReplayLiq, longLiqPrice, shortLiqPrice, truncateReplayInput, REPLAY_OUT_OF_RANGE, scaleTierThresholds, riskOfUsd, BTC_TIER_EXTREME_USD, BTC_TIER_HIGH_USD, DONGYI_REF_BIN_PCT, REPLAY_BUCKET_PCT } from "../lib/replay/liq-replay.ts";
import { parseReplayQuery } from "../lib/replay/service.ts";
import { fetchOiHistory, fetchPriceBars, clearReplayCache } from "../lib/replay/history.ts";
import { nextReplayTime, prevReplayTime, replayCutoffMs, sliceReplayCandles, snapReplayStart } from "../lib/replay/replay-state.ts";
import { alertsRequestGuard } from "../lib/alerts/engine.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);
/** Deterministic synthetic market: 4 days of 1m bars (a sharp drop on day 3) and 5m OI for two venues. */
function market(days = 4) {
  const bars = [];
  let p = 80_000;
  for (let i = 0; i < days * 1440; i += 1) {
    const t = T0 + i * MIN;
    const drift = Math.sin(i / 180) * 18 + (i >= 2.5 * 1440 && i < 2.5 * 1440 + 30 ? -120 : 0); // -4.5% crash in 30 min
    const open = p; p = Math.max(1000, p + drift);
    bars.push({ time: t, open, high: Math.max(open, p) + 8, low: Math.min(open, p) - 8, close: p });
  }
  const oi = { binance: [], bybit: [] };
  for (let i = 0; i <= days * 288; i += 1) {
    const ts = T0 + i * 5 * MIN;
    oi.binance.push({ ts, oiUsd: 7e9 + 4e8 * Math.sin(i / 20) + i * 1e6 });
    oi.bybit.push({ ts, oiUsd: 4e9 + 2e8 * Math.cos(i / 15) });
  }
  return { bars, oi };
}
const run = (cutoff, m = market()) => computeReplayLiq({ symbol: "BTCUSDT", cutoff, bars: m.bars, oi: m.oi, barMs: MIN });

test("no lookahead: identical boxes whether or not future bars / OI exist (input truncated at T)", () => {
  const m = market();
  for (const cutoff of [T0 + 3.2 * 86_400_000, T0 + 2.5 * 86_400_000 + 20 * MIN, T0 + 1.6 * 86_400_000]) {
    const full = run(cutoff, m);
    const truncated = computeReplayLiq({ symbol: "BTCUSDT", cutoff, bars: m.bars.filter((b) => b.time + MIN <= cutoff), oi: Object.fromEntries(Object.entries(m.oi).map(([v, pts]) => [v, pts.filter((p) => p.ts <= cutoff)])), barMs: MIN });
    assert.ok(full.ok && truncated.ok);
    assert.deepEqual(full.snapshot.zones, truncated.snapshot.zones);
    assert.deepEqual(full.snapshot.bands, truncated.snapshot.bands);
    assert.equal(full.mark, truncated.mark);
    // Mutating the future must not matter either.
    const poisoned = { bars: m.bars.map((b) => (b.time + MIN > cutoff ? { ...b, high: b.high * 3, low: b.low / 3, close: b.close * 2 } : b)), oi: Object.fromEntries(Object.entries(m.oi).map(([v, pts]) => [v, pts.map((p) => (p.ts > cutoff ? { ...p, oiUsd: p.oiUsd * 50 } : p))])) };
    assert.deepEqual(run(cutoff, poisoned).snapshot.zones, full.snapshot.zones);
  }
  const t = truncateReplayInput({ symbol: "X", cutoff: T0 + 10 * MIN, bars: market(1).bars, oi: market(1).oi, barMs: MIN });
  assert.ok(t.bars.every((b) => b.time + MIN <= T0 + 10 * MIN));
});

test("side invariant at many replay candles incl. the crash: support/long below the candle price, resistance/short above", () => {
  const m = market();
  let checked = 0;
  for (let cutoff = T0 + 1.2 * 86_400_000; cutoff < T0 + 4 * 86_400_000; cutoff += 97 * MIN) {
    const r = run(cutoff, m);
    if (!r.ok) continue;
    const price = m.bars.filter((b) => b.time + MIN <= cutoff).at(-1).close;
    assert.equal(r.mark, price, "mark = close of the replay candle");
    for (const z of r.snapshot.zones) {
      if (z.role === "support") assert.ok(z.hi < price && z.side === "long", `support ${z.lo}-${z.hi} vs ${price}`);
      else assert.ok(z.lo > price && z.side === "short", `resistance ${z.lo}-${z.hi} vs ${price}`);
    }
    for (const b of r.snapshot.bands) assert.ok(b.side === "long" ? b.hi < price : b.lo > price);
    checked += 1;
  }
  assert.ok(checked >= 20);
});

test("hand-checkable bucket: liq_m equals the sum of surviving cohort levels in that bucket", () => {
  const cutoff = T0 + 3 * 86_400_000;
  const r = run(cutoff);
  assert.ok(r.ok && r.snapshot.bands.length > 0);
  const band = r.snapshot.bands[0];
  const step = (r.mark * 0.5) / 100;
  const idx = Math.round((band.lo - r.mark) / step);
  const sum = r.levels.filter((l) => l.side === band.side && Math.floor((l.price - r.mark) / step) === idx).reduce((s, l) => s + l.usd, 0);
  assert.ok(Math.abs(sum / 1e6 - band.liq_m) < 0.01, `${sum / 1e6} vs ${band.liq_m}`);
  assert.ok(Math.abs(longLiqPrice(100, 10) - 90.5) < 1e-9 && Math.abs(shortLiqPrice(100, 10) - 109.5) < 1e-9);
});

test("unavailable venues are marked; no OI/price coverage → 超出可回溯范围", () => {
  const m = market();
  const cutoff = T0 + 3 * 86_400_000;
  const r = computeReplayLiq({ symbol: "BTCUSDT", cutoff, bars: m.bars, oi: { ...m.oi, okx: [], bitget: m.oi.bybit.filter((p) => p.ts < cutoff - 5 * 3_600_000) }, barMs: MIN });
  assert.ok(r.ok);
  assert.deepEqual(r.venuesUsed.sort(), ["binance", "bybit"]);
  assert.deepEqual(r.venuesUnavailable.sort(), ["bitget", "okx"]);
  const none = computeReplayLiq({ symbol: "BTCUSDT", cutoff: T0 - 86_400_000, bars: m.bars, oi: m.oi, barMs: MIN });
  assert.deepEqual(none, { ok: false, error: REPLAY_OUT_OF_RANGE });
});

test("Tier C: replay query validation (range, format, unknown params) + localhost/same-origin GET-only route", () => {
  const now = Date.UTC(2026, 9, 17, 12);
  const u = (q) => new URL(`http://127.0.0.1:3000/api/replay/liq?${q}`);
  assert.equal(parseReplayQuery(u(`symbol=BTCUSDT&ts=${now - 86_400_000}`), now).ok, true);
  const out = parseReplayQuery(u(`symbol=BTCUSDT&ts=${now - 31 * 86_400_000}`), now);
  assert.equal(out.ok, false); assert.equal(out.status, 422); assert.equal(out.error, "超出可回溯范围");
  for (const q of [`symbol=BTCUSDT&ts=${now + 3_600_000}`, "symbol=BTCUSDT&ts=abc", "symbol=BTCUSDT&ts=-1", "symbol=btc&ts=1792000000000", `symbol=../x&ts=${now}`, `symbol=BTCUSDT&ts=${now}&admin=1`, "symbol=BTCUSDT", `ts=${now}`]) {
    const r = parseReplayQuery(u(q), now);
    assert.equal(r.ok, false, q); assert.equal(r.status, 400, q);
  }
  assert.equal(alertsRequestGuard(new Request("http://192.168.1.4:3000/api/replay/liq"), false).status, 403);
  assert.equal(alertsRequestGuard(new Request("http://127.0.0.1:3000/api/replay/liq", { headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } }), false).status, 403);
  const route = readFileSync(new URL("../app/api/replay/liq/route.ts", import.meta.url), "utf8");
  assert.match(route, /alertsRequestGuard\(request, false\)/);
  assert.match(route, /export const POST = deny/);
  assert.doesNotMatch(route, /writeFile|appendFile|localStorage/, "nothing persisted");
});

test("history fetchers: chunked, cached in memory, Bitget unavailable, failures → null", async () => {
  clearReplayCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes("klines")) return { ok: true, json: async () => [[T0, "1", "2", "0.5", "1.5"], [T0 + MIN, "1.5", "2", "1", "1.2"]] };
    if (url.includes("openInterestHist")) return { ok: true, json: async () => [{ timestamp: T0, sumOpenInterestValue: "100" }] };
    if (url.includes("bybit")) return { ok: true, json: async () => ({ result: { list: [{ timestamp: String(T0), openInterest: "10" }] } }) };
    return { ok: false, json: async () => ({}) };
  };
  const bars = await fetchPriceBars("BTCUSDT", T0, T0 + 5 * MIN, fetchImpl, T0 + 86_400_000);
  assert.equal(bars.length, 2);
  await fetchPriceBars("BTCUSDT", T0, T0 + 5 * MIN, fetchImpl, T0 + 86_400_000);
  assert.equal(calls, 1, "closed chunk served from memory");
  assert.deepEqual(await fetchOiHistory("binance", "BTCUSDT", T0, T0 + MIN, fetchImpl, T0 + 86_400_000, () => 2), [{ ts: T0, oiUsd: 100 }]);
  assert.deepEqual(await fetchOiHistory("bybit", "BTCUSDT", T0, T0 + MIN, fetchImpl, T0 + 86_400_000, () => 2), [{ ts: T0, oiUsd: 20 }], "coins × price");
  assert.equal(await fetchOiHistory("bitget", "BTCUSDT", T0, T0 + MIN, fetchImpl, T0, () => 2), null);
  assert.equal(await fetchOiHistory("okx", "BTCUSDT", T0, T0 + MIN, fetchImpl, T0 + 86_400_000, () => 2), null);
});

test("client replay state: hidden bars, stepping, snapping, cutoff = replay candle close", () => {
  const candles = [100, 160, 220, 280].map((time) => ({ time }));
  assert.deepEqual(sliceReplayCandles(candles, 160).map((c) => c.time), [100, 160]);
  assert.equal(nextReplayTime(candles, 160), 220);
  assert.equal(nextReplayTime(candles, 280), null);
  assert.equal(prevReplayTime(candles, 160), 100);
  assert.equal(snapReplayStart(candles, 200), 160);
  assert.equal(replayCutoffMs(1_800_000_000, "15", 2_000_000_000_000), (1_800_000_000 + 900) * 1000);
  assert.equal(replayCutoffMs(1_800_000_000, "D", (1_800_000_000 + 3600) * 1000), (1_800_000_000 + 3600) * 1000, "never past now");
});

test("workspace wiring: every consumer sees sliced candles; alerts disabled; zones fetched per replay candle", () => {
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /const candles = useMemo\(\(\) => \(replayCursor == null \? liveCandles : sliceReplayCandles\(liveCandles, replayCursor\)\)/);
  assert.match(ws, /\/api\/replay\/liq\?symbol=\$\{encodeURIComponent\(symbol\)\}&ts=\$\{cutoff\}/);
  assert.match(ws, /disabled=\{!!replay\} onClick=\{\(\) => setShowAlertForm\(true\)\}/);
  assert.match(ws, /liqZones\.length > 0 && !replay && <button type="button" className=\{`liq-zone-bell/);
  assert.match(ws, /candlesRef\.current = liveCandles/);
});

test("H2 tier scaling: BTC floors; alt scales by OI ratio", () => {
  const btc = scaleTierThresholds(12e9, 12e9);
  assert.equal(btc.extremeUsd, BTC_TIER_EXTREME_USD);
  assert.equal(riskOfUsd(100e6, btc), "极高");
  assert.equal(riskOfUsd(70e6, btc), "高");
  assert.equal(riskOfUsd(15e6, btc), "中");
  assert.equal(riskOfUsd(1e6, btc), "低");
  const alt = scaleTierThresholds(50e6, 5e9); // 1%
  assert.ok(Math.abs(alt.extremeUsd - 1e6) < 1e-6);
  assert.equal(riskOfUsd(1e6, alt), "极高");
});

// TH-BUG-06: dollar floors are per Dongyi ~0.19% BTC bin; wider buckets scale them (same contract as oi_liq/h2.py).
test("TH-BUG-06 tier scaling: default = reference bin; 0.5% bucket scales floors; ratio kept", () => {
  assert.equal(DONGYI_REF_BIN_PCT, 0.19);
  const ref = scaleTierThresholds(12e9, 12e9);
  assert.equal(ref.extremeUsd, BTC_TIER_EXTREME_USD);
  const live = scaleTierThresholds(12e9, 12e9, REPLAY_BUCKET_PCT);
  const f = REPLAY_BUCKET_PCT / 0.19;
  assert.ok(Math.abs(live.extremeUsd - BTC_TIER_EXTREME_USD * f) < 1e-3);
  assert.ok(Math.abs(live.highUsd / live.extremeUsd - BTC_TIER_HIGH_USD / BTC_TIER_EXTREME_USD) < 1e-12);
  const alt = scaleTierThresholds(6.2e9, 10e9, 0.5); // OI share 0.62 composes with bucket factor
  assert.ok(Math.abs(alt.extremeUsd - BTC_TIER_EXTREME_USD * 0.62 * (0.5 / 0.19)) < 1e-3);
});

test("TH-BUG-06 deny: invalid bucket width falls back to the reference bin; factor is clamped", () => {
  for (const bad of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
    assert.equal(scaleTierThresholds(12e9, 12e9, bad).extremeUsd, BTC_TIER_EXTREME_USD, String(bad));
  }
  assert.ok(scaleTierThresholds(12e9, 12e9, 1e-9).extremeUsd >= BTC_TIER_EXTREME_USD * 0.05 - 1e-6);
  assert.ok(scaleTierThresholds(12e9, 12e9, 500).extremeUsd <= BTC_TIER_EXTREME_USD * 50 + 1e-6);
});

test("TH-BUG-06 live BTC 0.5% buckets are no longer mostly 极高", () => {
  const data = JSON.parse(readFileSync(new URL("./fixtures/liq_btc_live_0p5.json", import.meta.url), "utf8"));
  const rows = data.buckets;
  assert.ok(rows.length >= 30);
  const oldX = rows.filter((r) => riskOfUsd(r.liq_usd, scaleTierThresholds(1, 1)) === "极高").length;
  assert.ok(oldX / rows.length > 0.5, "fixture reproduces the bug");
  const t = scaleTierThresholds(1, 1, data.bucket_width_pct * 100);
  const tiers = rows.map((r) => riskOfUsd(r.liq_usd, t));
  const newX = tiers.filter((x) => x === "极高").length;
  assert.ok(newX / rows.length < 0.5, `${newX}/${rows.length} still 极高`);
  assert.ok(newX >= 1 && tiers.includes("高") && tiers.includes("中"));
});
