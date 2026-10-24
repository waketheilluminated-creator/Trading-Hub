// Deribit option open interest: pure parsing, max-pain math, and chart layout.
// Quote-currency intrinsic (OI × |settlement − strike|) is the published max-pain
// definition. Deribit's inverse BTC/ETH payoff also divides by the settlement
// price; that rescales each candidate differently and is intentionally not used.

export const OPTIONS_CURRENCIES = ["BTC", "ETH"] as const;
export type OptionsCurrency = (typeof OPTIONS_CURRENCIES)[number];

export const DEFAULT_STRIKE_BAND = 0.4;
export const OPTIONS_OI_CACHE_MS = 60_000;
export const OPTIONS_SETTLEMENT_LABEL = "08:00 UTC";
const MEANINGFUL_OI_SHARE = 0.02;
const MAX_INSTRUMENT_OI = 1e7;
const MAX_STRIKE = 1e8;

export const OPTIONS_OI_ERRORS = {
  currency: "Currency must be BTC or ETH.",
  expiry: "Expiry must be a calendar date (YYYY-MM-DD).",
  unlisted: "That expiry is not listed for this currency.",
  empty: "No option open interest for this currency.",
  upstream: "Options data is unavailable.",
} as const;

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const INSTRUMENT = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AS_OF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

export type ParsedOption = {
  currency: OptionsCurrency;
  expiry: string;
  strike: number;
  type: "C" | "P";
};

export type StrikeOi = {
  strike: number;
  callOi: number;
  putOi: number;
};

export type OptionsExpirySummary = {
  expiry: string;
  callOi: number;
  putOi: number;
  totalOi: number;
};

export type OptionsOiSnapshot = {
  currency: OptionsCurrency;
  expiry: string;
  expiries: OptionsExpirySummary[];
  strikes: StrikeOi[];
  totalOiBase: number;
  totalOiUsd: number;
  putCallRatio: number | null;
  maxPain: number | null;
  spot: number;
  distancePct: number | null;
  asOf: string;
  settlement: typeof OPTIONS_SETTLEMENT_LABEL;
};

export type OptionsOiQuery =
  | { ok: true; currency: OptionsCurrency; expiry: string | null }
  | { ok: false; error: string };

type ExpiryBook = {
  expiry: string;
  friday: boolean;
  callOi: number;
  putOi: number;
  totalOi: number;
  strikes: StrikeOi[];
};

export function parseDeribitInstrument(name: unknown): ParsedOption | null {
  if (typeof name !== "string") return null;
  const match = INSTRUMENT.exec(name.trim().toUpperCase());
  if (!match) return null;
  const currency = match[1];
  if (!isOptionsCurrency(currency)) return null;
  const month = MONTHS[match[3]];
  if (!month) return null;
  const expiry = isoDate(2000 + Number(match[4]), month, Number(match[2]));
  if (!expiry) return null;
  const strike = Number(match[5]);
  if (!Number.isFinite(strike) || strike <= 0 || strike > MAX_STRIKE) return null;
  const type = match[6];
  if (type !== "C" && type !== "P") return null;
  return { currency, expiry, strike, type };
}

export function computeMaxPain(strikes: readonly StrikeOi[]): number | null {
  const rows: StrikeOi[] = [];
  for (const row of strikes) {
    if (!row || !Number.isFinite(row.strike) || row.strike <= 0) continue;
    const callOi = positive(row.callOi);
    const putOi = positive(row.putOi);
    if (callOi === 0 && putOi === 0) continue;
    rows.push({ strike: row.strike, callOi, putOi });
  }
  if (!rows.length) return null;
  rows.sort((left, right) => left.strike - right.strike);
  let bestStrike = rows[0].strike;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const candidate of rows) {
    let cost = 0;
    for (const row of rows) {
      if (candidate.strike > row.strike) cost += row.callOi * (candidate.strike - row.strike);
      else if (candidate.strike < row.strike) cost += row.putOi * (row.strike - candidate.strike);
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestStrike = candidate.strike;
    }
  }
  return bestStrike;
}

export function parseOptionsOiQuery(url: URL): OptionsOiQuery {
  const rawCurrency = url.searchParams.get("currency");
  if (rawCurrency != null && rawCurrency.trim() === "") return { ok: false, error: OPTIONS_OI_ERRORS.currency };
  const currency = (rawCurrency ?? "BTC").trim().toUpperCase();
  if (!isOptionsCurrency(currency)) return { ok: false, error: OPTIONS_OI_ERRORS.currency };
  const rawExpiry = url.searchParams.get("expiry");
  if (rawExpiry == null) return { ok: true, currency, expiry: null };
  if (!isIsoDate(rawExpiry)) return { ok: false, error: OPTIONS_OI_ERRORS.expiry };
  return { ok: true, currency, expiry: rawExpiry };
}

export function assembleOptionsSnapshot(input: {
  currency: OptionsCurrency;
  expiry: string | null;
  rows: readonly unknown[];
  spot: number;
  asOf: string;
  now?: Date;
}): { ok: true; snapshot: OptionsOiSnapshot } | { ok: false; status: 404 | 502; error: string } {
  const books = collectBooks(input.rows, input.currency);
  if (!books.length) return { ok: false, status: 502, error: OPTIONS_OI_ERRORS.empty };
  const expiry = input.expiry ?? selectDefaultExpiry(books, input.now ?? new Date());
  const selected = books.find((book) => book.expiry === expiry);
  if (!expiry || !selected) return { ok: false, status: 404, error: OPTIONS_OI_ERRORS.unlisted };
  const callOi = selected.callOi;
  const putOi = selected.putOi;
  const maxPain = computeMaxPain(selected.strikes);
  return {
    ok: true,
    snapshot: {
      currency: input.currency,
      expiry: selected.expiry,
      expiries: books.map(toExpirySummary),
      strikes: selected.strikes,
      totalOiBase: callOi + putOi,
      totalOiUsd: (callOi + putOi) * input.spot,
      putCallRatio: callOi > 0 ? putOi / callOi : null,
      maxPain,
      spot: input.spot,
      distancePct: maxPain != null && maxPain > 0 ? ((input.spot - maxPain) / maxPain) * 100 : null,
      asOf: input.asOf,
      settlement: OPTIONS_SETTLEMENT_LABEL,
    },
  };
}

export function selectDefaultExpiry(books: readonly ExpiryBook[], now: Date): string | null {
  const today = now.toISOString().slice(0, 10);
  const settlementPassed = now.getUTCHours() * 60 + now.getUTCMinutes() >= 8 * 60;
  const upcoming = books.filter((book) => book.expiry > today || (book.expiry === today && !settlementPassed));
  const pool = upcoming.length ? upcoming : books;
  const fridays = pool.filter((book) => book.friday);
  const candidates = fridays.length ? fridays : pool;
  const peak = candidates.reduce((max, book) => Math.max(max, book.totalOi), 0);
  const floor = peak * MEANINGFUL_OI_SHARE;
  const meaningful = candidates.filter((book) => book.totalOi >= floor);
  const ranked = (meaningful.length ? meaningful : candidates).slice().sort((left, right) => left.expiry.localeCompare(right.expiry));
  return ranked[0]?.expiry ?? null;
}

export function clipStrikes(strikes: readonly StrikeOi[], spot: number, maxPain: number | null, band: number | null): StrikeOi[] {
  const sorted = [...strikes].sort((left, right) => left.strike - right.strike);
  if (band == null || !(spot > 0)) return sorted;
  const low = spot * (1 - band);
  const high = spot * (1 + band);
  return sorted.filter((row) => (row.strike >= low && row.strike <= high) || (maxPain != null && row.strike === maxPain));
}

export type OptionsChartBar = {
  strike: number;
  x: number;
  width: number;
  callY: number;
  callH: number;
  putY: number;
  putH: number;
};

export type OptionsChartLayout = {
  width: number;
  height: number;
  zeroY: number;
  plotTop: number;
  plotBottom: number;
  plotLeft: number;
  plotRight: number;
  bars: OptionsChartBar[];
  maxPain: { x: number } | null;
  spot: { x: number } | null;
  band: { x: number; width: number } | null;
  distance: { x: number; y: number; text: string } | null;
  ticks: { x: number; text: string }[];
};

export function layoutOptionsChart(
  strikes: readonly StrikeOi[],
  spot: number,
  maxPain: number | null,
  distancePct: number | null,
  width: number,
  height: number,
): OptionsChartLayout {
  const plotLeft = 8;
  const plotRight = Math.max(plotLeft + 1, width - 8);
  const plotTop = 8;
  const plotBottom = Math.max(plotTop + 1, height - 40);
  const zeroY = plotTop + (plotBottom - plotTop) / 2;
  const sorted = [...strikes].sort((left, right) => left.strike - right.strike);
  const prices = sorted.map((row) => row.strike);
  if (spot > 0) prices.push(spot);
  if (maxPain != null && maxPain > 0) prices.push(maxPain);
  const min = prices.length ? Math.min(...prices) : 0;
  const max = prices.length ? Math.max(...prices) : 1;
  const xOf = (price: number) => (max === min ? (plotLeft + plotRight) / 2 : plotLeft + ((price - min) / (max - min)) * (plotRight - plotLeft));
  const maxOi = sorted.reduce((peak, row) => Math.max(peak, positive(row.callOi), positive(row.putOi)), 0) || 1;
  const half = (plotBottom - plotTop) / 2;
  const slot = (plotRight - plotLeft) / Math.max(sorted.length, 1);
  const barWidth = Math.max(1, Math.min(10, slot * 0.62));
  const bars = sorted.map((row) => {
    const callH = (positive(row.callOi) / maxOi) * half;
    const putH = (positive(row.putOi) / maxOi) * half;
    return {
      strike: row.strike,
      x: xOf(row.strike) - barWidth / 2,
      width: barWidth,
      callY: zeroY - callH,
      callH,
      putY: zeroY,
      putH,
    };
  });
  const maxPainX = maxPain != null && maxPain > 0 ? xOf(maxPain) : null;
  const spotX = spot > 0 ? xOf(spot) : null;
  const band = maxPainX != null && spotX != null && spotX !== maxPainX
    ? { x: Math.min(maxPainX, spotX), width: Math.abs(spotX - maxPainX) }
    : null;
  const distanceText = formatDistancePct(distancePct);
  return {
    width,
    height,
    zeroY,
    plotTop,
    plotBottom,
    plotLeft,
    plotRight,
    bars,
    maxPain: maxPainX == null ? null : { x: maxPainX },
    spot: spotX == null ? null : { x: spotX },
    band,
    distance: distanceText && maxPainX != null && spotX != null ? { x: (maxPainX + spotX) / 2, y: height - 22, text: distanceText } : null,
    ticks: axisTicks(min, max, xOf),
  };
}

export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatStrike(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}

export function formatSpotUsd(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatDistancePct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

export function formatOptionsKicker(currency: OptionsCurrency, expiry: string): string {
  switch (currency) {
    case "BTC":
      return `BITCOIN OPTIONS EXPIRING ${expiry}`;
    case "ETH":
      return `ETHEREUM OPTIONS EXPIRING ${expiry}`;
    default: {
      const unexpected: never = currency;
      return unexpected;
    }
  }
}

export function formatOptionsHeadline(totalOiUsd: number, putCallRatio: number | null): string {
  const ratio = putCallRatio == null || !Number.isFinite(putCallRatio) ? "—" : putCallRatio.toFixed(2);
  return `${formatUsdCompact(totalOiUsd)} of open interest, put/call ${ratio}`;
}

export function formatOptionsFooter(snapshot: { asOf: string; spot: number; maxPain: number | null }): string {
  const pain = snapshot.maxPain == null ? "Max pain unavailable" : `Max pain ${formatSpotUsd(snapshot.maxPain)}`;
  return `Deribit, 08:00 UTC settlement. ${pain} computed from open interest at ${snapshot.asOf}; spot ${formatSpotUsd(snapshot.spot)}.`;
}

export function formatExpiryChoice(expiry: string): string {
  const match = ISO_DATE.exec(expiry);
  if (!match) return expiry;
  return `${Number(match[3])} ${MONTH_NAMES[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

export function formatAsOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}

export function parseOptionsOiSnapshot(value: unknown): OptionsOiSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const currency = record.currency;
  const expiry = record.expiry;
  if (!isOptionsCurrency(currency)) return null;
  if (typeof expiry !== "string" || !isIsoDate(expiry)) return null;
  if (typeof record.spot !== "number" || !Number.isFinite(record.spot) || record.spot <= 0) return null;
  if (typeof record.asOf !== "string" || !AS_OF.test(record.asOf)) return null;
  if (record.settlement !== OPTIONS_SETTLEMENT_LABEL) return null;
  if (typeof record.totalOiBase !== "number" || !Number.isFinite(record.totalOiBase) || record.totalOiBase < 0) return null;
  if (typeof record.totalOiUsd !== "number" || !Number.isFinite(record.totalOiUsd) || record.totalOiUsd < 0) return null;
  const putCallRatio = optionalNumber(record.putCallRatio);
  const maxPain = optionalNumber(record.maxPain);
  const distancePct = optionalNumber(record.distancePct);
  if (putCallRatio === undefined || maxPain === undefined || distancePct === undefined) return null;
  if (!Array.isArray(record.strikes) || !Array.isArray(record.expiries)) return null;
  const strikes: StrikeOi[] = [];
  for (const row of record.strikes) {
    const strike = readStrike(row);
    if (strike) strikes.push(strike);
  }
  const expiries: OptionsExpirySummary[] = [];
  for (const row of record.expiries) {
    const expiry = readExpiry(row);
    if (expiry) expiries.push(expiry);
  }
  return {
    currency,
    expiry,
    expiries,
    strikes,
    totalOiBase: record.totalOiBase,
    totalOiUsd: record.totalOiUsd,
    putCallRatio,
    maxPain,
    spot: record.spot,
    distancePct,
    asOf: record.asOf,
    settlement: OPTIONS_SETTLEMENT_LABEL,
  };
}

export function isOptionsCurrency(value: unknown): value is OptionsCurrency {
  return value === "BTC" || value === "ETH";
}

function collectBooks(rows: readonly unknown[], currency: OptionsCurrency): ExpiryBook[] {
  const grouped = new Map<string, Map<number, StrikeOi>>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const parsed = parseDeribitInstrument(record.instrument_name);
    if (!parsed || parsed.currency !== currency) continue;
    const oi = readOi(record.open_interest);
    if (oi == null || oi === 0 || oi > MAX_INSTRUMENT_OI) continue;
    let strikes = grouped.get(parsed.expiry);
    if (!strikes) {
      strikes = new Map();
      grouped.set(parsed.expiry, strikes);
    }
    const bucket = strikes.get(parsed.strike) ?? { strike: parsed.strike, callOi: 0, putOi: 0 };
    if (parsed.type === "C") bucket.callOi += oi;
    else bucket.putOi += oi;
    strikes.set(parsed.strike, bucket);
  }
  const books: ExpiryBook[] = [];
  for (const [expiry, strikes] of grouped) {
    const rowsForExpiry = [...strikes.values()].sort((left, right) => left.strike - right.strike);
    let callOi = 0;
    let putOi = 0;
    for (const row of rowsForExpiry) {
      callOi += row.callOi;
      putOi += row.putOi;
    }
    if (callOi + putOi <= 0) continue;
    books.push({ expiry, friday: isUtcFriday(expiry), callOi, putOi, totalOi: callOi + putOi, strikes: rowsForExpiry });
  }
  books.sort((left, right) => left.expiry.localeCompare(right.expiry));
  return books;
}

function toExpirySummary(book: ExpiryBook): OptionsExpirySummary {
  return { expiry: book.expiry, callOi: book.callOi, putOi: book.putOi, totalOi: book.totalOi };
}

function readOi(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function readStrike(value: unknown): StrikeOi | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.strike !== "number" || !Number.isFinite(record.strike) || record.strike <= 0) return null;
  if (typeof record.callOi !== "number" || !Number.isFinite(record.callOi) || record.callOi < 0) return null;
  if (typeof record.putOi !== "number" || !Number.isFinite(record.putOi) || record.putOi < 0) return null;
  return { strike: record.strike, callOi: record.callOi, putOi: record.putOi };
}

function readExpiry(value: unknown): OptionsExpirySummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.expiry !== "string" || !isIsoDate(record.expiry)) return null;
  if (typeof record.callOi !== "number" || !Number.isFinite(record.callOi) || record.callOi < 0) return null;
  if (typeof record.putOi !== "number" || !Number.isFinite(record.putOi) || record.putOi < 0) return null;
  if (typeof record.totalOi !== "number" || !Number.isFinite(record.totalOi) || record.totalOi < 0) return null;
  return { expiry: record.expiry, callOi: record.callOi, putOi: record.putOi, totalOi: record.totalOi };
}

function axisTicks(min: number, max: number, xOf: (price: number) => number): { x: number; text: string }[] {
  if (!(max > min)) return [];
  const step = niceStep(max - min);
  const start = Math.ceil(min / step) * step;
  const ticks: { x: number; text: string }[] = [];
  for (let price = start; price <= max + step * 1e-6; price += step) {
    const x = xOf(price);
    const previous = ticks.at(-1);
    if (previous && x - previous.x < 36) continue;
    ticks.push({ x, text: String(Math.round(price)) });
  }
  return ticks;
}

function niceStep(span: number): number {
  const rough = span / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / pow;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * pow;
}

function isUtcFriday(expiry: string): boolean {
  const match = ISO_DATE.exec(expiry);
  if (!match) return false;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() === 5;
}

function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  return isoDate(Number(match[1]), Number(match[2]), Number(match[3])) === value;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
