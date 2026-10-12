import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LIQ_REFRESH_UNCONFIGURED,
  createLiqRefresher,
  estimatorArgvFromEnv,
  estimatorChildEnv,
  parseEstimatorCommand,
  refreshRequestGuard,
} from "../lib/liq-refresh.ts";
import { formatLiqPrice, formatLiqUpdatedAt, liqHeatmapDefaultOn, requestLiqRefresh, sanitizeVenuesFailed } from "../lib/liq-heatmap.ts";

const zec = JSON.parse(readFileSync(new URL("../fixtures/liq_heatmap_bands.ZECUSDT.json", import.meta.url), "utf8"));
const CMD = "/home/u/liq-estimator/.venv/bin/python /home/u/liq-estimator/refresh_liq.py";

/** Mock spawn: records calls, writes `output` to --out, exits with `code` (or never, for timeouts). */
function harness({ env = { LIQ_ESTIMATOR_CMD: CMD, HOME: "/home/u", PATH: "/usr/bin" }, output = zec, code = 0, hang = false, spawnThrows = false, timeoutMs = 50 } = {}) {
  const files = new Map();
  const calls = [];
  let clock = 1_000_000;
  const children = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (spawnThrows) throw new Error("ENOENT");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = null;
    child.kill = (signal) => { child.killed = signal; };
    children.push(child);
    if (!hang) {
      setImmediate(() => {
        const out = args[args.indexOf("--out") + 1];
        if (code === 0 && output !== null) files.set(out, typeof output === "string" ? output : JSON.stringify(output));
        if (code !== 0) child.stderr.emit("data", "all venues failed");
        child.emit("close", code, null);
      });
    }
    return child;
  };
  const refresher = createLiqRefresher({
    spawn,
    env,
    outDir: "/srv/liq",
    randomId: () => "abc-123",
    readFile: async (path) => { if (!files.has(path)) throw new Error("ENOENT"); return files.get(path); },
    fileSize: async (path) => { if (!files.has(path)) throw new Error("ENOENT"); return files.get(path).length; },
    writeFile: async (path, data) => { files.set(path, data); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    remove: async (path) => { files.delete(path); },
    mkdir: async () => {},
    now: () => clock,
    timeoutMs,
    cooldownMs: 90_000,
  });
  return { refresher, calls, files, children, advance: (ms) => { clock += ms; } };
}

test("refresh spawns argv (no shell) with only the allowlisted symbol and a server-chosen --out", async () => {
  const h = harness();
  const result = await h.refresher.refresh("ZECUSDT");
  assert.equal(result.status, 200);
  assert.equal(h.calls.length, 1);
  const [{ command, args, options }] = h.calls;
  assert.equal(command, "/home/u/liq-estimator/.venv/bin/python");
  assert.deepEqual(args, ["/home/u/liq-estimator/refresh_liq.py", "--symbol", "ZECUSDT", "--out", "/srv/liq/run-ZECUSDT-abc-123.json"]);
  assert.equal(options.shell, false);
  assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH"]);
  assert.equal(result.body.snapshot.markPrice, zec.markPrice);
  assert.equal(result.body.cooldownSec, 90);
  assert.ok(h.files.has("/srv/liq/liq_heatmap_bands.ZECUSDT.json"), "atomic swap into last-good path");
  assert.ok(!h.files.has("/srv/liq/run-ZECUSDT-abc-123.json"), "temp output cleaned up");
  assert.equal(h.refresher.lastGood("ZECUSDT").markPrice, zec.markPrice);
});

test("deny: symbols outside the allowlist never reach spawn", async () => {
  for (const bad of [null, "", "BTCUSD", "zecusdt", "ZECUSDT --out /etc/passwd", "ZECUSDT;rm -rf /", "../ZECUSDT", "PYTHUSDT\n"]) {
    const h = harness();
    const result = await h.refresher.refresh(bad);
    assert.equal(result.status, 400, String(bad));
    assert.equal(h.calls.length, 0);
  }
});

test("deny: unset or malformed LIQ_ESTIMATOR_CMD → 503, no spawn", async () => {
  for (const env of [{}, { LIQ_ESTIMATOR_CMD: "" }, { LIQ_ESTIMATOR_CMD: "   " }, { LIQ_ESTIMATOR_CMD: "[1,2]" }, { LIQ_ESTIMATOR_CMD: "[\"a\"" }, { LIQ_ESTIMATOR_CMD: "$HOME/x", HOME: "relative" }, { LIQ_ESTIMATOR_CMD: "python $(whoami)" }, { LIQ_ESTIMATOR_CMD: "python `id`" }]) {
    const h = harness({ env });
    const result = await h.refresher.refresh("ZECUSDT");
    assert.equal(result.status, 503, JSON.stringify(env));
    assert.equal(h.calls.length, 0);
  }
  assert.equal((await harness({ env: {} }).refresher.refresh("ZECUSDT")).body.error, LIQ_REFRESH_UNCONFIGURED);
});

test("estimator argv: whitespace split, JSON array, PYTHON+SCRIPT pair, $HOME/~ expansion only", () => {
  assert.deepEqual(parseEstimatorCommand("a  b\tc"), ["a", "b", "c"]);
  assert.deepEqual(parseEstimatorCommand('["/p y/python", "/s/refresh_liq.py"]'), ["/p y/python", "/s/refresh_liq.py"]);
  assert.equal(parseEstimatorCommand(undefined), null);
  assert.deepEqual(estimatorArgvFromEnv({ LIQ_ESTIMATOR_CMD: "$HOME/liq/.venv/bin/python ${HOME}/liq/refresh_liq.py", HOME: "/Users/wake" }), ["/Users/wake/liq/.venv/bin/python", "/Users/wake/liq/refresh_liq.py"]);
  assert.deepEqual(estimatorArgvFromEnv({ LIQ_ESTIMATOR_CMD: "~/x", HOME: "/Users/wake" }), ["/Users/wake/x"]);
  assert.deepEqual(estimatorArgvFromEnv({ LIQ_ESTIMATOR_PYTHON: "/opt/py", LIQ_ESTIMATOR_SCRIPT: "/opt/refresh_liq.py", LIQ_ESTIMATOR_CMD: "ignored" }), ["/opt/py", "/opt/refresh_liq.py"]);
  assert.equal(estimatorArgvFromEnv({ LIQ_ESTIMATOR_CMD: "python $SECRET" }), null);
});

test("child env is minimal; LIQ_SOCKS_PROXY passes through only when set and well-formed", () => {
  const base = { PATH: "/usr/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "x", OPENAI_API_KEY: "y", LIQ_ESTIMATOR_CMD: "z" };
  assert.deepEqual(estimatorChildEnv(base), { PATH: "/usr/bin", HOME: "/h" });
  assert.equal(estimatorChildEnv({ ...base, LIQ_SOCKS_PROXY: "socks5h://127.0.0.1:9050" }).LIQ_SOCKS_PROXY, "socks5h://127.0.0.1:9050");
  assert.equal(estimatorChildEnv({ ...base, LIQ_SOCKS_PROXY: "http://evil; rm" }).LIQ_SOCKS_PROXY, undefined);
  assert.equal(estimatorChildEnv({ ...base, LIQ_SOCKS_PROXY: "" }).LIQ_SOCKS_PROXY, undefined);
});

test("deny: single-flight per symbol (409) while a run is in progress; other symbol unaffected", async () => {
  const h = harness({ hang: true, timeoutMs: 40 });
  const first = h.refresher.refresh("ZECUSDT");
  const second = await h.refresher.refresh("ZECUSDT");
  assert.equal(second.status, 409);
  assert.equal(h.calls.length, 1);
  const pyth = h.refresher.refresh("PYTHUSDT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2);
  await Promise.all([first, pyth]);
});

test("deny: cooldown → 429 with retry-after, then allowed again", async () => {
  const h = harness();
  assert.equal((await h.refresher.refresh("ZECUSDT")).status, 200);
  h.advance(30_000);
  const cooled = await h.refresher.refresh("ZECUSDT");
  assert.equal(cooled.status, 429);
  assert.equal(cooled.retryAfterSec, 60);
  assert.equal(h.calls.length, 1);
  h.advance(60_000);
  assert.equal((await h.refresher.refresh("ZECUSDT")).status, 200);
});

test("deny: timeout kills the child (SIGKILL) → 504, last good kept", async () => {
  const h = harness();
  await h.refresher.refresh("ZECUSDT");
  const good = h.refresher.lastGood("ZECUSDT");
  const slow = harness({ hang: true, timeoutMs: 20 });
  const result = await slow.refresher.refresh("ZECUSDT");
  assert.equal(result.status, 504);
  assert.equal(slow.children[0].killed, "SIGKILL");
  assert.equal(h.refresher.lastGood("ZECUSDT"), good);
});

test("deny: non-zero exit, spawn error, missing/invalid/forged output → 502 and last good kept", async () => {
  const cases = [
    { code: 2 },
    { spawnThrows: true },
    { output: null },
    { output: "not json" },
    { output: { ...zec, kind: "other" } },
    { output: { ...zec, symbol: "PYTHUSDT" } },
    { output: { ...zec, schemaVersion: undefined } },
    { output: { ...zec, markPrice: "NaN" } },
    { output: "x".repeat(2 * 1024 * 1024 + 1) },
  ];
  for (const options of cases) {
    const h = harness();
    await h.refresher.refresh("ZECUSDT");
    const good = h.refresher.lastGood("ZECUSDT");
    h.advance(100_000);
    const bad = harness(options);
    const result = await bad.refresher.refresh("ZECUSDT");
    assert.equal(result.status, 502, JSON.stringify(Object.keys(options)));
    assert.equal(bad.refresher.lastGood("ZECUSDT"), null, "bad output is never swapped in");
    assert.ok(![...bad.files.keys()].some((key) => key.endsWith("liq_heatmap_bands.ZECUSDT.json")));
    assert.equal(h.refresher.lastGood("ZECUSDT"), good);
  }
});

test("bad zone rows in estimator output are dropped by the sanitizer before swap-in", async () => {
  const forged = { ...zec, zones: [...zec.zones, { lo: 5, hi: 1, role: "support", liq_m: 1, risk_max: "极高", dist_pct: -1, bucket_count: 2 }, { lo: 1, hi: 2, role: "evil" }] };
  const h = harness({ output: forged });
  const result = await h.refresher.refresh("ZECUSDT");
  assert.equal(result.status, 200);
  assert.equal(result.body.snapshot.zones.length, zec.zones.length);
});

test("restore() re-validates the last-good file from an earlier process", async () => {
  const h = harness();
  h.files.set("/srv/liq/liq_heatmap_bands.ZECUSDT.json", JSON.stringify({ ...zec, kind: "nope" }));
  assert.equal(await h.refresher.restore("ZECUSDT"), null);
  h.files.set("/srv/liq/liq_heatmap_bands.ZECUSDT.json", JSON.stringify(zec));
  assert.equal((await h.refresher.restore("ZECUSDT")).symbol, "ZECUSDT");
});

test("request guard: POST only, localhost only, same-origin only", () => {
  const url = "http://localhost:3000/api/liq-zones/refresh?symbol=ZECUSDT";
  const ok = (init) => refreshRequestGuard(new Request(url, init));
  assert.equal(ok({ method: "POST", headers: { origin: "http://localhost:3000" } }).ok, true);
  assert.equal(ok({ method: "GET" }).status, 405);
  assert.equal(ok({ method: "POST" }).status, 403, "missing Origin");
  assert.equal(ok({ method: "POST", headers: { origin: "http://evil.example" } }).status, 403);
  assert.equal(ok({ method: "POST", headers: { origin: "http://localhost:3001" } }).status, 403);
  assert.equal(ok({ method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" } }).status, 403);
  const remote = refreshRequestGuard(new Request("http://trading.example.com/api/liq-zones/refresh", { method: "POST", headers: { origin: "http://trading.example.com" } }));
  assert.equal(remote.status, 403);
  assert.equal(refreshRequestGuard(new Request("http://127.0.0.1:3000/x", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } })).ok, true);
});

test("venues_failed (object or array) surfaces, unlisted venues are not warnings", () => {
  assert.deepEqual(sanitizeVenuesFailed({ htx: "boom", bitmex: "no instrument", "<script>": "x" }, ["bitmex"]), ["htx"]);
  assert.deepEqual(sanitizeVenuesFailed(["okx", { venue: "gate" }, 5]), ["okx", "gate"]);
  assert.deepEqual(sanitizeVenuesFailed("okx"), []);
});

test("priceDecimals drives price labels; 更新于 HH:MM from asOf; default-on for ZEC/PYTH only", () => {
  assert.equal(formatLiqPrice(0.0789123, 6), "0.078912");
  assert.equal(formatLiqPrice(1224.6, 2), "1224.60");
  assert.equal(formatLiqUpdatedAt("2026-10-10T14:33:56-04:00", "America/Toronto"), "更新于 14:33");
  assert.equal(formatLiqUpdatedAt("garbage"), null);
  assert.equal(liqHeatmapDefaultOn("ZECUSDT"), true);
  assert.equal(liqHeatmapDefaultOn("PYTHUSDT"), true);
  assert.equal(liqHeatmapDefaultOn("BTCUSDT"), false);
});

test("client refresh: POSTs once, re-sanitizes, maps 429 retry-after, rejects forged bodies", async () => {
  const seen = [];
  const reply = (status, body, headers = {}) => async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status, headers }); };
  const ok = await requestLiqRefresh("ZECUSDT", reply(200, { ok: true, snapshot: zec, cooldownSec: 90 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.model.zones.length, zec.zones.length);
  assert.equal(seen[0].url, "/api/liq-zones/refresh?symbol=ZECUSDT");
  assert.equal(seen[0].init.method, "POST");
  const cooling = await requestLiqRefresh("ZECUSDT", reply(429, { ok: false, error: "cooling" }, { "retry-after": "42" }));
  assert.deepEqual(cooling, { ok: false, error: "cooling", retryAfterSec: 42 });
  const forged = await requestLiqRefresh("ZECUSDT", reply(200, { ok: true, snapshot: { kind: "x" } }));
  assert.equal(forged.ok, false);
  const unsupported = await requestLiqRefresh("BTCUSDT", async () => { throw new Error("must not fetch"); });
  assert.equal(unsupported.ok, false);
});

test("UI: refresh button sits next to the flame toggle, no polling timers for recompute", () => {
  const toolbar = readFileSync(new URL("../components/drawing-toolbar.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(toolbar, /<LiqHeatmapIcon \/>\s*<\/button>\s*\{onLiqRefresh && <button[\s\S]*?aria-label="刷新清算"/);
  assert.match(toolbar, /disabled=\{liqRefreshState !== "idle"\}/);
  const timers = workspace.match(/setInterval\([^)]*\)/g) ?? [];
  assert.ok(!/requestLiqRefresh/.test(timers.join("")), "requestLiqRefresh is never on a timer");
  assert.match(workspace, /readClientPaneFlag\(window\.localStorage, LIQ_HEATMAP_STORAGE_KEY, liqHeatmapDefaultOn\(symbol, liqProbe\?\.symbol === symbol \? liqProbe\.has : null\)\)/);
});

test("anchor: zone boxes start at the bar containing asOf (open <= asOf < next open)", async () => {
  const { liqZoneAnchorTime, formatLiqComputedAt } = await import("../lib/liq-heatmap.ts");
  const asOf = "2026-10-10T14:33:56-04:00"; // 18:33:56Z
  const t = Date.parse(asOf) / 1000;
  const m15 = Array.from({ length: 200 }, (_, i) => Math.floor(t / 900) * 900 - 150 * 900 + i * 900);
  assert.equal(liqZoneAnchorTime(m15, asOf), Math.floor(t / 900) * 900, "15m: the 18:30Z bar");
  const h1 = Array.from({ length: 100 }, (_, i) => Math.floor(t / 3600) * 3600 - 50 * 3600 + i * 3600);
  assert.equal(liqZoneAnchorTime(h1, asOf), Math.floor(t / 3600) * 3600, "1h: interval switch re-anchors to the 18:00Z bar");
  assert.equal(liqZoneAnchorTime(m15, "2026-10-10T18:30:00Z"), Date.parse("2026-10-10T18:30:00Z") / 1000, "exactly on an open belongs to that bar");
  assert.equal(liqZoneAnchorTime(m15, "2020-01-01T00:00:00Z"), m15[0], "older than loaded data → first loaded bar");
  assert.equal(liqZoneAnchorTime(m15, "2030-01-01T00:00:00Z"), m15.at(-1), "newer than the latest bar → latest bar");
  assert.equal(liqZoneAnchorTime(m15, null), m15.at(-1));
  assert.equal(liqZoneAnchorTime(m15, "garbage"), m15.at(-1));
  assert.equal(liqZoneAnchorTime([], asOf), null);
  const later = "2026-10-10T16:58:10-04:00";
  assert.equal(liqZoneAnchorTime(m15, later), Math.floor(Date.parse(later) / 1000 / 900) * 900, "refresh with a new asOf moves the anchor");
  assert.equal(formatLiqComputedAt(asOf, "America/Toronto"), "计算于 14:33");
});

test("anchor wiring: workspace passes the asOf anchor (not the latest candle) and a 计算于 marker to the primitive", () => {
  const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  const primitive = readFileSync(new URL("../lib/liq-heatmap-primitive.ts", import.meta.url), "utf8");
  assert.match(workspace, /liqZoneAnchorTime\(candles\.map\(\(candle\) => Number\(candle\.time\)\), liqAsOf\)/);
  assert.match(workspace, /setZones\(showLiqHeatmap \? liqZones : \[\], liqAnchorTime as Time \| null, liqComputedLabel\)/);
  assert.doesNotMatch(workspace, /setZones\([^)]*latestCandleTime/);
  assert.match(primitive, /drawAnchorMarker\(context, anchorX/);
});
