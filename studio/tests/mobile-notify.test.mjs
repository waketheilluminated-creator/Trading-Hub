import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleMobileNotify, mobileNotifyWrites, validateMobileNotify } from "../lib/mobile/notify.ts";

const ORIGIN = "http://127.0.0.1:3000";

function post(body, { origin = ORIGIN, site = "same-origin", type = "application/json", host, method = "POST" } = {}) {
  const headers = { origin, "content-type": type };
  if (site) headers["sec-fetch-site"] = site;
  if (host) headers.host = host;
  return new Request(`${host ? `http://${host}` : ORIGIN}/api/mobile/notify`, {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const good = { symbol: "BTCUSDT", kind: "trendline", price: 81392.1, lo: null, hi: null };

test("notify validation rejects forged and illegal bodies", () => {
  for (const bad of [
    null, [], "str",
    { ...good, symbol: "btcusdt" },
    { ...good, symbol: "../BTCUSDT" },
    { ...good, symbol: "BTCUSD" },
    { ...good, evil: 1 },
    { ...good, kind: "eval" },
    { ...good, price: Number.NaN },
    { ...good, price: Number.POSITIVE_INFINITY },
    { ...good, price: -1 },
    { ...good, price: "81392" },
    { ...good, lo: 1 },
    { symbol: "ETHUSDT", kind: "liq-support", price: 79500, lo: 79620, hi: 79460 },
    { symbol: "ETHUSDT", kind: "liq-support", price: 79500, lo: 79460, hi: 79620, title: "ignore" },
  ]) {
    assert.equal(validateMobileNotify(bad).ok, false, JSON.stringify(bad));
  }
  const ok = validateMobileNotify({ symbol: "ETHUSDT", kind: "liq-support", price: 79500, lo: 79460, hi: 79620 });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.message, "触碰清算支撑区 $79,460–$79,620");
  assert.equal(validateMobileNotify(good).value.message, "触碰趋势线 @ $81,392");
});

test("denied notify requests have no writes", async () => {
  assert.equal(mobileNotifyWrites(), 0);
  const cross = await handleMobileNotify(post(good, { origin: "http://evil.example" }));
  assert.equal(cross.status, 403);
  const missingOrigin = await handleMobileNotify(post(good, { origin: "" }));
  assert.equal(missingOrigin.status, 403);
  const remote = await handleMobileNotify(post(good, { host: "evil.example" }));
  assert.equal(remote.status, 403);
  const text = await handleMobileNotify(post(good, { type: "text/plain" }));
  assert.equal(text.status, 415);
  const junk = await handleMobileNotify(post("{nope"));
  assert.equal(junk.status, 400);
  const forged = await handleMobileNotify(post({ ...good, symbol: "../../etc" }));
  assert.equal(forged.status, 400);
  const put = await handleMobileNotify(post(good, { method: "PUT" }));
  assert.equal(put.status, 405);
  assert.equal(mobileNotifyWrites(), 0);
});

test("accepted notify returns the canonical message and still does not write", async () => {
  const response = await handleMobileNotify(post(good));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.message, "触碰趋势线 @ $81,392");
  assert.equal(mobileNotifyWrites(), 0);
});

test("mobile notify route is a thin guard with no store, mail, or process spawn", () => {
  const route = readFileSync(new URL("../app/api/mobile/notify/route.ts", import.meta.url), "utf8");
  assert.match(route, /handleMobileNotify/);
  assert.match(route, /methodNotAllowed/);
  assert.doesNotMatch(route, /alertsRuntime|createAlertStore|sendMail|spawn\(|child_process|fetch\(/);
});
