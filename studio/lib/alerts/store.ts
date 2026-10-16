/**
 * SQLite persistence (node:sqlite, Node >= 22.13). One file outside the repo:
 *   ALERTS_DB_PATH or ~/.tradinghub/alerts.db (Windows: %USERPROFILE%\.tradinghub\alerts.db).
 * Tables: alerts, alert_log, outbox (UNIQUE dedupe_key), settings.
 */
import type { AlertRecord, AlertStatus } from "./core.ts";

type Statement = { run(...args: unknown[]): { changes: number | bigint }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
export type Db = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, venue TEXT NOT NULL, interval TEXT NOT NULL,
  operator TEXT NOT NULL, level REAL NOT NULL, frequency TEXT NOT NULL, expires_at INTEGER, message TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, fired_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER, last_fired_bar INTEGER, prev_price REAL, last_closed_bar INTEGER
);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL, alert_name TEXT NOT NULL, symbol TEXT NOT NULL,
  fired_at INTEGER NOT NULL, bar_time INTEGER NOT NULL, price REAL NOT NULL, message TEXT NOT NULL,
  email_status TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, log_id INTEGER,
  recipient TEXT NOT NULL, subject TEXT NOT NULL, text_body TEXT NOT NULL, html_body TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type AlertRow = {
  id: string; name: string; symbol: string; venue: string; interval: string; operator: string; level: number; frequency: string;
  expires_at: number | null; message: string; status: string; created_at: number; fired_count: number; last_fired_at: number | null;
  last_fired_bar: number | null; prev_price: number | null; last_closed_bar: number | null;
};

function toRecord(row: AlertRow): AlertRecord {
  return {
    id: row.id, name: row.name, symbol: row.symbol, venue: row.venue as AlertRecord["venue"], interval: row.interval as AlertRecord["interval"],
    operator: row.operator as AlertRecord["operator"], level: row.level, frequency: row.frequency as AlertRecord["frequency"],
    expiresAt: row.expires_at, message: row.message, status: row.status as AlertStatus, createdAt: row.created_at,
    firedCount: row.fired_count, lastFiredAt: row.last_fired_at, lastFiredBar: row.last_fired_bar, prevPrice: row.prev_price, lastClosedBar: row.last_closed_bar,
  };
}

export type LogEntry = { id: number; alertId: string; alertName: string; symbol: string; firedAt: number; barTime: number; price: number; message: string; emailStatus: string };
export type OutboxRow = { id: number; kind: string; dedupe_key: string; log_id: number | null; recipient: string; subject: string; text_body: string; html_body: string; status: string; attempts: number; next_attempt_at: number };

export type NotifySettings = { email: string | null; verified: boolean; codeHash: string | null; codeExpiresAt: number | null; codeAttempts: number; lastTestAt: number | null };

export function createAlertStore(db: Db) {
  db.exec(SCHEMA);
  const q = {
    insert: db.prepare(`INSERT INTO alerts (id,name,symbol,venue,interval,operator,level,frequency,expires_at,message,status,created_at,fired_count,last_fired_at,last_fired_bar,prev_price,last_closed_bar)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    update: db.prepare(`UPDATE alerts SET status=?, fired_count=?, last_fired_at=?, last_fired_bar=?, prev_price=?, last_closed_bar=? WHERE id=?`),
    list: db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC`),
    get: db.prepare(`SELECT * FROM alerts WHERE id=?`),
    active: db.prepare(`SELECT * FROM alerts WHERE status='active'`),
    countActive: db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE status IN ('active','paused')`),
    setStatus: db.prepare(`UPDATE alerts SET status=? WHERE id=?`),
    remove: db.prepare(`DELETE FROM alerts WHERE id=?`),
    log: db.prepare(`INSERT OR IGNORE INTO alert_log (alert_id,alert_name,symbol,fired_at,bar_time,price,message,email_status,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?)`),
    logList: db.prepare(`SELECT * FROM alert_log WHERE id > ? ORDER BY id DESC LIMIT ?`),
    logStatus: db.prepare(`UPDATE alert_log SET email_status=? WHERE id=?`),
    enqueue: db.prepare(`INSERT OR IGNORE INTO outbox (kind,dedupe_key,log_id,recipient,subject,text_body,html_body,status,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,'pending',0,?,?)`),
    recordSent: db.prepare(`INSERT INTO outbox (kind,dedupe_key,log_id,recipient,subject,text_body,html_body,status,attempts,next_attempt_at,created_at,sent_at) VALUES (?,?,NULL,?,?,'','','sent',1,?,?,?)`),
    due: db.prepare(`SELECT * FROM outbox WHERE status='pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`),
    claim: db.prepare(`UPDATE outbox SET status='sending', attempts=attempts+1 WHERE id=? AND status='pending'`),
    sent: db.prepare(`UPDATE outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?`),
    retry: db.prepare(`UPDATE outbox SET status='pending', next_attempt_at=?, last_error=? WHERE id=?`),
    fail: db.prepare(`UPDATE outbox SET status=?, last_error=? WHERE id=?`),
    sentSince: db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE (status='sent' AND sent_at >= ?) OR status='sending'`),
    resetSending: db.prepare(`UPDATE outbox SET status='pending' WHERE status='sending'`),
    getSetting: db.prepare(`SELECT value FROM settings WHERE key=?`),
    setSetting: db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
  };
  // A crash mid-send leaves rows in 'sending'; requeue them (dedupe_key keeps it to one message per fire).
  q.resetSending.run();

  return {
    insertAlert(a: AlertRecord) {
      q.insert.run(a.id, a.name, a.symbol, a.venue, a.interval, a.operator, a.level, a.frequency, a.expiresAt, a.message, a.status, a.createdAt, a.firedCount, a.lastFiredAt, a.lastFiredBar, a.prevPrice, a.lastClosedBar);
    },
    saveAlert(a: AlertRecord) {
      q.update.run(a.status, a.firedCount, a.lastFiredAt, a.lastFiredBar, a.prevPrice, a.lastClosedBar, a.id);
    },
    listAlerts: (): AlertRecord[] => (q.list.all() as AlertRow[]).map(toRecord),
    getAlert: (id: string): AlertRecord | null => { const row = q.get.get(id) as AlertRow | undefined; return row ? toRecord(row) : null; },
    activeAlerts: (): AlertRecord[] => (q.active.all() as AlertRow[]).map(toRecord),
    countLive: (): number => Number((q.countActive.get() as { n: number }).n),
    setStatus: (id: string, status: AlertStatus): boolean => Number(q.setStatus.run(status, id).changes) > 0,
    deleteAlert: (id: string): boolean => Number(q.remove.run(id).changes) > 0,
    /** Returns the new log id, or null when this dedupe key was already logged (duplicate fire). */
    appendLog(entry: Omit<LogEntry, "id">, dedupeKey: string): number | null {
      const result = q.log.run(entry.alertId, entry.alertName, entry.symbol, entry.firedAt, entry.barTime, entry.price, entry.message, entry.emailStatus, dedupeKey);
      if (Number(result.changes) === 0) return null;
      return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    },
    listLog(afterId = 0, limit = 100): LogEntry[] {
      return (q.logList.all(afterId, Math.min(500, Math.max(1, limit))) as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id), alertId: String(r.alert_id), alertName: String(r.alert_name), symbol: String(r.symbol), firedAt: Number(r.fired_at),
        barTime: Number(r.bar_time), price: Number(r.price), message: String(r.message), emailStatus: String(r.email_status),
      }));
    },
    setLogEmailStatus: (logId: number, status: string) => { q.logStatus.run(status, logId); },
    enqueueEmail(kind: "alert" | "test", dedupeKey: string, logId: number | null, recipient: string, subject: string, text: string, html: string, now: number): boolean {
      return Number(q.enqueue.run(kind, dedupeKey, logId, recipient, subject, text, html, now, now).changes) > 0;
    },
    /** Directly-sent mail (test email) still counts toward the global hourly cap. */
    recordSent: (kind: string, dedupeKey: string, recipient: string, subject: string, now: number) => { q.recordSent.run(kind, dedupeKey, recipient, subject, now, now, now); },
    dueEmails: (now: number, limit = 10): OutboxRow[] => q.due.all(now, limit) as OutboxRow[],
    claimEmail: (id: number): boolean => Number(q.claim.run(id).changes) > 0,
    markSent: (id: number, now: number) => { q.sent.run(now, id); },
    markRetry: (id: number, at: number, error: string) => { q.retry.run(at, error.slice(0, 200), id); },
    markFailed: (id: number, status: "failed" | "suppressed", error: string) => { q.fail.run(status, error.slice(0, 200), id); },
    sentInWindow: (since: number): number => Number((q.sentSince.get(since) as { n: number }).n),
    getSettings(): NotifySettings {
      const raw = q.getSetting.get("notify") as { value: string } | undefined;
      const base: NotifySettings = { email: null, verified: false, codeHash: null, codeExpiresAt: null, codeAttempts: 0, lastTestAt: null };
      if (!raw) return base;
      try { return { ...base, ...(JSON.parse(raw.value) as Partial<NotifySettings>) }; } catch { return base; }
    },
    setSettings: (s: NotifySettings) => { q.setSetting.run("notify", JSON.stringify(s)); },
    close: () => db.close(),
  };
}

export type AlertStore = ReturnType<typeof createAlertStore>;
