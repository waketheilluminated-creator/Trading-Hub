/** Browser-side helpers for /api/alerts (same-origin JSON). Never touches credentials. */
import type { AlertFrequency, AlertOperator, AlertRecord } from "./core.ts";

export type AlertLogEntry = { id: number; alertId: string; alertName: string; symbol: string; firedAt: number; barTime: number; price: number; message: string; emailStatus: string };
export type NotifySettingsView = { email: string | null; verified: boolean; codePending: boolean; lastTestAt: number | null };
export type SettingsResponse = { settings: NotifySettingsView; smtpConfigured: boolean; smtpReason: string | null; envPath: string };

export type ZoneGroupView = {
  id: string; symbol: string; venue: string; createdAt: number; asOf: string | null; firedCount: number; lastFiredAt: number | null;
  zones: { role: "support" | "resistance"; lo: number; hi: number; liqM: number; armed: boolean; phase: string | null; firedCount: number; test: boolean }[];
};
/** TH-FEAT-16 bell toggle label in the liq legend. */
export const ZONE_ALERT_LABEL = "价格触及支撑/阻力区时提醒";

export const OPERATOR_LABELS: Record<AlertOperator, string> = {
  crossing: "Crossing",
  crossing_up: "Crossing Up",
  crossing_down: "Crossing Down",
  greater_than: "Greater Than",
  less_than: "Less Than",
};
export const FREQUENCY_LABELS: Record<AlertFrequency, string> = {
  once: "Only Once",
  every: "Once Per Minute",
  bar_close: "Once Per Bar Close",
};
export const EMAIL_STATUS_LABELS: Record<string, string> = {
  queued: "Email queued", sent: "Email sent", retrying: "Email retrying", failed: "Email failed", capped: "Email skipped (hourly cap)", "no-recipient": "No verified email",
};

async function call<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const alertsApi = {
  list: () => call<{ alerts: AlertRecord[]; zoneGroups?: ZoneGroupView[]; engineRunning: boolean }>("/api/alerts"),
  zones: (action: "enable" | "disable", symbol: string, venue: string) => call<{ zoneGroup?: ZoneGroupView; deleted?: string }>("/api/alerts/zones", { method: "POST", body: { action, symbol, venue } }),
  create: (input: Record<string, unknown>) => call<{ alert: AlertRecord }>("/api/alerts", { method: "POST", body: input }),
  action: (id: string, action: "pause" | "resume" | "delete") => call<{ alert?: AlertRecord }>("/api/alerts/action", { method: "POST", body: { id, action } }),
  log: (after = 0, limit = 100) => call<{ log: AlertLogEntry[] }>(`/api/alerts/log?after=${after}&limit=${limit}`),
  settings: () => call<SettingsResponse>("/api/alerts/settings"),
  setEmail: (email: string) => call<{ settings: NotifySettingsView }>("/api/alerts/settings", { method: "POST", body: { action: "set", email } }),
  sendTest: () => call<{ settings: NotifySettingsView }>("/api/alerts/settings", { method: "POST", body: { action: "send-test" } }),
  verify: (code: string) => call<{ settings: NotifySettingsView }>("/api/alerts/settings", { method: "POST", body: { action: "verify", code } }),
  clear: () => call<{ settings: NotifySettingsView }>("/api/alerts/settings", { method: "POST", body: { action: "clear" } }),
};

export function describeAlert(alert: Pick<AlertRecord, "symbol" | "operator" | "level">): string {
  return `${alert.symbol} ${OPERATOR_LABELS[alert.operator]} ${alert.level}`;
}

/** Local datetime-local value (YYYY-MM-DDTHH:mm) for a timestamp. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
