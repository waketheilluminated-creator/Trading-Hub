import { handle, methodNotAllowed } from "@/lib/alerts/http.ts";

/** Readiness/boot ping: the launcher hits this so the engine starts without opening the UI. */
export const GET = (request: Request) => handle(request, false, (rt) => ({ status: 200, body: { ok: true, engineRunning: rt.running } }));
export const POST = methodNotAllowed;
