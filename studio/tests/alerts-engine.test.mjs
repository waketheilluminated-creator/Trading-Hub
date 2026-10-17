import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { evaluateAlert, conditionMet, renderAlertTemplate, validateAlertInput, normalizeEmail, headerSafe, GLOBAL_EMAIL_CAP_PER_HOUR } from "../lib/alerts/core.ts";
import { createAlertStore } from "../lib/alerts/store.ts";
import { createAlertEngine } from "../lib/alerts/engine.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

/** Replay harness: fake clock, fake kline feed (two candles: last closed + forming), captured mail. */
function harness({ smtpOk = true, sendImpl } = {}) {
  const store = createAlertStore(new DatabaseSync(":memory:"));
  let clock = T0;
  let candles = [];
  const mails = [];
  let n = 0;
  const engine = createAlertEngine({
    store,
    envPath: "/home/u/.tradinghub/alerts.env",
    fetchKlines: async () => candles,
    resolveSmtp: async () => (smtpOk ? { ok: true, config: { host: "127.0.0.1", port: 2525, secure: false, user: null, pass: null, from: "a@b.co" } } : { ok: false, reason: "Email is not configured: alerts.env not found." }),
    sendMail: sendImpl ?? (async (_c, m) => { mails.push(m); }),
    now: () => clock,
    randomId: () => `id-${String(++n).padStart(8, "0")}`,
    randomCode: () => "123456",
    hash: (t) => `h:${t}`,
    safeEqual: (a, b) => a === b,
  });
  const api = {
    store, engine, mails,
    set now(v) { clock = v; }, get now() { return clock; },
    /** Price sample on a forming 1m bar opening at barOpen. */
    feed(price, barOpen = Math.floor(clock / MIN) * MIN, closedClose = price) {
      candles = [
        { time: barOpen - MIN, open: closedClose, high: closedClose, low: closedClose, close: closedClose, volume: 10 },
        { time: barOpen, open: price, high: price, low: price, close: price, volume: 5 },
      ];
    },
    feedRaw(raw) { candles = raw; },
    async step(price, advanceMs = 5_000, closedClose) {
      clock += advanceMs;
      api.feed(price, undefined, closedClose ?? price);
      await engine.tick();
      await engine.pump();
    },
    create(overrides) {
      const r = engine.createAlert({ symbol: "BTCUSDT", venue: "binance", interval: "1", operator: "crossing", level: 100, frequency: "every", ...overrides });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.alert.id;
    },
    fired: (id) => store.listLog(0, 500).filter((e) => e.alertId === id).length,
    verify() {
      store.setSettings({ email: "wake@example.com", verified: true, codeHash: null, codeExpiresAt: null, codeAttempts: 0, lastTestAt: null });
    },
  };
  return api;
}

test("conditions: crossings need a previous sample; greater/less are strict", () => {
  assert.equal(conditionMet("crossing_up", null, 101, 100), false);
  assert.equal(conditionMet("crossing_up", 99, 100, 100), true);
  assert.equal(conditionMet("crossing_up", 101, 102, 100), false);
  assert.equal(conditionMet("crossing_down", 101, 100, 100), true);
  assert.equal(conditionMet("crossing", 99, 101, 100), true);
  assert.equal(conditionMet("crossing", 101, 99, 100), true);
  assert.equal(conditionMet("greater_than", null, 100, 100), false);
  assert.equal(conditionMet("greater_than", null, 100.01, 100), true);
  assert.equal(conditionMet("less_than", null, 99.99, 100), true);
});

for (const [operator, path, expectFires] of [
  ["crossing", [95, 98, 101, 103, 99], 2],
  ["crossing_up", [95, 101, 99, 102], 2],
  ["crossing_down", [105, 99, 101, 98], 2],
  ["greater_than", [95, 101], 1],
  ["less_than", [105, 99], 1],
]) {
  test(`replay ${operator}: fires on the expected samples (every, spaced ≥1 min)`, async () => {
    const h = harness();
    const id = h.create({ operator, frequency: "every" });
    for (const price of path) await h.step(price, 61_000);
    assert.equal(h.fired(id), expectFires);
  });
}

test("no immediate fire when created on the far side (crossing_up above level, crossing_down below)", async () => {
  const h = harness();
  const up = h.create({ operator: "crossing_up", level: 100 });
  const down = h.create({ operator: "crossing_down", level: 100 });
  const cross = h.create({ operator: "crossing", level: 100 });
  // Price already above 100: up must wait for a dip below and a re-cross; down is on the far side too (above → needs cross down).
  await h.step(105); await h.step(106); await h.step(107);
  assert.equal(h.fired(up), 0);
  assert.equal(h.fired(cross), 0);
  assert.equal(h.fired(down), 0);
  await h.step(99, 61_000);
  assert.equal(h.fired(down), 1);
  assert.equal(h.fired(up), 0);
  await h.step(101, 61_000);
  assert.equal(h.fired(up), 1);
});

test("once stops after the first fire", async () => {
  const h = harness();
  const id = h.create({ operator: "crossing", frequency: "once" });
  await h.step(95); await h.step(105, 61_000); await h.step(95, 61_000); await h.step(105, 61_000);
  assert.equal(h.fired(id), 1);
  assert.equal(h.store.getAlert(id).status, "stopped");
});

test("every is capped at 1 per minute", async () => {
  const h = harness();
  const id = h.create({ operator: "greater_than", frequency: "every" });
  for (let i = 0; i < 24; i += 1) await h.step(105, 5_000); // 2 minutes of 5s samples
  assert.ok(h.fired(id) <= 3 && h.fired(id) >= 2, `fired ${h.fired(id)}`);
  const times = h.store.listLog(0, 100).map((e) => e.firedAt).sort();
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= MIN);
});

test("bar_close ignores intrabar crosses and fires only at bar close", async () => {
  const h = harness();
  const id = h.create({ operator: "greater_than", frequency: "bar_close" });
  // Bar A (opened before creation, closes after): forming price spikes above but closes below.
  const barA = Math.floor(h.now / MIN) * MIN;
  h.now = barA + 10_000; h.feed(105, barA, 90); await h.engine.tick();
  h.now = barA + 30_000; h.feed(110, barA, 90); await h.engine.tick();
  assert.equal(h.fired(id), 0, "intrabar must not fire");
  // Bar A closes at 95 (< 100): no fire.
  h.now = barA + MIN + 2_000; h.feed(101, barA + MIN, 95); await h.engine.tick();
  assert.equal(h.fired(id), 0);
  // Bar B closes at 101: fires once, repeated polls of the same closed bar do not refire.
  h.now = barA + 2 * MIN + 2_000; h.feed(101, barA + 2 * MIN, 101); await h.engine.tick();
  h.now = barA + 2 * MIN + 7_000; await h.engine.tick();
  assert.equal(h.fired(id), 1);
});

test("bar_close: a bar that closed before the alert existed never fires", async () => {
  const h = harness();
  const barOpen = Math.floor(h.now / MIN) * MIN;
  h.feed(101, barOpen, 150);
  const id = h.create({ operator: "greater_than", frequency: "bar_close" });
  h.now += 3_000; await h.engine.tick();
  assert.equal(h.fired(id), 0);
});

test("expiry: alert expires and never fires afterwards", async () => {
  const h = harness();
  const id = h.create({ operator: "greater_than", expiresAt: T0 + 2 * MIN });
  await h.step(95, 10_000);
  h.now = T0 + 3 * MIN;
  await h.step(150, 0);
  assert.equal(h.fired(id), 0);
  assert.equal(h.store.getAlert(id).status, "expired");
  assert.equal(validateAlertInput({ symbol: "BTCUSDT", venue: "binance", interval: "1", operator: "crossing", level: 1, frequency: "once" }, T0).value.expiresAt, T0 + 30 * 24 * 3600_000);
});

test("dedupe: same alert + same bar/minute is logged and emailed once (restart replay)", async () => {
  const h = harness();
  h.verify();
  const id = h.create({ operator: "greater_than", frequency: "once" });
  await h.step(105);
  // Simulate a crash before state save: reactivate with the same counters and re-run the same bar.
  const a = h.store.getAlert(id);
  h.store.saveAlert({ ...a, status: "active", firedCount: 0, lastFiredAt: null, lastFiredBar: null });
  await h.engine.tick(); await h.engine.pump();
  assert.equal(h.fired(id), 1);
  assert.equal(h.mails.length, 1);
});

test(`global cap: at most ${GLOBAL_EMAIL_CAP_PER_HOUR} emails per hour, the rest are marked capped`, async () => {
  const h = harness();
  h.verify();
  for (let i = 0; i < 40; i += 1) h.create({ operator: "greater_than", frequency: "once", name: `cap ${i}` });
  await h.step(105);
  assert.equal(h.mails.length, GLOBAL_EMAIL_CAP_PER_HOUR);
  const statuses = h.store.listLog(0, 100).map((e) => e.emailStatus);
  assert.equal(statuses.filter((s) => s === "sent").length, 30);
  assert.equal(statuses.filter((s) => s === "capped").length, 10);
});

test("retry with backoff on transient SMTP failure, permanent 5xx fails fast", async () => {
  let calls = 0;
  const h = harness({ sendImpl: async () => { calls += 1; if (calls < 3) { const e = new Error("SMTP message failed (421)"); e.name = "SmtpError"; e.permanent = false; throw e; } } });
  h.verify();
  const id = h.create({ operator: "greater_than", frequency: "once" });
  await h.step(105);
  assert.equal(h.store.listLog(0, 10)[0].emailStatus, "retrying");
  h.now += 10_000; await h.engine.pump();
  assert.equal(calls, 1, "not before the 30s backoff");
  h.now += 30_000; await h.engine.pump();
  assert.equal(calls, 2);
  h.now += 120_000; await h.engine.pump();
  assert.equal(calls, 3);
  assert.equal(h.store.listLog(0, 10)[0].emailStatus, "sent");
  assert.equal(h.fired(id), 1);

  const p = harness({ sendImpl: async () => { const e = new Error("SMTP RCPT TO failed (550)"); e.name = "SmtpError"; e.permanent = true; throw e; } });
  p.verify();
  p.create({ operator: "greater_than", frequency: "once" });
  await p.step(105);
  assert.equal(p.store.listLog(0, 10)[0].emailStatus, "failed");
});

test("no email without a verified recipient; log still records the fire for the toast", async () => {
  const h = harness();
  h.store.setSettings({ email: "wake@example.com", verified: false, codeHash: null, codeExpiresAt: null, codeAttempts: 0, lastTestAt: null });
  h.create({ operator: "greater_than", frequency: "once" });
  await h.step(105);
  assert.equal(h.mails.length, 0);
  assert.equal(h.store.listLog(0, 10)[0].emailStatus, "no-recipient");
});

test("placeholders render in log and email; HTML is escaped; subject is header-safe", async () => {
  const h = harness();
  h.verify();
  h.create({ operator: "greater_than", frequency: "once", name: "BTC <b>x</b>", message: "{{ticker}} on {{exchange}} {{interval}} > {{level}} close={{close}} <script>{{unknown}}" });
  await h.step(105);
  const entry = h.store.listLog(0, 10)[0];
  assert.equal(entry.message, "BTCUSDT on BINANCE 1 > 100 close=105 <script>{{unknown}}");
  assert.match(h.mails[0].html, /&lt;script&gt;/);
  assert.doesNotMatch(h.mails[0].html, /<script>/);
  assert.equal(h.mails[0].subject, "[Trading Hub] BTC <b>x</b>");
  assert.equal(headerSafe("a\r\nBcc: evil@x.com"), "a Bcc: evil@x.com");
  assert.equal(renderAlertTemplate("{{time}} {{timenow}}", { ticker: "", exchange: "", interval: "", level: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, time: T0, timenow: T0, name: "" }), "2026-10-12T12:00:00Z 2026-10-12T12:00:00Z");
});

test("pause stops evaluation; resume re-arms without an instant crossing fire", async () => {
  const h = harness();
  const id = h.create({ operator: "crossing_up", level: 100 });
  await h.step(95);
  assert.equal(h.engine.alertAction({ id, action: "pause" }).status, 200);
  await h.step(105, 61_000);
  assert.equal(h.fired(id), 0);
  assert.equal(h.engine.alertAction({ id, action: "resume" }).status, 200);
  await h.step(106, 61_000);
  assert.equal(h.fired(id), 0, "resume above the level must not fire");
  assert.equal(h.engine.alertAction({ id, action: "delete" }).status, 200);
  assert.equal(h.store.getAlert(id), null);
});

test("evaluateAlert ignores non-finite prices", () => {
  const base = { id: "x", name: "", symbol: "BTCUSDT", venue: "binance", interval: "1", operator: "greater_than", level: 1, frequency: "every", expiresAt: null, message: "", status: "active", createdAt: 0, firedCount: 0, lastFiredAt: null, lastFiredBar: null, prevPrice: null, lastClosedBar: null };
  assert.equal(evaluateAlert(base, { price: NaN, barTime: 0, closed: false, now: 1 }).fire, false);
  assert.equal(normalizeEmail("Wake@Example.COM"), "Wake@example.com");
});

test("candles in UNIX seconds (live feed format) are normalised to ms: bar_close fires and {{time}} is correct", async () => {
  const h = harness();
  h.verify();
  const id = h.create({ operator: "greater_than", frequency: "bar_close", message: "{{time}}" });
  const barA = Math.floor(h.now / MIN) * MIN;
  const secs = (price, open, closedClose) => [
    { time: (open - MIN) / 1000, open: closedClose, high: closedClose, low: closedClose, close: closedClose, volume: 1 },
    { time: open / 1000, open: price, high: price, low: price, close: price, volume: 1 },
  ];
  h.now = barA + 2 * MIN + 2_000;
  h.feedRaw(secs(101, barA + 2 * MIN, 105));
  await h.engine.tick(); await h.engine.pump();
  assert.equal(h.fired(id), 1);
  assert.equal(h.store.listLog(0, 10)[0].message, new Date(barA + MIN).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.doesNotMatch(h.mails[0].text, /1970/);
});
