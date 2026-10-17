import { handle, methodNotAllowed } from "@/lib/alerts/http.ts";

export const GET = (request: Request) => handle(request, false, (rt) => rt.engine.getSettings());
export const POST = (request: Request) => handle(request, true, (rt, body) => rt.engine.updateSettings(body));
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
