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
import { isMarketVenue, type ChartInterval, type MarketCandle, type MarketVenue } from "../market-venues.ts";
import {
  MAX_ZONE_GROUPS, evaluateZone, syncZoneStates, validateZoneAction, zoneFireMessage, type ZoneGroup, type ZoneSpec,
} from "./zones.ts";

/** TH-FEAT-16: current liquidation zones for a symbol (estimator snapshot + optional operator test fixture). */
export type ZoneSource = (symbol: string) => Promise<{ asOf: string | null; zones: ZoneSpec[]; decimals: number | null } | null>;

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
  loadZones?: ZoneSource;
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

  function recipientNow(): string | null {
    const settings = store.getSettings();
    return settings.verified && settings.email ? settings.email : null;
  }

  async function processZoneGroup(group: ZoneGroup, candle: MarketCandle, now: number): Promise<number> {
    let next: ZoneGroup = group;
    // Auto-sync on every poll: 刷新清算 / a new asOf replaces the zone list; unchanged zones keep their state.
    const loaded = deps.loadZones ? await deps.loadZones(group.symbol).catch(() => null) : null;
    if (loaded) next = { ...next, asOf: loaded.asOf, syncedAt: now, zones: syncZoneStates(next.zones, loaded.zones) };
    const decimals = loaded?.decimals ?? null;
    let fired = 0;
    const zones = [];
    for (const zone of next.zones) {
      const result = evaluateZone(zone, candle.close, now);
      zones.push(result.next);
      if (!result.fire) continue;
      const text = zoneFireMessage(group.symbol, group.venue, result.fire, decimals);
      const key = `zone:${group.id}:${zone.key}:${Math.floor(now / 60_000)}`;
      const recipient = recipientNow();
      const logId = store.appendLog({
        alertId: group.id, alertName: text.title, symbol: group.symbol, firedAt: now, barTime: candle.time,
        price: candle.close, message: text.message, emailStatus: recipient ? "queued" : "no-recipient",
      }, key);
      if (logId == null) continue;
      fired += 1;
      if (recipient) {
        const body = `${text.message}\n\nZone ${zone.role} ${zone.lo}–${zone.hi} · liq $${zone.liqM}M\nPrice: ${candle.close}\nZones as of: ${next.asOf ?? "n/a"}\nTime: ${new Date(now).toISOString()}`;
        const html = `<div style="font-family:system-ui,sans-serif"><p style="font-size:15px">${escapeHtml(text.message)}</p>`
          + `<p style="color:#555;font-size:13px">Zones as of ${escapeHtml(next.asOf ?? "n/a")}<br>${escapeHtml(new Date(now).toISOString())}</p></div>`;
        store.enqueueEmail("alert", key, logId, recipient, text.subject, body, html, now);
      }
    }
    next = { ...next, zones, firedCount: next.firedCount + fired, lastFiredAt: fired ? now : next.lastFiredAt };
    store.saveZoneGroup(next);
    return fired;
  }

  async function tick(): Promise<{ evaluated: number; fired: number }> {
    if (ticking) return { evaluated: 0, fired: 0 };
    ticking = true;
    let evaluated = 0;
    let fired = 0;
    try {
      const groups = new Map<string, { venue: MarketVenue; symbol: string; interval: ChartInterval; alerts: AlertRecord[]; zoneGroups: ZoneGroup[] }>();
      const slot = (venue: MarketVenue, symbol: string, interval: ChartInterval) => {
        const key = `${venue}:${symbol}:${interval}`;
        let entry = groups.get(key);
        if (!entry) { entry = { venue, symbol, interval, alerts: [], zoneGroups: [] }; groups.set(key, entry); }
        return entry;
      };
      for (const alert of store.activeAlerts()) slot(alert.venue, alert.symbol, alert.interval).alerts.push(alert);
      // Zone alerts watch the live price of the 1m forming candle.
      for (const group of store.listZoneGroups()) slot(group.venue, group.symbol, "1").zoneGroups.push(group);
      for (const { venue, symbol, interval, alerts, zoneGroups } of groups.values()) {
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
        for (const group of zoneGroups) {
          evaluated += 1;
          fired += await processZoneGroup(group, forming, now);
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

  function publicZoneGroup(g: ZoneGroup) {
    return {
      id: g.id, symbol: g.symbol, venue: g.venue, createdAt: g.createdAt, asOf: g.asOf, firedCount: g.firedCount, lastFiredAt: g.lastFiredAt,
      zones: g.zones.map((z) => ({ role: z.role, lo: z.lo, hi: z.hi, liqM: z.liqM, armed: z.armed, phase: z.phase, firedCount: z.firedCount, test: z.test === true })),
    };
  }

  function listAlerts(): ServiceResult {
    return ok({ alerts: store.listAlerts(), zoneGroups: store.listZoneGroups().map(publicZoneGroup) });
  }

  function listZoneGroups(): ServiceResult {
    return ok({ zoneGroups: store.listZoneGroups().map(publicZoneGroup) });
  }

  async function zoneAction(body: unknown): Promise<ServiceResult> {
    const parsed = validateZoneAction(body, isMarketVenue);
    if (!parsed.ok) return bad(400, parsed.error);
    const { action, symbol, venue } = parsed.value;
    const existing = store.findZoneGroup(symbol, venue);
    if (action === "disable") {
      if (!existing) return bad(404, "Zone alerts are not enabled for this symbol.");
      store.deleteZoneGroup(existing.id);
      return ok({ deleted: existing.id });
    }
    if (existing) return ok({ zoneGroup: publicZoneGroup(existing) });
    if (store.countZoneGroups() >= MAX_ZONE_GROUPS) return bad(409, `At most ${MAX_ZONE_GROUPS} zone alert groups.`);
    const loaded = deps.loadZones ? await deps.loadZones(symbol).catch(() => null) : null;
    if (!loaded || !loaded.zones.length) return bad(409, "No liquidation zones for this symbol yet (refresh 刷新清算 first).");
    const now = deps.now();
    // Zones start unobserved: the first poll records where price is, so a zone price is already inside never fires.
    const group: ZoneGroup = { id: deps.randomId(), symbol, venue, createdAt: now, asOf: loaded.asOf, syncedAt: now, zones: syncZoneStates([], loaded.zones), firedCount: 0, lastFiredAt: null };
    if (!store.insertZoneGroup(group)) return bad(409, "Zone alerts are already enabled.");
    return { status: 201, body: { ok: true, zoneGroup: publicZoneGroup(group) } };
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

  return { tick, pump, listAlerts, createAlert, alertAction, listLog, getSettings, updateSettings, listZoneGroups, zoneAction };
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
