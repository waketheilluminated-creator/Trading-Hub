import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allowlistedSymbol, createLiqRefresher, liqLastGoodPath } from "../lib/liq-refresh.ts";
import {
  LIQ_HEATMAP_NO_SNAPSHOT,
  LIQ_UNLISTED_NOTICE,
  chartSupportsLiqSample,
  isLiqSymbol,
  liqHeatmapDefaultOn,
  loadLiqHeatmapBands,
  parseLiqHeatmapQuery,
  requestLiqRefresh,
  sanitizeLiqHeatmapSnapshot,
  selectLiqSnapshotSource,
} from "../lib/liq-heatmap.ts";

const zec = JSON.parse(readFileSync(new URL("../fixtures/liq_heatmap_bands.ZECUSDT.json", import.meta.url), "utf8"));
const asSymbol = (symbol) => ({ ...zec, symbol });

const BAD = [
  "", "BTC", "USDT", "BTCUSD", "BTCUSDC", "btcusdt", "BtcUSDT", " BTCUSDT", "BTCUSDT ", "BTCUSDT\n", "BTC-USDT", "BTC/USDT", "BTC_USDT",
  "../BTCUSDT", "..%2FBTCUSDT", "BTCUSDT/../../etc/passwd", "/etc/passwdUSDT", "BTCUSDT;rm -rf /", "BTC$(id)USDT", "BTC`id`USDT",
  "BTC USDT", "BTC\u0000USDT", "ＢＴＣUSDT", "BTCUSDT.json", "AAAAAAAAAAAAAAAAAAAAAUSDT", "--symbolUSDT", "-XUSDT", null, undefined, 42, ["BTCUSDT"], { s: "BTCUSDT" },
];

test("any USDT perpetual passes the strict format; leading digits allowed and distinct", () => {
  for (const ok of ["BTCUSDT", "ZECUSDT", "PYTHUSDT", "1000PEPEUSDT", "PEPEUSDT", "XUSDT".replace("X", "AB"), "AAAAAAAAAAAAAAAAAAAAUSDT"]) {
    assert.equal(isLiqSymbol(ok), true, ok);
    assert.equal(allowlistedSymbol(ok), ok);
  }
  assert.notEqual(allowlistedSymbol("PEPEUSDT"), allowlistedSymbol("1000PEPEUSDT"));
});

test("deny: bad formats, traversal and injection characters never pass", () => {
  for (const bad of BAD) {
    assert.equal(isLiqSymbol(bad), false, JSON.stringify(bad));
    assert.equal(allowlistedSymbol(bad), null, JSON.stringify(bad));
  }
  for (const bad of BAD.filter((value) => typeof value === "string")) {
    assert.throws(() => liqLastGoodPath("/srv/liq", bad), /invalid liquidation symbol/, JSON.stringify(bad));
  }
  assert.equal(liqLastGoodPath("/srv/liq", "1000PEPEUSDT"), "/srv/liq/liq_heatmap_bands.1000PEPEUSDT.json");
});

test("deny: GET query rejects non-USDT and malformed symbols", () => {
  for (const bad of ["BTCUSD", "BTC", "../x", "BTCUSDT;ls", "%00"]) {
    assert.equal(parseLiqHeatmapQuery(new URL(`http://x/api/liq-heatmap?symbol=${encodeURIComponent(bad)}`)).ok, false, bad);
  }
  assert.equal(parseLiqHeatmapQuery(new URL("http://x/api/liq-heatmap?symbol=btc-usdt")).symbol, "BTCUSDT");
});

/** Mock spawn harness (estimator contract: exit 0 + file, 1 all venues failed, 2 bad args, 3 unlisted). */
function harness({ code = 0, hang = false, maxConcurrent, maxCached } = {}) {
  const files = new Map();
  const calls = [];
  const removed = [];
  let clock = 0;
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (!hang) setImmediate(() => {
      const symbol = args[args.indexOf("--symbol") + 1];
      if (code === 0) files.set(args[args.indexOf("--out") + 1], JSON.stringify(asSymbol(symbol)));
      if (code === 3) child.stderr.emit("data", `no venue lists ${symbol}`);
      child.emit("close", code, null);
    });
    return child;
  };
  const refresher = createLiqRefresher({
    spawn, env: { LIQ_ESTIMATOR_CMD: "/py /est.py" }, outDir: "/srv/liq", randomId: () => String(calls.length),
    readFile: async (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
    fileSize: async (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p).length; },
    writeFile: async (p, d) => { files.set(p, d); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    remove: async (p) => { removed.push(p); files.delete(p); },
    mkdir: async () => {}, now: () => clock, timeoutMs: 30, cooldownMs: 90_000, maxConcurrent, maxCached,
  });
  return { refresher, calls, files, removed, advance: (ms) => { clock += ms; } };
}

test("refresh works for any valid symbol; argv carries only that exact symbol", async () => {
  const h = harness();
  const result = await h.refresher.refresh("1000PEPEUSDT");
  assert.equal(result.status, 200);
  assert.deepEqual(h.calls[0], ["/py", "/est.py", "--symbol", "1000PEPEUSDT", "--out", "/srv/liq/run-1000PEPEUSDT-0.json"]);
  assert.equal(h.refresher.lastGood("1000PEPEUSDT").symbol, "1000PEPEUSDT");
});

test("deny: bad symbols never spawn (400)", async () => {
  const h = harness();
  for (const bad of BAD) assert.equal((await h.refresher.refresh(bad)).status, 400, JSON.stringify(bad));
  assert.equal(h.calls.length, 0);
});

test("exit 3 → 422 「该币种暂无交易所永续合约」; exit 2 and 1 → 502 keeping last good", async () => {
  const unlisted = await harness({ code: 3 }).refresher.refresh("NOPECOINUSDT");
  assert.equal(unlisted.status, 422);
  assert.equal(unlisted.body.error, LIQ_UNLISTED_NOTICE);
  assert.equal(unlisted.body.code, "unlisted");
  for (const code of [1, 2]) {
    const h = harness({ code });
    const result = await h.refresher.refresh("BTCUSDT");
    assert.equal(result.status, 502, String(code));
    assert.equal(h.refresher.lastGood("BTCUSDT"), null);
  }
});

test("global concurrency cap: a third symbol waits (429) while two runs are in flight", async () => {
  const h = harness({ hang: true, maxConcurrent: 2 });
  const a = h.refresher.refresh("BTCUSDT");
  const b = h.refresher.refresh("ETHUSDT");
  const c = await h.refresher.refresh("SOLUSDT");
  assert.equal(c.status, 429);
  assert.ok(c.retryAfterSec > 0);
  await Promise.all([a, b]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2);
});

test("cache cap: oldest snapshot is evicted from memory and disk", async () => {
  const h = harness({ maxCached: 2 });
  for (const symbol of ["AAUSDT", "BBUSDT", "CCUSDT"]) assert.equal((await h.refresher.refresh(symbol)).status, 200);
  assert.equal(h.refresher.lastGood("AAUSDT"), null);
  assert.ok(h.refresher.lastGood("CCUSDT"));
  assert.ok(h.removed.includes("/srv/liq/liq_heatmap_bands.AAUSDT.json"));
  assert.ok(!h.files.has("/srv/liq/liq_heatmap_bands.AAUSDT.json"));
});

test("per-symbol cooldown still applies; other symbols are independent", async () => {
  const h = harness();
  assert.equal((await h.refresher.refresh("BTCUSDT")).status, 200);
  assert.equal((await h.refresher.refresh("BTCUSDT")).status, 429);
  assert.equal((await h.refresher.refresh("ETHUSDT")).status, 200);
});

test("restore() refuses bad symbols and never touches the filesystem for them", async () => {
  const h = harness();
  for (const bad of ["../x", "btcusdt", "BTCUSDT/../../a"]) assert.equal(await h.refresher.restore(bad), null);
});

test("GET source selection: any valid symbol without a snapshot → none (404 「尚未计算，点刷新生成」)", () => {
  assert.equal(selectLiqSnapshotSource("BTCUSDT", {}, zec), null);
  assert.equal(selectLiqSnapshotSource("1000PEPEUSDT", { "x/liq_heatmap_bands.PEPEUSDT.json": asSymbol("PEPEUSDT") }, zec), null, "PEPE ≠ 1000PEPE");
  assert.equal(selectLiqSnapshotSource("BTCUSDT", { "x/liq_heatmap_bands.BTCUSDT.json": asSymbol("BTCUSDT") }, zec).source, "live");
  assert.equal(LIQ_HEATMAP_NO_SNAPSHOT, "尚未计算，点刷新生成");
});

test("client: empty state for symbols without a snapshot, refresh enabled; 422 unlisted shown as-is", async () => {
  assert.equal(chartSupportsLiqSample("BTC/USDT"), true);
  assert.equal(chartSupportsLiqSample("BTCUSD"), false);
  const empty = await loadLiqHeatmapBands("BTCUSDT", async () => Response.json({ error: LIQ_HEATMAP_NO_SNAPSHOT }, { status: 404 }));
  assert.equal(empty.notice, "尚未计算，点刷新生成");
  const unlisted = await requestLiqRefresh("NOPECOINUSDT", async () => Response.json({ ok: false, error: LIQ_UNLISTED_NOTICE, code: "unlisted" }, { status: 422 }));
  assert.deepEqual(unlisted, { ok: false, error: "该币种暂无交易所永续合约", retryAfterSec: null });
});

test("default-on flame: only when a snapshot exists (probe), bundled ZEC/PYTH until probed", () => {
  assert.equal(liqHeatmapDefaultOn("BTCUSDT"), false);
  assert.equal(liqHeatmapDefaultOn("BTCUSDT", true), true);
  assert.equal(liqHeatmapDefaultOn("ZECUSDT"), true);
  assert.equal(liqHeatmapDefaultOn("ZECUSDT", false), false);
  assert.equal(liqHeatmapDefaultOn("BTCUSD", true), false);
});

test("tickSize from the any-symbol estimator is kept when sane", () => {
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...zec, tickSize: 0.01 }).snapshot.tickSize, 0.01);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...zec, tickSize: -1 }).snapshot.tickSize, null);
  assert.equal(sanitizeLiqHeatmapSnapshot({ ...zec, tickSize: "0.1" }).snapshot.tickSize, null);
});
