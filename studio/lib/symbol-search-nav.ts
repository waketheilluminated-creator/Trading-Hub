import { filterSymbolSearch } from "./market-symbols.js";
import { isMarketVenue, MARKET_VENUES, venueLabel, type MarketVenue } from "./market-venues.ts";

export const SYMBOL_ASSET_TYPES = [
  { id: "all", label: "All" },
  { id: "stocks", label: "Stocks" },
  { id: "funds", label: "Funds" },
  { id: "futures", label: "Futures" },
  { id: "forex", label: "Forex" },
  { id: "crypto", label: "Crypto" },
  { id: "currency", label: "Currency" },
  { id: "indices", label: "Indices" },
  { id: "bonds", label: "Bonds" },
  { id: "options", label: "Options" },
] as const;

export type SymbolAssetType = (typeof SYMBOL_ASSET_TYPES)[number]["id"];

export const LIVE_ASSET_TYPES: readonly SymbolAssetType[] = ["all", "crypto"];

export const SYMBOL_KINDS = [
  { id: "all", label: "All types" },
  { id: "perpetual", label: "Perpetual" },
  { id: "spot", label: "Spot" },
] as const;

export type SymbolKindFilter = (typeof SYMBOL_KINDS)[number]["id"];

export const EXCHANGE_TYPES = [
  { id: "all", label: "All exchange types" },
  { id: "cex", label: "Centralized" },
  { id: "dex", label: "Decentralized" },
] as const;

export type ExchangeTypeFilter = (typeof EXCHANGE_TYPES)[number]["id"];

export type MarketSource = {
  id: MarketVenue;
  label: string;
  subtitle: string;
  category: string;
};

export const CRYPTO_SOURCES: MarketSource[] = MARKET_VENUES
  .map((venue) => ({
    id: venue,
    label: venueLabel(venue),
    subtitle: venueLabel(venue),
    category: "CRYPTOCURRENCY",
  }))
  .sort((left, right) => left.label.localeCompare(right.label));

export type SymbolSearchFilters = {
  query?: string;
  type?: string;
  source?: string;
  kind?: string;
  exchangeType?: string;
};

export type SearchEmptyCopy = {
  title: string;
  detail: string;
};

export function isSymbolAssetType(value: unknown): value is SymbolAssetType {
  return SYMBOL_ASSET_TYPES.some((item) => item.id === value);
}

export function isSymbolKindFilter(value: unknown): value is SymbolKindFilter {
  return SYMBOL_KINDS.some((item) => item.id === value);
}

export function isExchangeTypeFilter(value: unknown): value is ExchangeTypeFilter {
  return EXCHANGE_TYPES.some((item) => item.id === value);
}

export function assetTypeLabel(type: string): string {
  return SYMBOL_ASSET_TYPES.find((item) => item.id === type)?.label || "All";
}

export function assetTypeHasLiveCatalog(type: string): boolean {
  return LIVE_ASSET_TYPES.includes(type as SymbolAssetType);
}

export function sourcesForAssetType(type: string): MarketSource[] {
  return assetTypeHasLiveCatalog(type) ? CRYPTO_SOURCES : [];
}

export function normalizeSourceQuery(query: string): string {
  return String(query || "").trim().toLowerCase().replace(/[\s/:_-]/g, "");
}

export function filterSources(sources: MarketSource[], query = ""): MarketSource[] {
  const normalized = normalizeSourceQuery(query);
  if (!normalized) return sources;
  return sources.filter((source) => normalizeSourceQuery(`${source.label}${source.subtitle}${source.id}${source.category}`).includes(normalized));
}

export function groupSourcesByCategory(sources: MarketSource[]): { category: string; sources: MarketSource[] }[] {
  const groups = new Map<string, MarketSource[]>();
  for (const source of sources) {
    const list = groups.get(source.category) ?? [];
    list.push(source);
    groups.set(source.category, list);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, sources: items }));
}

export function resolveSourceFilter(type: string, source: string): "all" | MarketVenue {
  if (source === "all" || !isMarketVenue(source)) return "all";
  return sourcesForAssetType(type).some((item) => item.id === source) ? source : "all";
}

export function sourceTriggerLabel(source: string): string {
  if (source === "all" || !isMarketVenue(source)) return "All sources";
  return venueLabel(source);
}

export function kindTriggerLabel(kind: string): string {
  return SYMBOL_KINDS.find((item) => item.id === kind)?.label || "All types";
}

export function exchangeTypeTriggerLabel(exchangeType: string): string {
  return EXCHANGE_TYPES.find((item) => item.id === exchangeType)?.label || "All exchange types";
}

export function filterWorkspaceSymbols<T extends { venue?: string; symbol?: string; kind?: string }>(
  markets: T[],
  { query = "", type = "crypto", source = "all", kind = "all", exchangeType = "all" }: SymbolSearchFilters = {},
): T[] {
  if (!assetTypeHasLiveCatalog(type) || kind === "spot" || exchangeType === "dex") return [];
  const resolved = resolveSourceFilter(type, source);
  return filterSymbolSearch(markets, {
    query,
    venue: resolved === "all" ? "" : resolved,
    tab: kind === "perpetual" ? "perpetual" : "all",
  }) as T[];
}

export function symbolSearchEmptyCopy({
  type = "crypto",
  kind = "all",
  exchangeType = "all",
  query = "",
  source = "all",
}: SymbolSearchFilters = {}): SearchEmptyCopy {
  if (!assetTypeHasLiveCatalog(type)) {
    return {
      title: `${assetTypeLabel(type)} markets are coming soon`,
      detail: "Live catalogs and chart feeds stay on Crypto. Other asset types stay empty until a real venue is wired.",
    };
  }
  if (kind === "spot") {
    return {
      title: "Spot markets are coming soon",
      detail: "This workspace currently lists USDT perpetuals from Binance, Bybit, OKX, and Bitget.",
    };
  }
  if (exchangeType === "dex") {
    return {
      title: "Decentralized venues are coming soon",
      detail: "Live sources today are Binance, Bybit, OKX, and Bitget.",
    };
  }
  if (query) {
    return {
      title: "No symbols found",
      detail: source === "all"
        ? "Try another ticker, coin, or source name."
        : `No matching ${sourceTriggerLabel(source)} markets. Clear search or choose All sources.`,
    };
  }
  return {
    title: "No symbols found",
    detail: "Try another ticker, or open Sources to pick an exchange.",
  };
}

export function sourcesEmptyCopy(type: string): SearchEmptyCopy {
  return {
    title: `No ${assetTypeLabel(type).toLowerCase()} sources yet`,
    detail: "Live exchange catalogs are available for Crypto. Other types stay empty until a real venue is wired.",
  };
}
