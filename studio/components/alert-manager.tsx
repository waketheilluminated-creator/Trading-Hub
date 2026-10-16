"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AlertRecord } from "@/lib/alerts/core.ts";
import { EMAIL_STATUS_LABELS, FREQUENCY_LABELS, alertsApi, describeAlert, type AlertLogEntry } from "@/lib/alerts/client.ts";

const POLL_MS = 5_000;
const TOAST_MS = 12_000;

export type AlertToast = { key: number; title: string; body: string };

/** Polls the server-side engine: alerts list, fire log, and toasts for fires that happen while the page is open. */
export function useAlertFeed() {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [log, setLog] = useState<AlertLogEntry[]>([]);
  const [engineRunning, setEngineRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const lastId = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, entries] = await Promise.all([alertsApi.list(), alertsApi.log(0, 100)]);
      setAlerts(list.alerts); setEngineRunning(list.engineRunning); setLog(entries.log); setError(null);
      const newest = entries.log[0]?.id ?? 0;
      if (lastId.current != null) {
        const fresh = entries.log.filter((e) => e.id > (lastId.current as number)).reverse();
        if (fresh.length) {
          setToasts((items) => [...items, ...fresh.map((e) => ({ key: e.id, title: e.alertName, body: e.message }))].slice(-4));
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            for (const e of fresh) new Notification(e.alertName, { body: e.message });
          }
        }
      }
      lastId.current = Math.max(newest, lastId.current ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : "Alerts unavailable"); }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = window.setTimeout(() => setToasts((items) => items.slice(1)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  const dismiss = (key: number) => setToasts((items) => items.filter((t) => t.key !== key));
  return { alerts, log, engineRunning, error, toasts, refresh, dismiss };
}

export function AlertToasts({ toasts, onDismiss }: { toasts: AlertToast[]; onDismiss: (key: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="alert-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div className="alert-toast" role="status" key={t.key} data-alert-toast>
          <span aria-hidden="true">◷</span><div><strong>{t.title}</strong><p>{t.body}</p></div>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(t.key)}>×</button>
        </div>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { active: "Active", paused: "Paused", stopped: "Triggered", expired: "Expired" };

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Side-panel alert manager: Alerts tab (pause/resume/delete) and Log tab. */
export function AlertManager({ feed, onCreate }: { feed: ReturnType<typeof useAlertFeed>; onCreate: () => void }) {
  const [tab, setTab] = useState<"alerts" | "log">("alerts");
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, action: "pause" | "resume" | "delete") => {
    setBusy(id);
    try { await alertsApi.action(id, action); await feed.refresh(); } catch { /* surfaced on next poll */ } finally { setBusy(null); }
  };
  return (
    <div className="alert-manager" data-alert-manager>
      <div className="alert-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "alerts"} className={tab === "alerts" ? "active" : ""} onClick={() => setTab("alerts")}>Alerts {feed.alerts.length ? `(${feed.alerts.length})` : ""}</button>
        <button role="tab" aria-selected={tab === "log"} className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>Log {feed.log.length ? `(${feed.log.length})` : ""}</button>
      </div>
      {feed.error && <div className="alert-hint negative">{feed.error}</div>}
      {feed.engineRunning === false && <div className="alert-hint">Alert engine is off on this machine (ALERTS_ENGINE≠1). Alerts are saved but only fire on the alert host.</div>}
      {tab === "alerts" ? (
        <>
          {feed.alerts.length === 0 && <div className="alert-hint">No alerts yet.</div>}
          {feed.alerts.map((alert) => (
            <div className="alert-row" key={alert.id} data-alert-row={alert.status}>
              <div className="alert-copy">
                <strong>{alert.name}</strong>
                <span>{describeAlert(alert)} · {FREQUENCY_LABELS[alert.frequency]} · <em className={`alert-status-${alert.status}`}>{STATUS_LABEL[alert.status]}</em>{alert.firedCount ? ` · fired ${alert.firedCount}×` : ""}</span>
              </div>
              <div className="alert-actions">
                {alert.status === "active" && <button className="tool-button" disabled={busy === alert.id} title="Pause" aria-label={`Pause ${alert.name}`} onClick={() => void act(alert.id, "pause")}>❚❚</button>}
                {(alert.status === "paused" || alert.status === "stopped") && <button className="tool-button" disabled={busy === alert.id} title="Restart" aria-label={`Restart ${alert.name}`} onClick={() => void act(alert.id, "resume")}>▶</button>}
                <button className="tool-button" disabled={busy === alert.id} title="Delete" aria-label={`Delete ${alert.name}`} onClick={() => void act(alert.id, "delete")}>×</button>
              </div>
            </div>
          ))}
          <button className="add-alert" onClick={onCreate}>＋ Create alert</button>
        </>
      ) : (
        <>
          {feed.log.length === 0 && <div className="alert-hint">No alerts have fired yet.</div>}
          {feed.log.map((entry) => (
            <div className="alert-log-row" key={entry.id} data-alert-log>
              <div className="alert-log-head"><strong>{entry.alertName}</strong><time>{fmtTime(entry.firedAt)}</time></div>
              <p>{entry.message}</p>
              <span className={`alert-email-${entry.emailStatus}`}>{entry.symbol} @ {entry.price} · {EMAIL_STATUS_LABELS[entry.emailStatus] ?? entry.emailStatus}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
