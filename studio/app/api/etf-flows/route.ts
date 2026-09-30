import etfFlowsFixture from "../../../fixtures/etf_flows.sample.json";
import { etfFlowsHttpBody } from "@/lib/etf-flows.ts";

// Trust boundary: only the sanitized checked-in fixture is returned.
// admin, role, entitled, and hasMarketHistory query flags are not read.
export async function GET() {
  const result = etfFlowsHttpBody(etfFlowsFixture);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": result.status === 200 ? "public, max-age=60" : "no-store" },
  });
}
