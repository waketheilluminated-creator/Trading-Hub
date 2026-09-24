import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clampMinNotional,
  clusterOrderWalls,
  DEFAULT_MIN_WALL_NOTIONAL_USD,
  depthRequestUrl,
  fetchVenueDepth,
  LARGE_ORDER_SR_STORAGE_KEY,
  loadLargeOrderWalls,
  parseDepthQuery,
  parseOkxContractValue,
  parseVenueDepth,
  filterWallsForRange,
  LARGE_ORDER_SR_MIN_NOTIONAL_KEY,
  LARGE_ORDER_SR_RANGE_KEY,
  layoutSeparatedWalls,
  MIN_WALL_CENTER_GAP_PX,
  MIN_WALL_NOTIONAL_USD,
  readStoredMinNotional,
  readStoredWallRange,
  visualWallBands,
  wallFillStyle,
  writeStoredMinNotional,
  writeStoredWallRange,
} from "../lib/market-depth.ts";
import { formatVenueFallbackNotice, supportedExchangesMessage } from "../lib/market-venues.ts";
import { readStoredFlag, writeStoredFlag } from "../lib/chart-indicator-panes.ts";

const LEGAL_WALL = "Binance is blocked in this region (Service unavailable from a restricted location according to 'b. Eligibility' in https://www.binance.com/en/terms. Please contact customer service if you believe you received this message in error.).";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    store,
  };
}

test("rejects invalid venue and symbol without fetching depth", () => {
  const badVenue = parseDepthQuery(new URL("http://localhost/api/depth?exchange=unknown&symbol=BTCUSDT"), supportedExchangesMessage());
  assert.deepEqual(badVenue, { ok: false, error: "Supported exchanges: bybit, binance, okx, bitget" });

  const badSymbol = parseDepthQuery(new URL("http://localhost/api/depth?exchange=okx&symbol=../etc/passwd"), supportedExchangesMessage());
  assert.deepEqual(badSymbol, { ok: false, error: "Use a compact perpetual symbol such as BTCUSDT" });

  const injectedBook = parseDepthQuery(new URL("http://localhost/api/depth?exchange=okx&symbol=BTCUSDT&bids=90000,999&minNotional=-1"), supportedExchangesMessage());
  assert.equal(injectedBook.ok, true);
  if (injectedBook.ok) {
    assert.equal(injectedBook.venue, "okx");
    assert.equal(injectedBook.symbol, "BTCUSDT");
    assert.equal(injectedBook.minNotional, 10_000);
  }
  const omitted = parseDepthQuery(new URL("http://localhost/api/depth?exchange=okx&symbol=BTCUSDT"), supportedExchangesMessage());
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.minNotional, DEFAULT_MIN_WALL_NOTIONAL_USD);
});

test("clamps forged min notional instead of trusting client bounds", () => {
  assert.equal(DEFAULT_MIN_WALL_NOTIONAL_USD, 100_000);
  assert.equal(MIN_WALL_NOTIONAL_USD, 10_000);
  assert.equal(clampMinNotional("abc"), DEFAULT_MIN_WALL_NOTIONAL_USD);
  assert.equal(clampMinNotional(null), DEFAULT_MIN_WALL_NOTIONAL_USD);
  assert.equal(clampMinNotional(""), DEFAULT_MIN_WALL_NOTIONAL_USD);
  assert.equal(clampMinNotional(-50), 10_000);
  assert.equal(clampMinNotional(9_999), 10_000);
  assert.equal(clampMinNotional(1e12), 50_000_000);
  assert.equal(clampMinNotional(100_000), 100_000);
  assert.equal(clampMinNotional(500_000), 500_000);
});

test("builds public L2 URLs for geo-friendly venues", () => {
  assert.equal(
    depthRequestUrl("okx", "BTCUSDT"),
    "https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=400",
  );
  assert.equal(
    depthRequestUrl("bybit", "ETHUSDT"),
    "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=ETHUSDT&limit=200",
  );
  assert.equal(parseOkxContractValue({ data: [{ ctVal: "0.01" }] }), 0.01);
  assert.equal(parseOkxContractValue({ data: [] }), 1);
});

test("parses Bybit, OKX, Bitget, and Binance books into USD notionals", () => {
  assert.deepEqual(parseVenueDepth("bybit", {
    result: { b: [["80000", "2"]], a: [["80100", "1"]] },
  }), {
    bids: [{ price: 80_000, size: 2, notional: 160_000 }],
    asks: [{ price: 80_100, size: 1, notional: 80_100 }],
  });
  assert.deepEqual(parseVenueDepth("okx", {
    data: [{ bids: [["80000", "1000"]], asks: [["80100", "500"]] }],
  }, 0.01), {
    bids: [{ price: 80_000, size: 10, notional: 800_000 }],
    asks: [{ price: 80_100, size: 5, notional: 400_500 }],
  });
  assert.deepEqual(parseVenueDepth("bitget", {
    data: { bids: [["80000", "3"]], asks: [["80100", "2"]] },
  }), {
    bids: [{ price: 80_000, size: 3, notional: 240_000 }],
    asks: [{ price: 80_100, size: 2, notional: 160_200 }],
  });
  assert.deepEqual(parseVenueDepth("binance", {
    bids: [["80000", "4"]],
    asks: [["80100", "1.5"]],
  }), {
    bids: [{ price: 80_000, size: 4, notional: 320_000 }],
    asks: [{ price: 80_100, size: 1.5, notional: 120_150 }],
  });
});

test("clusters nearby large bids/asks into S/R walls and drops small noise", () => {
  const walls = clusterOrderWalls(
    [
      { price: 79_990, size: 4, notional: 319_960 },
      { price: 80_000, size: 6, notional: 480_000 },
      { price: 70_000, size: 0.1, notional: 7_000 },
    ],
    [
      { price: 81_000, size: 8, notional: 648_000 },
      { price: 81_010, size: 2, notional: 162_020 },
    ],
    { minNotional: 100_000, clusterBps: 20, maxPerSide: 8 },
  );
  assert.equal(walls.some((wall) => wall.price === 70_000 || wall.notional === 7_000), false);
  const bids = walls.filter((wall) => wall.side === "bid");
  const asks = walls.filter((wall) => wall.side === "ask");
  assert.equal(bids.length, 1);
  assert.equal(asks.length, 1);
  assert.equal(bids[0].notional, 799_960);
  assert.equal(asks[0].notional, 810_020);
  assert.ok(bids[0].low <= bids[0].high);
  const visuals = visualWallBands(walls);
  assert.equal(visuals.length, 2);
  assert.ok(visuals.every((wall) => wall.opacity > 0.1 && wall.thicknessPx >= 3));
  assert.match(wallFillStyle(visuals.find((wall) => wall.side === "bid")), /83, 201, 144/);
  assert.match(wallFillStyle(visuals.find((wall) => wall.side === "ask")), /231, 103, 112/);
});

test("keeps distinct large levels more than one basis point apart", () => {
  const walls = clusterOrderWalls(
    [
      { price: 75_910, size: 5, notional: 379_550 },
      { price: 75_850, size: 5, notional: 379_250 },
    ],
    [
      { price: 75_930, size: 5, notional: 379_650 },
      { price: 75_980, size: 5, notional: 379_900 },
    ],
    { minNotional: 250_000 },
  );
  assert.equal(walls.filter((wall) => wall.side === "bid").length, 2);
  assert.equal(walls.filter((wall) => wall.side === "ask").length, 2);
});

test("does not invent walls when the venue returns an empty book", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    return jsonResponse({ retCode: 0, result: { b: [], a: [] } });
  };
  await assert.rejects(
    () => fetchVenueDepth("bybit", "BTCUSDT", 250_000, fetchImpl),
    (error) => {
      assert.match(String(error.message || error), /unavailable|failed/i);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("classifies a geo-blocked depth host without leaking legal-wall text", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ msg: LEGAL_WALL }), { status: 451 });
  await assert.rejects(
    () => fetchVenueDepth("binance", "BTCUSDT", 250_000, fetchImpl),
    (error) => {
      assert.equal(error.blocked, true);
      assert.match(error.message, /blocked here/i);
      assert.doesNotMatch(error.message, /eligibility|https?:\/\//i);
      return true;
    },
  );
});

test("loadLargeOrderWalls skips blocked Bybit and uses OKX walls", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("exchange=bybit")) {
      return jsonResponse({ error: "Bybit blocked here — try OKX.", blocked: true, exchange: "bybit" }, 403);
    }
    if (url.includes("exchange=okx")) {
      return jsonResponse({
        venue: "okx",
        symbol: "BTCUSDT",
        source: "official",
        midPrice: 80_050,
        walls: [
          { side: "bid", price: 79_500, low: 79_480, high: 79_520, size: 12, notional: 954_000 },
          { side: "ask", price: 81_000, low: 80_980, high: 81_020, size: 9, notional: 729_000 },
        ],
        notice: null,
        updatedAt: 1,
      });
    }
    return new Response("no", { status: 502 });
  };

  const result = await loadLargeOrderWalls("bybit", "BTCUSDT", fetchImpl);
  assert.equal(result.venue, "okx");
  assert.equal(result.fallbackFrom, "bybit");
  assert.equal(result.snapshot.walls.length, 2);
  assert.equal(result.notice, formatVenueFallbackNotice("bybit", "okx", true));
  assert.doesNotMatch(result.notice ?? "", /eligibility|https?:\/\//i);
  assert.ok(calls.some((url) => url.includes("/api/depth?exchange=bybit")));
  assert.ok(calls.some((url) => url.includes("/api/depth?exchange=okx")));
  assert.ok(calls.every((url) => url.startsWith("/api/depth?")));
});

test("drops forged tiny walls from a proxied depth payload", async () => {
  const fetchImpl = async () => jsonResponse({
    venue: "okx",
    symbol: "BTCUSDT",
    walls: [
      { side: "bid", price: 80_000, low: 80_000, high: 80_000, size: 1, notional: 80_000 },
      { side: "ask", price: 81_000, low: 81_000, high: 81_000, size: 10, notional: 810_000 },
      { side: "bid", price: "spoof", notional: 9_999_999 },
    ],
    midPrice: 80_500,
    updatedAt: 1,
  });
  const result = await loadLargeOrderWalls("okx", "BTCUSDT", fetchImpl, { minNotional: 250_000 });
  assert.deepEqual(result.snapshot.walls.map((wall) => wall.side), ["ask"]);
  assert.equal(result.snapshot.walls[0].notional, 810_000);
});

function wallAt(side, price, notional) {
  return { side, price, low: price, high: price, size: notional / price, notional };
}

test("spreads collapsed live-book walls into distinct green and red bands", () => {
  const walls = visualWallBands([
    wallAt("ask", 84_020, 300_000),
    wallAt("ask", 84_050, 420_000),
    wallAt("ask", 84_080, 260_000),
    wallAt("bid", 83_990, 500_000),
    wallAt("bid", 83_970, 250_000),
  ]);
  const mid = 84_000;
  const priceToY = (price) => 300 - (price - mid) * (2 / 50);
  const placed = layoutSeparatedWalls(walls, priceToY);
  assert.equal(placed.length, 5);
  const asks = placed.filter((band) => band.wall.side === "ask").map((band) => band.centerY).sort((a, b) => a - b);
  const bids = placed.filter((band) => band.wall.side === "bid").map((band) => band.centerY).sort((a, b) => a - b);
  assert.ok(Math.max(...asks) <= Math.min(...bids) - MIN_WALL_CENTER_GAP_PX);
  for (const group of [asks, bids]) {
    for (let index = 1; index < group.length; index += 1) {
      assert.ok(group[index] - group[index - 1] >= MIN_WALL_CENTER_GAP_PX);
    }
  }
  assert.ok(placed.every((band) => band.thicknessPx <= MIN_WALL_CENTER_GAP_PX - 2));
  assert.ok(placed.every((band) => band.edgeY !== band.centerY));
  assert.match(wallFillStyle(placed.find((band) => band.wall.side === "bid").wall), /83, 201, 144/);
  assert.match(wallFillStyle(placed.find((band) => band.wall.side === "ask").wall), /231, 103, 112/);
});

test("leaves already separated walls on their live prices", () => {
  const walls = visualWallBands([
    wallAt("bid", 80_000, 200_000),
    wallAt("ask", 81_000, 220_000),
  ]);
  const placed = layoutSeparatedWalls(walls, (price) => (price === 80_000 ? 400 : 80));
  const bid = placed.find((band) => band.wall.side === "bid");
  const ask = placed.find((band) => band.wall.side === "ask");
  assert.equal(bid.centerY, 400);
  assert.equal(ask.centerY, 80);
  assert.equal(bid.edgeY, 400);
  assert.equal(ask.edgeY, 80);
  assert.ok(bid.thicknessPx >= 3);
  assert.ok(ask.thicknessPx >= 3);
});

test("filters live walls by book, visible, or custom price span", () => {
  const walls = [
    wallAt("bid", 80_000, 200_000),
    { side: "bid", price: 100, low: 90, high: 110, size: 1, notional: 200_000 },
    wallAt("ask", 84_000, 300_000),
    wallAt("ask", 90_000, 400_000),
  ];
  assert.deepEqual(filterWallsForRange(walls, "book").map((wall) => wall.price), [80_000, 100, 84_000, 90_000]);
  assert.deepEqual(filterWallsForRange(walls, "visible", { visible: null }).map((wall) => wall.price), [80_000, 100, 84_000, 90_000]);
  assert.deepEqual(filterWallsForRange(walls, "visible", { visible: { low: 83_000, high: 85_000 } }).map((wall) => wall.price), [84_000]);
  assert.deepEqual(filterWallsForRange(walls, "visible", { visible: { low: 70_000, high: 80_000 } }).map((wall) => wall.price), [80_000]);
  assert.equal(filterWallsForRange(walls, "visible", { visible: { low: 108, high: 120 } }).some((wall) => wall.price === 100), true);
  assert.equal(filterWallsForRange(walls, "visible", { visible: { low: 111, high: 120 } }).some((wall) => wall.price === 100), false);
  assert.deepEqual(filterWallsForRange(walls, "custom", { customLow: null, customHigh: 85_000 }).map((wall) => wall.price), [80_000, 100, 84_000, 90_000]);
  assert.deepEqual(filterWallsForRange(walls, "custom", { customLow: 91_000, customHigh: 89_000 }).map((wall) => wall.price), [90_000]);
});

test("persists min notional and price-range settings and ignores forged modes", () => {
  assert.equal(LARGE_ORDER_SR_MIN_NOTIONAL_KEY, "th-large-order-sr-min-notional");
  assert.equal(LARGE_ORDER_SR_RANGE_KEY, "th-large-order-sr-range");
  const storage = memoryStorage();
  assert.equal(readStoredMinNotional(storage), 100_000);
  writeStoredMinNotional(storage, 50_000);
  assert.equal(readStoredMinNotional(storage), 50_000);
  writeStoredMinNotional(storage, 5_000);
  assert.equal(readStoredMinNotional(storage), 10_000);
  writeStoredMinNotional(storage, 80_000_000);
  assert.equal(readStoredMinNotional(storage), 50_000_000);
  assert.deepEqual(readStoredWallRange(storage), { mode: "book", low: null, high: null });
  writeStoredWallRange(storage, { mode: "custom", low: 80_000, high: 90_000 });
  assert.deepEqual(readStoredWallRange(storage), { mode: "custom", low: 80_000, high: 90_000 });
  storage.setItem(LARGE_ORDER_SR_RANGE_KEY, JSON.stringify({ mode: "historical", low: 1, high: 2 }));
  assert.deepEqual(readStoredWallRange(storage), { mode: "book", low: null, high: null });
  storage.setItem(LARGE_ORDER_SR_RANGE_KEY, JSON.stringify({ mode: "visible", low: -4, high: "nope" }));
  assert.deepEqual(readStoredWallRange(storage), { mode: "visible", low: null, high: null });
  writeStoredMinNotional({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  }, 250_000);
  writeStoredWallRange({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  }, { mode: "book", low: null, high: null });
  assert.equal(readStoredMinNotional({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  }), 100_000);
});

test("loadLargeOrderWalls sends clamped min notional on the depth request", async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    return jsonResponse({
      venue: "okx",
      symbol: "BTCUSDT",
      source: "official",
      midPrice: 80_000,
      walls: [wallAt("bid", 80_000, 200_000)],
      notice: null,
      updatedAt: 1,
    });
  };
  await loadLargeOrderWalls("okx", "BTCUSDT", fetchImpl, { minNotional: 50_000, retryPreferred: false });
  assert.ok(calls.some((url) => url.includes("/api/depth?") && url.includes("minNotional=50000")));
  calls.length = 0;
  await loadLargeOrderWalls("okx", "BTCUSDT", fetchImpl, { minNotional: -1, retryPreferred: false });
  assert.ok(calls.some((url) => url.includes("minNotional=10000")));
  assert.ok(calls.every((url) => !url.includes("minNotional=-1")));
});

test("persists the left-rail S/R toggle without throwing in private mode", () => {
  const storage = memoryStorage();
  assert.equal(readStoredFlag(storage, LARGE_ORDER_SR_STORAGE_KEY, false), false);
  writeStoredFlag(storage, LARGE_ORDER_SR_STORAGE_KEY, true);
  assert.equal(readStoredFlag(storage, LARGE_ORDER_SR_STORAGE_KEY), true);
  writeStoredFlag({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  }, LARGE_ORDER_SR_STORAGE_KEY, true);
});

test("workspace plots S/R on the K-chart from the left rail and never adds a right-side list", () => {
  const workspace = readFileSync(fileURLToPath(new URL("../app/trading-workspace.tsx", import.meta.url)), "utf8");
  const toolbar = readFileSync(fileURLToPath(new URL("../components/drawing-toolbar.tsx", import.meta.url)), "utf8");
  assert.match(toolbar, /Show support\/resistance walls/);
  assert.match(toolbar, /Hide support\/resistance walls/);
  assert.match(toolbar, /data-icon="large-order-sr"/);
  assert.match(workspace, /\[showFast, setShowFast\] = useState\(false\)/);
  assert.match(workspace, /\[showSlow, setShowSlow\] = useState\(false\)/);
  assert.match(workspace, /S\/R · \{displayedWalls\.length\}/);
  assert.match(workspace, /<SrWallControls /);
  assert.match(workspace, /filterWallsForRange/);
  assert.match(workspace, /loadLargeOrderWalls\(activeVenue, symbol, fetch, \{ retryPreferred, minNotional \}\)/);
  assert.match(workspace, /getVisibleRange\(\)/);
  const controls = readFileSync(fileURLToPath(new URL("../components/sr-wall-controls.tsx", import.meta.url)), "utf8");
  assert.match(controls, /\$50k/);
  assert.match(controls, /\$100k/);
  assert.match(controls, /\$250k/);
  assert.match(controls, /\$1M/);
  assert.match(controls, /aria-label="Custom minimum wall notional"/);
  assert.match(controls, /aria-label="Wall price range"/);
  assert.match(controls, /aria-label="Custom range low"/);
  assert.match(controls, /aria-label="Custom range high"/);
  assert.match(controls, />Book</);
  assert.match(controls, />Visible</);
  assert.match(controls, />Custom</);
  const primitive = readFileSync(fileURLToPath(new URL("../lib/large-order-sr-primitive.ts", import.meta.url)), "utf8");
  assert.match(primitive, /layoutSeparatedWalls/);
  assert.doesNotMatch(primitive, /historical|swing high|candle high/);
  assert.match(workspace, /loadLargeOrderWalls/);
  assert.match(workspace, /LargeOrderSrPrimitive/);
  assert.match(workspace, /LARGE_ORDER_SR_STORAGE_KEY/);
  assert.match(workspace, /data-large-order-sr/);
  assert.doesNotMatch(workspace, /large-order-list|order-book-panel|大额挂单/);
  assert.doesNotMatch(toolbar, /large-order-list|order-book-panel/);
  const marketEffect = workspace.slice(workspace.indexOf("loadLargeOrderWalls(activeVenue"), workspace.indexOf("}, [activeVenue, minNotional, showLargeOrderSr, symbol]"));
  assert.doesNotMatch(marketEffect, /setConsoleText|setConsoleKind/);
});
