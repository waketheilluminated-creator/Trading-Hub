import { classifyNetworkError, classifyProviderStatus, emptyModelReply, extractProviderMessage } from "./errors.ts";
import { validatePublicHttpsEndpoint } from "./endpoint.ts";
import { buildSystemPrompt, buildTestPrompt, buildUserPrompt } from "./prompt.ts";
import { redactSecrets } from "./secrets.ts";

export type AiProxyMode = "analyze" | "test";

export type AiProxyBody = {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  question?: string;
  context?: unknown;
  mode?: AiProxyMode;
};

const CONTEXT_LIMIT = 180_000;

function json(payload: Record<string, unknown>, status: number) {
  return Response.json(payload, { status });
}

function responseText(payload: Record<string, unknown>) {
  const choices = payload.choices as { message?: { content?: string } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.response === "string") return payload.response;
  return null;
}

function stringifyContext(context: unknown): { ok: true; json: string } | { ok: false; error: string } {
  try {
    const jsonText = JSON.stringify(context ?? {});
    if (jsonText.length > CONTEXT_LIMIT) return { ok: false, error: "Market context is too large." };
    return { ok: true, json: jsonText };
  } catch {
    return { ok: false, error: "Market context could not be serialized." };
  }
}

export async function runAiProxy(body: AiProxyBody, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const mode: AiProxyMode = body.mode === "test" ? "test" : "analyze";
  const endpoint = body.endpoint?.trim() ?? "";
  const model = body.model?.trim() ?? "";
  const question = body.question?.trim() ?? "";
  const apiKey = body.apiKey?.trim() ?? "";

  if (!endpoint || !model || (mode === "analyze" && !question)) {
    return json({ error: mode === "test" ? "Endpoint and model are required." : "Endpoint, model, and question are required." }, 400);
  }

  const target = validatePublicHttpsEndpoint(endpoint);
  if (!target.ok) return json({ error: target.error }, 400);

  let contextJson = "{}";
  if (mode === "analyze") {
    const packed = stringifyContext(body.context);
    if (!packed.ok) return json({ error: packed.error }, packed.error.includes("too large") ? 413 : 400);
    contextJson = packed.json;
  }

  const test = buildTestPrompt();
  const system = mode === "test" ? test.system : buildSystemPrompt();
  const user = mode === "test" ? test.question : buildUserPrompt(question, contextJson);

  try {
    const upstream = await fetchImpl(target.url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(mode === "test" ? 15_000 : 30_000),
      body: JSON.stringify({
        model,
        temperature: mode === "test" ? 0 : 0.2,
        max_tokens: mode === "test" ? 8 : 1000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    const raw = redactSecrets(await upstream.text(), [apiKey]);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(raw); } catch { /* handled below */ }
    if (!upstream.ok) {
      const classified = classifyProviderStatus(upstream.status, extractProviderMessage(payload, raw), apiKey);
      return json({ error: classified.error, code: classified.code }, classified.status);
    }
    const analysis = responseText(payload);
    if (!analysis) return json({ error: emptyModelReply().error, code: "empty" }, 502);
    if (mode === "test") return json({ ok: true, model });
    return json({ analysis });
  } catch (error) {
    const classified = classifyNetworkError(error, apiKey);
    return json({ error: classified.error, code: classified.code }, classified.status);
  }
}
