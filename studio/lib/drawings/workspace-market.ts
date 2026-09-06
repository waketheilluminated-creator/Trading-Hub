import type { MarketVenue } from "../market-venues.ts";

// Default collection when the user has not chosen another chart venue.
// Automatic geo-fallback of the live feed must keep using this selected
// venue so drawings do not remount when Bybit is blocked.
export const CHART_MARKET_VENUE = "bybit" as const;

export type ChartDrawingMarket = Readonly<{
  venue: MarketVenue;
  symbol: string;
}>;

export function chartDrawingMarket(symbol: string, venue: MarketVenue = CHART_MARKET_VENUE): ChartDrawingMarket {
  return { venue, symbol };
}
