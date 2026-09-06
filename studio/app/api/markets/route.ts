import { fetchVenueMarkets } from "@/lib/market-rest.ts";
import { isMarketVenue } from "@/lib/market-venues.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchange = (url.searchParams.get("exchange") || "bybit").toLowerCase();

  if (!isMarketVenue(exchange)) {
    return Response.json({ error: "Supported exchanges: bybit, binance, okx" }, { status: 400 });
  }

  try {
    const result = await fetchVenueMarkets(exchange);
    return Response.json({
      exchange: result.venue,
      source: result.source,
      markets: result.markets,
    }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } });
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { message?: string; blocked?: boolean; status?: number; venue?: string } : {};
    return Response.json({
      error: failure.message || (error instanceof Error ? error.message : "Exchange catalog request failed"),
      exchange: failure.venue || exchange,
      blocked: Boolean(failure.blocked),
    }, { status: failure.blocked ? 403 : 502 });
  }
}
