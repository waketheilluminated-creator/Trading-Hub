/**
 * Alert engine + service layer. Dependency-injected so tests drive it with a fake feed, a fake clock and a mock SMTP.
 *  - tick(): one REST poll per venue:symbol:interval in use, evaluates every active alert, logs fires (deduped),
 *    enqueues emails to the verified recipient.
 *  - pump(): drains the outbox with the global hourly cap and exponential backoff retries.
 */
import {
  GLOBAL_EMAIL_CAP_PER_HOUR, MAX_ACTIVE_ALERTS, escapeHtml, evaluateAlert, fireDedupeKey, headerSafe, nextRetryAt, normalizeEmail,
  renderAlertTemplate, underGlobalCap, validateAlertInput, type AlertRecord, type PriceSample,
} from "./core.ts";
import type { AlertStore, LogEntry, NotifySettings } from "./store.ts";
import type { MailMessage, SmtpConfig } from "./smtp.ts";
import type { SmtpResolution } from "./secrets.ts";
import type { ChartInterval, MarketCandle, MarketVenue } from "../market-venues.ts";

export const VERIFY_CODE_TTL_MS = 15 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 5;
export const TEST_EMAIL_MIN_INTERVAL_MS = 60_000;
export const ENGINE_POLL_MS = 5_000;

export type EngineDeps = {
  store: AlertStore;
  fetchKlines: (venue: MarketVenue, symbol: string, interval: ChartInterval) => Promise<MarketCandle[]>;
  resolveSmtp: () => Promise<SmtpResolution>;
  sendMail: (config: SmtpConfig, message: MailMessage) => Promise<void>;
  now: () => number;
  randomId: () => string;
  randomCode: () => string; // 6 digits
  hash: (text: string) => string;
  safeEqual: (a: string, b: string) => boolean;
  log?: (message: string) => void;
  envPath: string;
};

export type ServiceResult = { status: number; body: Record<string, unknown> };
const ok = (body: Record<string, unknown> = {}): ServiceResult => ({ status: 200, body: { ok: true, ...body } });
const bad = (status: number, error: string): ServiceResult => ({ status, body: { ok: false, error } });

function publicSettings(s: NotifySettings) {
  return { email: s.email, verified: s.verified, codePending: !!(s.codeHash && s.codeExpiresAt), lastTestAt: s.lastTestAt };
}

function errorText(error: unknown): string {
  // Only our own SmtpError messages (no credentials, no server banner) are surfaced.
  if (error && typeof error === "object" && (error as { name?: string }).name === "SmtpError") return String((error as Error).message);
  return "SMTP connection failed.";
}

export function createAlertEngine(deps: EngineDeps) {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  let ticking = false;
  let pumping = false;

  function buildAlertEmail(alert: AlertRecord, message: string, price: number, candle: MarketCandle, firedAt: number): { subject: string; text: string; html: string } {
    const subject = headerSafe(`[Trading Hub] ${alert.name}`);
    const text = `${message}\n\n${alert.symbol} · ${alert.venue.toUpperCase()} · ${alert.interval}\nPrice: ${price}\nLevel: ${alert.level}\nTime: ${new Date(firedAt).toISOString()}\nCandle open ${new Date(candle.time).toISOString()}`;
    const html = `<div style="font-family:system-ui,sans-serif"><p style="font-size:15px">${escapeHtml(message).replace(/\n/g, "<br>")}</p>`
      + `<p style="color:#555;font-size:13px">${escapeHtml(alert.symbol)} · ${escapeHtml(alert.venue.toUpperCase())} · ${escapeHtml(alert.interval)}<br>`
      + `Price: ${escapeHtml(String(price))} · Level: ${escapeHtml(String(alert.level))}<br>${escapeHtml(new Date(firedAt).toISOString())}</p></div>`;
    return { subject, text, html };
  }

  function processSample(alert: AlertRecord, sample: PriceSample, candle: MarketCandle): AlertRecord {
    const result = evaluateAlert(alert, sample);
    let next = result.next;
    if (result.fire) {
      const key = fireDedupeKey(alert, sample);
      const message = renderAlertTemplate(alert.message, {
        ticker: alert.symbol, exchange: alert.venue, interval: alert.interval, level: alert.level,
        open: candle.open, high: candle.high, low: candle.low, close: sample.price, volume: candle.volume,
        time: candle.time, timenow: sample.now, name: alert.name,
      });
      const settings = store.getSettings();
      const recipient = settings.verified && settings.email ? settings.email : null;
      const logId = store.appendLog({
        alertId: alert.id, alertName: alert.name, symbol: alert.symbol, firedAt: sample.now, barTime: sample.barTime,
        price: sample.price, message, emailStatus: recipient ? "queued" : "no-recipient",
      }, key);
      if (logId == null) {
        // Duplicate fire for the same bar/minute (e.g. restart replay): keep state, do not log or email twice.
        next = { ...next, firedCount: alert.firedCount };
      } else if (recipient) {
        const mail = buildAlertEmail(next, message, sample.price, candle, sample.now);
        store.enqueueEmail("alert", key, logId, recipient, mail.subject, mail.text, mail.html, sample.now);
      }
    }
    store.saveAlert(next);
    return next;
  }

  async function tick(): Promise<{ evaluated: number; fired: number }> {
    if (ticking) return { evaluated: 0, fired: 0 };
    ticking = true;
    let evaluated = 0;
    let fired = 0;
    try {
      const groups = new Map<string, AlertRecord[]>();
      for (const alert of store.activeAlerts()) {
        const key = `${alert.venue}:${alert.symbol}:${alert.interval}`;
        groups.set(key, [...(groups.get(key) ?? []), alert]);
      }
      for (const alerts of groups.values()) {
        const { venue, symbol, interval } = alerts[0];
        let candles: MarketCandle[];
        try {
          candles = await deps.fetchKlines(venue, symbol, interval);
        } catch {
          log(`alerts: feed failed for ${venue}:${symbol}:${interval}`);
          continue;
        }
        if (candles.length < 2) continue;
        // Market candles carry lightweight-charts UNIX seconds; the engine works in ms (bar_close vs createdAt, {{time}}).
        candles = candles.map((c) => (c.time < 1e12 ? { ...c, time: c.time * 1000 } : c));
        const forming = candles[candles.length - 1];
        const closed = candles[candles.length - 2];
        const now = deps.now();
        for (const alert of alerts) {
          const before = alert.firedCount;
          let next: AlertRecord;
          if (alert.frequency === "bar_close") {
            next = processSample(alert, { price: closed.close, barTime: closed.time, closed: true, closeTime: forming.time, now }, closed);
          } else {
            next = processSample(alert, { price: forming.close, barTime: forming.time, closed: false, now }, forming);
          }
          evaluated += 1;
          if (next.firedCount > before) fired += 1;
        }
      }
      // Expire paused alerts too.
      const now = deps.now();
      for (const alert of store.listAlerts()) {
        if (alert.status === "paused" && alert.expiresAt != null && now >= alert.expiresAt) store.setStatus(alert.id, "expired");
      }
    } finally {
      ticking = false;
    }
    return { evaluated, fired };
  }

  async function pump(): Promise<{ sent: number; failed: number; capped: number }> {
    const stats = { sent: 0, failed: 0, capped: 0 };
    if (pumping) return stats;
    pumping = true;
    try {
      let smtp: SmtpResolution | null = null;
      for (let batch = 0; batch < 10; batch += 1) {
      const due = store.dueEmails(deps.now(), 25);
      if (!due.length) break;
      smtp ??= await deps.resolveSmtp();
      for (const row of due) {
        const now = deps.now();
        if (!underGlobalCap(store.sentInWindow(now - 3_600_000), GLOBAL_EMAIL_CAP_PER_HOUR)) {
          store.markFailed(row.id, "suppressed", "Global cap of 30 emails/hour reached.");
          if (row.log_id != null) store.setLogEmailStatus(row.log_id, "capped");
          stats.capped += 1;
          continue;
        }
        if (!store.claimEmail(row.id)) continue;
        const attempts = row.attempts + 1;
        if (!smtp.ok) {
          const retryAt = nextRetryAt(attempts, now);
          if (retryAt == null) { store.markFailed(row.id, "failed", smtp.reason); if (row.log_id != null) store.setLogEmailStatus(row.log_id, "failed"); stats.failed += 1; }
          else { store.markRetry(row.id, retryAt, smtp.reason); if (row.log_id != null) store.setLogEmailStatus(row.log_id, "retrying"); }
          continue;
        }
        try {
          await deps.sendMail(smtp.config, { to: row.recipient, subject: row.subject, text: row.text_body, html: row.html_body });
          store.markSent(row.id, deps.now());
          if (row.log_id != null) store.setLogEmailStatus(row.log_id, "sent");
          stats.sent += 1;
        } catch (error) {
          const permanent = !!(error && typeof error === "object" && (error as { permanent?: boolean }).permanent);
          const retryAt = permanent ? null : nextRetryAt(attempts, deps.now());
          const message = errorText(error);
          if (retryAt == null) { store.markFailed(row.id, "failed", message); if (row.log_id != null) store.setLogEmailStatus(row.log_id, "failed"); stats.failed += 1; }
          else { store.markRetry(row.id, retryAt, message); if (row.log_id != null) store.setLogEmailStatus(row.log_id, "retrying"); }
          log(`alerts: email ${row.id} attempt ${attempts} failed: ${message}`);
        }
      }
      }
    } finally {
      pumping = false;
    }
    return stats;
  }

  // ---- service API (called by routes after the request guard) ----

  function listAlerts(): ServiceResult {
    return ok({ alerts: store.listAlerts() });
  }

  function createAlert(body: unknown): ServiceResult {
    const now = deps.now();
    const parsed = validateAlertInput(body, now);
    if (!parsed.ok) return bad(400, parsed.error);
    if (store.countLive() >= MAX_ACTIVE_ALERTS) return bad(409, `At most ${MAX_ACTIVE_ALERTS} alerts.`);
    const record: AlertRecord = {
      ...parsed.value, id: deps.randomId(), status: "active", createdAt: now, firedCount: 0,
      lastFiredAt: null, lastFiredBar: null, prevPrice: null, lastClosedBar: null,
    };
    store.insertAlert(record);
    return { status: 201, body: { ok: true, alert: record } };
  }

  function alertAction(body: unknown): ServiceResult {
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad(400, "Body must be a JSON object.");
    const { id, action, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) return bad(400, "Unknown field.");
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return bad(400, "Invalid id.");
    const alert = store.getAlert(id);
    if (!alert) return bad(404, "Alert not found.");
    if (action === "delete") { store.deleteAlert(id); return ok({ deleted: id }); }
    if (action === "pause") {
      if (alert.status !== "active") return bad(409, "Only active alerts can be paused.");
      store.setStatus(id, "paused");
    } else if (action === "resume") {
      if (alert.status === "expired" && (alert.expiresAt == null || alert.expiresAt <= deps.now())) return bad(409, "Alert expired.");
      // Resuming re-arms: crossings need a fresh reference so a stale prevPrice cannot cause an instant fire.
      store.saveAlert({ ...alert, status: "active", prevPrice: null, lastClosedBar: null });
    } else return bad(400, "action must be pause, resume or delete.");
    return ok({ alert: store.getAlert(id) });
  }

  function listLog(afterId: number, limit: number): ServiceResult {
    return ok({ log: store.listLog(afterId, limit) as LogEntry[] });
  }

  async function getSettings(): Promise<ServiceResult> {
    const smtp = await deps.resolveSmtp();
    return ok({ settings: publicSettings(store.getSettings()), smtpConfigured: smtp.ok, smtpReason: smtp.ok ? null : smtp.reason, envPath: deps.envPath });
  }

  async function updateSettings(body: unknown): Promise<ServiceResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad(400, "Body must be a JSON object.");
    const raw = body as Record<string, unknown>;
    const allowed: Record<string, string[]> = { set: ["action", "email"], "send-test": ["action"], verify: ["action", "code"], clear: ["action"] };
    const keys = typeof raw.action === "string" ? allowed[raw.action] : undefined;
    if (!keys) return bad(400, "Unknown action.");
    for (const key of Object.keys(raw)) if (!keys.includes(key)) return bad(400, "Unknown field.");
    const current = store.getSettings();
    const now = deps.now();
    const reset: NotifySettings = { email: null, verified: false, codeHash: null, codeExpiresAt: null, codeAttempts: 0, lastTestAt: current.lastTestAt };

    if (raw.action === "clear") { store.setSettings(reset); return ok({ settings: publicSettings(reset) }); }
    if (raw.action === "set") {
      const email = normalizeEmail(raw.email);
      if (!email) return bad(400, "Invalid email address.");
      // Any change of address resets verification.
      const next = email === current.email ? current : { ...reset, email };
      store.setSettings(next);
      return ok({ settings: publicSettings(next) });
    }
    if (raw.action === "send-test") {
      if (!current.email) return bad(409, "Set 通知邮箱 first.");
      if (current.lastTestAt != null && now - current.lastTestAt < TEST_EMAIL_MIN_INTERVAL_MS) return bad(429, "Wait a minute before sending another test email.");
      if (!underGlobalCap(store.sentInWindow(now - 3_600_000))) return bad(429, "Global email cap reached; try later.");
      const smtp = await deps.resolveSmtp();
      if (!smtp.ok) return bad(503, smtp.reason);
      const code = deps.randomCode();
      const next: NotifySettings = { ...current, codeHash: deps.hash(code), codeExpiresAt: now + VERIFY_CODE_TTL_MS, codeAttempts: 0, lastTestAt: now };
      store.setSettings(next);
      try {
        await deps.sendMail(smtp.config, {
          to: current.email,
          subject: "[Trading Hub] 测试邮件 / verification code",
          text: `Trading Hub test email.\n\nVerification code: ${code}\n\nEnter it on the 通知邮箱 settings page within 15 minutes.`,
          html: `<div style="font-family:system-ui,sans-serif"><p>Trading Hub test email.</p><p style="font-size:22px;letter-spacing:4px"><b>${escapeHtml(code)}</b></p><p>Enter it on the 通知邮箱 settings page within 15 minutes.</p></div>`,
        });
        store.recordSent("test", `test:${now}:${deps.randomId()}`, current.email, "test", now);
      } catch (error) {
        store.setSettings({ ...next, codeHash: null, codeExpiresAt: null });
        return bad(502, errorText(error));
      }
      return ok({ settings: publicSettings(store.getSettings()) });
    }
    // verify
    const code = typeof raw.code === "string" ? raw.code.trim() : "";
    if (!/^\d{6}$/.test(code)) return bad(400, "Code must be 6 digits.");
    if (!current.codeHash || !current.codeExpiresAt) return bad(409, "Send a test email first.");
    if (now > current.codeExpiresAt) { store.setSettings({ ...current, codeHash: null, codeExpiresAt: null }); return bad(410, "Code expired; send a new test email."); }
    if (current.codeAttempts >= VERIFY_MAX_ATTEMPTS) { store.setSettings({ ...current, codeHash: null, codeExpiresAt: null }); return bad(429, "Too many attempts; send a new test email."); }
    if (!deps.safeEqual(deps.hash(code), current.codeHash)) {
      const attempts = current.codeAttempts + 1;
      store.setSettings(attempts >= VERIFY_MAX_ATTEMPTS ? { ...current, codeAttempts: attempts, codeHash: null, codeExpiresAt: null } : { ...current, codeAttempts: attempts });
      return bad(400, "Wrong code.");
    }
    const verified: NotifySettings = { ...current, verified: true, codeHash: null, codeExpiresAt: null, codeAttempts: 0 };
    store.setSettings(verified);
    return ok({ settings: publicSettings(verified) });
  }

  return { tick, pump, listAlerts, createAlert, alertAction, listLog, getSettings, updateSettings };
}

export type AlertEngine = ReturnType<typeof createAlertEngine>;

// ---- request guard (Tier C) ----

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export const ALERTS_MAX_BODY = 8 * 1024;

export type GuardResult = { ok: true } | { ok: false; status: 403 | 405 | 413 | 415; error: string };

/** Localhost-only; mutations must be same-origin POST with JSON ≤ 8 KB. Reads must not be cross-site. */
export function alertsRequestGuard(request: Request, mutation: boolean): GuardResult {
  const url = new URL(request.url);
  if (!LOCAL_HOSTS.has(url.hostname)) return { ok: false, status: 403, error: "Alerts API is only available on localhost." };
  const hostHeader = request.headers.get("host");
  if (hostHeader && !LOCAL_HOSTS.has(hostHeader.replace(/:\d+$/, ""))) return { ok: false, status: 403, error: "Alerts API is only available on localhost." };
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (site && site !== "same-origin" && site !== "none") return { ok: false, status: 403, error: "Cross-origin request blocked." };
  if (origin && origin !== url.origin) return { ok: false, status: 403, error: "Cross-origin request blocked." };
  if (!mutation) return { ok: true };
  if (request.method !== "POST") return { ok: false, status: 405, error: "Use POST." };
  if (!origin) return { ok: false, status: 403, error: "Missing Origin." };
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { ok: false, status: 415, error: "Content-Type must be application/json." };
  const length = Number(request.headers.get("content-length") || 0);
  if (length > ALERTS_MAX_BODY) return { ok: false, status: 413, error: "Body too large." };
  return { ok: true };
}

/** Reads a JSON body with a hard size cap (content-length may be absent or lie). */
export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const text = await request.text();
  if (text.length > ALERTS_MAX_BODY) return { ok: false, status: 413, error: "Body too large." };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, status: 400, error: "Invalid JSON." }; }
}
