import { fetchInstrumentTick, precisionFromTick } from "@/lib/price-precision.ts";
import { isMarketVenue } from "@/lib/market-venues.ts";

const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;

/** TH-BUG-04: instrument tick size for price precision. Public market metadata only; strict query. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const venue = (url.searchParams.get("exchange") || "").toLowerCase();
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!isMarketVenue(venue) || !SYMBOL.test(symbol)) {
    return Response.json({ error: "Use exchange=<venue>&symbol=<BASE>USDT" }, { status: 400 });
  }
  const tickSize = await fetchInstrumentTick(venue, symbol);
  return Response.json(
    { exchange: venue, symbol, tickSize, precision: tickSize == null ? null : precisionFromTick(tickSize) },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
