import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ETF_FLOW_ROWS_MAX,
  etfCardAmount,
  etfCardTone,
  etfFlowsHttpBody,
  flowTone,
  formatEtfCardAmount,
  formatFlowCell,
  sanitizeEtfFlowsSnapshot,
} from "../lib/etf-flows.ts";

const fixtureUrl = new URL("../fixtures/etf_flows.sample.json", import.meta.url);
const sample = JSON.parse(readFileSync(fixtureUrl, "utf8"));

function day(index) {
  return new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
}

function row(date, usd = 1, btc = null) {
  return {
    date,
    flowsUsdM: { IBIT: usd, GBTC: 0, Total: usd },
    flowsBtc: { IBIT: btc, GBTC: null, Total: btc },
  };
}

function minimal(overrides = {}) {
  return {
    kind: "btc_spot_etf_flows",
    venue: "US",
    asset: "BTC",
    updatedAt: "2026-09-30T13:49:06-04:00",
    asOfDate: "2026-09-29",
    unitDefault: "USD",
    units: ["USD", "BTC"],
    lagNote: "Figures usually settle after US cash close (evening ET).",
    source: { table: "farside", cards: "sosovalue_ssr" },
    tickers: ["IBIT", "GBTC"],
    cards: [
      { id: "cum_net_inflow", label: "Cumulative Total Net Inflow", usd: 100, btc: null },
      { id: "day_net_inflow", label: "Daily Total Net Inflow", usd: -5_000_000, btc: -1.5 },
      { id: "day_volume", label: "Daily Volume", usd: 10, btc: null },
      { id: "total_nav", label: "Total Net Assets", usd: 20, btc: null },
    ],
    rows: [row("2026-09-28", -2, null), row("2026-09-29", 3, 1.25)],
    ...overrides,
  };
}

test("sanitizes the US BTC ETF sample with newest rows first", () => {
  const parsed = sanitizeEtfFlowsSnapshot(sample);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 0);
  assert.equal(parsed.snapshot.kind, "btc_spot_etf_flows");
  assert.equal(parsed.snapshot.venue, "US");
  assert.equal(parsed.snapshot.asset, "BTC");
  assert.equal(parsed.snapshot.asOfDate, "2026-09-29");
  assert.equal(parsed.snapshot.unitDefault, "USD");
  assert.deepEqual(parsed.snapshot.units, ["USD", "BTC"]);
  assert.match(parsed.snapshot.lagNote, /evening ET/);
  assert.equal(parsed.snapshot.cards.length, 4);
  assert.deepEqual(parsed.snapshot.cards.map((card) => card.label), [
    "Cumulative Total Net Inflow",
    "Daily Total Net Inflow",
    "Daily Volume",
    "Total Net Assets",
  ]);
  assert.equal(parsed.snapshot.cards[0].btc, null);
  assert.equal(parsed.snapshot.cards[1].usd, 66194702.4);
  assert.equal(parsed.snapshot.cards[1].btc, 792.1633978535441);
  assert.deepEqual(parsed.snapshot.tickers, sample.tickers);
  assert.equal(parsed.snapshot.rows.length, 20);
  assert.equal(parsed.snapshot.rows[0].date, "2026-09-29");
  assert.equal(parsed.snapshot.rows[0].flowsUsdM.IBIT, 51.1);
  assert.equal(parsed.snapshot.rows[0].flowsUsdM.BITB, -18.1);
  assert.equal(parsed.snapshot.rows[0].flowsBtc.Total, 792.1633978535441);
  assert.equal(parsed.snapshot.rows[1].flowsBtc.IBIT, null);
  assert.equal(parsed.snapshot.rows.at(-1).date, "2026-09-01");
  assert.deepEqual(parsed.snapshot.source, { table: "farside", cards: "sosovalue_ssr" });
});

test("rejects the wrong kind and structural forgeries without mutating the input", () => {
  const forged = {
    ...sample,
    kind: "order_book",
    admin: true,
    entitled: true,
    role: "admin",
  };
  const before = structuredClone(forged);
  assert.equal(sanitizeEtfFlowsSnapshot(forged).ok, false);
  assert.deepEqual(forged, before);
  assert.equal(sanitizeEtfFlowsSnapshot(null).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot([]).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot({ ...sample, venue: "binance" }).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot({ ...sample, asset: "ETH" }).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot({ ...sample, asOfDate: "09-29-2026" }).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot({ ...sample, cards: "already-packed" }).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot({ ...sample, rows: "already-packed" }).ok, false);
  assert.equal(sanitizeEtfFlowsSnapshot({ ...sample, tickers: ["!!!"] }).ok, false);

  const wrongKind = etfFlowsHttpBody(forged);
  assert.equal(wrongKind.status, 400);
  assert.deepEqual(Object.keys(wrongKind.body), ["error"]);
  assert.equal(wrongKind.body.error, "ETF flow kind is not btc_spot_etf_flows.");
  assert.doesNotMatch(wrongKind.body.error, /admin|order_book/);
  assert.equal(etfFlowsHttpBody(null).status, 400);
});

test("drops bad rows and cards and ignores client privilege flags", () => {
  const parsed = sanitizeEtfFlowsSnapshot(minimal({
    admin: true,
    entitled: true,
    role: "admin",
    authorized: true,
    hasMarketHistory: true,
    membership: "pro",
    privileged: true,
    units: ["ADMIN", "USD"],
    lagNote: "See https://evil.example/secret before close.",
    source: { table: "farside", cards: "sosovalue_ssr", admin: true },
    cards: [
      { id: "cum_net_inflow", label: "Cumulative Total Net Inflow", usd: Number.NaN, btc: null, admin: true },
      { id: "day_net_inflow", label: "Daily Total Net Inflow", usd: -5_000_000, btc: "nope" },
      { id: "day_volume", label: "Daily Volume", usd: 10, btc: null },
      { id: "total_nav", label: "Total Net Assets", usd: 20, btc: null, role: "admin" },
      { id: "not_a_card", label: "Injected", usd: 1, btc: 1 },
    ],
    rows: [
      row("2026-09-28", -2, null),
      row("2026-09-29", 3, 1.25),
      null,
      ["2026-09-27"],
      row("2026-02-31", 1, 1),
      row("09-27-2026", 1, 1),
      { date: "2026-09-27", flowsUsdM: { IBIT: "51.1", GBTC: 0, Total: 1 }, flowsBtc: { IBIT: null, GBTC: null, Total: null } },
      { date: "2026-09-26", flowsUsdM: { IBIT: Number.NaN, GBTC: 0, Total: 1 }, flowsBtc: { IBIT: null, GBTC: null, Total: null } },
      { date: "2026-09-25", flowsUsdM: { IBIT: Number.POSITIVE_INFINITY, GBTC: 0, Total: 1 }, flowsBtc: { IBIT: null, GBTC: null, Total: null } },
      { date: "2026-09-24", flowsUsdM: { IBIT: 1, GBTC: 0, Total: 1 }, flowsBtc: { IBIT: {}, GBTC: null, Total: null } },
      { flowsUsdM: { IBIT: 1, GBTC: 0, Total: 1 }, flowsBtc: { IBIT: null, GBTC: null, Total: null } },
      { ...row("2026-09-23", 4, 2), admin: true, entitled: true },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.dropped, 12);
  assert.deepEqual(parsed.snapshot.cards.map((card) => card.id), ["day_volume", "total_nav"]);
  assert.deepEqual(parsed.snapshot.rows.map((item) => item.date), ["2026-09-29", "2026-09-28", "2026-09-23"]);
  assert.equal(parsed.snapshot.rows[0].flowsUsdM.IBIT, 3);
  assert.deepEqual(Object.keys(parsed.snapshot.rows[2]), ["date", "flowsUsdM", "flowsBtc"]);
  assert.equal(parsed.snapshot.lagNote, "See before close.");
  assert.deepEqual(parsed.snapshot.units, ["USD", "BTC"]);
  assert.doesNotMatch(JSON.stringify(parsed.snapshot), /admin|entitled|authorized|hasMarketHistory|membership|privileged|evil\.example/);

  const clean = sanitizeEtfFlowsSnapshot(sample);
  const flagged = sanitizeEtfFlowsSnapshot({
    ...sample,
    admin: true,
    entitled: true,
    role: "admin",
    authorized: true,
    hasMarketHistory: true,
    membership: "pro",
    privileged: true,
  });
  assert.deepEqual(flagged, clean);

  const http = etfFlowsHttpBody(parsed.snapshot);
  assert.equal(http.status, 200);
  assert.equal(http.body.admin, undefined);
  assert.equal(http.body.rows.length, 3);
});

test("keeps the newest duplicate date and caps the row count", () => {
  const replaced = sanitizeEtfFlowsSnapshot(minimal({
    rows: [row("2026-09-29", 1, 1), row("2026-09-29", 9, 4)],
  }));
  assert.equal(replaced.ok, true);
  if (!replaced.ok) return;
  assert.equal(replaced.dropped, 1);
  assert.equal(replaced.snapshot.rows.length, 1);
  assert.equal(replaced.snapshot.rows[0].flowsUsdM.IBIT, 9);

  const rows = Array.from({ length: ETF_FLOW_ROWS_MAX + 1 }, (_, index) => row(day(index), index, null));
  const capped = sanitizeEtfFlowsSnapshot(minimal({ rows }));
  assert.equal(capped.ok, true);
  if (!capped.ok) return;
  assert.equal(capped.snapshot.rows.length, ETF_FLOW_ROWS_MAX);
  assert.ok(capped.dropped >= 1);
  assert.equal(capped.snapshot.rows[0].date > capped.snapshot.rows.at(-1).date, true);
});

test("formats USD and BTC cards and flow cells by sign", () => {
  assert.equal(formatEtfCardAmount(57_643_988_078.043, "USD"), "$57.64B");
  assert.equal(formatEtfCardAmount(66_194_702.4, "USD"), "$66.19M");
  assert.equal(formatEtfCardAmount(-5_000_000, "USD"), "-$5.00M");
  assert.equal(formatEtfCardAmount(null, "BTC"), "—");
  assert.equal(formatEtfCardAmount(792.163, "BTC"), "792.16 BTC");
  assert.equal(formatFlowCell(51.1, "USD"), "+51.1");
  assert.equal(formatFlowCell(-18.1, "USD"), "-18.1");
  assert.equal(formatFlowCell(0, "USD"), "0.0");
  assert.equal(formatFlowCell(null, "BTC"), "—");
  assert.equal(formatFlowCell(1.256, "BTC"), "+1.26");
  assert.equal(flowTone(1), "inflow");
  assert.equal(flowTone(-1), "outflow");
  assert.equal(flowTone(0), "flat");
  assert.equal(flowTone(null), "flat");
  const card = { id: "day_volume", label: "Daily Volume", usd: 10, btc: null };
  assert.equal(etfCardAmount(card, "BTC"), null);
  assert.equal(etfCardTone("day_net_inflow", -1), "outflow");
  assert.equal(etfCardTone("day_volume", 10), "flat");
});

test("ETF route serves only the sanitized fixture helper", () => {
  const route = readFileSync(new URL("../app/api/etf-flows/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/etf-flows/page.tsx", import.meta.url), "utf8");
  assert.match(route, /etf_flows\.sample\.json/);
  assert.match(route, /etfFlowsHttpBody\(etfFlowsFixture\)/);
  assert.doesNotMatch(route, /fetch\(|request\.json\(|searchParams|farside\.co|sosovalue\.com/i);
  assert.match(page, /sanitizeEtfFlowsSnapshot/);
  assert.doesNotMatch(page, /fetch\(|searchParams/);
});
