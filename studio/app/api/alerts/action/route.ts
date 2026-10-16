import { handle, methodNotAllowed } from "@/lib/alerts/http.ts";

export const GET = methodNotAllowed;
export const POST = (request: Request) => handle(request, true, (rt, body) => rt.engine.alertAction(body));
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
