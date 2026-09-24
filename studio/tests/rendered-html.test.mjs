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

function buttonOpeningTag(html, label) {
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  const button = buttons.find((tag) => tag.includes(`aria-label="${label}"`));
  assert.ok(button, `missing button ${label}`);
  return button;
}

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

test("server-renders the Trading Hub trading workspace", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), env, context);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Trading Hub — Live crypto charting<\/title>/i);
  assert.match(html, /Trading Hub/);
  assert.doesNotMatch(html, /πlab|pi lab|Pine Studio/i);
  assert.match(html, /Derivatives pulse/);
  assert.match(html, /Order flow/);
  assert.match(html, /Perp CVD/);
  assert.match(html, /Spot CVD/);
  assert.match(html, /Toggle CVD pane/);
  assert.match(html, /Toggle open interest pane/);
  assert.match(html, /data-cvd-pane="off"/);
  assert.match(html, /data-oi-pane="off"/);
  assert.match(html, /data-large-order-sr="off"/);
  assert.match(html, /data-large-trades="off"/);
  assert.match(html, /data-large-order-list="off"/);
  assert.match(html, /aria-label="Show unfilled large orders"/);
  assert.match(html, /title="Show unfilled large orders \(大额挂单\)"/);
  assert.match(html, /aria-label="Show executed large trades"/);
  assert.match(html, /title="Show executed large trades \(大额成交\)"/);
  assert.match(html, /data-icon="large-order-sr"/);
  assert.match(html, /data-icon="large-trades"/);
  assert.ok(html.indexOf('aria-label="Show unfilled large orders"') < html.indexOf('aria-label="Show executed large trades"'));
  assert.ok(html.indexOf('aria-label="Show executed large trades"') < html.indexOf('aria-label="Chart settings"'));
  assert.doesNotMatch(buttonOpeningTag(html, "Show unfilled large orders"), /\bactive\b/);
  assert.doesNotMatch(buttonOpeningTag(html, "Show executed large trades"), /\bactive\b/);
  assert.doesNotMatch(html, /Custom minimum wall notional/);
  assert.doesNotMatch(html, /Wall price range/);
  assert.doesNotMatch(html, /aria-label="Unfilled large orders"/);
  assert.doesNotMatch(html, /aria-label="Executed large trades"/);
  assert.match(html, /Order flow · separate pane/);
  assert.match(html, /Derivatives · separate pane/);
  assert.match(html, /Futures vs spot|Futures − spot/);
  assert.match(html, /Backend data packs are ready/);
  assert.match(html, /Pine Editor/);
  assert.match(html, /Open Pine editor in new tab/);
  assert.match(html, /Collapse bottom panel/);
  assert.match(html, /Toggle EMA 9/);
  assert.match(html, /Toggle EMA 21/);
  assert.doesNotMatch(buttonOpeningTag(html, "Toggle EMA 9"), /\bactive\b/);
  assert.doesNotMatch(buttonOpeningTag(html, "Toggle EMA 21"), /\bactive\b/);
  assert.doesNotMatch(html, /Remove EMA 9 indicator/);
  assert.doesNotMatch(html, /Remove EMA 21 indicator/);
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
  assert.match(html, /Trading Hub AI Analyst/);
  assert.match(html, /Test connection/);
  assert.match(html, /Bring your own key/);
  assert.match(html, /Session only/);
  assert.match(html, /AI provider preset/);
  assert.match(html, /backend Context Pack/);
  assert.match(html, /never from screenshots/);
  assert.match(html, /Backend series/);
  assert.doesNotMatch(html, /πlab AI Analyst/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("server-renders the synchronized Pine editor tab", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/pine-editor", { headers: { accept: "text/html" } }), env, context);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Pine Editor — Trading Hub<\/title>/i);
  assert.match(html, /Changes sync automatically with every open Trading Hub tab/);
  assert.match(html, /Return to chart/);
  assert.doesNotMatch(html, /πlab|pi lab|Pine Studio/i);
});

test("AI route validates model connection details before forwarding data", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/ai/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://localhost:11434/v1/chat/completions", model: "test", question: "Analyze" }),
  }), env, context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Only public HTTPS model endpoints are allowed." });
});

test("AI test-connection mode still blocks private hosts", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/ai/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "test", endpoint: "https://127.0.0.1/v1/chat/completions", model: "test", apiKey: "sk-proj-not-a-real-key" }),
  }), env, context);
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "Only public HTTPS model endpoints are allowed.");
  assert.doesNotMatch(JSON.stringify(payload), /sk-proj-not-a-real-key/);
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

test("depth API rejects unsupported exchanges and forged symbols", async () => {
  const app = await worker();
  const unknown = await app.fetch(new Request("http://localhost/api/depth?exchange=unknown&symbol=BTCUSDT"), env, context);
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "Supported exchanges: bybit, binance, okx, bitget" });
  const forged = await app.fetch(new Request("http://localhost/api/depth?exchange=okx&symbol=../etc/passwd"), env, context);
  assert.equal(forged.status, 400);
  assert.deepEqual(await forged.json(), { error: "Use a compact perpetual symbol such as BTCUSDT" });
});

test("depth API can serve OKX public order-book walls without API keys", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/depth?exchange=okx&symbol=BTCUSDT&minNotional=100000"), env, context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.venue, "okx");
  assert.equal(payload.symbol, "BTCUSDT");
  assert.ok(Array.isArray(payload.walls));
  assert.equal(typeof payload.midPrice, "number");
});

test("trades API rejects forged venues and symbols and ignores client trade dumps", async () => {
  const app = await worker();
  const unknown = await app.fetch(new Request("http://localhost/api/trades?exchange=unknown&symbol=BTCUSDT&privileged=1&trades=%5B%5D"), env, context);
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "Supported exchanges: bybit, binance, okx, bitget" });
  const forged = await app.fetch(new Request("http://localhost/api/trades?exchange=okx&symbol=../etc/passwd&minNotional=-1"), env, context);
  assert.equal(forged.status, 400);
  assert.deepEqual(await forged.json(), { error: "Use a compact perpetual symbol such as BTCUSDT" });
});

test("trades API can serve OKX public prints without API keys", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/trades?exchange=okx&symbol=BTCUSDT&minNotional=100000&privileged=1"), env, context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.venue, "okx");
  assert.equal(payload.symbol, "BTCUSDT");
  assert.equal(payload.source, "official");
  assert.equal(payload.minNotional, 100_000);
  assert.ok(Array.isArray(payload.trades));
  assert.ok(payload.trades.every((trade) => trade.notional >= 100_000 && (trade.side === "buy" || trade.side === "sell")));
  assert.equal(payload.privileged, undefined);
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

test("OI API can serve OKX public open-interest history without API keys", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/oi?exchange=okx&symbol=BTCUSDT&interval=15"), env, context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.venue, "okx");
  assert.equal(payload.symbol, "BTCUSDT");
  assert.ok(Array.isArray(payload.points));
  assert.ok(payload.points.length >= 2);
  assert.equal(typeof payload.points[0].time, "number");
  assert.equal(typeof payload.points[0].value, "number");
  assert.equal(payload.unit, "usd");
});
