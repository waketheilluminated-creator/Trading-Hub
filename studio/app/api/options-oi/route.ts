import { loadOptionsOi } from "@/lib/options-oi-server.ts";

// Trust boundary: parseOptionsOiQuery (via loadOptionsOi) allowlists BTC/ETH and a
// calendar expiry before any Deribit request. Client book, spot, and OI fields are ignored.
export async function GET(request: Request) {
  const result = await loadOptionsOi(new URL(request.url));
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": result.ok ? "public, max-age=60, s-maxage=60" : "no-store" },
  });
}
