import cvdOiFixture from "../../../fixtures/cvd_oi.sample.json";
import { cvdOiHttpBody } from "@/lib/cvd-oi.ts";

// Trust boundary: only the sanitized checked-in fixture is returned.
// Client symbol overrides and privilege flags are not read. No Binance fetch.
export async function GET() {
  const result = cvdOiHttpBody(cvdOiFixture);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": result.status === 200 ? "public, max-age=60" : "no-store" },
  });
}
