import { handleMobileNotify, methodNotAllowed } from "@/lib/mobile/notify.ts";

export const POST = (request: Request) => handleMobileNotify(request);
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
