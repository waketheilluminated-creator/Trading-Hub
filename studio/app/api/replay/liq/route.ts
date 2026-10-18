import { alertsRequestGuard } from "@/lib/alerts/engine.ts";
import { parseReplayQuery, replayLiqZones } from "@/lib/replay/service.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const deny = () => Response.json({ ok: false, error: "Method not allowed." }, { status: 405, headers: NO_STORE });

/**
 * TH-FEAT-17: liquidation zones as of a replay candle, computed on demand from historical OI + price.
 * Tier C: localhost + same-origin only (same guard as /api/alerts), read-only, strict ts range. Nothing persisted.
 */
export async function GET(request: Request) {
  const guard = alertsRequestGuard(request, false);
  if (!guard.ok) return Response.json({ ok: false, error: guard.error }, { status: guard.status, headers: NO_STORE });
  const parsed = parseReplayQuery(new URL(request.url), Date.now());
  if (!parsed.ok) return Response.json({ ok: false, error: parsed.error, outOfRange: parsed.outOfRange === true }, { status: parsed.status, headers: NO_STORE });
  try {
    const result = await replayLiqZones(parsed.symbol, parsed.cutoff, (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }), Date.now());
    return Response.json(result, { status: result.ok ? 200 : 422, headers: NO_STORE });
  } catch {
    return Response.json({ ok: false, error: "Replay liquidation zones unavailable." }, { status: 502, headers: NO_STORE });
  }
}
export const POST = deny;
export const PUT = deny;
export const DELETE = deny;
export const PATCH = deny;
