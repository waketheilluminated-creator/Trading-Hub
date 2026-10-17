import { handle, methodNotAllowed } from "@/lib/alerts/http.ts";

/** TH-FEAT-16 liquidation-zone alert groups. GET lists; POST {action: enable|disable, symbol, venue}. Tier C guard in handle(). */
export const GET = (request: Request) => handle(request, false, (rt) => rt.engine.listZoneGroups());
export const POST = (request: Request) => handle(request, true, (rt, body) => rt.engine.zoneAction(body));
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
