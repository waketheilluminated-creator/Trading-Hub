import { fetchDerivativesSnapshot } from "@/lib/market-derivatives.ts";
import { classifyMarketFailure, isMarketVenue, supportedExchangesMessage } from "@/lib/market-venues.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exchangeId = (url.searchParams.get("exchange") || "bybit").toLowerCase();
  const symbol = url.searchParams.get("symbol") || "BTC/USDT:USDT";

  if (!isMarketVenue(exchangeId)) {
    return Response.json({ error: supportedExchangesMessage() }, { status: 400 });
  }
  if (!/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}:[A-Z0-9]{2,12}$/.test(symbol)) {
    return Response.json({ error: "Use a unified perpetual symbol such as BTC/USDT:USDT" }, { status: 400 });
  }

  try {
    const snapshot = await fetchDerivativesSnapshot(exchangeId, symbol);
    return Response.json(snapshot, { headers: { "Cache-Control": "public, max-age=20, s-maxage=20" } });
  } catch (error) {
    const classified = classifyMarketFailure(
      exchangeId,
      error && typeof error === "object" && "status" in error ? Number((error as { status?: unknown }).status) || 502 : 502,
      error instanceof Error ? error.message : "Exchange data request failed",
    );
    return Response.json({
      error: classified.message,
      exchange: exchangeId,
      symbol,
      blocked: classified.blocked,
    }, { status: classified.blocked ? 403 : 502 });
  }
}
