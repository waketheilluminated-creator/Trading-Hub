// Allow: the checked-in US BTC spot ETF fixture (finite flows, null BTC cells, bad rows dropped).
// Deny: wrong kind, non-finite numbers, malformed rows, and client privilege flags. No remote fetch.

export const ETF_FLOWS_KIND = "btc_spot_etf_flows" as const;
export const ETF_CARD_IDS = ["cum_net_inflow", "day_net_inflow", "day_volume", "total_nav"] as const;
export const ETF_FLOW_COLUMNS_MAX = 24;
export const ETF_FLOW_ROWS_MAX = 400;

const FLOW_ABS_MAX = 1e8;
const CARD_ABS_MAX = 1e15;

export type EtfUnit = "USD" | "BTC";
export type EtfCardId = (typeof ETF_CARD_IDS)[number];
export type EtfFlowMap = Record<string, number | null>;

export type EtfFlowCard = {
  id: EtfCardId;
  label: string;
  usd: number;
  btc: number | null;
};

export type EtfFlowRow = {
  date: string;
  flowsUsdM: EtfFlowMap;
  flowsBtc: EtfFlowMap;
};

export type EtfFlowsSnapshot = {
  kind: typeof ETF_FLOWS_KIND;
  venue: "US";
  asset: "BTC";
  updatedAt: string | null;
  asOfDate: string;
  unitDefault: EtfUnit;
  units: EtfUnit[];
  lagNote: string;
  source: { table: "farside"; cards: "sosovalue_ssr" } | null;
  tickers: string[];
  cards: EtfFlowCard[];
  rows: EtfFlowRow[];
};

export type EtfSanitizeResult =
  | { ok: true; snapshot: EtfFlowsSnapshot; dropped: number }
  | { ok: false; error: string };

export type EtfHttpResult =
  | { status: 200; body: EtfFlowsSnapshot }
  | { status: 400; body: { error: string } };

const UNITS: EtfUnit[] = ["USD", "BTC"];

function cleanCopy(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    text += code <= 31 || code === 127 ? " " : char;
  }
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanLabel(value: unknown, max: number): string | null {
  const clean = cleanCopy(value, max);
  return clean || null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function isCardId(value: unknown): value is EtfCardId {
  return value === "cum_net_inflow" || value === "day_net_inflow" || value === "day_volume" || value === "total_nav";
}

function requiredFinite(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > max) return null;
  return value;
}

function optionalFinite(value: unknown, max: number): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > max) return undefined;
  return value;
}

function flowCell(value: unknown): number | null | undefined {
  if (value == null) return null;
  return optionalFinite(value, FLOW_ABS_MAX);
}

function sanitizeTickers(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tickers: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Z][A-Z0-9]{0,11}$/.test(item) || item === "TOTAL") continue;
    if (tickers.includes(item)) continue;
    tickers.push(item);
    if (tickers.length >= ETF_FLOW_COLUMNS_MAX) break;
  }
  return tickers.length ? tickers : null;
}

function sanitizeFlowMap(value: unknown, tickers: readonly string[]): EtfFlowMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const flows: EtfFlowMap = {};
  for (const ticker of [...tickers, "Total"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, ticker)) {
      flows[ticker] = null;
      continue;
    }
    const cell = flowCell(raw[ticker]);
    if (cell === undefined) return null;
    flows[ticker] = cell;
  }
  return flows;
}

function sanitizeRow(value: unknown, tickers: readonly string[]): EtfFlowRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const date = isoDate(raw.date);
  if (!date) return null;
  const flowsUsdM = sanitizeFlowMap(raw.flowsUsdM, tickers);
  const flowsBtc = sanitizeFlowMap(raw.flowsBtc, tickers);
  if (!flowsUsdM || !flowsBtc) return null;
  return { date, flowsUsdM, flowsBtc };
}

function sanitizeCard(value: unknown): EtfFlowCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isCardId(raw.id)) return null;
  const label = cleanLabel(raw.label, 80);
  const usd = requiredFinite(raw.usd, CARD_ABS_MAX);
  const btc = optionalFinite(raw.btc, CARD_ABS_MAX);
  if (!label || usd == null || btc === undefined) return null;
  return { id: raw.id, label, usd, btc };
}

function sanitizeSource(value: unknown): EtfFlowsSnapshot["source"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.table !== "farside" || raw.cards !== "sosovalue_ssr") return null;
  return { table: "farside", cards: "sosovalue_ssr" };
}

export function sanitizeEtfFlowsSnapshot(input: unknown): EtfSanitizeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "ETF flow snapshot is invalid." };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== ETF_FLOWS_KIND) return { ok: false, error: "ETF flow kind is not btc_spot_etf_flows." };
  if (raw.venue !== "US") return { ok: false, error: "ETF flow venue is invalid." };
  if (raw.asset !== "BTC") return { ok: false, error: "ETF flow asset is invalid." };
  const asOfDate = isoDate(raw.asOfDate);
  if (!asOfDate) return { ok: false, error: "ETF flow as-of date is invalid." };
  if (!Array.isArray(raw.cards)) return { ok: false, error: "ETF flow cards are missing." };
  if (!Array.isArray(raw.rows)) return { ok: false, error: "ETF flow rows are missing." };
  const tickers = sanitizeTickers(raw.tickers);
  if (!tickers) return { ok: false, error: "ETF flow tickers are missing." };

  let dropped = 0;
  const cardsById = new Map<EtfCardId, EtfFlowCard>();
  for (const item of raw.cards) {
    const card = sanitizeCard(item);
    if (!card || cardsById.has(card.id)) {
      dropped += 1;
      continue;
    }
    cardsById.set(card.id, card);
  }
  const cards = ETF_CARD_IDS.flatMap((id) => {
    const card = cardsById.get(id);
    return card ? [card] : [];
  });

  const rowsByDate = new Map<string, EtfFlowRow>();
  for (const item of raw.rows) {
    const row = sanitizeRow(item, tickers);
    if (!row) {
      dropped += 1;
      continue;
    }
    if (rowsByDate.has(row.date)) {
      dropped += 1;
      rowsByDate.set(row.date, row);
      continue;
    }
    if (rowsByDate.size >= ETF_FLOW_ROWS_MAX) {
      dropped += 1;
      continue;
    }
    rowsByDate.set(row.date, row);
  }
  const rows = [...rowsByDate.values()].sort((left, right) => right.date.localeCompare(left.date));
  const unitDefault: EtfUnit = raw.unitDefault === "BTC" ? "BTC" : "USD";

  return {
    ok: true,
    dropped,
    snapshot: {
      kind: ETF_FLOWS_KIND,
      venue: "US",
      asset: "BTC",
      updatedAt: isoTimestamp(raw.updatedAt),
      asOfDate,
      unitDefault,
      units: UNITS,
      lagNote: cleanCopy(raw.lagNote, 280),
      source: sanitizeSource(raw.source),
      tickers,
      cards,
      rows,
    },
  };
}

export function etfFlowsHttpBody(raw: unknown): EtfHttpResult {
  const parsed = sanitizeEtfFlowsSnapshot(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  return { status: 200, body: parsed.snapshot };
}

export function flowTone(value: number | null): "inflow" | "outflow" | "flat" {
  if (value == null || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "inflow" : "outflow";
}

export function etfCardAmount(card: EtfFlowCard, unit: EtfUnit): number | null {
  return unit === "BTC" ? card.btc : card.usd;
}

export function etfCardTone(id: EtfCardId, value: number | null): "inflow" | "outflow" | "flat" {
  if (id !== "cum_net_inflow" && id !== "day_net_inflow") return "flat";
  return flowTone(value);
}

export function formatEtfCardAmount(value: number | null, unit: EtfUnit): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (unit === "BTC") {
    return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })} BTC`;
  }
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatFlowCell(value: number | null, unit: EtfUnit): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = unit === "USD" ? 1 : 2;
  const abs = Math.abs(value).toFixed(digits);
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return unit === "USD" ? "0.0" : "0.00";
}
