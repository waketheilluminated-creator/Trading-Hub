import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatPriceWithPrecision, historyRetryDelayMs, inferTickFromCandles, instrumentRequestUrl, parseInstrumentTick,
  precisionFromTick, priceFormatForTick, roundToTick, fetchInstrumentTick, formatAlertPrefill,
} from "../lib/price-precision.ts";
import { formatLiqPrice } from "../lib/liq-heatmap.ts";
import { formatWallZoneTooltip } from "../lib/wall-zones.ts";

for (const [tick, precision, price, shown] of [
  [0.00001, 5, 0.06041, "0.06041"],
  [0.0001, 4, 0.2884, "0.2884"],
  [0.01, 2, 182.37, "182.37"],
  [0.5, 1, 81583.5, "81,583.5"],
]) {
  test(`tick ${tick}: series priceFormat precision ${precision}, minMove ${tick}; legend/liq/wall/alert all agree`, () => {
    assert.equal(precisionFromTick(tick), precision);
    assert.deepEqual(priceFormatForTick(tick), { type: "price", precision, minMove: tick });
    assert.equal(formatPriceWithPrecision(price, precision), shown);
    assert.equal(formatLiqPrice(price, precision), price.toFixed(precision));
    assert.equal(formatAlertPrefill(price, precision), price.toFixed(precision));
    const tip = formatWallZoneTooltip({ side: "bid", lo: price, hi: price, notional: 1_000_000, count: 1 }, precision);
    assert.ok(tip.includes(price.toFixed(precision)), tip);
    assert.equal(roundToTick(price + tick * 0.3, tick), price);
  });
}

test("SAND-like $0.06 symbol no longer collapses to 2 decimals", () => {
  const fmt = priceFormatForTick(0.00001);
  assert.notEqual(fmt.precision, 2);
  assert.equal(formatPriceWithPrecision(0.06041, fmt.precision), "0.06041");
  assert.deepEqual(priceFormatForTick(null), { type: "price", precision: 2, minMove: 0.01 }, "unknown → previous default");
  assert.deepEqual(priceFormatForTick(0.1 * 3), { type: "price", precision: 1, minMove: 0.3 }, "float noise normalised");
});

test("fallback: tick inferred from candle decimals when exchange info is unavailable", () => {
  assert.equal(inferTickFromCandles([{ open: 0.0606, high: 0.06092, low: 0.06026, close: 0.06041 }]), 0.00001);
  assert.equal(inferTickFromCandles([{ open: 81583, high: 81590.5, low: 81500, close: 81583.1 }]), 0.1);
  assert.equal(inferTickFromCandles([]), null);
});

test("exchange info parsers: Binance, Bybit, OKX, Bitget", () => {
  assert.equal(parseInstrumentTick("binance", "SANDUSDT", { symbols: [{ symbol: "SANDUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "1" }, { filterType: "PRICE_FILTER", tickSize: "0.00001" }] }] }), 0.00001);
  assert.equal(parseInstrumentTick("bybit", "BTCUSDT", { result: { list: [{ symbol: "BTCUSDT", priceFilter: { tickSize: "0.10" } }] } }), 0.1);
  assert.equal(parseInstrumentTick("okx", "BTCUSDT", { data: [{ instId: "BTC-USDT-SWAP", tickSz: "0.1" }] }), 0.1);
  assert.equal(parseInstrumentTick("bitget", "ETHUSDT", { data: [{ symbol: "ETHUSDT", pricePlace: "2", priceEndStep: "1" }] }), 0.01);
  assert.equal(parseInstrumentTick("bitget", "XUSDT", { data: [{ symbol: "XUSDT", pricePlace: "1", priceEndStep: "5" }] }), 0.5);
  assert.equal(parseInstrumentTick("binance", "SANDUSDT", { symbols: [{ symbol: "OTHERUSDT", filters: [] }] }), null);
  assert.equal(parseInstrumentTick("bybit", "BTCUSDT", { result: { list: [{ symbol: "BTCUSDT", priceFilter: { tickSize: "-1" } }] } }), null);
  assert.match(instrumentRequestUrl("binance", "SANDUSDT"), /^https:\/\/fapi\.binance\.com\/fapi\/v1\/exchangeInfo\?symbol=SANDUSDT$/);
  assert.match(instrumentRequestUrl("okx", "BTCUSDT"), /instId=BTC-USDT-SWAP/);
});

test("fetchInstrumentTick caches per venue:symbol and survives network failure", async () => {
  let calls = 0;
  const ok = async () => { calls += 1; return new Response(JSON.stringify({ result: { list: [{ symbol: "AAAUSDT", priceFilter: { tickSize: "0.0001" } }] } })); };
  assert.equal(await fetchInstrumentTick("bybit", "AAAUSDT", ok, 1), 0.0001);
  assert.equal(await fetchInstrumentTick("bybit", "AAAUSDT", ok, 2), 0.0001);
  assert.equal(calls, 1);
  assert.equal(await fetchInstrumentTick("bybit", "BBBUSDT", async () => { throw new Error("offline"); }, 3), null);
});

test("workspace applies the tick-based priceFormat on symbol/venue switch and formats legend with it; history load retries", () => {
  const src = readFileSync(new URL("../app/trading-workspace.tsx", import.meta.url), "utf8");
  assert.match(src, /candleSeriesRef\.current\?\.applyOptions\(\{ priceFormat \}\)/);
  assert.match(src, /\[chartVersion, effectiveTick\]/);
  assert.match(src, /\/api\/market-meta\?exchange=\$\{activeVenue\}/);
  assert.match(src, /H \{fmtPrice\(last\?\.high/);
  assert.match(src, /precision=\{pricePrecision\}/);
  assert.match(src, /\[symbol, interval, chartVenue, barCount, historyRetry\]/);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(historyRetryDelayMs), [3000, 6000, 12000, 24000, 30000, 30000]);
});
