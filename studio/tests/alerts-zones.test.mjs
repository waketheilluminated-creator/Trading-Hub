import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAlertStore } from "../lib/alerts/store.ts";
import { alertsRequestGuard, createAlertEngine } from "../lib/alerts/engine.ts";
import { evaluateZone, normalizeZoneSpecs, syncZoneStates, validateZoneAction, zoneFireMessage, zoneKey, MAX_ZONE_GROUPS } from "../lib/alerts/zones.ts";
import { isMarketVenue } from "../lib/market-venues.ts";
import { ZONE_ALERT_LABEL } from "../lib/alerts/client.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
// Real BTC zones from the estimator after the TH-BUG-05 fix (2026-10-17, mark 81340).
const BTC_ZONES = [
  { role: "support", lo: 72799.3, hi: 73612.7, liq_m: 1642.63 },
  { role: "support", lo: 79306.5, hi: 80119.9, liq_m: 3198.6 },
  { role: "resistance", lo: 89067.3, hi: 89880.7, liq_m: 812.4 },
];

function harness({ zones = BTC_ZONES, asOf = "2026-10-17T21:00:00Z" } = {}) {
  const store = createAlertStore(new DatabaseSync(":memory:"));
  let clock = T0;
  let price = 81340;
  let source = { asOf, zones: normalizeZoneSpecs(zones), decimals: 1 };
  const mails = [];
  let n = 0;
  const engine = createAlertEngine({
    store,
    envPath: "/home/u/.tradinghub/alerts.env",
    fetchKlines: async () => {
      const bar = Math.floor(clock / MIN) * MIN / 1000; // UNIX seconds like the real feed
      return [
        { time: bar - 60, open: price, high: price, low: price, close: price, volume: 1 },
        { time: bar, open: price, high: price, low: price, close: price, volume: 1 },
      ];
    },
    resolveSmtp: async () => ({ ok: true, config: { host: "127.0.0.1", port: 2525, secure: false, user: null, pass: null, from: "a@b.co" } }),
    sendMail: async (_c, m) => { mails.push(m); },
    now: () => clock,
    randomId: () => `zg-${String(++n).padStart(8, "0")}`,
    randomCode: () => "123456",
    hash: (t) => `h:${t}`,
    safeEqual: (a, b) => a === b,
    loadZones: async () => source,
  });
  store.setSettings({ email: "wake@example.com", verified: true, codeHash: null, codeExpiresAt: null, codeAttempts: 0, lastTestAt: null });
  const api = {
    store, engine, mails,
    get now() { return clock; },
    setZones(next, nextAsOf) { source = { asOf: nextAsOf, zones: normalizeZoneSpecs(next), decimals: 1 }; },
    async at(p, advance = 5_000) { clock += advance; price = p; await engine.tick(); await engine.pump(); },
    async enable(symbol = "BTCUSDT", venue = "binance") { return engine.zoneAction({ action: "enable", symbol, venue }); },
    fires: () => store.listLog(0, 500),
  };
  return api;
}

test("entering resistance from below fires once with symbol, role, range, liq_m and price; email + log (toast)", async () => {
  const h = harness();
  assert.equal((await h.enable()).status, 201);
  await h.at(88000);
  await h.at(88900);
  assert.equal(h.fires().length, 0);
  await h.at(89100);
  const fires = h.fires();
  assert.equal(fires.length, 1);
  assert.match(fires[0].message, /BTCUSDT/);
  assert.match(fires[0].message, /阻力区 resistance/);
  assert.match(fires[0].message, /89067\.3–89880\.7/);
  assert.match(fires[0].message, /\$812M/);
  assert.match(fires[0].message, /价格 89100\.0/);
  assert.match(fires[0].message, /从下方 from below/);
  assert.equal(fires[0].emailStatus, "sent");
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, "wake@example.com");
  assert.match(h.mails[0].subject, /BTCUSDT 阻力 89067\.3–89880\.7/);
  // Staying inside does not fire again.
  await h.at(89500); await h.at(89300, MIN);
  assert.equal(h.fires().length, 1);
});

test("entering support from above fires; a jump straight through a zone also counts", async () => {
  const h = harness();
  await h.enable();
  await h.at(81000);
  await h.at(80000);
  assert.equal(h.fires().length, 1);
  assert.match(h.fires()[0].message, /支撑区 support 79306\.5–80119\.9/);
  assert.match(h.fires()[0].message, /从上方 from above/);
  // Gap through the lower support between two polls.
  await h.at(75000, MIN); await h.at(72000, MIN);
  const lower = h.fires().filter((e) => /72799\.3–73612\.7/.test(e.message));
  assert.equal(lower.length, 1);
});

test("no fire when price is already inside a zone at creation; fires only after exit + buffer and re-entry", async () => {
  const h = harness();
  await h.at(79800, 0);
  assert.equal((await h.enable()).status, 201);
  await h.at(79800); await h.at(79700); await h.at(80000);
  assert.equal(h.fires().length, 0, "already inside → silent");
  // Leave by less than the 0.1% buffer and come back: still not armed.
  await h.at(80150); await h.at(80100);
  assert.equal(h.fires().length, 0);
  // Leave clearly, come back.
  await h.at(80300); await h.at(80050, MIN);
  assert.equal(h.fires().length, 1);
});

test("re-arm: once per entry, re-arms after exit + buffer, at most one fire per minute per zone", async () => {
  const h = harness();
  await h.enable();
  await h.at(80500);
  await h.at(80000);
  assert.equal(h.fires().length, 1);
  await h.at(80300, 5_000); // re-armed (outside > 0.1%)
  await h.at(80000, 5_000); // re-entry 10s after the fire → rate-limited, consumed
  assert.equal(h.fires().length, 1, "≤1 fire/min per zone");
  await h.at(79900, MIN); // still inside → no late fire
  assert.equal(h.fires().length, 1);
  await h.at(80400, 5_000); await h.at(80000, 5_000);
  assert.equal(h.fires().length, 2, "re-armed entry after a minute fires again");
  const zone = evaluateZone({ ...syncZoneStates([], normalizeZoneSpecs(BTC_ZONES))[1], phase: "above", armed: false }, 80125, T0);
  assert.equal(zone.next.armed, false, "inside the buffer does not re-arm");
});

test("zone refresh (刷新清算 / new asOf): unchanged zones keep state, new zones start unarmed, removed zones stop", async () => {
  const h = harness();
  await h.enable();
  await h.at(81340);
  const before = h.store.listZoneGroups()[0];
  assert.equal(before.zones.length, 3);
  assert.ok(before.zones.every((z) => z.armed));
  // New snapshot: the 79306 support moves to sit around price; 89067 resistance unchanged; 72799 gone.
  h.setZones([
    { role: "support", lo: 81000, hi: 81600, liq_m: 2500 },
    { role: "resistance", lo: 89067.3, hi: 89880.7, liq_m: 900 },
  ], "2026-10-17T22:00:00Z");
  await h.at(81340);
  const after = h.store.listZoneGroups()[0];
  assert.equal(after.asOf, "2026-10-17T22:00:00Z");
  assert.deepEqual(after.zones.map((z) => z.key), [zoneKey({ role: "support", lo: 81000, hi: 81600 }), zoneKey({ role: "resistance", lo: 89067.3, hi: 89880.7 })]);
  assert.equal(after.zones[1].armed, true, "unchanged zone keeps its state");
  assert.equal(after.zones[1].liqM, 900, "liq_m updated");
  assert.equal(after.zones[0].armed, false, "price already inside the new zone → not armed");
  await h.at(81200); await h.at(81500);
  assert.equal(h.fires().length, 0, "refresh around price never fires instantly");
  await h.at(80000, MIN); // the old 79306–80119 zone was removed → no fire
  assert.equal(h.fires().length, 0);
});

test("test zones are labeled [TEST ZONE]; one group per symbol + venue; disable removes it; cap enforced", async () => {
  const msg = zoneFireMessage("BTCUSDT", "binance", { zone: { ...syncZoneStates([], normalizeZoneSpecs([{ role: "support", lo: 1, hi: 2, liq_m: 0.5 }], true))[0] }, direction: "from_above", price: 1.5 }, 1);
  assert.match(msg.message, /^\[TEST ZONE\] BTCUSDT/);
  assert.match(msg.title, /^\[TEST ZONE\]/);
  assert.match(msg.subject, /\[TEST ZONE\]/);
  const h = harness();
  assert.equal((await h.enable()).status, 201);
  assert.equal((await h.enable()).status, 200, "idempotent enable");
  assert.equal(h.store.listZoneGroups().length, 1);
  assert.equal((await h.enable("BTCUSDT", "bybit")).status, 201, "separate venue → separate group");
  assert.equal(h.engine.listAlerts().body.zoneGroups.length, 2);
  assert.equal((await h.engine.zoneAction({ action: "disable", symbol: "BTCUSDT", venue: "bybit" })).status, 200);
  assert.equal((await h.engine.zoneAction({ action: "disable", symbol: "BTCUSDT", venue: "bybit" })).status, 404);
  for (let i = 0; i < MAX_ZONE_GROUPS - 1; i += 1) await h.enable(`C${i}USDT`, "okx");
  assert.equal((await h.enable("LASTUSDT", "okx")).status, 409);
  const empty = harness({ zones: [] });
  assert.equal((await empty.enable()).status, 409, "no zones → cannot enable");
});

test("Tier C deny paths for /api/alerts/zones: strict body, venue/symbol validation, guard", async () => {
  const bad = [
    null, [], "x", {}, { action: "enable" }, { action: "enable", symbol: "BTCUSDT" },
    { action: "nuke", symbol: "BTCUSDT", venue: "binance" },
    { action: "enable", symbol: "btc/usdt", venue: "binance" },
    { action: "enable", symbol: "../../etc", venue: "binance" },
    { action: "enable", symbol: "BTCUSDT", venue: "evil" },
    { action: "enable", symbol: "BTCUSDT", venue: "binance", admin: true },
    { action: "enable", symbol: "BTCUSDT", venue: "binance", zones: [{ role: "support", lo: 1, hi: 2 }] },
  ];
  for (const body of bad) assert.equal(validateZoneAction(body, isMarketVenue).ok, false, JSON.stringify(body));
  const h = harness();
  for (const body of bad) assert.equal((await h.engine.zoneAction(body)).status, 400);
  assert.equal(h.store.listZoneGroups().length, 0, "client cannot inject zones");
  const ORIGIN = "http://127.0.0.1:3000";
  const req = (init = {}) => new Request(`${init.url ?? ORIGIN}/api/alerts/zones`, { method: init.method ?? "POST", headers: init.headers ?? { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: (init.method ?? "POST") === "GET" ? undefined : "{}" });
  assert.deepEqual(alertsRequestGuard(req(), true), { ok: true });
  assert.equal(alertsRequestGuard(req({ url: "http://192.168.1.5:3000" }), true).status, 403);
  assert.equal(alertsRequestGuard(req({ headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" } }), true).status, 403);
  assert.equal(alertsRequestGuard(req({ headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" } }), true).status, 403, "missing Origin");
  assert.equal(alertsRequestGuard(req({ headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "text/plain" } }), true).status, 415);
  assert.equal(alertsRequestGuard(req({ method: "PUT" }), true).status, 405);
  const route = readFileSync(new URL("../app/api/alerts/zones/route.ts", import.meta.url), "utf8");
  assert.match(route, /handle\(request, true,/);
  assert.match(route, /export const (PUT|DELETE|PATCH) = methodNotAllowed/);
  const src = readFileSync(new URL("../lib/alerts/zone-source.ts", import.meta.url), "utf8");
  assert.match(src, /env\.ALERTS_TEST_ZONES_FILE/, "test zones only from operator env");
});

test("UI: bell toggle in the liq legend with the Chinese label; manager lists zone groups", () => {
  assert.equal(ZONE_ALERT_LABEL, "价格触及支撑/阻力区时提醒");
  const ws = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(ws, /data-liq-zone-alert=/);
  assert.match(ws, /aria-label=\{ZONE_ALERT_LABEL\}/);
  assert.match(ws, /alertsApi\.zones\(zoneAlertsOn \? "disable" : "enable", symbol, chartVenue\)/);
  const mgr = readFileSync(new URL("../components/alert-manager.tsx", import.meta.url), "utf8");
  assert.match(mgr, /data-zone-alert-row/);
});
