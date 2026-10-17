"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ALERT_FREQUENCIES, ALERT_OPERATORS, DEFAULT_EXPIRY_MS, PLACEHOLDERS, defaultAlertMessage, type AlertFrequency, type AlertOperator } from "@/lib/alerts/core.ts";
import { FREQUENCY_LABELS, OPERATOR_LABELS, alertsApi, toLocalInput, type SettingsResponse } from "@/lib/alerts/client.ts";
import { venueLabel, type ChartInterval, type MarketVenue } from "@/lib/market-venues.ts";

type Props = {
  open: boolean;
  symbol: string;
  venue: MarketVenue;
  interval: ChartInterval;
  lastPrice: number | null;
  onClose: () => void;
  onCreated: () => void;
};

/** TradingView-style "Create alert" dialog: condition → level → trigger → expiration → name/message → notifications. */
export function AlertDialog({ open, symbol, venue, interval, lastPrice, onClose, onCreated }: Props) {
  if (!open) return null;
  return <AlertDialogBody key={`${symbol}:${venue}:${interval}`} symbol={symbol} venue={venue} interval={interval} lastPrice={lastPrice} onClose={onClose} onCreated={onCreated} />;
}

function AlertDialogBody({ symbol, venue, interval, lastPrice, onClose, onCreated }: Omit<Props, "open">) {
  const [operator, setOperator] = useState<AlertOperator>("crossing");
  const [level, setLevel] = useState(lastPrice ? String(lastPrice) : "");
  const [frequency, setFrequency] = useState<AlertFrequency>("once");
  const [expiry, setExpiry] = useState(() => toLocalInput(Date.now() + DEFAULT_EXPIRY_MS));
  const [openEnded, setOpenEnded] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const levelRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<() => void>(() => {});

  useEffect(() => {
    levelRef.current?.focus();
    levelRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    alertsApi.settings().then((s) => { if (live) setSettings(s); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const insertPlaceholder = (token: string) => {
    const el = messageRef.current;
    const text = message || defaultAlertMessage(operator);
    const at = el && message ? el.selectionStart : text.length;
    setMessage(`${text.slice(0, at)}{{${token}}}${text.slice(at)}`);
  };

  const submit = async () => {
    const value = Number(level);
    if (!Number.isFinite(value) || value <= 0) { setError("Enter a positive price."); return; }
    const expiresAt = openEnded ? null : new Date(expiry).getTime();
    if (expiresAt != null && !(expiresAt > Date.now())) { setError("Expiration must be in the future."); return; }
    setBusy(true); setError(null);
    try {
      await alertsApi.create({ symbol, venue, interval, operator, level: value, frequency, expiresAt, name, message });
      onCreated(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create alert."); }
    finally { setBusy(false); }
  };

  useEffect(() => { submitRef.current = () => void submit(); });

  const emailLine = !settings ? "Checking email…" : settings.settings.verified && settings.settings.email
    ? `Email → ${settings.settings.email}` : "Email off: verify 通知邮箱 in Settings";

  return (
    <>
      <button type="button" className="alert-dialog-backdrop" aria-label="Close alert dialog" tabIndex={-1} onClick={onClose} />
      <div className="alert-dialog" role="dialog" aria-modal="true" aria-label="Create alert" data-alert-dialog>
        <header><strong>Create alert on {symbol}</strong><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="alert-dialog-body">
          <label className="alert-field"><span>Condition</span>
            <div className="alert-field-row"><span className="alert-chip">{symbol} · {venueLabel(venue)} · {interval}</span>
              <select aria-label="Condition" value={operator} onChange={(e) => setOperator(e.target.value as AlertOperator)}>{ALERT_OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}</select></div>
          </label>
          <label className="alert-field"><span>Value</span><input aria-label="Alert price" inputMode="decimal" ref={levelRef} value={level} onChange={(e) => setLevel(e.target.value)} placeholder={lastPrice ? String(lastPrice) : "Price"} /></label>
          <div className="alert-field"><span>Trigger</span>
            <div className="alert-segment" role="radiogroup" aria-label="Trigger">{ALERT_FREQUENCIES.map((f) => <button type="button" role="radio" aria-checked={frequency === f} key={f} className={frequency === f ? "active" : ""} onClick={() => setFrequency(f)}>{FREQUENCY_LABELS[f]}</button>)}</div>
          </div>
          <div className="alert-field"><span>Expiration</span>
            <div className="alert-field-row"><input type="datetime-local" aria-label="Expiration" value={expiry} disabled={openEnded} onChange={(e) => setExpiry(e.target.value)} />
              <label className="alert-check"><input type="checkbox" checked={openEnded} onChange={(e) => setOpenEnded(e.target.checked)} /> Open-ended</label></div>
          </div>
          <label className="alert-field"><span>Alert name</span><input aria-label="Alert name" maxLength={80} value={name} placeholder={`${symbol} ${OPERATOR_LABELS[operator]} ${level || "…"}`} onChange={(e) => setName(e.target.value)} /></label>
          <label className="alert-field"><span>Message</span><textarea ref={messageRef} aria-label="Alert message" maxLength={1000} rows={3} value={message} placeholder={defaultAlertMessage(operator)} onChange={(e) => setMessage(e.target.value)} /></label>
          <div className="alert-placeholders" aria-label="Placeholders">{PLACEHOLDERS.map((p) => <button type="button" key={p} onClick={() => insertPlaceholder(p)}>{`{{${p}}}`}</button>)}</div>
          <div className="alert-field"><span>Notifications</span>
            <div className="alert-notify"><span>✓ In-app toast</span><span className={settings?.settings.verified ? "positive" : "muted"}>{emailLine}</span><Link prefetch={false} href="/settings">Settings</Link></div>
          </div>
          {error && <div className="alert-error" role="alert">{error}</div>}
        </div>
        <footer><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Creating…" : "Create"}</button></footer>
      </div>
    </>
  );
}
