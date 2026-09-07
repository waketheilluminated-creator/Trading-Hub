import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderPreset, providerFromEndpoint } from "../lib/ai/providers.ts";
import { validatePublicHttpsEndpoint } from "../lib/ai/endpoint.ts";
import { classifyNetworkError, classifyProviderStatus } from "../lib/ai/errors.ts";
import { buildContextPack, summarizeContextPack } from "../lib/ai/context-pack.ts";
import { CONTEXT_CAPTURE, HISTORY_SERVER_REASON, detectHistoryLookback, packHistoryRange } from "../lib/ai/history.ts";
import { buildSystemPrompt, buildUserPrompt } from "../lib/ai/prompt.ts";
import { runAiProxy } from "../lib/ai/proxy.ts";
import { containsSecret, redactSecrets } from "../lib/ai/secrets.ts";
import { BYOK_SESSION_KEY, defaultByokSession, loadByokSession, parseByokSession, saveByokSession, serializeByokSession } from "../lib/ai/session.ts";

const secret = "sk-proj-SUPERSECRETKEYVALUE99";

function memoryStorage(start = {}) {
  const values = new Map(Object.entries(start));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    values,
  };
}

test("provider presets map known hosts and keep a custom model", () => {
  assert.equal(providerFromEndpoint("https://api.openai.com/v1/chat/completions"), "openai");
  assert.equal(providerFromEndpoint("https://api.deepseek.com/v1/chat/completions"), "deepseek");
  assert.equal(providerFromEndpoint("https://api.groq.com/openai/v1/chat/completions"), "groq");
  assert.equal(providerFromEndpoint("https://api.together.xyz/v1/chat/completions"), "together");
  assert.equal(providerFromEndpoint("https://llm.example.com/v1/chat/completions"), "custom");
  assert.deepEqual(applyProviderPreset("deepseek", { providerId: "openai", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini" }), {
    providerId: "deepseek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
  });
  assert.equal(applyProviderPreset("groq", { providerId: "custom", endpoint: "", model: "my-finetune" }).model, "my-finetune");
});

test("rejects private or non-HTTPS endpoints and completes /v1 paths", () => {
  assert.equal(validatePublicHttpsEndpoint("http://api.openai.com/v1/chat/completions").ok, false);
  assert.equal(validatePublicHttpsEndpoint("https://127.0.0.1/v1/chat/completions").ok, false);
  assert.equal(validatePublicHttpsEndpoint("https://10.0.0.8/v1/chat/completions").ok, false);
  assert.equal(validatePublicHttpsEndpoint("https://localhost/v1/chat/completions").ok, false);
  assert.equal(validatePublicHttpsEndpoint("https://fcm.googleapis.com/v1/chat/completions").ok, true);
  assert.equal(validatePublicHttpsEndpoint("https://user:pass@api.openai.com/v1/chat/completions").ok, false);
  const normalized = validatePublicHttpsEndpoint("https://api.openai.com/v1");
  assert.equal(normalized.ok, true);
  assert.equal(normalized.url.pathname, "/v1/chat/completions");
});

test("redacts API keys from provider copy and never echoes them", () => {
  const dirty = `Invalid key ${secret} Bearer ${secret}`;
  const clean = redactSecrets(dirty, [secret]);
  assert.equal(containsSecret(clean, [secret]), false);
  assert.match(clean, /\[redacted\]/);
  assert.doesNotMatch(clean, /SUPERSECRETKEYVALUE99/);
});

test("classifies 401, 429, invalid model, and unreachable hosts", () => {
  assert.equal(classifyProviderStatus(401, `Incorrect API key provided: ${secret}`, secret).code, "unauthorized");
  assert.equal(classifyProviderStatus(429, "Rate limit exceeded").code, "rate_limited");
  assert.equal(classifyProviderStatus(404, "The model `nope` does not exist").code, "invalid_model");
  assert.equal(classifyProviderStatus(400, "invalid model: nope").code, "invalid_model");
  assert.equal(classifyNetworkError(new Error("getaddrinfo ENOTFOUND api.openai.com")).code, "unreachable");
  assert.doesNotMatch(classifyProviderStatus(401, secret, secret).error, /SUPERSECRETKEYVALUE99/);
});

test("context pack attaches candles and derivatives and degrades missing CVD", () => {
  const pack = buildContextPack({
    symbol: "BTCUSDT",
    venue: "bybit",
    timeframe: "15m",
    lastPrice: 100,
    candles: [
      { time: 1700000000, open: 1, high: 2, low: 1, close: 2, volume: 8 },
      { time: 1700000900, open: 2, high: 3, low: 2, close: 2.5, volume: 5 },
    ],
    pinePlots: [{ title: "RSI", data: [40, 45, 50] }],
    derivatives: {
      sourceExchange: "bybit",
      openInterestUsd: 1,
      openInterestBase: 2,
      fundingRate: 0.0001,
      markPrice: 100,
      indexPrice: 99.5,
      nextFundingTimestamp: 1700000000000,
    },
  }, "2026-09-06T00:00:00.000Z");
  assert.equal(pack.market.symbol, "BTCUSDT");
  assert.equal(pack.source.kind, CONTEXT_CAPTURE);
  assert.equal(pack.source.screenshots, false);
  assert.equal(pack.history.status, "current-window");
  assert.equal(pack.candles.length, 2);
  assert.equal(pack.derivatives.available, true);
  assert.equal(pack.cvd.available, false);
  assert.match(pack.cvd.reason, /CVD is not attached/);
  assert.deepEqual(summarizeContextPack(pack), { candles: 2, hasDerivatives: true, hasCvd: false, history: "current-window", indicators: 3 });

  const withCvd = buildContextPack({
    symbol: "ETHUSDT",
    venue: "okx",
    timeframe: "1H",
    candles: [{ time: 1700000000, open: 1, high: 1, low: 1, close: 1 }],
    cvd: { last: 12, recent: [{ value: 12 }] },
  });
  assert.equal(withCvd.cvd.available, true);
  assert.equal(withCvd.derivatives.available, false);
});

test("system prompt uses Trading Hub research framing", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Trading Hub AI Analyst/);
  assert.doesNotMatch(prompt, /πlab/);
  assert.match(prompt, /not personalized financial advice/);
  assert.match(prompt, /same language as the user's question/);
  assert.match(prompt, /Never request, infer from, or wait for chart screenshots/);
  assert.match(prompt, /history\.status is packed or partial/);
  assert.doesNotMatch(prompt, /history\.status is deferred/);
  assert.match(buildUserPrompt("趋势如何？", "{\"symbol\":\"BTCUSDT\"}"), /CURRENT TRADING HUB CONTEXT PACK/);
});

test("history lookback is an arbitrary backend pack, never screenshots", () => {
  assert.equal(detectHistoryLookback("What is the current trend?").requested, false);
  assert.equal(detectHistoryLookback("Is funding paying longs today?").requested, false);
  assert.equal(detectHistoryLookback("Summarize the last 3 months of OI and funding").requested, true);
  assert.equal(detectHistoryLookback("How did this market trade over the past year?").requested, true);
  assert.equal(detectHistoryLookback("对比近半年的持仓").requested, true);

  const pending = buildContextPack({
    symbol: "BTCUSDT",
    venue: "okx",
    timeframe: "15m",
    candles: [{ time: 1700000000, open: 1, high: 1, low: 1, close: 1 }],
  }, "2026-09-06T00:00:00.000Z", "Show me the last 90 days of structure");
  assert.equal(pending.history.status, "unavailable");
  assert.equal(pending.history.available, false);
  assert.equal(pending.history.requested, "last 90 days");
  assert.equal(pending.history.reason, HISTORY_SERVER_REASON);
  assert.equal(pending.source.screenshots, false);
  assert.equal(pending.source.capture, "never-screenshots");
  assert.doesNotMatch(JSON.stringify(pending), /image\/png|data:image|scroll-and-screenshot/i);

  const bars = Array.from({ length: 120 }, (_, index) => ({
    t: 1_700_000_000 + index * 900,
    o: 100,
    h: 101,
    l: 99,
    c: 100.5,
    v: 4,
  }));
  const packed = packHistoryRange("47 hours", bars, { interval: "15", venue: "okx" });
  assert.equal(packed.status, "packed");
  assert.equal(packed.available, true);
  assert.equal(packed.screenshots, false);
  assert.equal(packed.recent.length, 80);
  assert.ok(packed.earlier && packed.earlier.bars === 40);
  assert.equal(packHistoryRange("since listing").requested, "since listing");
  assert.equal(packHistoryRange("since listing").status, "unavailable");
  assert.equal(packHistoryRange("").status, "current-window");
});

test("sessionStorage keeps settings and only writes the key when opted in", () => {
  const storage = memoryStorage();
  const session = { ...defaultByokSession(), endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", apiKey: secret };
  assert.equal(saveByokSession(storage, session), true);
  assert.doesNotMatch(storage.getItem(BYOK_SESSION_KEY), /SUPERSECRETKEYVALUE99/);
  assert.equal(loadByokSession(storage).apiKey, "");

  session.rememberKey = true;
  saveByokSession(storage, session);
  const stored = parseByokSession(storage.getItem(BYOK_SESSION_KEY));
  assert.equal(stored.apiKey, secret);
  assert.equal(JSON.parse(serializeByokSession({ ...session, rememberKey: false })).apiKey, undefined);
  assert.equal(loadByokSession(null).providerId, "openai");
});

test("proxy test mode validates the model without echoing secrets", async () => {
  const response = await runAiProxy({
    mode: "test",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini",
    apiKey: secret,
  }, async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 8);
    assert.doesNotMatch(body.messages[1].content, /CONTEXT PACK/);
    return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${secret}` } }), { status: 401 });
  });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.code, "unauthorized");
  assert.equal(containsSecret(JSON.stringify(payload), [secret]), false);
});

test("proxy analyze mode attaches the context pack on success", async () => {
  const response = await runAiProxy({
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    question: "趋势如何？",
    context: { market: { symbol: "BTCUSDT" }, cvd: { available: false } },
  }, async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content, /Trading Hub AI Analyst/);
    assert.match(body.messages[1].content, /CURRENT TRADING HUB CONTEXT PACK/);
    assert.match(body.messages[1].content, /BTCUSDT/);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Market state: 观察中" } }] }), { status: 200 });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { analysis: "Market state: 观察中" });
});
