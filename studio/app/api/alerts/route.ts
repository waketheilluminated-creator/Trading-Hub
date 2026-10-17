import { handle, methodNotAllowed } from "@/lib/alerts/http.ts";

export const GET = (request: Request) => handle(request, false, (rt) => {
  const result = rt.engine.listAlerts();
  return { ...result, body: { ...result.body, engineRunning: rt.running } };
});
export const POST = (request: Request) => handle(request, true, (rt, body) => rt.engine.createAlert(body));
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
