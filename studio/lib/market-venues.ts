export const MARKET_VENUES = ["bybit", "binance", "okx", "bitget"] as const;
export type MarketVenue = (typeof MARKET_VENUES)[number];
export type ChartInterval = "1" | "5" | "15" | "60" | "240" | "D";

export const CHART_INTERVALS: readonly ChartInterval[] = ["1", "5", "15", "60", "240", "D"];

export const VENUE_LABELS: Record<MarketVenue, string> = {
  bybit: "Bybit",
  binance: "Binance",
  okx: "OKX",
  bitget: "Bitget",
};

const CANADA_FRIENDLY_FALLBACK: readonly MarketVenue[] = ["okx", "bitget", "binance", "bybit"];

export type MarketCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MarketRequestFailure = {
  venue: MarketVenue;
  status: number;
  blocked: boolean;
  message: string;
};

const BINANCE_INTERVAL: Record<ChartInterval, string> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "60": "1h",
  "240": "4h",
  D: "1d",
};

const OKX_BAR: Record<ChartInterval, string> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "60": "1H",
  "240": "4H",
  D: "1D",
};

const BITGET_BAR: Record<ChartInterval, string> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "60": "1H",
  "240": "4H",
  D: "1D",
};

export function isMarketVenue(value: unknown): value is MarketVenue {
  return MARKET_VENUES.includes(value as MarketVenue);
}

export function isChartInterval(value: unknown): value is ChartInterval {
  return CHART_INTERVALS.includes(value as ChartInterval);
}

export function parseChartInterval(value: unknown, fallback: ChartInterval = "15"): ChartInterval {
  if (isChartInterval(value)) return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "1m" || raw === "1min" || raw === "1minute") return "1";
  if (raw === "5" || raw === "5m" || raw === "5min") return "5";
  if (raw === "15" || raw === "15m" || raw === "15min") return "15";
  if (raw === "60" || raw === "1h" || raw === "1hr" || raw === "60m") return "60";
  if (raw === "240" || raw === "4h" || raw === "4hr") return "240";
  if (raw === "d" || raw === "1d" || raw === "day" || raw === "daily") return "D";
  return fallback;
}

export function pickSummaryInterval(base: ChartInterval, remainingMs: number, maxBars = 200): ChartInterval {
  const start = CHART_INTERVALS.indexOf(base);
  for (let index = Math.max(0, start); index < CHART_INTERVALS.length; index += 1) {
    const interval = CHART_INTERVALS[index];
    if (Math.ceil(remainingMs / intervalDurationMs(interval)) <= maxBars) return interval;
  }
  return "D";
}

export function venueLabel(venue: MarketVenue): string {
  return VENUE_LABELS[venue];
}

export function venueCode(venue: MarketVenue): string {
  return venue.toUpperCase();
}

export function supportedExchangesMessage(): string {
  return `Supported exchanges: ${MARKET_VENUES.join(", ")}`;
}

export function venueFallbackOrder(preferred: MarketVenue): MarketVenue[] {
  return [preferred, ...CANADA_FRIENDLY_FALLBACK.filter((venue) => venue !== preferred)];
}

export function formatMarketId(venue: MarketVenue, symbol: string): string {
  return `${venueCode(venue)}:${compactSymbol(symbol)}`;
}

export function parseMarketId(value: string): { venue: MarketVenue; symbol: string } {
  const raw = String(value || "").trim();
  const match = raw.match(/^([A-Za-z]+):(.+)$/);
  if (match && isMarketVenue(match[1].toLowerCase())) {
    return { venue: match[1].toLowerCase() as MarketVenue, symbol: compactSymbol(match[2]) };
  }
  return { venue: "bybit", symbol: compactSymbol(raw) };
}

export function compactSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[-_/:]/g, "").replace(/SWAP$/, "").replace(/USDTUSDT$/, "USDT");
}

export function toUnifiedSwapSymbol(symbol: string): string {
  const compact = compactSymbol(symbol);
  if (compact.endsWith("USDT")) return `${compact.slice(0, -4)}/USDT:USDT`;
  if (compact.endsWith("USDC")) return `${compact.slice(0, -4)}/USDC:USDC`;
  throw new Error(`Unsupported unified swap symbol ${symbol}`);
}

export function toOkxSwapInstId(symbol: string): string {
  const compact = compactSymbol(symbol);
  if (compact.endsWith("USDT")) return `${compact.slice(0, -4)}-USDT-SWAP`;
  if (compact.endsWith("USDC")) return `${compact.slice(0, -4)}-USDC-SWAP`;
  throw new Error(`Unsupported OKX symbol ${symbol}`);
}

export function toOkxSpotInstId(symbol: string): string {
  const compact = compactSymbol(symbol);
  if (compact.endsWith("USDT")) return `${compact.slice(0, -4)}-USDT`;
  if (compact.endsWith("USDC")) return `${compact.slice(0, -4)}-USDC`;
  throw new Error(`Unsupported OKX symbol ${symbol}`);
}

export function intervalDurationMs(interval: ChartInterval): number {
  return interval === "D" ? 86_400_000 : Number(interval) * 60_000;
}

export function toBinanceInterval(interval: ChartInterval): string {
  return BINANCE_INTERVAL[interval];
}

export function toOkxBar(interval: ChartInterval): string {
  return OKX_BAR[interval];
}

export function toBitgetBar(interval: ChartInterval): string {
  return BITGET_BAR[interval];
}

export function classifyMarketFailure(venue: MarketVenue, status: number, body: string): MarketRequestFailure {
  const text = body.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const blocked = status === 403
    || status === 451
    || lower.includes("cloudfront")
    || lower.includes("block access from your country")
    || lower.includes("restricted location")
    || lower.includes("service unavailable from a restricted location");
  const detail = extractFailureDetail(text);
  return {
    venue,
    status,
    blocked,
    message: blocked
      ? `${venueLabel(venue)} is blocked in this region${detail ? ` (${detail})` : ""}.`
      : detail || `${venueLabel(venue)} market request failed (${status || "network"}).`,
  };
}

export function formatVenueFallbackNotice(from: MarketVenue, to: MarketVenue, blocked: boolean): string {
  if (from === to) return "";
  return blocked
    ? `${venueLabel(from)} is blocked in this region. Using ${venueLabel(to)}.`
    : `${venueLabel(from)} is unavailable. Using ${venueLabel(to)}.`;
}

function extractFailureDetail(body: string): string {
  if (!body) return "";
  try {
    const payload = JSON.parse(body) as { error?: unknown; msg?: unknown; message?: unknown; retMsg?: unknown };
    const value = payload.error ?? payload.msg ?? payload.message ?? payload.retMsg;
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {
    const match = body.match(/error\s*:\s*([^}\n]+)/i);
    if (match?.[1]) return match[1].trim();
  }
  return body.length > 180 ? `${body.slice(0, 177)}...` : body;
}
