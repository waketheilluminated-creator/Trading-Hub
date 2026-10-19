// TH-BUG-06 — server-side liquidation auto-refresh (Tier C: background job that spawns the estimator).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LIQ_AUTO_REFRESH_DEFAULT_SEC,
  LIQ_AUTO_WATCH_MAX,
  autoRefreshConfigFromEnv,
  autoRefreshWatchAllowed,
  createLiqAutoRefresh,
} from "../lib/liq-auto-refresh.ts";

const CMD = "/home/u/liq-estimator/.venv/bin/python /home/u/liq-estimator/refresh_liq.py";
const MIN = 60_000;

/** Fake refresher: records refresh() calls; snapshots carry updatedAt = clock at refresh. */
function fake({ status = 200, initial = {} } = {}) {
  let clock = 10_000_000;
  const calls = [];
  const snaps = new Map(Object.entries(initial));
  const refresher = {
    async refresh(symbol) {
      calls.push(symbol);
      const s = typeof status === "function" ? status(symbol) : status;
      if (s === 200) {
        const snapshot = { symbol, updatedAt: clock };
        snaps.set(symbol, snapshot);
        return { status: 200, body: { ok: true, snapshot, cooldownSec: 30 } };
      }
      return { status: s, body: { ok: false, error: "x" } };
    },
    async restore(symbol) { return snaps.get(symbol) ?? null; },
  };
  return { refresher, calls, snaps, now: () => clock, advance: (ms) => { clock += ms; } };
}

function make(f, opts = {}) {
  return createLiqAutoRefresh({ refresher: f.refresher, now: f.now, intervalMs: 5 * MIN, symbols: ["BTCUSDT", "ETHUSDT"], ...opts });
}

test("config: enabled by default (300 s, BTC+ETH) only when the estimator is configured", () => {
  const on = autoRefreshConfigFromEnv({ LIQ_ESTIMATOR_CMD: CMD, HOME: "/home/u" });
  assert.deepEqual(on, { enabled: true, intervalMs: LIQ_AUTO_REFRESH_DEFAULT_SEC * 1000, symbols: ["BTCUSDT", "ETHUSDT"] });
  assert.equal(LIQ_AUTO_REFRESH_DEFAULT_SEC, 300);
  // Deny: no estimator command → no background job at all (fail closed).
  assert.equal(autoRefreshConfigFromEnv({}).enabled, false);
  assert.equal(autoRefreshConfigFromEnv({ LIQ_ESTIMATOR_CMD: "  " }).enabled, false);
});

test("config: operator can disable, interval is clamped, symbol list is format-checked and capped", () => {
  const base = { LIQ_ESTIMATOR_CMD: CMD };
  assert.equal(autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SEC: "0" }).enabled, false);
  assert.equal(autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SEC: "off" }).enabled, false);
  assert.equal(autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SEC: "5" }).intervalMs, 60_000);
  assert.equal(autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SEC: "999999" }).intervalMs, 3_600_000);
  assert.equal(autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SEC: "abc" }).intervalMs, 300_000);
  const syms = autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SYMBOLS: "SOLUSDT, btcusdt,../etc,BTCUSDT;rm,ZECUSDT,SOLUSDT" }).symbols;
  assert.deepEqual(syms, ["SOLUSDT", "ZECUSDT"]); // lowercase / path / shell junk dropped, duplicates removed
  const many = Array.from({ length: 20 }, (_, i) => `A${i}USDT`).join(",");
  assert.equal(autoRefreshConfigFromEnv({ ...base, LIQ_AUTO_REFRESH_SYMBOLS: many }).symbols.length, LIQ_AUTO_WATCH_MAX);
});

test("tick refreshes stale/missing default symbols through the refresher, then waits for the interval", async () => {
  const f = fake();
  const auto = make(f);
  await auto.tick();
  assert.deepEqual(f.calls, ["BTCUSDT", "ETHUSDT"]);
  f.advance(2 * MIN);
  await auto.tick();
  assert.equal(f.calls.length, 2, "fresh snapshots are not re-run");
  f.advance(3 * MIN);
  await auto.tick();
  assert.deepEqual(f.calls.slice(2), ["BTCUSDT", "ETHUSDT"], "asOf advances on its own after the interval");
});

test("a snapshot refreshed manually (fresh updatedAt) is not re-run by the scheduler", async () => {
  const f = fake({ initial: { BTCUSDT: { symbol: "BTCUSDT", updatedAt: 10_000_000 - MIN } } });
  await make(f).tick();
  assert.deepEqual(f.calls, ["ETHUSDT"]);
});

test("failures back off for one interval (no hammering); 422 unlisted drops a watched symbol", async () => {
  const f = fake({ status: (s) => (s === "ETHUSDT" ? 502 : s === "NOPEUSDT" ? 422 : 200) });
  const auto = make(f);
  auto.watch("NOPEUSDT");
  await auto.tick();
  assert.deepEqual(f.calls, ["BTCUSDT", "ETHUSDT", "NOPEUSDT"]);
  f.advance(MIN);
  await auto.tick();
  assert.equal(f.calls.length, 3, "502 is retried only after the interval");
  f.advance(5 * MIN);
  await auto.tick();
  assert.deepEqual(f.calls.slice(3), ["BTCUSDT", "ETHUSDT"], "unlisted symbol is no longer watched");
});

test("ticks never overlap (single-flight scheduler)", async () => {
  const f = fake();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { ...f.refresher, async refresh(s) { await gate; return f.refresher.refresh(s); } };
  const auto = createLiqAutoRefresh({ refresher: slow, now: f.now, intervalMs: 5 * MIN, symbols: ["BTCUSDT"] });
  const first = auto.tick();
  const second = await auto.tick();
  assert.equal(second.skipped, true);
  release();
  await first;
  assert.deepEqual(f.calls, ["BTCUSDT"]);
});

test("watched symbols: format-checked, expire after the TTL, capped (oldest evicted)", async () => {
  const f = fake();
  const auto = make(f, { symbols: [], watchTtlMs: 10 * MIN });
  for (const bad of ["btcusdt", "../../x", "BTCUSDT;rm -rf", "", null, 42, "A".repeat(40) + "USDT"]) auto.watch(bad);
  assert.deepEqual(auto.watched(), []);
  for (let i = 0; i < LIQ_AUTO_WATCH_MAX + 3; i++) auto.watch(`S${i}USDT`);
  assert.equal(auto.watched().length, LIQ_AUTO_WATCH_MAX);
  assert.ok(!auto.watched().includes("S0USDT"));
  f.advance(11 * MIN);
  assert.deepEqual(auto.watched(), []);
  await auto.tick();
  assert.deepEqual(f.calls, []);
});

test("start(): one timer, unref'd, idempotent; stop() clears it", () => {
  const f = fake();
  const timers = [];
  const auto = make(f, {
    setTimer: (fn, ms) => { const t = { fn, ms, unref() { t.unrefd = true; } }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  auto.start();
  auto.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].unrefd, true);
  assert.ok(timers[0].ms <= 60_000);
  auto.stop();
  assert.equal(timers[0].cleared, true);
});

test("watch enrolment deny paths: only same-origin GET from localhost may add a symbol", () => {
  const req = (url, headers = {}, method = "GET") => new Request(url, { method, headers });
  assert.equal(autoRefreshWatchAllowed(req("http://127.0.0.1:3000/api/liq-heatmap?symbol=BTCUSDT", { "sec-fetch-site": "same-origin" })), true);
  assert.equal(autoRefreshWatchAllowed(req("http://localhost:3000/api/liq-heatmap", { "sec-fetch-site": "same-origin" })), true);
  // cross-site page (no-cors GET to localhost) must not be able to make the server spawn estimators
  assert.equal(autoRefreshWatchAllowed(req("http://127.0.0.1:3000/api/liq-heatmap", { "sec-fetch-site": "cross-site" })), false);
  assert.equal(autoRefreshWatchAllowed(req("http://127.0.0.1:3000/api/liq-heatmap", { "sec-fetch-site": "same-site" })), false);
  assert.equal(autoRefreshWatchAllowed(req("http://127.0.0.1:3000/api/liq-heatmap")), false, "missing header fails closed");
  assert.equal(autoRefreshWatchAllowed(req("http://evil.example/api/liq-heatmap", { "sec-fetch-site": "same-origin" })), false);
  assert.equal(autoRefreshWatchAllowed(req("http://127.0.0.1:3000/api/liq-heatmap", { "sec-fetch-site": "same-origin" }, "POST")), false);
});

test("wiring: instrumentation starts the scheduler; GET route enrols only guarded views; manual cooldown stays 30 s", () => {
  const inst = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
  assert.match(inst, /export async function register\(\)/);
  assert.match(inst, /startLiqAutoRefresh\(\)/);
  const route = readFileSync(new URL("../app/api/liq-heatmap/route.ts", import.meta.url), "utf8");
  assert.match(route, /autoRefreshWatchAllowed\(request\)/);
  const server = readFileSync(new URL("../lib/liq-refresh-server.ts", import.meta.url), "utf8");
  assert.match(server, /Symbol\.for\("tradinghub\.liq\.refresher"\)/);
  const refresh = readFileSync(new URL("../lib/liq-refresh.ts", import.meta.url), "utf8");
  assert.match(refresh, /export const LIQ_REFRESH_COOLDOWN_MS = 30_000;/);
});

test("client: overlay re-reads the snapshot every 60 s and swaps only when asOf moved (no client-side recompute)", () => {
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /window\.setInterval\(\(\) => void load\(false\), LIQ_HEATMAP_POLL_MS\)/);
  assert.match(ws, /if \(!initial && \(result\.notice \|\| asOf === lastAsOf\)\) return;/);
  assert.match(ws, /window\.clearInterval\(timer\)/);
  const heat = readFileSync(new URL("../lib/liq-heatmap.ts", import.meta.url), "utf8");
  assert.match(heat, /export const LIQ_HEATMAP_POLL_MS = 60_000;/);
  const route = readFileSync(new URL("../app/api/liq-heatmap/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.get\("probe"\) !== "1"/, "the default-on probe must not enrol symbols");
});
