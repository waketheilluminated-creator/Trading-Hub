import { fetchVenueCvd } from "@/lib/market-cvd.ts";
import { compactSymbol, isChartInterval, isMarketVenue, supportedExchangesMessage } from "@/lib/market-venues.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchange = (url.searchParams.get("exchange") || "bybit").toLowerCase();
  const symbol = compactSymbol(url.searchParams.get("symbol") || "BTCUSDT");
  const interval = url.searchParams.get("interval") || "15";

  if (!isMarketVenue(exchange)) {
    return Response.json({ error: supportedExchangesMessage() }, { status: 400 });
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return Response.json({ error: "Use a compact perpetual symbol such as BTCUSDT" }, { status: 400 });
  }
  if (!isChartInterval(interval)) {
    return Response.json({ error: "Supported intervals: 1, 5, 15, 60, 240, D" }, { status: 400 });
  }

  try {
    const snapshot = await fetchVenueCvd(exchange, symbol, interval);
    if (!snapshot.perp.available && !snapshot.spot.available) {
      return Response.json({
        error: snapshot.notice || `${exchange} returned no public trades`,
        exchange,
        symbol,
        interval,
      }, { status: 502 });
    }
    return Response.json(snapshot, { headers: { "Cache-Control": "public, max-age=8, s-maxage=8" } });
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { message?: string; blocked?: boolean; status?: number; venue?: string } : {};
    return Response.json({
      error: failure.message || (error instanceof Error ? error.message : "Exchange trade request failed"),
      exchange: failure.venue || exchange,
      symbol,
      interval,
      blocked: Boolean(failure.blocked),
    }, { status: failure.blocked ? 403 : 502 });
  }
}
