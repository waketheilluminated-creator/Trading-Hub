import { fetchVenueOiHistory } from "@/lib/market-oi.ts";
import { classifyMarketFailure, compactSymbol, isChartInterval, isMarketVenue, sanitizeMarketCopy, supportedExchangesMessage } from "@/lib/market-venues.ts";

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
    const snapshot = await fetchVenueOiHistory(exchange, symbol, interval);
    if (!snapshot.points.length) {
      return Response.json({
        error: "Open interest series unavailable.",
        exchange,
        symbol,
        interval,
        blocked: false,
      }, { status: 502 });
    }
    return Response.json(snapshot, { headers: { "Cache-Control": "public, max-age=20, s-maxage=20" } });
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { message?: string; blocked?: boolean; status?: number; venue?: string } : {};
    const classified = classifyMarketFailure(
      exchange,
      failure.blocked ? 403 : (failure.status || 502),
      failure.message || (error instanceof Error ? error.message : "Exchange open interest request failed"),
    );
    return Response.json({
      error: sanitizeMarketCopy(classified.message, exchange) || classified.message,
      exchange: failure.venue || exchange,
      symbol,
      interval,
      blocked: Boolean(failure.blocked || classified.blocked),
    }, { status: (failure.blocked || classified.blocked) ? 403 : 502 });
  }
}
