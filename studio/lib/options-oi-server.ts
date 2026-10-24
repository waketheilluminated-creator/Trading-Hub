// Trust boundary: only BTC/ETH and a calendar expiry reach Deribit.
// Client spot, book, and open-interest parameters are never read.
// Both URLs are fixed public endpoints; redirects are rejected.

import {
  OPTIONS_OI_CACHE_MS,
  OPTIONS_OI_ERRORS,
  assembleOptionsSnapshot,
  formatAsOf,
  parseOptionsOiQuery,
  type OptionsCurrency,
  type OptionsOiSnapshot,
} from "./options-oi.ts";

export type OptionsOiResult =
  | { ok: true; status: 200; body: OptionsOiSnapshot }
  | { ok: false; status: 400 | 404 | 502; body: { error: string } };

type CachedBook = {
  at: number;
  rows: unknown[];
  spot: number;
  asOf: string;
};

const cache = new Map<OptionsCurrency, CachedBook>();

export function clearOptionsOiCache(): void {
  cache.clear();
}

export async function loadOptionsOi(url: URL, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<OptionsOiResult> {
  const query = parseOptionsOiQuery(url);
  if (!query.ok) return { ok: false, status: 400, body: { error: query.error } };

  try {
    const book = await loadBook(query.currency, fetchImpl, now);
    const assembled = assembleOptionsSnapshot({
      currency: query.currency,
      expiry: query.expiry,
      rows: book.rows,
      spot: book.spot,
      asOf: book.asOf,
      now: new Date(now),
    });
    if (!assembled.ok) return { ok: false, status: assembled.status, body: { error: assembled.error } };
    return { ok: true, status: 200, body: assembled.snapshot };
  } catch {
    return { ok: false, status: 502, body: { error: OPTIONS_OI_ERRORS.upstream } };
  }
}

async function loadBook(currency: OptionsCurrency, fetchImpl: typeof fetch, now: number): Promise<CachedBook> {
  const cached = cache.get(currency);
  if (cached && now - cached.at < OPTIONS_OI_CACHE_MS) return cached;
  const init: RequestInit = {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  };
  const bookResponse = await fetchImpl(bookUrl(currency), init);
  const indexResponse = await fetchImpl(indexUrl(currency), init);
  const bookPayload = await readJson(bookResponse);
  const indexPayload = await readJson(indexResponse);
  const rows = readRows(bookPayload);
  const spot = readIndexPrice(indexPayload);
  if (!rows || spot == null) throw new Error("upstream");
  const stored: CachedBook = { at: now, rows, spot, asOf: asOfFrom(bookPayload, now) };
  cache.set(currency, stored);
  return stored;
}

function bookUrl(currency: OptionsCurrency): string {
  return `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
}

function indexUrl(currency: OptionsCurrency): string {
  switch (currency) {
    case "BTC":
      return "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd";
    case "ETH":
      return "https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd";
    default: {
      const unexpected: never = currency;
      throw new Error(`Unsupported options currency ${String(unexpected)}`);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("upstream");
  return response.json() as Promise<unknown>;
}

function readRows(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object" || !("result" in payload)) return null;
  const result = (payload as { result?: unknown }).result;
  return Array.isArray(result) ? result : null;
}

function readIndexPrice(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("result" in payload)) return null;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object" || !("index_price" in result)) return null;
  const price = (result as { index_price?: unknown }).index_price;
  const number = typeof price === "number" ? price : typeof price === "string" ? Number(price) : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function asOfFrom(payload: unknown, now: number): string {
  const usOut = payload && typeof payload === "object" && "usOut" in payload ? (payload as { usOut?: unknown }).usOut : null;
  const ms = typeof usOut === "number" && Number.isFinite(usOut) && usOut > 1e14 ? usOut / 1000 : now;
  return formatAsOf(ms);
}
