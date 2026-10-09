import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(html, /data-liq-heatmap="off"/);
  assert.match(html, /aria-label="Show unfilled large orders"/);
  assert.match(html, /title="Show unfilled large orders \(大额挂单\)"/);
  assert.match(html, /aria-label="Show executed large trades"/);
  assert.match(html, /title="Show executed large trades \(大额成交\)"/);
  assert.match(html, /data-icon="large-order-sr"/);
  assert.match(html, /data-icon="large-trades"/);
  assert.match(html, /data-icon="liq-heatmap"/);
  assert.match(html, /aria-label="Show liquidation heatmap"/);
  assert.match(html, /title="Show extreme liquidation heatmap \(极高清算带\)"/);
  assert.ok(html.indexOf('aria-label="Show unfilled large orders"') < html.indexOf('aria-label="Show executed large trades"'));
  assert.ok(html.indexOf('aria-label="Show executed large trades"') < html.indexOf('aria-label="Show liquidation heatmap"'));
  assert.ok(html.indexOf('aria-label="Show liquidation heatmap"') < html.indexOf('aria-label="Chart settings"'));
  assert.doesNotMatch(buttonOpeningTag(html, "Show unfilled large orders"), /\bactive\b/);
  assert.doesNotMatch(buttonOpeningTag(html, "Show executed large trades"), /\bactive\b/);
  assert.doesNotMatch(buttonOpeningTag(html, "Show liquidation heatmap"), /\bactive\b/);
  assert.doesNotMatch(html, /Custom minimum wall notional/);
  assert.doesNotMatch(html, /Wall price range/);
  assert.doesNotMatch(html, /aria-label="Unfilled large orders"/);
  assert.doesNotMatch(html, /aria-label="Executed large trades"/);
  // TH-UI-06: the right-panel INDICATORS list is replaced by a TradingView-style
  // toolbar "Indicators" menu plus a chart legend.
  assert.doesNotMatch(html, /<h2 class="section-kicker">Indicators<\/h2>/);
  assert.doesNotMatch(html, /Order flow · separate pane/);
  assert.doesNotMatch(html, /Derivatives · separate pane/);
  assert.doesNotMatch(html, /aria-label="Run custom Pine"/);
  assert.match(buttonOpeningTag(html, "Indicators"), /aria-expanded="false"/);
  assert.ok(html.indexOf('aria-label="Indicators"') < html.indexOf('class="chart-region"'), "Indicators button lives in the chart toolbar");
  assert.match(html, /aria-label="Resize right panel"[^>]*aria-orientation="vertical"/);
  assert.match(buttonOpeningTag(html, "Collapse right panel"), /aria-expanded="true"/);
  assert.match(buttonOpeningTag(html, "Collapse right panel"), /aria-controls="th-right-panel"/);
  assert.match(html, /<aside class="right-panel" id="th-right-panel">/);
  assert.match(html, /--side-panel-width:292px/);
  assert.match(html, /Futures vs spot|Futures − spot/);
  assert.match(html, /Backend data packs are ready/);
  assert.match(html, /Pine Editor/);
  assert.match(html, /Open Pine editor in new tab/);
  assert.match(html, /Collapse bottom panel/);
  assert.doesNotMatch(html, /Toggle EMA 9/);
  assert.doesNotMatch(html, /Toggle EMA 21/);
  // Nothing is added by default, so the server-rendered legend is empty.
  assert.doesNotMatch(html, /aria-label="Chart indicators"/);
  assert.doesNotMatch(html, /Remove EMA 9/);
  assert.doesNotMatch(html, /Remove EMA 21/);
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
  assert.match(html, /href="\/etf-flows"/);
  assert.match(html, />ETF Flows<\/a>/);
  assert.match(html, /href="\/cvd-oi"/);
  assert.match(html, />CVD \/ OI<\/a>/);
  assert.match(html, /href="\/cex-netflow"/);
  assert.match(html, />Net Flow<\/a>/);
  assert.match(html, /aria-label="Exchange Net Flow Pulse \(proxy\)"/);
  assert.doesNotMatch(html, /href="\/ifp"/);
  assert.ok(html.indexOf('href="/etf-flows"') < html.indexOf('aria-label="Chart drawing tools"'));
  assert.ok(html.indexOf('href="/cvd-oi"') < html.indexOf('aria-label="Chart drawing tools"'));
  assert.ok(html.indexOf('href="/cex-netflow"') < html.indexOf('aria-label="Chart drawing tools"'));
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

test("ETF flows and CVD/OI pages serve sanitized fixtures and ignore privilege flags", async () => {
  const app = await worker();
  const forgedQuery = "admin=1&entitled=true&role=admin&authorized=1&hasMarketHistory=1&membership=pro&privileged=1";
  const etfPage = await app.fetch(new Request(`http://localhost/etf-flows?${forgedQuery}`, { headers: { accept: "text/html" } }), env, context);
  assert.equal(etfPage.status, 200);
  const etfHtml = await etfPage.text();
  assert.match(etfHtml, /<title>BTC ETF Flows — Trading Hub<\/title>/i);
  assert.match(etfHtml, /Cumulative Total Net Inflow/);
  assert.match(etfHtml, /Daily Total Net Inflow/);
  assert.match(etfHtml, /Daily Volume/);
  assert.match(etfHtml, /Total Net Assets/);
  assert.match(etfHtml, /As of 2026-09-29/);
  assert.match(etfHtml, /evening ET/);
  assert.match(etfHtml, /\$57\.64B/);
  assert.match(etfHtml, /\+51\.1/);
  assert.match(etfHtml, /-18\.1/);
  assert.match(etfHtml, /Back to workspace/);
  assert.match(etfHtml, /href="\/"/);
  assert.match(etfHtml, /aria-label="Flow unit"/);
  assert.doesNotMatch(etfHtml, /Access granted|Pro membership/);

  const etf = await app.fetch(new Request(`http://localhost/api/etf-flows?${forgedQuery}&symbol=ETHUSDT`), env, context);
  assert.equal(etf.status, 200);
  assert.match(etf.headers.get("cache-control") ?? "", /max-age=60/);
  const etfBody = await etf.json();
  assert.equal(etfBody.kind, "btc_spot_etf_flows");
  assert.equal(etfBody.asOfDate, "2026-09-29");
  assert.equal(etfBody.rows.length, 20);
  assert.equal(etfBody.rows[0].date, "2026-09-29");
  assert.equal(etfBody.rows[0].flowsUsdM.IBIT, 51.1);
  assert.equal(etfBody.admin, undefined);
  assert.equal(etfBody.role, undefined);
  assert.equal(etfBody.entitled, undefined);
  assert.equal(etfBody.hasMarketHistory, undefined);
  assert.equal(etfBody.privileged, undefined);
  assert.doesNotMatch(JSON.stringify(etfBody), /https?:\/\//);

  const etfPost = await app.fetch(new Request("http://localhost/api/etf-flows?admin=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "btc_spot_etf_flows", admin: true, rows: [{ date: "1999-01-01" }] }),
  }), env, context);
  assert.notEqual(etfPost.status, 200);
  assert.doesNotMatch(await etfPost.text(), /1999-01-01/);

  const cvdPage = await app.fetch(new Request(`http://localhost/cvd-oi?${forgedQuery}`, { headers: { accept: "text/html" } }), env, context);
  assert.equal(cvdPage.status, 200);
  const cvdHtml = await cvdPage.text();
  assert.match(cvdHtml, /<title>CVD \/ OI — Trading Hub<\/title>/i);
  assert.match(cvdHtml, /BTC Price/);
  assert.match(cvdHtml, /Open Interest/);
  assert.match(cvdHtml, /Cumulative Net Taker Volume/);
  assert.match(cvdHtml, /Direction\/scale close to CryptoQuant/);
  assert.match(cvdHtml, /84,024\.90/);
  assert.match(cvdHtml, /#111111/);
  assert.match(cvdHtml, /#2f6bff/);
  assert.match(cvdHtml, /#e23b4a/);
  assert.match(cvdHtml, /Back to workspace/);
  assert.match(cvdHtml, /Shared time axis/);

  const cvd = await app.fetch(new Request(`http://localhost/api/cvd-oi?symbol=ETHUSDT&${forgedQuery}`), env, context);
  assert.equal(cvd.status, 200);
  const cvdBody = await cvd.json();
  assert.equal(cvdBody.kind, "binance_cvd_oi");
  assert.equal(cvdBody.symbol, "BTCUSDT");
  assert.equal(cvdBody.series.length, 288);
  assert.equal(cvdBody.series.at(-1).price, 84024.9);
  assert.equal(cvdBody.admin, undefined);
  assert.equal(cvdBody.role, undefined);
  assert.equal(cvdBody.hasMarketHistory, undefined);
  assert.equal(cvdBody.symbol, "BTCUSDT");
  assert.doesNotMatch(JSON.stringify(cvdBody), /https?:\/\/|ETHUSDT/);

  const cvdPost = await app.fetch(new Request("http://localhost/api/cvd-oi", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "binance_cvd_oi", symbol: "ETHUSDT", admin: true }),
  }), env, context);
  assert.notEqual(cvdPost.status, 200);
  assert.doesNotMatch(await cvdPost.text(), /ETHUSDT/);
});

test("exchange net flow page serves the sanitized reserve proxy and ignores privilege flags", async () => {
  const app = await worker();
  const sample = JSON.parse(readFileSync(new URL("../fixtures/cex_netflow.sample.json", import.meta.url), "utf8"));
  const forgedQuery = "admin=1&entitled=true&role=admin&authorized=1&hasMarketHistory=1&membership=pro&privileged=1&kind=btc_ifp";
  const page = await app.fetch(new Request(`http://localhost/cex-netflow?${forgedQuery}`, { headers: { accept: "text/html" } }), env, context);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Exchange Net Flow Pulse — Trading Hub<\/title>/i);
  assert.match(html, /data-page="cex-netflow"/);
  assert.match(html, /交易所净流\/储备脉搏/);
  assert.match(html, /<h1>Bitcoin: Exchange Net Flow Pulse \(proxy\)<\/h1>/);
  assert.match(html, /CEX reserve proxy \(CoinMetrics\)/);
  assert.match(html, /Not CryptoQuant Inter-exchange Flow Pulse\./);
  assert.match(html, /CEX net flow \/ reserve proxy/);
  assert.match(html, /BTC Price/);
  assert.match(html, /2\.686M BTC/);
  assert.match(html, /\$83,674\.66/);
  assert.match(html, /data-signal="bull"/);
  assert.match(html, /non-CQ \/ experimental proxy/);
  assert.match(html, /90(?:<!-- -->)?d MA/);
  assert.match(html, /Back to workspace/);
  assert.doesNotMatch(html, /href="\/ifp"/);
  assert.doesNotMatch(html, /<h1>[^<]*\bIFP\b/);
  const nav = html.match(/<nav class="desk-nav"[\s\S]*?<\/nav>/);
  assert.ok(nav);
  assert.match(nav[0], /href="\/cex-netflow"/);
  assert.doesNotMatch(nav[0], /CryptoQuant|Inter-exchange Flow Pulse|\bIFP\b/);

  const api = await app.fetch(new Request(`http://localhost/api/cex-netflow?${forgedQuery}`), env, context);
  assert.equal(api.status, 200);
  assert.match(api.headers.get("cache-control") ?? "", /max-age=60/);
  const body = await api.json();
  assert.equal(body.kind, "btc_cex_netflow");
  assert.equal(body.disclaimer, sample.disclaimer);
  assert.equal(body.series.length, 303);
  assert.equal(body.series.at(-1).t, "2026-09-29");
  assert.equal(body.series.at(-1).flowBtc, 2686232.3669);
  assert.equal(body.series.at(-1).signal, "bull");
  assert.equal(body.admin, undefined);
  assert.equal(body.role, undefined);
  assert.equal(body.entitled, undefined);
  assert.equal(body.hasMarketHistory, undefined);
  assert.equal(body.privileged, undefined);
  assert.equal(body.axes.flowBtc.meaning, undefined);
  const { disclaimer, ...rest } = body;
  assert.equal(disclaimer, sample.disclaimer);
  assert.doesNotMatch(JSON.stringify(rest), /CryptoQuant|Inter-exchange Flow Pulse|\bIFP\b|https?:\/\/|btc_ifp/);

  const posted = await app.fetch(new Request("http://localhost/api/cex-netflow?admin=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "btc_ifp", admin: true, series: [{ t: "1999-01-01", flowBtc: 1 }] }),
  }), env, context);
  assert.notEqual(posted.status, 200);
  assert.doesNotMatch(await posted.text(), /1999-01-01|btc_ifp/);
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

test("liq heatmap API serves the ZEC fixture and drops mismatched or forged queries", async () => {
  const app = await worker();
  const missing = await app.fetch(new Request("http://localhost/api/liq-heatmap"), env, context);
  assert.equal(missing.status, 400);
  const forged = await app.fetch(new Request("http://localhost/api/liq-heatmap?symbol=../etc/passwd&admin=1&entitled=true"), env, context);
  assert.equal(forged.status, 400);
  assert.deepEqual(await forged.json(), { error: "Use a compact perpetual symbol such as ZECUSDT" });
  const mismatch = await app.fetch(new Request("http://localhost/api/liq-heatmap?symbol=BTCUSDT&admin=1&role=admin&hasMarketHistory=1"), env, context);
  assert.equal(mismatch.status, 200);
  const mismatchBody = await mismatch.json();
  assert.deepEqual(mismatchBody.bands, []);
  assert.equal(mismatchBody.notice, "Extreme liquidation bands match ZECUSDT only.");
  assert.equal(mismatchBody.admin, undefined);
  assert.equal(mismatchBody.role, undefined);
  const sample = await app.fetch(new Request("http://localhost/api/liq-heatmap?symbol=ZEC&liqSample=1&role=admin"), env, context);
  assert.equal(sample.status, 200);
  const body = await sample.json();
  assert.equal(body.kind, "liq_heatmap_bands");
  assert.equal(body.symbol, "ZECUSDT");
  assert.equal(body.bucket_pct, 0.5);
  assert.equal(body.bands.length, 13);
  assert.equal(body.admin, undefined);
  assert.equal(body.role, undefined);
  assert.ok(body.bands.every((band) => band.risk === "极高" && (band.side === "long" || band.side === "short")));
  assert.equal(body.bands.some((band) => band.side === "long"), true);
  assert.equal(body.bands.some((band) => band.side === "short"), true);
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
