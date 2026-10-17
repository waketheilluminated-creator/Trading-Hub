import { handle, methodNotAllowed } from "@/lib/alerts/http.ts";

export const GET = (request: Request) => handle(request, false, (rt) => {
  const params = new URL(request.url).searchParams;
  const after = Math.max(0, Math.floor(Number(params.get("after")) || 0));
  const limit = Math.min(500, Math.max(1, Math.floor(Number(params.get("limit")) || 100)));
  return rt.engine.listLog(after, limit);
});
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;
