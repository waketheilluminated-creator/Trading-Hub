import {
  fetchVenueDepth,
  parseDepthQuery,
} from "@/lib/market-depth.ts";
import { classifyMarketFailure, isMarketVenue, sanitizeMarketCopy, supportedExchangesMessage } from "@/lib/market-venues.ts";

export async function GET(request: Request) {
  const parsed = parseDepthQuery(new URL(request.url), supportedExchangesMessage());
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const snapshot = await fetchVenueDepth(parsed.venue, parsed.symbol, parsed.minNotional);
    return Response.json(snapshot, { headers: { "Cache-Control": "public, max-age=2, s-maxage=2" } });
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { message?: string; blocked?: boolean; status?: number; venue?: string } : {};
    const classified = classifyMarketFailure(
      parsed.venue,
      failure.blocked ? 403 : (failure.status || 502),
      failure.message || (error instanceof Error ? error.message : "Exchange order book request failed"),
    );
    const venue = isMarketVenue(failure.venue) ? failure.venue : parsed.venue;
    return Response.json({
      error: sanitizeMarketCopy(classified.message, venue) || classified.message,
      exchange: venue,
      symbol: parsed.symbol,
      blocked: Boolean(failure.blocked || classified.blocked),
    }, { status: (failure.blocked || classified.blocked) ? 403 : 502 });
  }
}
