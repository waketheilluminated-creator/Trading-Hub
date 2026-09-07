import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assembleAnalystDataPack,
  attachAnalystHistoryPack,
  enrichAnalyzeRequest,
  parseAnalystMarketRef,
} from "../lib/ai-context.ts";
import { runAiProxy } from "../lib/ai/proxy.ts";
import {
  detectHistoryLookback,
  packHistoryRange,
  parseRangePhrase,
  resolveLookback,
} from "../lib/ai/history.ts";
import { parseChartInterval, pickSummaryInterval } from "../lib/market-venues.ts";

const NOW = Date.parse("2026-09-07T00:00:00.000Z");

function candleSeries(count, start = 1_700_000_000, step = 900) {
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * step,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));
}

function historyBars(count, start = 1_700_000_000, step = 900) {
  return candleSeries(count, start, step).map((candle) => ({
    t: candle.time, o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume,
  }));
}

test("parses compact, English, Chinese, and calendar lookbacks", () => {
  assert.equal(detectHistoryLookback("47h").phrase, "47h");
  assert.equal(parseRangePhrase("47h", NOW).durationMs, 47 * 3_600_000);
  assert.equal(parseRangePhrase("2 weeks", NOW).durationMs, 14 * 86_400_000);
  assert.equal(parseRangePhrase("近半年", NOW).durationMs, 182 * 86_400_000);
  assert.equal(parseRangePhrase("last 3 months", NOW).durationMs, 90 * 86_400_000);
  assert.equal(parseRangePhrase("YTD", NOW).kind, "calendar");
  assert.equal(parseRangePhrase("今年", NOW).startMs, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(parseRangePhrase("since listing", NOW).kind, "listing");
  assert.equal(parseRangePhrase("not a range", NOW).parseError != null, true);
});

test("explicit lookback overrides a natural-language question", () => {
  const parsed = resolveLookback({
    explicit: "47h",
    question: "对比近半年的持仓",
    now: NOW,
  });
  assert.equal(parsed.source, "explicit");
  assert.equal(parsed.phrase, "47h");
  assert.equal(parsed.durationMs, 47 * 3_600_000);

  const fromQuestion = resolveLookback({ question: "How did this trade over the past year?", now: NOW });
  assert.equal(fromQuestion.source, "question");
  assert.equal(fromQuestion.durationMs, 365 * 86_400_000);

  const none = resolveLookback({ question: "What is the current trend?", now: NOW });
  assert.equal(none.requested, false);
});

test("packHistoryRange compresses recent full bars and earlier summary stats", () => {
  const packed = packHistoryRange("47 hours", historyBars(188), {
    interval: "15",
    venue: "okx",
    cvd: { available: true, perpDelta: 4, spotDelta: -1, interpretation: "Perpetual takers are buying." },
    openInterest: { available: true, openInterestUsd: 100, fundingRate: 0.0001 },
  });
  assert.equal(packed.status, "packed");
  assert.equal(packed.available, true);
  assert.equal(packed.screenshots, false);
  assert.equal(packed.recent.length, 80);
  assert.equal(packed.earlier.bars, 108);
  assert.equal(typeof packed.earlier.high, "number");
  assert.ok(packed.earlier.buckets.length >= 2);
  assert.equal(packed.cvd.available, true);
  assert.equal(packed.cvd.perpDelta, 4);
  assert.match(packed.cvd.windowNote, /latest public trades/);
  assert.equal(packed.openInterest.available, true);
  assert.match(packed.openInterest.windowNote, /current snapshot/);
  assert.ok(Date.parse(packed.start) < Date.parse(packed.end));
  assert.doesNotMatch(JSON.stringify(packed), /image\/png|data:image|scroll-and-screenshot/i);
});

test("packHistoryRange degrades honestly without bars or invented CVD/OI", () => {
  const missing = packHistoryRange("2 weeks");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.available, false);
  assert.match(missing.reason, /No historical OHLCV/);

  const listing = packHistoryRange("since listing", historyBars(20, 1_600_000_000, 86_400), { interval: "D" });
  assert.equal(listing.status, "partial");
  assert.match(listing.reason, /Listing date is not known/);
  assert.equal(listing.cvd.available, false);
  assert.equal(listing.openInterest.available, false);
  assert.equal(listing.cvd.perpDelta, null);
});

test("assembleAnalystDataPack attaches a history pack only when a range is requested", async () => {
  const calls = [];
  const loaders = {
    fetchKlines: async (venue, symbol, interval, limit) => {
      calls.push({ venue, symbol, interval, limit });
      return {
        venue,
        symbol,
        interval,
        source: "official",
        candles: candleSeries(limit, 1_700_000_000, interval === "D" ? 86_400 : 900),
      };
    },
    fetchCvd: async () => {
      throw new Error("CVD blocked in this region");
    },
    fetchDerivatives: async () => ({
      exchange: "okx",
      symbol: "BTC/USDT:USDT",
      openInterestAmount: 2,
      openInterestValue: 100,
      fundingRate: 0.0001,
      fundingInterval: "8h",
      nextFundingTimestamp: null,
      markPrice: 1,
      indexPrice: 1,
      updatedAt: 1,
    }),
  };

  const live = await assembleAnalystDataPack(
    { symbol: "BTCUSDT", venue: "okx", interval: "15" },
    null,
    loaders,
  );
  assert.equal(live.packs.history.status, "current-window");
  assert.deepEqual(live.media, { screenshots: false, scrollCapture: false, chartImages: false });
  assert.equal(calls.filter((call) => call.interval === "15").length, 1);

  const packed = await assembleAnalystDataPack(
    { symbol: "BTCUSDT", venue: "okx", interval: "15" },
    null,
    loaders,
    { question: "Summarize the last 47 hours", now: NOW },
  );
  assert.equal(packed.packs.history.status, "packed");
  assert.equal(packed.packs.history.available, true);
  assert.equal(packed.packs.history.recent.length, 80);
  assert.ok(packed.packs.history.earlier.bars > 0);
  assert.equal(packed.packs.history.cvd.available, false);
  assert.match(packed.packs.history.cvd.reason, /CVD blocked/);
  assert.equal(packed.packs.history.openInterest.available, true);
  assert.equal(packed.packs.history.openInterest.openInterestUsd, 100);
  assert.equal(packed.media.screenshots, false);

  const halfYear = await assembleAnalystDataPack(
    { symbol: "ETHUSDT", venue: "okx", interval: "15" },
    null,
    loaders,
    { range: "近半年", now: NOW },
  );
  assert.ok(halfYear.packs.history.status === "packed" || halfYear.packs.history.status === "partial");
  assert.ok(calls.some((call) => call.interval === "D"));
});

test("assembleAnalystDataPack reports blocked venues instead of inventing history", async () => {
  const pack = await assembleAnalystDataPack(
    { symbol: "BTCUSDT", venue: "bybit", interval: "15" },
    null,
    {
      fetchKlines: async () => {
        throw Object.assign(new Error("Bybit is blocked in this region."), { blocked: true, venue: "bybit" });
      },
      fetchCvd: async () => {
        throw Object.assign(new Error("Bybit is blocked in this region."), { blocked: true, venue: "bybit" });
      },
      fetchDerivatives: async () => {
        throw Object.assign(new Error("Bybit is blocked in this region."), { blocked: true, venue: "bybit" });
      },
    },
    { range: "2 weeks", now: NOW },
  );
  assert.equal(pack.packs.history.status, "unavailable");
  assert.match(pack.packs.history.reason, /blocked/i);
  assert.equal(pack.packs.klines.available, false);
  assert.equal(pack.media.screenshots, false);
});

test("analyze route wires market, explicit range, and backend history into the Context Pack", () => {
  const analyze = readFileSync(fileURLToPath(new URL("../app/api/ai/analyze/route.ts", import.meta.url)), "utf8");
  const drawer = readFileSync(fileURLToPath(new URL("../components/ai-analyst-drawer.tsx", import.meta.url)), "utf8");
  assert.match(analyze, /enrichAnalyzeRequest/);
  assert.match(analyze, /Client-supplied candles are not treated as historical/);
  assert.match(drawer, /range: mode === "analyze"/);
  assert.match(drawer, /market: mode === "analyze" \? market/);
  assert.match(drawer, /History lookback range/);
  assert.match(drawer, /Backend data packs are ready/);
  assert.match(drawer, /never from screenshots/);

  const attached = attachAnalystHistoryPack(
    { candles: [{ close: 1 }], history: { status: "unavailable" } },
    {
      kind: "pilab.market-datapack/v1",
      capturedAt: "2026-09-07T00:00:00.000Z",
      input: "backend-api",
      media: { screenshots: false, scrollCapture: false, chartImages: false },
      market: { symbol: "BTCUSDT", venue: "okx", interval: "15", contract: "USDT perpetual" },
      packs: {
        klines: { available: true },
        openInterest: { available: false },
        cvd: { available: false },
        history: { available: true, status: "packed", requested: "47h", screenshots: false, recent: [] },
      },
      overlay: null,
    },
  );
  assert.equal(attached.history.status, "packed");
  assert.equal(attached.media.screenshots, false);
  assert.equal(attached.packs.history.status, "packed");
});

test("analyze proxy payload includes the packed history and keeps screenshot flags false", async () => {
  const loaders = {
    fetchKlines: async (venue, symbol, interval, limit) => ({
      venue,
      symbol,
      interval,
      source: "official",
      candles: candleSeries(limit, 1_700_000_000, interval === "D" ? 86_400 : 900),
    }),
    fetchCvd: async () => {
      throw new Error("CVD unavailable");
    },
    fetchDerivatives: async () => ({
      exchange: "okx",
      symbol: "BTC/USDT:USDT",
      openInterestAmount: 2,
      openInterestValue: 100,
      fundingRate: 0.0001,
      fundingInterval: "8h",
      nextFundingTimestamp: null,
      markPrice: 1,
      indexPrice: 1,
      updatedAt: 1,
    }),
  };

  const { context } = await enrichAnalyzeRequest({
    question: "Summarize structure over the last 47 hours",
    range: "47h",
    market: { symbol: "BTCUSDT", venue: "okx", interval: "15" },
    context: { candles: [{ close: 99 }], history: { status: "unavailable" } },
  }, loaders);

  assert.equal(context.history.status, "packed");
  assert.equal(context.history.recent.length, 80);
  assert.equal(context.media.screenshots, false);
  assert.equal(context.packs.history.screenshots, false);
  assert.notEqual(context.history.status, "deferred");

  const live = await enrichAnalyzeRequest({
    question: "What is the current trend?",
    market: { symbol: "BTCUSDT", venue: "okx", interval: "15" },
  }, loaders);
  assert.equal(live.context.history.status, "current-window");
  assert.equal(live.context.media.screenshots, false);

  const response = await runAiProxy({
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    question: "Summarize structure over the last 47 hours",
    context,
  }, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.messages[1].content, /"status":"packed"/);
    assert.match(body.messages[1].content, /"screenshots":false/);
    assert.match(body.messages[1].content, /"recent"/);
    assert.doesNotMatch(body.messages[1].content, /"status":"deferred"/);
    assert.doesNotMatch(body.messages[1].content, /image\/png|data:image|scroll-and-screenshot/i);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Market state: packed lookback used" } }] }), { status: 200 });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { analysis: "Market state: packed lookback used" });
});

test("interval labels from the chart snapshot map onto venue intervals", () => {
  assert.equal(parseChartInterval("15m"), "15");
  assert.equal(parseChartInterval("1H"), "60");
  assert.equal(parseChartInterval("1D"), "D");
  assert.equal(parseAnalystMarketRef({ symbol: "eth/usdt:usdt", venue: "bitget", interval: "4h" }).interval, "240");
  assert.equal(pickSummaryInterval("15", 182 * 86_400_000), "D");
  assert.equal(pickSummaryInterval("1", 47 * 3_600_000), "15");
});
