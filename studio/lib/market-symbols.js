import { MARKET_VENUES, compactSymbol, formatMarketId, isMarketVenue, parseMarketId, venueCode, venueLabel } from "./market-venues.ts";

export const FALLBACK_TICKERS = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT" },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT" },
  { symbol: "SOLUSDT", base: "SOL", quote: "USDT" },
  { symbol: "XRPUSDT", base: "XRP", quote: "USDT" },
];

export const FALLBACK_MARKETS = FALLBACK_TICKERS;

const POPULAR_SYMBOL_RANK = {
  BTCUSDT: 0,
  ETHUSDT: 1,
  SOLUSDT: 2,
  XRPUSDT: 3,
};

export function fallbackCatalog(venues = MARKET_VENUES) {
  return venues.flatMap((venue) => FALLBACK_TICKERS.map((ticker) => tagMarket(venue, ticker)));
}

export function tagMarket(venue, market) {
  return {
    venue,
    symbol: compactSymbol(market.symbol),
    base: market.base,
    quote: market.quote || "USDT",
    kind: market.kind || "perpetual",
  };
}

export function marketIdentity(market) {
  return formatMarketId(market.venue, market.symbol);
}

export function normalizeBybitMarkets(payload) {
  const rows = Array.isArray(payload?.result?.list) ? payload.result.list : [];
  const unique = new Map();
  for (const row of rows) {
    if (row?.status !== "Trading" || row?.contractType !== "LinearPerpetual" || row?.quoteCoin !== "USDT") continue;
    if (!row.symbol || !row.baseCoin) continue;
    unique.set(row.symbol, { symbol: row.symbol, base: row.baseCoin, quote: row.quoteCoin });
  }
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function normalizeBinanceMarkets(payload) {
  const rows = Array.isArray(payload?.symbols) ? payload.symbols : [];
  const unique = new Map();
  for (const row of rows) {
    if (row?.status !== "TRADING" || row?.quoteAsset !== "USDT") continue;
    if (row.contractType && row.contractType !== "PERPETUAL") continue;
    if (!row.symbol || !row.baseAsset) continue;
    unique.set(row.symbol, { symbol: row.symbol, base: row.baseAsset, quote: "USDT" });
  }
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function normalizeOkxSwapMarkets(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const unique = new Map();
  for (const row of rows) {
    if (row?.state !== "live" || row?.ctType !== "linear" || row?.settleCcy !== "USDT") continue;
    const base = row.ctValCcy || String(row.instFamily || "").split("-")[0];
    if (!base) continue;
    unique.set(`${base}USDT`, { symbol: `${base}USDT`, base, quote: "USDT" });
  }
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function normalizeBitgetMarkets(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const unique = new Map();
  for (const row of rows) {
    if (row?.symbolStatus !== "normal" || row?.symbolType !== "perpetual" || row?.quoteCoin !== "USDT") continue;
    if (!row.symbol || !row.baseCoin) continue;
    unique.set(row.symbol, { symbol: row.symbol, base: row.baseCoin, quote: "USDT" });
  }
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function normalizeSearchQuery(query) {
  return String(query || "").toUpperCase().replace(/[\s/:_-]/g, "");
}

export function searchMarkets(markets, query) {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return markets;
  return markets.filter((market) => marketSearchHaystack(market).includes(normalized));
}

export function filterSymbolSearch(markets, { query = "", venue = "", tab = "all" } = {}) {
  const scoped = isMarketVenue(venue) ? markets.filter((market) => market.venue === venue) : markets;
  const typed = tab === "perpetual"
    ? scoped.filter((market) => (market.kind || "perpetual") === "perpetual")
    : scoped;
  return rankSymbolSearch(searchMarkets(typed, query));
}

export function rankSymbolSearch(markets) {
  return [...markets].sort((left, right) => {
    const leftRank = POPULAR_SYMBOL_RANK[left.symbol] ?? 50;
    const rightRank = POPULAR_SYMBOL_RANK[right.symbol] ?? 50;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const symbolOrder = left.symbol.localeCompare(right.symbol);
    if (symbolOrder) return symbolOrder;
    return String(left.venue || "").localeCompare(String(right.venue || ""));
  });
}

export function nextRecentSymbols(recent, symbol, limit = 6) {
  return [symbol, ...recent.filter((item) => item !== symbol)].slice(0, limit);
}

export function resolveRecentMarket(recentId, catalog) {
  const parsed = parseMarketId(recentId);
  return catalog.find((market) => market.venue === parsed.venue && market.symbol === parsed.symbol)
    || tagMarket(parsed.venue, { symbol: parsed.symbol, base: parsed.symbol.replace(/USDT$/, ""), quote: "USDT" });
}

function marketSearchHaystack(market) {
  const venue = isMarketVenue(market.venue) ? market.venue : "";
  const code = venue ? venueCode(venue) : "";
  const label = venue ? venueLabel(venue) : "";
  const id = venue ? formatMarketId(venue, market.symbol) : market.symbol;
  return normalizeSearchQuery(`${market.symbol}${market.base}${market.quote}${code}${label}${id}${venue}`);
}

export { formatMarketId, parseMarketId };
