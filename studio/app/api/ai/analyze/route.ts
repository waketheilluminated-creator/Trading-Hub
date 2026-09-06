import { runAiProxy, type AiProxyBody } from "@/lib/ai/proxy.ts";

export async function POST(request: Request) {
  let body: AiProxyBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }
  return runAiProxy(body);
}
