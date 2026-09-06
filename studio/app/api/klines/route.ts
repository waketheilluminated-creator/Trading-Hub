import { fetchVenueKlines } from "@/lib/market-rest.ts";
import { compactSymbol, isChartInterval, isMarketVenue } from "@/lib/market-venues.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchange = (url.searchParams.get("exchange") || "bybit").toLowerCase();
  const symbol = compactSymbol(url.searchParams.get("symbol") || "BTCUSDT");
  const interval = url.searchParams.get("interval") || "15";
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 300) || 300));

  if (!isMarketVenue(exchange)) {
    return Response.json({ error: "Supported exchanges: bybit, binance, okx" }, { status: 400 });
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return Response.json({ error: "Use a compact perpetual symbol such as BTCUSDT" }, { status: 400 });
  }
  if (!isChartInterval(interval)) {
    return Response.json({ error: "Supported intervals: 1, 5, 15, 60, 240, D" }, { status: 400 });
  }

  try {
    const result = await fetchVenueKlines(exchange, symbol, interval, limit);
    if (!result.candles.length) {
      return Response.json({ error: `${exchange} returned no candles`, exchange, symbol, interval }, { status: 502 });
    }
    return Response.json({
      exchange: result.venue,
      symbol: result.symbol,
      interval: result.interval,
      source: result.source,
      candles: result.candles,
    }, { headers: { "Cache-Control": "public, max-age=5, s-maxage=5" } });
  } catch (error) {
    const failure = error && typeof error === "object" ? error as { message?: string; blocked?: boolean; status?: number; venue?: string } : {};
    return Response.json({
      error: failure.message || (error instanceof Error ? error.message : "Exchange kline request failed"),
      exchange: failure.venue || exchange,
      symbol,
      interval,
      blocked: Boolean(failure.blocked),
    }, { status: failure.blocked ? 403 : 502 });
  }
}
