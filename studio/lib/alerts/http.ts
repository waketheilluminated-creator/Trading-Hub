/** Shared route helpers for /api/alerts/* (Tier C guard + JSON + no-store). */
import { alertsRequestGuard, readJsonBody, type ServiceResult } from "./engine.ts";
import { alertsRuntime, type AlertsRuntime } from "./server.ts";

export const NO_STORE = { "Cache-Control": "no-store" };

export function json(result: ServiceResult): Response {
  return Response.json(result.body, { status: result.status, headers: NO_STORE });
}

export async function handle(request: Request, mutation: boolean, run: (rt: AlertsRuntime, body: unknown) => Promise<ServiceResult> | ServiceResult): Promise<Response> {
  const guard = alertsRequestGuard(request, mutation);
  if (!guard.ok) return json({ status: guard.status, body: { ok: false, error: guard.error } });
  let body: unknown = null;
  if (mutation) {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return json({ status: parsed.status, body: { ok: false, error: parsed.error } });
    body = parsed.value;
  }
  let rt: AlertsRuntime;
  try { rt = await alertsRuntime(); } catch { return json({ status: 503, body: { ok: false, error: "Alerts are unavailable in this runtime (needs Node ≥ 22.13)." } }); }
  try { return json(await run(rt, body)); } catch { return json({ status: 500, body: { ok: false, error: "Alerts request failed." } }); }
}

export function methodNotAllowed(): Response {
  return Response.json({ ok: false, error: "Method not allowed." }, { status: 405, headers: NO_STORE });
}
