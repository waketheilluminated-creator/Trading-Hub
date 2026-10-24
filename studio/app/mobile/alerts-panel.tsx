"use client";

import { useEffect, useRef } from "react";
import {
  alertCondition,
  displayStatus,
  formatAlertClock,
  intervalLabel,
  visibleAlerts,
  type AlertDraft,
  type AlertKind,
  type AlertListState,
  type AlertSegment,
  type GlobalAlert,
} from "@/lib/mobile/alerts.ts";
import type { ChartInterval } from "@/lib/market-venues.ts";

const KINDS: { id: AlertKind; label: string }[] = [
  { id: "trendline", label: "Trendline" },
  { id: "horizontal", label: "Horizontal" },
  { id: "ray", label: "Ray" },
  { id: "rectangle", label: "Rectangle" },
  { id: "liq", label: "Liquidation" },
];

const EXPIRY = [
  { id: "none", label: "None", ms: null },
  { id: "1d", label: "1d", ms: 86_400_000 },
  { id: "7d", label: "7d", ms: 7 * 86_400_000 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000 },
] as const;

function expiryId(alert: GlobalAlert, now: number): string {
  if (alert.expiresAt == null) return "none";
  const left = alert.expiresAt - now;
  const match = EXPIRY.find((item) => item.ms != null && Math.abs(item.ms - left) < 60_000);
  return match?.id ?? "none";
}

function AlertGlyph({ kind }: { kind: AlertKind }) {
  const label = kind === "liq" ? "Liquidation" : kind;
  switch (kind) {
    case "trendline":
      return <span className="m-glyph" aria-label={label}>↗</span>;
    case "horizontal":
      return <span className="m-glyph" aria-label={label}>—</span>;
    case "ray":
      return <span className="m-glyph" aria-label={label}>•—</span>;
    case "rectangle":
      return <span className="m-glyph" aria-label={label}>□</span>;
    case "liq":
      return <span className="m-glyph m-glyph-liq" aria-label={label}>▣</span>;
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

export function AlertsPanel(props: {
  book: AlertListState;
  symbols: readonly string[];
  intervals: readonly { id: ChartInterval; label: string }[];
  symbolChoices: readonly string[];
  filterSymbol: string;
  segment: AlertSegment;
  settingsOpen: boolean;
  notifyOn: boolean;
  soundOn: boolean;
  now: number;
  onFilterSymbol: (symbol: string) => void;
  onSegment: (segment: AlertSegment) => void;
  onToggleSettings: () => void;
  onToggleNotify: () => void;
  onToggleSound: () => void;
  onTestSound: () => void;
  onCreate: () => void;
  onExpand: (id: string) => void;
  onChange: (next: GlobalAlert) => void;
  onSave: () => void;
  onCancel: () => void;
  onPause: (id: string) => void;
  onDelete: (id: string) => void;
  onShowChart: (alert: GlobalAlert) => void;
}) {
  const rows = visibleAlerts(props.book, props.filterSymbol, props.segment);
  const chipSymbols = [...new Set([...props.symbols, ...rows.map((alert) => alert.symbol)])];
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-alert-expanded='true']")?.scrollIntoView({ block: "nearest" });
  }, [props.book.expandedId]);
  return (
    <div className="m-panel m-alerts" aria-label="Alerts">
      <div className="m-alert-head">
        <button type="button" className="m-tool" aria-label="Create alert" onClick={props.onCreate}>+</button>
        <div className="m-scroll" role="group" aria-label="Alert symbols">
          <button type="button" className={`m-chip ${props.filterSymbol === "ALL" ? "is-on" : ""}`} aria-pressed={props.filterSymbol === "ALL"} onClick={() => props.onFilterSymbol("ALL")}>All</button>
          {chipSymbols.map((symbol) => (
            <button key={symbol} type="button" className={`m-chip ${props.filterSymbol === symbol ? "is-on" : ""}`} aria-pressed={props.filterSymbol === symbol} onClick={() => props.onFilterSymbol(symbol)}>{symbol}</button>
          ))}
        </div>
        <button type="button" className={`m-tool ${props.settingsOpen ? "is-on" : ""}`} aria-label="Alert settings" aria-expanded={props.settingsOpen} onClick={props.onToggleSettings}>⚙</button>
      </div>
      {props.settingsOpen && (
        <div className="m-settings" role="dialog" aria-label="Alert settings">
          <div className="m-switch">
            <span>Notifications</span>
            <button type="button" className={`m-switch-btn ${props.notifyOn ? "is-on" : ""}`} aria-pressed={props.notifyOn} aria-label="iPhone notifications" onClick={props.onToggleNotify}>{props.notifyOn ? "On" : "Off"}</button>
          </div>
          <div className="m-switch">
            <span>Sound</span>
            <button type="button" className={`m-switch-btn ${props.soundOn ? "is-on" : ""}`} aria-pressed={props.soundOn} aria-label="Audible alert sound" onClick={props.onToggleSound}>{props.soundOn ? "On" : "Off"}</button>
          </div>
          <button type="button" className="m-chime" data-action="test-chime" onClick={props.onTestSound}>Test Sound</button>
        </div>
      )}
      <div className="m-segment" role="group" aria-label="Alert segment">
        <button type="button" className={props.segment === "active" ? "is-on" : ""} aria-pressed={props.segment === "active"} aria-label="Active alerts" onClick={() => props.onSegment("active")}>Active</button>
        <button type="button" className={props.segment === "triggered" ? "is-on" : ""} aria-pressed={props.segment === "triggered"} aria-label="Triggered alerts" onClick={() => props.onSegment("triggered")}>Triggered</button>
      </div>
      <div ref={listRef} className="m-alert-list" role="list" aria-label="Alert list">
        {rows.length === 0 && <p className="m-empty-copy">No alerts</p>}
        {rows.map((alert) => {
          const expanded = alert.id === props.book.expandedId;
          const editing = expanded ? (props.book.draft?.id === alert.id ? props.book.draft : props.book.edit ?? alert) : alert;
          if (!expanded) {
            const status = displayStatus(alert, props.now);
            return (
              <div key={alert.id} className="m-arow" role="listitem" data-symbol={alert.symbol} data-kind={alert.kind}>
                <button type="button" className="m-arow-main" onClick={() => props.onExpand(alert.id)} aria-label={`${alert.symbol} ${alert.kind} ${alertCondition(alert)} ${intervalLabel(alert.interval)} ${status}`}>
                  <AlertGlyph kind={alert.kind} />
                  <b>{alert.symbol}</b>
                  <span className="m-arow-cond">{alertCondition(alert)}</span>
                  <span>{intervalLabel(alert.interval)}</span>
                  <span className={`m-status m-status-${status}`}>{status}</span>
                  <time dateTime={alert.lastTriggeredAt ? new Date(alert.lastTriggeredAt).toISOString() : undefined}>{formatAlertClock(alert.lastTriggeredAt)}</time>
                </button>
                <button type="button" className="m-tool" aria-label={alert.paused ? "Resume alert" : "Pause alert"} onClick={() => props.onPause(alert.id)}>{alert.paused ? "▶" : "⏸"}</button>
                <button type="button" className="m-tool" aria-label="Delete alert" onClick={() => props.onDelete(alert.id)}>✕</button>
              </div>
            );
          }
          return (
            <form key={alert.id} className="m-acard" role="listitem" data-alert-expanded="true" data-symbol={editing.symbol} aria-label="Alert editor" onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
              <div className="m-acard-top">
                <AlertGlyph kind={editing.kind} />
                <strong>{(editing as AlertDraft).unsaved ? "New alert" : editing.symbol}</strong>
              </div>
              <label className="m-field">Symbol
                <select aria-label="Alert symbol" value={editing.symbol} onChange={(event) => props.onChange({ ...editing, symbol: event.target.value })}>
                  {props.symbolChoices.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                </select>
              </label>
              <label className="m-field">Type
                <select aria-label="Alert type" value={editing.kind} onChange={(event) => props.onChange(changeKind(editing, event.target.value as AlertKind))}>
                  {KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
                </select>
              </label>
              <label className="m-field">Timeframe
                <select aria-label="Alert timeframe" value={editing.interval} onChange={(event) => props.onChange({ ...editing, interval: event.target.value as ChartInterval })}>
                  {props.intervals.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              {editing.kind === "rectangle" ? (
                <div className="m-field-row">
                  <label className="m-field">Low
                    <input aria-label="Alert low" inputMode="decimal" value={editing.lo ?? ""} onChange={(event) => props.onChange(changeBand(editing, "lo", event.target.value))} />
                  </label>
                  <label className="m-field">High
                    <input aria-label="Alert high" inputMode="decimal" value={editing.hi ?? ""} onChange={(event) => props.onChange(changeBand(editing, "hi", event.target.value))} />
                  </label>
                </div>
              ) : editing.kind === "liq" ? (
                <p className="m-empty-copy">{alertCondition(editing)}</p>
              ) : (
                <label className="m-field">Level
                  <input aria-label="Alert level" inputMode="decimal" value={editing.level || ""} onChange={(event) => props.onChange(changeLevel(editing, event.target.value))} />
                </label>
              )}
              <div className="m-segment" role="group" aria-label="Trigger mode">
                <button type="button" className={editing.triggerMode === "once" ? "is-on" : ""} aria-pressed={editing.triggerMode === "once"} aria-label="Trigger once" onClick={() => props.onChange({ ...editing, triggerMode: "once" })}>Once</button>
                <button type="button" className={editing.triggerMode === "every" ? "is-on" : ""} aria-pressed={editing.triggerMode === "every"} aria-label="Trigger every time" onClick={() => props.onChange({ ...editing, triggerMode: "every" })}>Every</button>
              </div>
              <div className="m-switch">
                <span>Sound</span>
                <button type="button" className={`m-switch-btn ${editing.sound ? "is-on" : ""}`} aria-pressed={editing.sound} aria-label="Alert sound" onClick={() => props.onChange({ ...editing, sound: !editing.sound })}>{editing.sound ? "On" : "Off"}</button>
              </div>
              <div className="m-switch">
                <span>Notification</span>
                <button type="button" className={`m-switch-btn ${editing.notify ? "is-on" : ""}`} aria-pressed={editing.notify} aria-label="Alert notification" onClick={() => props.onChange({ ...editing, notify: !editing.notify })}>{editing.notify ? "On" : "Off"}</button>
              </div>
              <label className="m-field">Expiry
                <select aria-label="Expiry" value={expiryId(editing, props.now)} onChange={(event) => props.onChange(changeExpiry(editing, event.target.value, props.now))}>
                  {EXPIRY.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <div className="m-acard-actions">
                <button type="submit" className="m-chime">Save</button>
                <button type="button" className="m-text-btn" onClick={props.onCancel}>Cancel</button>
                {!(editing as AlertDraft).unsaved && (
                  <button type="button" className="m-text-btn" aria-label="Show on chart" onClick={() => props.onShowChart(editing)}>Show on chart</button>
                )}
              </div>
            </form>
          );
        })}
      </div>
    </div>
  );
}

function changeLevel(alert: GlobalAlert, raw: string): GlobalAlert {
  const level = Number(raw);
  if (!Number.isFinite(level)) return { ...alert, level: 0 };
  if (alert.kind === "trendline" && alert.b) return { ...alert, level, b: { ...alert.b, price: level } };
  if (alert.kind === "horizontal" || alert.kind === "ray") return { ...alert, level };
  return { ...alert, level };
}

function changeBand(alert: GlobalAlert, edge: "lo" | "hi", raw: string): GlobalAlert {
  const value = Number(raw);
  const next = Number.isFinite(value) ? value : null;
  if (edge === "lo") return { ...alert, lo: next, level: next ?? alert.level };
  return { ...alert, hi: next };
}

function changeKind(alert: GlobalAlert, kind: AlertKind): GlobalAlert {
  if (kind === "rectangle") {
    const lo = alert.lo ?? alert.level;
    const hi = alert.hi ?? (alert.level > 0 ? alert.level * 1.01 : 0);
    return { ...alert, kind, lo, hi, level: lo };
  }
  if (kind === "liq") return { ...alert, kind };
  return { ...alert, kind };
}

function changeExpiry(alert: GlobalAlert, id: string, now: number): GlobalAlert {
  const match = EXPIRY.find((item) => item.id === id);
  if (!match || match.ms == null) return { ...alert, expiresAt: null };
  return { ...alert, expiresAt: now + match.ms };
}
