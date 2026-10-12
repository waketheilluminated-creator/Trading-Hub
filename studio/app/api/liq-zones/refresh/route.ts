import { refreshRequestGuard } from "@/lib/liq-refresh.ts";
import { liqRefresher } from "@/lib/liq-refresh-server.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function methodNotAllowed() {
  return Response.json({ ok: false, error: "Use POST to refresh liquidation zones." }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;

export async function POST(request: Request) {
  const guard = refreshRequestGuard(request);
  if (!guard.ok) return Response.json({ ok: false, error: guard.error }, { status: guard.status, headers: NO_STORE });
  let refresher;
  try {
    refresher = await liqRefresher();
  } catch {
    return Response.json({ ok: false, error: "Liquidation refresh is unavailable in this runtime." }, { status: 503, headers: NO_STORE });
  }
  const result = await refresher.refresh(new URL(request.url).searchParams.get("symbol"));
  const headers: Record<string, string> = { ...NO_STORE };
  if ("retryAfterSec" in result && result.retryAfterSec != null) headers["Retry-After"] = String(result.retryAfterSec);
  return Response.json(result.body, { status: result.status, headers });
}
