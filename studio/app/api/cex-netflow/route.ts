import cexNetflowFixture from "../../../fixtures/cex_netflow.sample.json";
import { cexNetflowHttpBody } from "@/lib/cex-netflow.ts";

// Trust boundary: public read of the sanitized checked-in fixture only.
// Privilege flags are ignored. Wrong kind and malformed series are rejected. No remote market fetch.
export async function GET() {
  const result = cexNetflowHttpBody(cexNetflowFixture);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": result.status === 200 ? "public, max-age=60" : "no-store" },
  });
}
