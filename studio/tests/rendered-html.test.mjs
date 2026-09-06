import assert from "node:assert/strict";
import test from "node:test";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

function requiredIndex(html, token) {
  const index = html.indexOf(token);
  assert.notEqual(index, -1, `missing rendered token: ${token}`);
  return index;
}

test("renders drawing tools between the chart toolbar and editor", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), env, context);
  const html = await response.text();
  const chartToolbar = requiredIndex(html, 'class="chart-toolbar"');
  const chartRegion = requiredIndex(html, 'class="chart-region"');
  const drawingToolbar = requiredIndex(html, 'aria-label="Chart drawing tools"');
  const chartStage = requiredIndex(html, 'class="chart-stage');
  const bottomPanel = requiredIndex(html, 'class="bottom-panel');
  assert.ok(chartToolbar < chartRegion);
  assert.ok(chartRegion < drawingToolbar);
  assert.ok(drawingToolbar < chartStage);
  assert.ok(chartStage < bottomPanel);
});

test("server-renders the πlab trading workspace", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), env, context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>πlab — Live crypto charting<\/title>/i);
  assert.match(html, /πlab/);
  assert.match(html, /Derivatives pulse/);
  assert.match(html, /Order flow/);
  assert.match(html, /Perp CVD/);
  assert.match(html, /Spot CVD/);
  assert.match(html, /Futures vs spot/);
  assert.match(html, /Pine Editor/);
  assert.match(html, /Open Pine editor in new tab/);
  assert.match(html, /Collapse bottom panel/);
  assert.match(html, /Remove EMA 9 indicator/);
  assert.match(html, /Remove EMA 21 indicator/);
  assert.match(html, /Add to chart/);
  assert.match(html, /Create alert \(Alt\+A\)/);
  assert.match(html, /Search symbols \(Cmd\/Ctrl\+K\)/);
  assert.match(html, /Resize Pine editor panel/);
  assert.match(html, /aria-valuemin="37"/);
  assert.match(html, /Resize compiler console/);
  assert.match(html, /Compiler output/);
  assert.match(html, /Chart market venue/);
  assert.match(html, /aria-label="Resize compiler console"[^>]*aria-orientation="horizontal"/);
  assert.match(html, /aria-label="Select drawing tool"/);
  assert.match(html, /aria-label="Trend line drawing tool"/);
  assert.match(html, /aria-label="Horizontal line drawing tool"/);
  assert.match(html, /aria-label="Arrow drawing tool"/);
  assert.match(html, /aria-label="Text drawing tool"/);
  assert.match(html, /aria-label="Measure price change drawing tool"/);
  assert.match(html, /data-icon="ruler"/);
  assert.match(html, /aria-label="Crosshair drawing tool"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Create alert/);
  assert.match(html, /AI Analyst/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("server-renders the synchronized Pine editor tab", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/pine-editor", { headers: { accept: "text/html" } }), env, context);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Pine Editor — πlab<\/title>/i);
  assert.match(html, /Changes sync automatically/);
  assert.match(html, /Return to chart/);
});

test("AI route validates model connection details before forwarding data", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/ai/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://localhost:11434/v1/chat/completions", model: "test", question: "Analyze" }),
  }), env, context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Only public HTTPS model endpoints are allowed" });
});

test("derivatives API rejects unsupported exchanges", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/derivatives?exchange=unknown"), env, context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Supported exchanges: bybit, binance, okx, bitget" });
});

test("CVD API rejects unsupported exchanges", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/cvd?exchange=unknown&symbol=BTCUSDT&interval=15"), env, context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Supported exchanges: bybit, binance, okx, bitget" });
});

test("klines and markets APIs reject unsupported exchanges", async () => {
  const app = await worker();
  const klines = await app.fetch(new Request("http://localhost/api/klines?exchange=unknown&symbol=BTCUSDT&interval=15"), env, context);
  assert.equal(klines.status, 400);
  assert.deepEqual(await klines.json(), { error: "Supported exchanges: bybit, binance, okx, bitget" });
  const markets = await app.fetch(new Request("http://localhost/api/markets?exchange=unknown"), env, context);
  assert.equal(markets.status, 400);
  assert.deepEqual(await markets.json(), { error: "Supported exchanges: bybit, binance, okx, bitget" });
});

test("markets API can list all public catalogs without API keys", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/markets?exchange=all"), env, context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.exchange, "all");
  assert.ok(Array.isArray(payload.markets));
  const venues = new Set(payload.markets.map((market) => market.venue));
  assert.ok(venues.has("okx"));
  assert.ok(venues.has("bitget"));
  assert.ok(payload.markets.some((market) => market.symbol === "BTCUSDT"));
});

test("CVD API can serve OKX public perp and spot trades without API keys", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/cvd?exchange=okx&symbol=BTCUSDT&interval=15"), env, context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.venue, "okx");
  assert.equal(payload.symbol, "BTCUSDT");
  assert.ok(payload.perp.available || payload.spot.available);
  if (payload.perp.available && payload.spot.available) {
    assert.equal(typeof payload.comparison.interpretation, "string");
    assert.match(payload.comparison.interpretation, /perp|spot|Force|takers/i);
  } else {
    assert.equal(payload.comparison.available, false);
  }
});

test("klines API can serve OKX public candles without API keys", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/klines?exchange=okx&symbol=BTCUSDT&interval=15&limit=2"), env, context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.exchange, "okx");
  assert.ok(Array.isArray(payload.candles));
  assert.ok(payload.candles.length >= 1);
  assert.equal(typeof payload.candles[0].close, "number");
});
