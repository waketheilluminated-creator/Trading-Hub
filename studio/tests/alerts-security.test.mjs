import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAlertStore } from "../lib/alerts/store.ts";
import { alertsRequestGuard, createAlertEngine, readJsonBody } from "../lib/alerts/engine.ts";
import { sendMail } from "../lib/alerts/smtp.ts";
import { alertsEnvPath, parseEnvFile, resolveSmtp } from "../lib/alerts/secrets.ts";
import { validateAlertInput, normalizeEmail } from "../lib/alerts/core.ts";
import { startMockSmtp } from "../tools/mock-smtp.mjs";

const ORIGIN = "http://127.0.0.1:3000";
const req = (path, { method = "POST", origin = ORIGIN, site = "same-origin", type = "application/json", host, body = "{}", length } = {}) => {
  const headers = {};
  if (origin) headers.origin = origin;
  if (site) headers["sec-fetch-site"] = site;
  if (type) headers["content-type"] = type;
  if (host) headers.host = host;
  if (length) headers["content-length"] = String(length);
  return new Request(`${host ? `http://${host}` : ORIGIN}${path}`, { method, headers, body: method === "GET" ? undefined : body });
};

test("guard: same-origin localhost JSON POST passes", () => {
  assert.deepEqual(alertsRequestGuard(req("/api/alerts"), true), { ok: true });
  assert.deepEqual(alertsRequestGuard(req("/api/alerts", { method: "GET", origin: null, site: null, type: null }), false), { ok: true });
});

test("guard deny paths: host, origin, sec-fetch-site, method, content-type, size", () => {
  assert.equal(alertsRequestGuard(req("/api/alerts", { host: "evil.example:3000" }), true).status, 403);
  assert.equal(alertsRequestGuard(req("/api/alerts", { host: "192.168.1.5:3000" }), true).status, 403);
  assert.equal(alertsRequestGuard(req("/api/alerts", { origin: "http://evil.example" }), true).status, 403);
  assert.equal(alertsRequestGuard(req("/api/alerts", { origin: "http://localhost:3000" }), true).status, 403, "different origin than request URL");
  assert.equal(alertsRequestGuard(req("/api/alerts", { origin: null }), true).status, 403);
  assert.equal(alertsRequestGuard(req("/api/alerts", { site: "cross-site" }), true).status, 403);
  assert.equal(alertsRequestGuard(req("/api/alerts/log", { method: "GET", origin: null, site: "cross-site", type: null }), false).status, 403, "cross-site reads blocked");
  assert.equal(alertsRequestGuard(req("/api/alerts", { method: "PUT" }), true).status, 405);
  assert.equal(alertsRequestGuard(req("/api/alerts", { type: "text/plain" }), true).status, 415);
  assert.equal(alertsRequestGuard(req("/api/alerts", { type: "application/x-www-form-urlencoded" }), true).status, 415);
  assert.equal(alertsRequestGuard(req("/api/alerts", { length: 9000 }), true).status, 413);
});

test("body: oversize and invalid JSON rejected even without content-length", async () => {
  assert.equal((await readJsonBody(new Request(ORIGIN, { method: "POST", body: "x".repeat(9000) }))).status, 413);
  assert.equal((await readJsonBody(new Request(ORIGIN, { method: "POST", body: "{nope" }))).status, 400);
});

const good = { symbol: "BTCUSDT", venue: "binance", interval: "1", operator: "crossing", level: 100, frequency: "once" };
test("validation deny paths: symbol, unknown fields, NaN/Infinity/negative, enums, expiry, control chars", () => {
  const now = 1_000_000;
  for (const bad of [
    { ...good, symbol: "btcusdt" }, { ...good, symbol: "../../etc" }, { ...good, symbol: "BTC USDT" }, { ...good, symbol: "BTCUSD" },
    { ...good, evil: 1 }, { ...good, __proto__x: 1 },
    { ...good, level: NaN }, { ...good, level: Infinity }, { ...good, level: -1 }, { ...good, level: "100" }, { ...good, level: 0 },
    { ...good, venue: "ftx" }, { ...good, interval: "7" }, { ...good, operator: "eval" }, { ...good, frequency: "always" },
    { ...good, expiresAt: now - 1 }, { ...good, expiresAt: now + 400 * 86400_000 }, { ...good, expiresAt: "tomorrow" },
    { ...good, name: "a\r\nBcc: x@y.z" }, { ...good, name: "x".repeat(81) }, { ...good, message: "x".repeat(1001) }, { ...good, message: "a\u0000b" },
    null, [], "str",
  ]) assert.equal(validateAlertInput(bad, now).ok, false, JSON.stringify(bad));
  assert.equal(validateAlertInput(good, now).ok, true);
});

test("recipient validation: strict single address", () => {
  for (const bad of ["", "a", "a@b", "a@b.c", "a,b@c.com", "a@c.com, b@d.com", "a@c.com\r\nBcc: x@y.com", "<a@c.com>", "a b@c.com", "a..b@c.com", ".a@c.com", "a@-c.com", 42, null, "x".repeat(250) + "@c.com"]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  assert.equal(normalizeEmail(" wake@example.com "), "wake@example.com");
});

function settingsHarness(sendImpl) {
  const store = createAlertStore(new DatabaseSync(":memory:"));
  let clock = 5_000_000;
  const mails = [];
  const engine = createAlertEngine({
    store, envPath: "C:\\Users\\wake\\.tradinghub\\alerts.env",
    fetchKlines: async () => [],
    resolveSmtp: async () => ({ ok: true, config: { host: "smtp.gmail.com", port: 465, secure: true, user: "me@gmail.com", pass: "abcd efgh ijkl mnop", from: "me@gmail.com" } }),
    sendMail: sendImpl ?? (async (_c, m) => { mails.push(m); }),
    now: () => clock, randomId: () => "rid-00000001", randomCode: () => "424242", hash: (t) => `h:${t}`, safeEqual: (a, b) => a === b,
  });
  return { store, engine, mails, advance: (ms) => { clock += ms; } };
}

test("verification flow: set → send-test → verify; change resets; attempts and expiry enforced", async () => {
  const h = settingsHarness();
  assert.equal((await h.engine.updateSettings({ action: "send-test" })).status, 409);
  assert.equal((await h.engine.updateSettings({ action: "set", email: "a@b.c" })).status, 400);
  assert.equal((await h.engine.updateSettings({ action: "set", email: "wake@example.com", extra: 1 })).status, 400);
  assert.equal((await h.engine.updateSettings({ action: "set", email: "wake@example.com" })).status, 200);
  assert.equal((await h.engine.updateSettings({ action: "send-test" })).status, 200);
  assert.equal(h.mails.length, 1);
  assert.match(h.mails[0].text, /424242/);
  assert.equal((await h.engine.updateSettings({ action: "send-test" })).status, 429, "throttled to 1/min");
  assert.equal((await h.engine.updateSettings({ action: "verify", code: "000000" })).status, 400);
  const okRes = await h.engine.updateSettings({ action: "verify", code: "424242" });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.settings.verified, true);
  // Same address again keeps verification; a different one resets it.
  assert.equal((await h.engine.updateSettings({ action: "set", email: "wake@example.com" })).body.settings.verified, true);
  assert.equal((await h.engine.updateSettings({ action: "set", email: "other@example.com" })).body.settings.verified, false);
  // Brute force: 5 wrong attempts burn the code.
  h.advance(61_000);
  await h.engine.updateSettings({ action: "send-test" });
  for (let i = 0; i < 5; i += 1) assert.equal((await h.engine.updateSettings({ action: "verify", code: "111111" })).status, 400);
  assert.equal((await h.engine.updateSettings({ action: "verify", code: "424242" })).status, 409, "code burned after 5 failures");
  // Expiry.
  h.advance(61_000);
  await h.engine.updateSettings({ action: "send-test" });
  h.advance(16 * 60_000);
  assert.equal((await h.engine.updateSettings({ action: "verify", code: "424242" })).status, 410);
});

test("secrets never leak through API responses, logs or stored settings", async () => {
  const logs = [];
  const h = settingsHarness(async () => { const e = new Error("SMTP AUTH failed (535)"); e.name = "SmtpError"; e.permanent = true; throw e; });
  await h.engine.updateSettings({ action: "set", email: "wake@example.com" });
  const res = await h.engine.updateSettings({ action: "send-test" });
  assert.equal(res.status, 502);
  const everything = JSON.stringify([res, await h.engine.getSettings(), h.store.getSettings(), logs]);
  assert.doesNotMatch(everything, /abcd efgh|ijkl mnop|me@gmail\.com/);
  assert.doesNotMatch(JSON.stringify((await h.engine.getSettings()).body), /424242|codeHash|h:/);
  // Unknown SMTP errors are generic (no server banner / creds).
  const g = settingsHarness(async () => { throw new Error("connect ECONNREFUSED pass=abcd efgh"); });
  await g.engine.updateSettings({ action: "set", email: "wake@example.com" });
  const r2 = await g.engine.updateSettings({ action: "send-test" });
  assert.equal(r2.body.error, "SMTP connection failed.");
});

test("env file: parse whitelist, owner-only mode on POSIX, plaintext only to loopback, creds never over plaintext", async () => {
  assert.deepEqual(parseEnvFile("# c\nGMAIL_USER=me@gmail.com\nGMAIL_APP_PASSWORD=\"abcd efgh ijkl mnop\"\nOTHER=1\n"), { GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" });
  assert.equal(alertsEnvPath({ USERPROFILE: "C:\\Users\\wake" }, "win32", "C:\\x", (...p) => p.join("\\")), "C:\\Users\\wake\\.tradinghub\\alerts.env");
  assert.equal(alertsEnvPath({}, "darwin", "/Users/wake", (...p) => p.join("/")), "/Users/wake/.tradinghub/alerts.env");
  const file = "GMAIL_USER=me@gmail.com\nGMAIL_APP_PASSWORD=abcdefghijklmnop\n";
  const fs = (mode) => ({ readFile: async () => file, stat: async () => ({ mode }) });
  assert.equal((await resolveSmtp({}, "/x", fs(0o100644), "darwin")).ok, false, "group/other readable refused");
  const okRes = await resolveSmtp({}, "/x", fs(0o100600), "darwin");
  assert.equal(okRes.ok, true);
  assert.equal(okRes.config.host, "smtp.gmail.com");
  assert.equal(okRes.config.secure, true);
  assert.equal((await resolveSmtp({ ALERTS_SMTP_HOST: "mail.evil.com", ALERTS_SMTP_SECURE: "0" }, "/x", fs(0o100600), "darwin")).ok, false);
  const mock = await resolveSmtp({ ALERTS_SMTP_HOST: "127.0.0.1", ALERTS_SMTP_PORT: "2525", ALERTS_SMTP_SECURE: "0" }, "/x", fs(0o100600), "darwin");
  assert.equal(mock.ok, true);
  assert.equal(mock.config.user, null);
  assert.equal(mock.config.pass, null);
  const missing = await resolveSmtp({}, "/x", { readFile: async () => { throw new Error("ENOENT"); }, stat: async () => { throw new Error("ENOENT"); } }, "win32");
  assert.equal(missing.ok, false);
});

test("SMTP client against an in-test mock server: delivers, dot-stuffs, rejects CRLF recipients", async () => {
  const got = [];
  const server = await startMockSmtp({ port: 0, onMessage: (m) => got.push(m) });
  const { port } = server.address();
  const config = { host: "127.0.0.1", port, secure: false, user: null, pass: null, from: "alerts@tradinghub.local" };
  await sendMail(config, { to: "wake@example.com", subject: "[Trading Hub] BTC 价格提醒", text: "line1\n.hidden\nend", html: "<p>hi</p>" });
  await assert.rejects(sendMail(config, { to: "a@b.com\r\nRCPT TO:<x@y.z>", subject: "s", text: "t", html: "h" }));
  server.close();
  assert.equal(got.length, 1);
  assert.equal(got[0].envelope.to[0], "<wake@example.com>");
  assert.equal(got[0].subject, "[Trading Hub] BTC 价格提醒");
  assert.equal(got[0].text, "line1\r\n.hidden\r\nend".replace(/\r\n/g, "\n"));
  assert.equal(got[0].html, "<p>hi</p>");
});

test("repo hygiene: no credentials or env files tracked; client code never imports server alert modules", () => {
  const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8") + readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /\.env/);
  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const dir of ["components", "app"]) {
    for (const file of walk(new URL(`../${dir}`, import.meta.url).pathname)) {
      if (file.includes(`${join("app", "api")}`)) continue;
      const src = readFileSync(file, "utf8");
      assert.doesNotMatch(src, /lib\/alerts\/(server|smtp|secrets|store|http)/, file);
      assert.doesNotMatch(src, /process\.env\.GMAIL|GMAIL_APP_PASSWORD=[A-Za-z0-9]/, file);
    }
  }
});
