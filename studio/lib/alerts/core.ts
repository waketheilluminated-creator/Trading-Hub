/**
 * TH-FEAT-15 alerts: pure core (validation, evaluation, templates, limits). No I/O here.
 * Semantics follow TradingView (see /workspace/th-alerts-research.md §1):
 *  - Crossing: previous and current sample on opposite sides of the level (or touching it).
 *  - Crossing up: prev < L && cur >= L. Crossing down: prev > L && cur <= L. Created on the far side → never fires
 *    until price first goes back to the other side.
 *  - Greater than / Less than: strict cur > L / cur < L.
 *  - Frequency: once (stops after the first fire), every (≤1 per minute), bar_close (only on closed bars).
 */
import { CHART_INTERVALS, MARKET_VENUES, type ChartInterval, type MarketVenue } from "../market-venues.ts";

export const ALERT_OPERATORS = ["crossing", "crossing_up", "crossing_down", "greater_than", "less_than"] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];
export const ALERT_FREQUENCIES = ["once", "every", "bar_close"] as const;
export type AlertFrequency = (typeof ALERT_FREQUENCIES)[number];
export type AlertStatus = "active" | "paused" | "stopped" | "expired";

export const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
export const EVERY_MIN_INTERVAL_MS = 60_000;
export const GLOBAL_EMAIL_CAP_PER_HOUR = 30;
export const MAX_ACTIVE_ALERTS = 200;
export const MAX_NAME = 80;
export const MAX_MESSAGE = 1000;
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;

export const ALERT_SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

export type AlertInput = {
  name: string;
  symbol: string;
  venue: MarketVenue;
  interval: ChartInterval;
  operator: AlertOperator;
  level: number;
  frequency: AlertFrequency;
  expiresAt: number | null; // null = open-ended
  message: string;
};

export type AlertRecord = AlertInput & {
  id: string;
  status: AlertStatus;
  createdAt: number;
  firedCount: number;
  lastFiredAt: number | null;
  lastFiredBar: number | null;
  prevPrice: number | null; // last sampled price (armed reference)
  lastClosedBar: number | null;
};

const INPUT_KEYS = new Set(["name", "symbol", "venue", "interval", "operator", "level", "frequency", "expiresAt", "message"]);

export function defaultAlertMessage(operator: AlertOperator): string {
  const verb: Record<AlertOperator, string> = {
    crossing: "Crossing", crossing_up: "Crossing up", crossing_down: "Crossing down", greater_than: "Greater than", less_than: "Less than",
  };
  return `{{ticker}} ${verb[operator]} {{level}} · close {{close}} · {{interval}} · {{timenow}}`;
}

/** Strict schema: unknown keys, wrong types, non-finite numbers and out-of-range values are rejected. */
export function validateAlertInput(body: unknown, now: number): { ok: true; value: AlertInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object." };
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!INPUT_KEYS.has(key)) return { ok: false, error: `Unknown field: ${key.slice(0, 40)}` };
  const symbol = raw.symbol;
  if (typeof symbol !== "string" || !ALERT_SYMBOL_PATTERN.test(symbol)) return { ok: false, error: "symbol must match ^[A-Z0-9]{2,20}USDT$" };
  if (typeof raw.venue !== "string" || !(MARKET_VENUES as readonly string[]).includes(raw.venue)) return { ok: false, error: "Unsupported venue." };
  if (typeof raw.interval !== "string" || !(CHART_INTERVALS as readonly string[]).includes(raw.interval)) return { ok: false, error: "Unsupported interval." };
  if (typeof raw.operator !== "string" || !(ALERT_OPERATORS as readonly string[]).includes(raw.operator)) return { ok: false, error: "Unsupported operator." };
  if (typeof raw.frequency !== "string" || !(ALERT_FREQUENCIES as readonly string[]).includes(raw.frequency)) return { ok: false, error: "Unsupported frequency." };
  const level = raw.level;
  if (typeof level !== "number" || !Number.isFinite(level) || level <= 0 || level > 1e12) return { ok: false, error: "level must be a positive finite number." };
  let expiresAt: number | null;
  if (raw.expiresAt === null) expiresAt = null;
  else if (raw.expiresAt === undefined) expiresAt = now + DEFAULT_EXPIRY_MS;
  else if (typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) && raw.expiresAt > now && raw.expiresAt <= now + MAX_EXPIRY_MS) expiresAt = Math.floor(raw.expiresAt);
  else return { ok: false, error: "expiresAt must be a future timestamp within 365 days, or null." };
  const name = raw.name === undefined ? "" : raw.name;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (typeof name !== "string" || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: `name must be ≤ ${MAX_NAME} characters without control characters.` };
  const message = raw.message === undefined ? "" : raw.message;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (typeof message !== "string" || message.length > MAX_MESSAGE || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) return { ok: false, error: `message must be ≤ ${MAX_MESSAGE} characters.` };
  const operator = raw.operator as AlertOperator;
  return {
    ok: true,
    value: {
      name: name.trim() || `${symbol} ${operator.replace("_", " ")} ${level}`,
      symbol,
      venue: raw.venue as MarketVenue,
      interval: raw.interval as ChartInterval,
      operator,
      level,
      frequency: raw.frequency as AlertFrequency,
      expiresAt,
      message: message.trim() || defaultAlertMessage(operator),
    },
  };
}

/** Is the operator's condition met between two samples? */
export function conditionMet(operator: AlertOperator, prev: number | null, cur: number, level: number): boolean {
  switch (operator) {
    case "greater_than": return cur > level;
    case "less_than": return cur < level;
    case "crossing_up": return prev != null && prev < level && cur >= level;
    case "crossing_down": return prev != null && prev > level && cur <= level;
    case "crossing": return prev != null && ((prev < level && cur >= level) || (prev > level && cur <= level));
  }
}

export type PriceSample = {
  /** Price to evaluate: the forming bar's last price (intrabar) or the bar close (closed). */
  price: number;
  /** Open time (ms) of the bar this sample belongs to. */
  barTime: number;
  /** true when this sample is the final close of `barTime`. */
  closed: boolean;
  /** For closed samples: when the bar closed (next bar's open). Bars that closed before the alert existed only arm it. */
  closeTime?: number;
  now: number;
};

export type Evaluation = { fire: boolean; next: AlertRecord; reason?: "expired" };

/**
 * Advance one alert by one sample. Pure: returns the fire decision and the next record.
 * The first sample after creation only arms the alert (sets prevPrice) and never fires for crossings.
 */
export function evaluateAlert(alert: AlertRecord, sample: PriceSample): Evaluation {
  if (alert.status !== "active") return { fire: false, next: alert };
  if (alert.expiresAt != null && sample.now >= alert.expiresAt) return { fire: false, next: { ...alert, status: "expired" }, reason: "expired" };
  if (!Number.isFinite(sample.price) || sample.price <= 0) return { fire: false, next: alert };

  if (alert.frequency === "bar_close") {
    // Intrabar samples are ignored entirely: neither arm nor fire (TV "once per bar close").
    if (!sample.closed) return { fire: false, next: alert };
    if (alert.lastClosedBar != null && sample.barTime <= alert.lastClosedBar) return { fire: false, next: alert };
    const met = conditionMet(alert.operator, alert.prevPrice, sample.price, alert.level);
    const next: AlertRecord = { ...alert, prevPrice: sample.price, lastClosedBar: sample.barTime };
    const predates = sample.closeTime != null && sample.closeTime <= alert.createdAt;
    if (!met || predates || alert.lastFiredBar === sample.barTime) return { fire: false, next };
    return { fire: true, next: { ...next, firedCount: alert.firedCount + 1, lastFiredAt: sample.now, lastFiredBar: sample.barTime } };
  }

  const met = conditionMet(alert.operator, alert.prevPrice, sample.price, alert.level);
  const armed: AlertRecord = { ...alert, prevPrice: sample.price };
  if (!met) return { fire: false, next: armed };
  if (alert.frequency === "every" && alert.lastFiredAt != null && sample.now - alert.lastFiredAt < EVERY_MIN_INTERVAL_MS) {
    // Rate-limited (≤1 per minute): the sample is consumed; crossings re-arm on the next opposite-side sample.
    return { fire: false, next: armed };
  }
  const fired: AlertRecord = { ...armed, firedCount: alert.firedCount + 1, lastFiredAt: sample.now, lastFiredBar: sample.barTime };
  if (alert.frequency === "once") fired.status = "stopped";
  return { fire: true, next: fired };
}

/** Dedupe key for one fire: one per alert per bar (bar_close / once) or per minute bucket (every). */
export function fireDedupeKey(alert: AlertRecord, sample: PriceSample): string {
  if (alert.frequency === "every") return `${alert.id}:m${Math.floor(sample.now / 60_000)}`;
  return `${alert.id}:b${sample.barTime}`;
}

// ---- placeholders ----

export type TemplateContext = {
  ticker: string; exchange: string; interval: string; level: number;
  open: number; high: number; low: number; close: number; volume: number;
  time: number; timenow: number; name: string;
};

export const PLACEHOLDERS = ["ticker", "exchange", "interval", "level", "open", "high", "low", "close", "volume", "time", "timenow", "name"] as const;

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Whitelisted {{token}} replacement. Unknown tokens stay literal; nothing is evaluated. */
export function renderAlertTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, token: string) => {
    switch (token) {
      case "ticker": return ctx.ticker;
      case "exchange": return ctx.exchange.toUpperCase();
      case "interval": return ctx.interval;
      case "name": return ctx.name;
      case "time": return isoSeconds(ctx.time);
      case "timenow": return isoSeconds(ctx.timenow);
      case "level": case "open": case "high": case "low": case "close": case "volume": {
        const value = ctx[token];
        return Number.isFinite(value) ? String(value) : "";
      }
      default: return match;
    }
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Header-safe single line (no CR/LF → no header injection), capped. */
export function headerSafe(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return text.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

// ---- recipient ----

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) return null;
  if (value.includes("..") || value.startsWith(".") || value.split("@")[0].endsWith(".")) return null;
  const [local, domain] = value.split("@");
  return `${local}@${domain.toLowerCase()}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// ---- outbox limits ----

export function nextRetryAt(attempts: number, now: number): number | null {
  const delay = RETRY_BACKOFF_MS[attempts - 1];
  return delay == null ? null : now + delay;
}

/** Global email cap: sent (or in-flight) count in the trailing hour must stay below the cap. */
export function underGlobalCap(sentInLastHour: number, cap = GLOBAL_EMAIL_CAP_PER_HOUR): boolean {
  return sentInLastHour < cap;
}
