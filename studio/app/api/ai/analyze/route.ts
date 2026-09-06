import { ANALYST_SYSTEM_PROMPT } from "@/lib/ai-context.ts";

type AnalysisRequest = {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  question?: string;
  context?: unknown;
};

function isBlockedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host === "::1" || host === "0.0.0.0") return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function responseText(payload: Record<string, unknown>) {
  const choices = payload.choices as { message?: { content?: string } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.response === "string") return payload.response;
  return null;
}

export async function POST(request: Request) {
  let body: AnalysisRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request" }, { status: 400 });
  }

  const endpoint = body.endpoint?.trim();
  const model = body.model?.trim();
  const question = body.question?.trim();
  if (!endpoint || !model || !question) {
    return Response.json({ error: "Endpoint, model, and question are required" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    return Response.json({ error: "Enter a valid HTTPS model endpoint" }, { status: 400 });
  }
  if (target.protocol !== "https:" || target.username || target.password || isBlockedHost(target.hostname)) {
    return Response.json({ error: "Only public HTTPS model endpoints are allowed" }, { status: 400 });
  }

  const contextJson = JSON.stringify(body.context ?? {});
  if (contextJson.length > 180_000) {
    return Response.json({ error: "Market context is too large" }, { status: 413 });
  }

  const system = ANALYST_SYSTEM_PROMPT;

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(body.apiKey?.trim() ? { Authorization: `Bearer ${body.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${question}\n\nCURRENT πlab MARKET CONTEXT\n${contextJson}` },
        ],
      }),
    });

    const raw = await upstream.text();
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(raw); } catch { /* handled below */ }
    if (!upstream.ok) {
      const message = (payload.error as { message?: string } | undefined)?.message || raw.slice(0, 240) || `Model request failed (${upstream.status})`;
      return Response.json({ error: message }, { status: 502 });
    }
    const analysis = responseText(payload);
    if (!analysis) return Response.json({ error: "The model returned no readable analysis" }, { status: 502 });
    return Response.json({ analysis });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to reach the model endpoint" }, { status: 502 });
  }
}
