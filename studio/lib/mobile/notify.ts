/**
 * POST /api/mobile/notify — validate a touch alert and return the canonical message.
 * Rejected requests do not write, fetch, send mail, or spawn anything. Writes stay at zero:
 * delivery is the phone (Notification + sound). /api/alerts is a separate, already-guarded route.
 */
import { alertsRequestGuard, readJsonBody } from "../alerts/engine.ts";
import { formatTouchMessage, type TouchTarget } from "./touch.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;
const KINDS = ["trendline", "horizontal", "ray", "rectangle", "liq-support", "liq-resistance"] as const;
type NotifyKind = (typeof KINDS)[number];
const KEYS = new Set(["symbol", "kind", "price", "lo", "hi"]);

export type MobileNotify = { symbol: string; kind: NotifyKind; price: number; lo: number | null; hi: number | null; message: string };

export function mobileNotifyWrites(): number {
  return 0;
}

function finitePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e12;
}

function targetFor(kind: NotifyKind): TouchTarget {
  switch (kind) {
    case "trendline": return "trendline";
    case "rectangle": return "rectangle";
    case "liq-support": return "support";
    case "liq-resistance": return "resistance";
    case "horizontal":
    case "ray":
      return kind === "ray" ? "ray" : "horizontal";
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

export function validateMobileNotify(body: unknown): { ok: true; value: MobileNotify } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object." };
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) return { ok: false, error: "Unknown field." };
  if (typeof raw.symbol !== "string" || !SYMBOL.test(raw.symbol)) return { ok: false, error: "Invalid symbol." };
  if (typeof raw.kind !== "string" || !(KINDS as readonly string[]).includes(raw.kind)) return { ok: false, error: "Invalid kind." };
  if (!finitePrice(raw.price)) return { ok: false, error: "price must be a positive finite number." };
  const kind = raw.kind as NotifyKind;
  const ranged = kind === "liq-support" || kind === "liq-resistance" || kind === "rectangle";
  let lo: number | null = null;
  let hi: number | null = null;
  if (ranged) {
    if (!finitePrice(raw.lo) || !finitePrice(raw.hi) || raw.lo >= raw.hi) return { ok: false, error: "lo and hi must satisfy 0 < lo < hi." };
    lo = raw.lo;
    hi = raw.hi;
  } else if (raw.lo != null || raw.hi != null) {
    return { ok: false, error: "lo and hi must be null for this kind." };
  }
  const message = formatTouchMessage({ target: targetFor(kind), price: raw.price, lo, hi });
  return { ok: true, value: { symbol: raw.symbol, kind, price: raw.price, lo, hi, message } };
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Same-origin localhost guard, then schema check. Invalid input returns before any other work. */
export async function handleMobileNotify(request: Request): Promise<Response> {
  const guard = alertsRequestGuard(request, true);
  if (!guard.ok) return json(guard.status, { ok: false, error: guard.error });
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json(parsed.status, { ok: false, error: parsed.error });
  const valid = validateMobileNotify(parsed.value);
  if (!valid.ok) return json(400, { ok: false, error: valid.error });
  return json(200, { ok: true, message: valid.value.message, kind: valid.value.kind, symbol: valid.value.symbol });
}

export function methodNotAllowed(): Response {
  return json(405, { ok: false, error: "Method not allowed." });
}
