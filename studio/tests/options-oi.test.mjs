import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_STRIKE_BAND,
  OPTIONS_OI_CACHE_MS,
  OPTIONS_OI_ERRORS,
  assembleOptionsSnapshot,
  clipStrikes,
  computeMaxPain,
  formatDistancePct,
  formatOptionsFooter,
  formatOptionsHeadline,
  formatOptionsKicker,
  formatUsdCompact,
  layoutOptionsChart,
  parseDeribitInstrument,
  parseOptionsOiQuery,
  parseOptionsOiSnapshot,
} from "../lib/options-oi.ts";
import { clearOptionsOiCache, loadOptionsOi } from "../lib/options-oi-server.ts";

const MAX_PAIN_BOOK = [
  { strike: 100, callOi: 10, putOi: 5 },
  { strike: 105, callOi: 20, putOi: 15 },
  { strike: 110, callOi: 5, putOi: 25 },
];

function bookRow(name, openInterest, extra = {}) {
  return { instrument_name: name, open_interest: openInterest, ...extra };
}

function fixtureRows() {
  return [
    bookRow("BTC-30OCT26-100-C", 10),
    bookRow("BTC-30OCT26-100-P", 5),
    bookRow("BTC-30OCT26-105-C", 20),
    bookRow("BTC-30OCT26-105-P", 15),
    bookRow("BTC-30OCT26-110-C", 5),
    bookRow("BTC-30OCT26-110-P", 25),
    bookRow("BTC-27NOV26-100-C", 7),
    bookRow("BTC-25OCT26-100-C", 50),
    bookRow("ETH-30OCT26-100-C", 99),
    bookRow("BTC-PERPETUAL", 1000),
    bookRow("BTC-30OCT26", 1000),
    bookRow("not-an-instrument", 50),
  ];
}

test("parses Deribit option names into expiry, strike, and type", () => {
  assert.deepEqual(parseDeribitInstrument("BTC-30OCT26-80000-C"), {
    currency: "BTC",
    expiry: "2026-10-30",
    strike: 80000,
    type: "C",
  });
  assert.deepEqual(parseDeribitInstrument(" eth-25dec26-2500.5-p "), {
    currency: "ETH",
    expiry: "2026-12-25",
    strike: 2500.5,
    type: "P",
  });
  assert.deepEqual(parseDeribitInstrument("BTC-7NOV25-90000-P"), {
    currency: "BTC",
    expiry: "2025-11-07",
    strike: 90000,
    type: "P",
  });
  for (const bad of [
    "BTC-PERPETUAL",
    "BTC-30OCT26",
    "BTC-30OCT26-80000-X",
    "BTC-32OCT26-80000-C",
    "BTC-30FOO26-80000-C",
    "BTC-29FEB26-80000-C",
    "SOL-30OCT26-100-C",
    "BTC-30OCT26-0-C",
    "BTC-30OCT26-80000-C-extra",
    "",
    null,
    80000,
  ]) {
    assert.equal(parseDeribitInstrument(bad), null, `accepted ${String(bad)}`);
  }
});

test("max pain is the strike with the lowest total intrinsic payout", () => {
  // At 100 the payout is 325, at 105 it is 175, at 110 it is 200.
  assert.equal(computeMaxPain(MAX_PAIN_BOOK), 105);
  assert.equal(computeMaxPain([...MAX_PAIN_BOOK].reverse()), 105);
  assert.equal(computeMaxPain([]), null);
  assert.equal(computeMaxPain([{ strike: 100, callOi: 0, putOi: 0 }]), null);
  // Equal pain keeps the lower strike. Negative OI cannot invent a cheaper strike.
  assert.equal(computeMaxPain([
    { strike: 110, callOi: 0, putOi: 1 },
    { strike: 100, callOi: 1, putOi: 0 },
  ]), 100);
  assert.equal(computeMaxPain([
    { strike: 100, callOi: -5, putOi: 0 },
    { strike: 110, callOi: 0, putOi: 4 },
  ]), 110);
});

test("max pain uses quote-currency intrinsic, not the inverse settlement payoff", () => {
  // f(50) = 900 and f(100) = 1000, so quote intrinsic picks 50.
  // Dividing by the settlement price would pick 100 (18 > 10).
  assert.equal(computeMaxPain([
    { strike: 50, callOi: 20, putOi: 0 },
    { strike: 100, callOi: 0, putOi: 18 },
  ]), 50);
});

test("assembles one expiry from the book without mutating rows or trusting extras", () => {
  const rows = fixtureRows();
  rows.push(bookRow("BTC-30OCT26-100-C", 1e12, { admin: true }));
  rows.push(null, "packed", { instrument_name: "BTC-30OCT26-105-C", open_interest: "lots" });
  const before = structuredClone(rows);
  const built = assembleOptionsSnapshot({
    currency: "BTC",
    expiry: "2026-10-30",
    rows,
    spot: 81424,
    asOf: "2026-10-23T00:49Z",
  });
  assert.deepEqual(rows, before);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.snapshot.maxPain, 105);
  assert.equal(built.snapshot.totalOiBase, 80);
  assert.equal(built.snapshot.totalOiUsd, 80 * 81424);
  assert.ok(Math.abs(built.snapshot.putCallRatio - 45 / 35) < 1e-12);
  assert.ok(Math.abs(built.snapshot.distancePct - ((81424 - 105) / 105) * 100) < 1e-9);
  assert.deepEqual(built.snapshot.strikes, MAX_PAIN_BOOK);
  assert.deepEqual(built.snapshot.expiries.map((row) => row.expiry), ["2026-10-25", "2026-10-30", "2026-11-27"]);
  assert.equal(built.snapshot.settlement, "08:00 UTC");
  assert.equal("admin" in built.snapshot, false);
  assert.deepEqual(Object.keys(built.snapshot).sort(), [
    "asOf", "currency", "distancePct", "expiries", "expiry", "maxPain", "putCallRatio", "settlement", "spot", "strikes", "totalOiBase", "totalOiUsd",
  ].sort());
});

test("defaults to the nearest upcoming Friday whose open interest is meaningful", () => {
  const rows = [
    bookRow("BTC-25OCT26-100-C", 5000),
    bookRow("BTC-30OCT26-100-C", 100),
    bookRow("BTC-27NOV26-100-C", 8000),
    bookRow("BTC-25DEC26-100-P", 20000),
  ];
  const saturday = assembleOptionsSnapshot({
    currency: "BTC",
    expiry: null,
    rows,
    spot: 80000,
    asOf: "2026-10-24T12:00Z",
    now: new Date("2026-10-24T12:00:00Z"),
  });
  assert.equal(saturday.ok, true);
  if (!saturday.ok) return;
  assert.equal(saturday.snapshot.expiry, "2026-11-27");

  const bigFriday = assembleOptionsSnapshot({
    currency: "BTC",
    expiry: null,
    rows: [
      bookRow("BTC-30OCT26-100-C", 5000),
      bookRow("BTC-25DEC26-100-C", 20000),
    ],
    spot: 80000,
    asOf: "2026-10-24T12:00Z",
    now: new Date("2026-10-24T12:00:00Z"),
  });
  assert.equal(bigFriday.ok, true);
  if (!bigFriday.ok) return;
  assert.equal(bigFriday.snapshot.expiry, "2026-10-30");

  const afterSettlement = assembleOptionsSnapshot({
    currency: "BTC",
    expiry: null,
    rows: [
      bookRow("BTC-30OCT26-100-C", 9000),
      bookRow("BTC-06NOV26-100-C", 4000),
    ],
    spot: 80000,
    asOf: "2026-10-30T09:00Z",
    now: new Date("2026-10-30T09:00:00Z"),
  });
  assert.equal(afterSettlement.ok, true);
  if (!afterSettlement.ok) return;
  assert.equal(afterSettlement.snapshot.expiry, "2026-11-06");

  const beforeSettlement = assembleOptionsSnapshot({
    currency: "BTC",
    expiry: null,
    rows: [bookRow("BTC-30OCT26-100-C", 9000), bookRow("BTC-06NOV26-100-C", 4000)],
    spot: 80000,
    asOf: "2026-10-30T07:30Z",
    now: new Date("2026-10-30T07:30:00Z"),
  });
  assert.equal(beforeSettlement.ok, true);
  if (!beforeSettlement.ok) return;
  assert.equal(beforeSettlement.snapshot.expiry, "2026-10-30");
});

test("clips far strikes to ±40% of spot and can widen to the whole book", () => {
  const strikes = [
    { strike: 50, callOi: 1, putOi: 0 },
    { strike: 70, callOi: 1, putOi: 0 },
    { strike: 100, callOi: 1, putOi: 1 },
    { strike: 130, callOi: 0, putOi: 1 },
    { strike: 200, callOi: 9, putOi: 0 },
  ];
  assert.equal(DEFAULT_STRIKE_BAND, 0.4);
  assert.deepEqual(clipStrikes(strikes, 100, 105, DEFAULT_STRIKE_BAND).map((row) => row.strike), [70, 100, 130]);
  assert.deepEqual(clipStrikes(strikes, 100, 50, DEFAULT_STRIKE_BAND).map((row) => row.strike), [50, 70, 100, 130]);
  assert.deepEqual(clipStrikes(strikes, 100, 50, null).map((row) => row.strike), [50, 70, 100, 130, 200]);
});

test("chart layout puts calls above the axis, puts below, and marks spot versus max pain", () => {
  const layout = layoutOptionsChart(MAX_PAIN_BOOK, 112, 105, ((112 - 105) / 105) * 100, 280, 168);
  const mid = layout.bars.find((bar) => bar.strike === 105);
  const wing = layout.bars.find((bar) => bar.strike === 100);
  assert.ok(mid && wing);
  assert.equal(mid.callY + mid.callH, layout.zeroY);
  assert.equal(mid.putY, layout.zeroY);
  assert.ok(mid.callH > wing.callH);
  assert.ok(mid.putH > 0);
  assert.ok(layout.spot && layout.maxPain);
  assert.ok(layout.spot.x > layout.maxPain.x);
  assert.equal(layout.band.x, layout.maxPain.x);
  assert.equal(layout.band.x + layout.band.width, layout.spot.x);
  assert.equal(layout.distance.text, "+7%");
  assert.equal(layout.distance.x, (layout.maxPain.x + layout.spot.x) / 2);
});

test("formats the headline, kicker, and Deribit footer", () => {
  assert.equal(formatUsdCompact(11.1e9), "$11.1B");
  assert.equal(formatDistancePct(((81424 - 78000) / 78000) * 100), "+4%");
  assert.equal(formatDistancePct(-4.2), "-4%");
  assert.equal(formatDistancePct(null), null);
  assert.equal(formatOptionsKicker("BTC", "2026-10-30"), "BITCOIN OPTIONS EXPIRING 2026-10-30");
  assert.equal(formatOptionsKicker("ETH", "2026-12-25"), "ETHEREUM OPTIONS EXPIRING 2026-12-25");
  assert.equal(formatOptionsHeadline(11.1e9, 0.56), "$11.1B of open interest, put/call 0.56");
  assert.equal(
    formatOptionsFooter({ asOf: "2026-10-23T00:49Z", spot: 81424, maxPain: 78000 }),
    "Deribit, 08:00 UTC settlement. Max pain $78,000 computed from open interest at 2026-10-23T00:49Z; spot $81,424.",
  );
});

test("rejects a forged snapshot instead of trusting client books or roles", () => {
  const valid = assembleOptionsSnapshot({
    currency: "BTC",
    expiry: "2026-10-30",
    rows: fixtureRows(),
    spot: 81424,
    asOf: "2026-10-23T00:49Z",
  });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  const forged = { ...valid.snapshot, admin: true, role: "admin", entitled: true, hasMarketHistory: true };
  const parsed = parseOptionsOiSnapshot(forged);
  assert.ok(parsed);
  assert.equal("admin" in parsed, false);
  assert.equal(parsed.role, undefined);
  assert.equal(parsed.maxPain, 105);
  assert.equal(parseOptionsOiSnapshot({ ...valid.snapshot, settlement: "instant" }), null);
  assert.equal(parseOptionsOiSnapshot({ ...valid.snapshot, spot: 1, currency: "SOL" }), null);
  assert.equal(parseOptionsOiSnapshot({ error: "nope", admin: true }), null);
  assert.equal(parseOptionsOiSnapshot(null), null);
});

test("rejects bad currency and expiry before any upstream fetch", async () => {
  clearOptionsOiCache();
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };
  const cases = [
    ["http://localhost/api/options-oi?currency=SOL", OPTIONS_OI_ERRORS.currency],
    ["http://localhost/api/options-oi?currency=BTC/../ETH", OPTIONS_OI_ERRORS.currency],
    ["http://localhost/api/options-oi?currency=", OPTIONS_OI_ERRORS.currency],
    ["http://localhost/api/options-oi?currency=BTC&expiry=30OCT26", OPTIONS_OI_ERRORS.expiry],
    ["http://localhost/api/options-oi?currency=BTC&expiry=2026-02-31", OPTIONS_OI_ERRORS.expiry],
    ["http://localhost/api/options-oi?currency=BTC&expiry=2026-10-30' OR 1=1", OPTIONS_OI_ERRORS.expiry],
    ["http://localhost/api/options-oi?currency=BTC&expiry=", OPTIONS_OI_ERRORS.expiry],
  ];
  for (const [href, error] of cases) {
    const parsed = parseOptionsOiQuery(new URL(href));
    assert.equal(parsed.ok, false, href);
    if (parsed.ok) continue;
    assert.equal(parsed.error, error, href);
    const result = await loadOptionsOi(new URL(href), fetchImpl, 1_000);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error });
  }
  assert.equal(fetches, 0);
  const omitted = parseOptionsOiQuery(new URL("http://localhost/api/options-oi"));
  assert.equal(omitted.ok, true);
  if (omitted.ok) {
    assert.equal(omitted.currency, "BTC");
    assert.equal(omitted.expiry, null);
  }
  const lower = parseOptionsOiQuery(new URL("http://localhost/api/options-oi?currency=eth&expiry=2026-12-25"));
  assert.deepEqual(lower, { ok: true, currency: "ETH", expiry: "2026-12-25" });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function deribitFetch(book, indexPrice, usOut) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("get_book_summary_by_currency")) {
      return jsonResponse({ result: book, usOut });
    }
    if (href.includes("get_index_price")) {
      return jsonResponse({ result: { index_price: indexPrice }, usOut });
    }
    throw new Error(`unexpected url ${href}`);
  };
  return { fetchImpl, calls };
}

test("loads Deribit book and index only, ignoring client spot and book parameters", async () => {
  clearOptionsOiCache();
  const usOut = Date.parse("2026-10-23T00:49:00.000Z") * 1000;
  const { fetchImpl, calls } = deribitFetch(fixtureRows(), 81424, usOut);
  const url = new URL("http://localhost/api/options-oi?currency=BTC&expiry=2026-10-30&spot=1&book=%5B%5D&admin=true&open_interest=999999");
  const result = await loadOptionsOi(url, fetchImpl, Date.parse("2026-10-24T00:00:00Z"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 200);
  assert.equal(result.body.spot, 81424);
  assert.equal(result.body.maxPain, 105);
  assert.equal(result.body.asOf, "2026-10-23T00:49Z");
  assert.equal("admin" in result.body, false);
  assert.deepEqual(calls, [
    "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option",
    "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd",
  ]);
  assert.equal(calls.some((href) => href.includes("2026-10-30") || href.includes("spot=1")), false);
});

test("serves ETH from its own index and does not reuse the BTC cache", async () => {
  clearOptionsOiCache();
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("currency=BTC")) return jsonResponse({ result: fixtureRows(), usOut: Date.parse("2026-10-23T00:49:00Z") * 1000 });
    if (href.includes("currency=ETH")) return jsonResponse({ result: [bookRow("ETH-25DEC26-2500-C", 4), bookRow("ETH-25DEC26-2500-P", 1)], usOut: Date.parse("2026-10-23T00:49:00Z") * 1000 });
    if (href.includes("btc_usd")) return jsonResponse({ result: { index_price: 80000 } });
    if (href.includes("eth_usd")) return jsonResponse({ result: { index_price: 2500 } });
    throw new Error(href);
  };
  const now = 5_000;
  const btc = await loadOptionsOi(new URL("http://localhost/api/options-oi?currency=BTC&expiry=2026-10-30"), fetchImpl, now);
  const eth = await loadOptionsOi(new URL("http://localhost/api/options-oi?currency=ETH"), fetchImpl, now + 1_000);
  assert.equal(btc.ok, true);
  assert.equal(eth.ok, true);
  if (!eth.ok) return;
  assert.equal(eth.body.currency, "ETH");
  assert.equal(eth.body.expiry, "2026-12-25");
  assert.equal(eth.body.spot, 2500);
  assert.equal(eth.body.totalOiBase, 5);
  assert.equal(calls.length, 4);
  assert.ok(calls.includes("https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd"));
});

test("caches a currency book for 60 seconds and refetches when the cache expires", async () => {
  clearOptionsOiCache();
  assert.equal(OPTIONS_OI_CACHE_MS, 60_000);
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    const href = String(url);
    if (href.includes("get_book_summary")) return jsonResponse({ result: fixtureRows(), usOut: Date.parse("2026-10-23T00:49:00Z") * 1000 });
    return jsonResponse({ result: { index_price: 81424 } });
  };
  const first = new URL("http://localhost/api/options-oi?currency=BTC&expiry=2026-10-30");
  const second = new URL("http://localhost/api/options-oi?currency=BTC&expiry=2026-11-27");
  const start = 10_000;
  assert.equal((await loadOptionsOi(first, fetchImpl, start)).ok, true);
  assert.equal((await loadOptionsOi(second, fetchImpl, start + 59_000)).ok, true);
  assert.equal(fetches, 2);
  assert.equal((await loadOptionsOi(first, fetchImpl, start + 60_000)).ok, true);
  assert.equal(fetches, 4);
});

test("returns a clear upstream error and does not cache the failure", async () => {
  clearOptionsOiCache();
  let mode = "down";
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    if (mode === "down") return new Response("<html>secret-token</html>", { status: 503 });
    const href = fetches;
    if (fetches % 2 === 1) return jsonResponse({ result: fixtureRows(), usOut: Date.parse("2026-10-23T00:49:00Z") * 1000 });
    return jsonResponse({ result: { index_price: 81424 }, note: href });
  };
  const url = new URL("http://localhost/api/options-oi?currency=BTC");
  const failed = await loadOptionsOi(url, fetchImpl, 1_000);
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: OPTIONS_OI_ERRORS.upstream });
  assert.doesNotMatch(JSON.stringify(failed.body), /secret-token|<html|deribit/i);
  mode = "up";
  const recovered = await loadOptionsOi(url, fetchImpl, 2_000);
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.equal(recovered.body.maxPain, 105);
  assert.ok(fetches >= 4);
});

test("unknown expiry is a 404 after the book loads, and an empty book is an error", async () => {
  clearOptionsOiCache();
  const missing = deribitFetch(fixtureRows(), 81424, Date.parse("2026-10-23T00:49:00Z") * 1000);
  const notListed = await loadOptionsOi(new URL("http://localhost/api/options-oi?currency=BTC&expiry=2026-01-02"), missing.fetchImpl, 3_000);
  assert.equal(notListed.ok, false);
  if (notListed.ok) return;
  assert.equal(notListed.status, 404);
  assert.deepEqual(notListed.body, { error: OPTIONS_OI_ERRORS.unlisted });

  clearOptionsOiCache();
  const empty = deribitFetch([], 81424, Date.parse("2026-10-23T00:49:00Z") * 1000);
  const noBook = await loadOptionsOi(new URL("http://localhost/api/options-oi?currency=BTC"), empty.fetchImpl, 4_000);
  assert.equal(noBook.ok, false);
  if (noBook.ok) return;
  assert.equal(noBook.status, 502);
  assert.equal(noBook.body.error, OPTIONS_OI_ERRORS.empty);
});

test("the route delegates to the server loader and the card stays inside the right panel", () => {
  const route = readFileSync(new URL("../app/api/options-oi/route.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../lib/options-oi-server.ts", import.meta.url), "utf8");
  const card = readFileSync(new URL("../components/options-expiry-card.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(route, /loadOptionsOi/);
  assert.match(route, /max-age=60/);
  assert.doesNotMatch(route, /deribit\.com/);
  assert.match(server, /https:\/\/www\.deribit\.com\/api\/v2\/public\/get_book_summary_by_currency/);
  assert.match(server, /redirect:\s*"error"/);

  const panelStart = workspace.indexOf('<aside className="right-panel"');
  const panel = workspace.slice(panelStart, workspace.indexOf("</aside>", panelStart));
  assert.match(panel, /title="Options expiry"/);
  assert.match(panel, /storageKey=\{OPTIONS_SECTION_KEY\}/);
  assert.match(panel, /<OptionsExpiryCard \/>/);
  assert.equal(workspace.indexOf("<OptionsExpiryCard"), panelStart + panel.indexOf("<OptionsExpiryCard"));
  assert.match(workspace, /const OPTIONS_SECTION_KEY = "th-section-options-expiry-open"/);
  assert.doesNotMatch(card, /deribit\.com|chartHost|chartRef|createChart|fitChartView/);
  assert.match(card, /\/api\/options-oi\?/);
  assert.match(card, /className="options-icon-button"/);
  assert.match(card, /aria-label=\{wide \? "Clip strikes to within 40% of spot" : "Show all strikes"\}/);
  assert.match(card, /title=\{wide \? "Clip strikes to within 40% of spot" : "Show all strikes"\}/);
  const button = card.match(/<button type="button" className="options-icon-button"[\s\S]*?<\/button>/);
  assert.ok(button);
  assert.match(button[0], /<RangeIcon /);
  assert.doesNotMatch(button[0], />\s*[A-Za-z]{3,}[^<]*<\/button>/);
  assert.match(css, /\.right-panel \{[^}]*overflow:auto/);
  assert.match(css, /\.options-chart-host \{[^}]*height:168px/);
  assert.doesNotMatch(css, /\.options-card[^}]*position:\s*(fixed|absolute)/);
  assert.doesNotMatch(css, /\.options-[\w-]+[^}]*chart-stage|\.options-[\w-]+[^}]*grid-template-columns:\s*minmax/);
});
