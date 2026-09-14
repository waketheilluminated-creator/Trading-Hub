import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchVenueOiHistory,
  oiHistoryRequestUrl,
  parseVenueOiHistory,
  toChartSeconds,
  toOkxCcy,
} from "../lib/market-oi.ts";

test("builds public OI history URLs for each venue", () => {
  assert.equal(
    oiHistoryRequestUrl("bybit", "BTCUSDT", "15"),
    "https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=15min&limit=200",
  );
  assert.equal(
    oiHistoryRequestUrl("binance", "ETHUSDT", "60"),
    "https://fapi.binance.com/futures/data/openInterestHist?symbol=ETHUSDT&period=1h&limit=200",
  );
  assert.equal(
    oiHistoryRequestUrl("okx", "BTCUSDT", "15"),
    "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=BTC-USDT-SWAP&period=15m",
  );
  assert.equal(
    oiHistoryRequestUrl("bitget", "BTCUSDT", "15"),
    "https://api.bitget.com/api/v2/mix/market/open-interest?productType=USDT-FUTURES&symbol=BTCUSDT",
  );
  assert.equal(toOkxCcy("ETHUSDT"), "ETH");
  assert.equal(oiHistoryRequestUrl("bybit", "BTCUSDT", "1").includes("intervalTime=5min"), true);
});

test("parses Bybit, Binance, OKX, and Bitget OI payloads onto chart seconds", () => {
  assert.deepEqual(parseVenueOiHistory("bybit", {
    result: { list: [
      { openInterest: "3", timestamp: "1700000900000" },
      { openInterest: "2", timestamp: "1700000000000" },
    ] },
  }), {
    unit: "base",
    points: [
      { time: 1_700_000_000, value: 2 },
      { time: 1_700_000_900, value: 3 },
    ],
  });
  assert.deepEqual(parseVenueOiHistory("binance", [
    { timestamp: 1_700_000_000_000, sumOpenInterest: "10", sumOpenInterestValue: "1000" },
    { timestamp: 1_700_000_900_000, sumOpenInterest: "11", sumOpenInterestValue: "1100" },
  ]), {
    unit: "usd",
    points: [
      { time: 1_700_000_000, value: 1000 },
      { time: 1_700_000_900, value: 1100 },
    ],
  });
  assert.deepEqual(parseVenueOiHistory("okx", {
    data: [
      ["1700000900000", "10", "0.1", "2861419938.2798"],
      ["1700000000000", "9", "0.1", "2850000000"],
    ],
  }), {
    unit: "usd",
    points: [
      { time: 1_700_000_000, value: 2_850_000_000 },
      { time: 1_700_000_900, value: 2_861_419_938.2798 },
    ],
  });
  assert.deepEqual(parseVenueOiHistory("bitget", {
    data: { openInterestList: [{ symbol: "BTCUSDT", size: "12.5" }], ts: "1700000000000" },
  }), {
    unit: "contracts",
    points: [{ time: 1_700_000_000, value: 12.5 }],
  });
  assert.equal(toChartSeconds(1_700_000_000_000), 1_700_000_000);
  assert.equal(toChartSeconds(1_700_000_000), 1_700_000_000);
});

test("does not invent an OI series when the venue returns no points", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    () => fetchVenueOiHistory("bybit", "BTCUSDT", "15", fetchImpl),
    (error) => {
      assert.match(String(error.message || error), /unavailable/i);
      return true;
    },
  );
});

test("classifies a geo-blocked OI host without leaking legal-wall text", async () => {
  const wall = "Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms.";
  const fetchImpl = async () => new Response(JSON.stringify({ error: wall }), { status: 403 });
  await assert.rejects(
    () => fetchVenueOiHistory("binance", "BTCUSDT", "15", fetchImpl),
    (error) => {
      assert.equal(error.blocked, true);
      assert.match(error.message, /blocked here/i);
      assert.doesNotMatch(error.message, /eligibility|https?:\/\//i);
      return true;
    },
  );
});
