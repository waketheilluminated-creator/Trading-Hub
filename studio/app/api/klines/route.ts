import { fetchVenueKlineHistory, MAX_KLINE_BARS, parseKlineQuery } from "@/lib/kline-history.ts";
import { compactSymbol, isChartInterval, isMarketVenue, supportedExchangesMessage } from "@/lib/market-venues.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchange = (url.searchParams.get("exchange") || "bybit").toLowerCase();
  const symbol = compactSymbol(url.searchParams.get("symbol") || "BTCUSDT");
  const interval = url.searchParams.get("interval") || "15";
  const query = parseKlineQuery(url.searchParams);

  if (!isMarketVenue(exchange)) {
    return Response.json({ error: supportedExchangesMessage() }, { status: 400 });
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return Response.json({ error: "Use a compact perpetual symbol such as BTCUSDT" }, { status: 400 });
  }
  if (!isChartInterval(interval)) {
    return Response.json({ error: "Supported intervals: 1, 5, 15, 60, 240, D" }, { status: 400 });
  }
  if ("error" in query) {
    return Response.json({ error: query.error, maxLimit: MAX_KLINE_BARS }, { status: 400 });
  }

  try {
    const result = await fetchVenueKlineHistory(exchange, symbol, interval, query);
    if (!result.candles.length && query.endTime == null) {
      return Response.json({ error: `${exchange} returned no candles`, exchange, symbol, interval }, { status: 502 });
    }
    return Response.json({
      exchange: result.venue,
      symbol: result.symbol,
      interval: result.interval,
      source: result.source,
      candles: result.candles,
      exhausted: result.exhausted,
      partial: result.partial,
      warning: result.warning,
      pages: result.pages,
    }, { headers: { "Cache-Control": query.endTime == null ? "public, max-age=5, s-maxage=5" : "public, max-age=60, s-maxage=60" } });
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
