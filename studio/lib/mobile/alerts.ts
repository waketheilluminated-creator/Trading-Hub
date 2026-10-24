/**
 * Global mobile alerts: one list for every symbol and timeframe.
 * Persisted in localStorage. Evaluation is pure and covers symbols that are not on screen.
 */
import { CHART_INTERVALS, type ChartInterval } from "../market-venues.ts";
import type { MobileDrawing } from "./drawings.ts";
import {
  MOBILE_TOUCH_COOLDOWN_MS,
  evaluateTouches,
  formatAlertPrice,
  type CooldownBook,
  type MobileLiqBox,
  type TouchBar,
  type TouchFire,
} from "./touch.ts";

export const MOBILE_ALERTS_KEY = "th-mobile-alerts:v1";
export const MOBILE_ALERT_POLL_MS = 20_000;

export type AlertKind = "trendline" | "horizontal" | "ray" | "rectangle" | "liq";
export type AlertStatus = "active" | "triggered" | "paused";
export type TriggerMode = "once" | "every";
export type AlertSegment = "active" | "triggered";
export type PriceBand = { lo: number; hi: number };
export type AlertPoint = { time: number; price: number };

export type GlobalAlert = {
  id: string;
  symbol: string;
  interval: ChartInterval;
  kind: AlertKind;
  paused: boolean;
  triggerMode: TriggerMode;
  sound: boolean;
  notify: boolean;
  expiresAt: number | null;
  createdAt: number;
  lastTriggeredAt: number | null;
  level: number;
  lo: number | null;
  hi: number | null;
  drawingId: string | null;
  a: AlertPoint | null;
  b: AlertPoint | null;
  anchorTime: number | null;
  ray: boolean;
  support: PriceBand | null;
  resistance: PriceBand | null;
};

export type AlertDraft = GlobalAlert & { unsaved: true };

export type AlertListState = {
  alerts: GlobalAlert[];
  draft: AlertDraft | null;
  edit: GlobalAlert | null;
  expandedId: string | null;
};

export type AlertQuote = { prev: TouchBar | null; bar: TouchBar };

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const KINDS = new Set<AlertKind>(["trendline", "horizontal", "ray", "rectangle", "liq"]);
const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;

const INTERVAL_LABEL: Record<ChartInterval, string> = {
  "1": "1m",
  "5": "5m",
  "15": "15m",
  "30": "30m",
  "60": "1h",
  "240": "4h",
  D: "1D",
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInterval(value: unknown): value is ChartInterval {
  return typeof value === "string" && (CHART_INTERVALS as readonly string[]).includes(value);
}

function isKind(value: unknown): value is AlertKind {
  return typeof value === "string" && KINDS.has(value as AlertKind);
}

function isPoint(value: unknown): value is AlertPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return finite(point.time) && finite(point.price);
}

function isBand(value: unknown): value is PriceBand {
  if (!value || typeof value !== "object") return false;
  const band = value as Record<string, unknown>;
  return finite(band.lo) && finite(band.hi) && band.hi > band.lo;
}

function emptyGeometry(): Pick<GlobalAlert, "a" | "b" | "anchorTime" | "ray" | "support" | "resistance" | "lo" | "hi" | "drawingId"> {
  return { a: null, b: null, anchorTime: null, ray: false, support: null, resistance: null, lo: null, hi: null, drawingId: null };
}

export function quoteKey(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

export function intervalLabel(interval: ChartInterval): string {
  return INTERVAL_LABEL[interval];
}

export function displayStatus(alert: GlobalAlert, now: number): AlertStatus {
  if (alert.paused) return "paused";
  if (alert.expiresAt != null && now >= alert.expiresAt) return "paused";
  if (alert.triggerMode === "once" && alert.lastTriggeredAt != null) return "triggered";
  return "active";
}

export function alertCondition(alert: GlobalAlert): string {
  switch (alert.kind) {
    case "trendline":
      return `touch trendline @ ${formatAlertPrice(alert.level)}`;
    case "horizontal":
      return `touch horizontal @ ${formatAlertPrice(alert.level)}`;
    case "ray":
      return `touch ray @ ${formatAlertPrice(alert.level)}`;
    case "rectangle":
      return `touch rectangle ${formatAlertPrice(alert.lo ?? alert.level)}–${formatAlertPrice(alert.hi ?? alert.level)}`;
    case "liq": {
      const parts: string[] = [];
      if (alert.support) parts.push(`liq support ${formatAlertPrice(alert.support.lo)}–${formatAlertPrice(alert.support.hi)}`);
      if (alert.resistance) parts.push(`liq resistance ${formatAlertPrice(alert.resistance.lo)}–${formatAlertPrice(alert.resistance.hi)}`);
      return parts.length ? parts.join(" · ") : "liq zones";
    }
    default: {
      const neverKind: never = alert.kind;
      return neverKind;
    }
  }
}

export function centerPriceRange(level: number): { from: number; to: number } | null {
  if (!finite(level) || level <= 0) return null;
  const pad = level * 0.04;
  return { from: level - pad, to: level + pad };
}

function isSavable(alert: GlobalAlert): boolean {
  if (!SYMBOL_RE.test(alert.symbol) || !isInterval(alert.interval) || !isKind(alert.kind)) return false;
  if (alert.triggerMode !== "once" && alert.triggerMode !== "every") return false;
  if (alert.kind === "rectangle") return finite(alert.lo) && finite(alert.hi) && alert.hi > alert.lo;
  if (alert.kind === "liq") return finite(alert.level) && alert.level >= 0;
  return finite(alert.level) && alert.level > 0;
}

function normalize(value: unknown): GlobalAlert | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 80) return null;
  if (typeof raw.symbol !== "string" || !SYMBOL_RE.test(raw.symbol)) return null;
  if (!isInterval(raw.interval) || !isKind(raw.kind)) return null;
  if (raw.triggerMode !== "once" && raw.triggerMode !== "every") return null;
  if (typeof raw.paused !== "boolean" || typeof raw.sound !== "boolean" || typeof raw.notify !== "boolean") return null;
  if (!finite(raw.createdAt) || !finite(raw.level)) return null;
  if (raw.kind === "rectangle") {
    if (!finite(raw.lo) || !finite(raw.hi) || raw.hi <= raw.lo) return null;
  } else if (raw.kind !== "liq" && !(raw.level > 0)) return null;
  const alert: GlobalAlert = {
    id: raw.id,
    symbol: raw.symbol,
    interval: raw.interval,
    kind: raw.kind,
    paused: raw.paused,
    triggerMode: raw.triggerMode,
    sound: raw.sound,
    notify: raw.notify,
    expiresAt: finite(raw.expiresAt) ? raw.expiresAt : null,
    createdAt: raw.createdAt,
    lastTriggeredAt: finite(raw.lastTriggeredAt) ? raw.lastTriggeredAt : null,
    level: raw.level,
    lo: finite(raw.lo) ? raw.lo : null,
    hi: finite(raw.hi) ? raw.hi : null,
    drawingId: typeof raw.drawingId === "string" && raw.drawingId.length > 0 ? raw.drawingId : null,
    a: isPoint(raw.a) ? { time: raw.a.time, price: raw.a.price } : null,
    b: isPoint(raw.b) ? { time: raw.b.time, price: raw.b.price } : null,
    anchorTime: finite(raw.anchorTime) ? raw.anchorTime : null,
    ray: raw.ray === true,
    support: isBand(raw.support) ? { lo: raw.support.lo, hi: raw.support.hi } : null,
    resistance: isBand(raw.resistance) ? { lo: raw.resistance.lo, hi: raw.resistance.hi } : null,
  };
  return alert;
}

export function loadGlobalAlerts(storage: StorageLike): GlobalAlert[] {
  try {
    const raw = storage.getItem(MOBILE_ALERTS_KEY);
    if (raw == null) return [];
    const envelope = JSON.parse(raw) as { version?: unknown; alerts?: unknown };
    if (envelope.version !== 1 || !Array.isArray(envelope.alerts)) return [];
    return envelope.alerts.flatMap((row) => {
      const alert = normalize(row);
      return alert ? [alert] : [];
    });
  } catch {
    return [];
  }
}

export function saveGlobalAlerts(storage: StorageLike, alerts: readonly GlobalAlert[]): boolean {
  try {
    const clean = alerts.flatMap((alert) => {
      const normalized = normalize(alert);
      return normalized ? [normalized] : [];
    });
    storage.setItem(MOBILE_ALERTS_KEY, JSON.stringify({ version: 1, alerts: clean }));
    return true;
  } catch {
    return false;
  }
}

export function filterAlerts(alerts: readonly GlobalAlert[], symbol: string, segment: AlertSegment): GlobalAlert[] {
  return alerts.filter((alert) => {
    if (symbol !== "ALL" && alert.symbol !== symbol) return false;
    const triggered = alert.lastTriggeredAt != null;
    if (segment === "triggered") return triggered;
    return displayStatus(alert, Number.POSITIVE_INFINITY) !== "triggered";
  });
}

export function visibleAlerts(state: AlertListState, symbol: string, segment: AlertSegment): Array<GlobalAlert & { unsaved?: true }> {
  const saved = filterAlerts(state.alerts, symbol, segment);
  if (!state.draft) return saved;
  return [state.draft, ...saved];
}

export function blankDraft(symbol: string, interval: ChartInterval, level: number, now: number): AlertDraft {
  return {
    id: `new:${now}`,
    symbol,
    interval,
    kind: "horizontal",
    paused: false,
    triggerMode: "every",
    sound: true,
    notify: true,
    expiresAt: null,
    createdAt: now,
    lastTriggeredAt: null,
    level,
    ...emptyGeometry(),
    unsaved: true,
  };
}

export function liqDraft(symbol: string, interval: ChartInterval, level: number, now: number): AlertDraft {
  return { ...blankDraft(symbol, interval, level, now), id: `liq:${symbol}`, kind: "liq", drawingId: null };
}

export function draftFromDrawing(symbol: string, interval: ChartInterval, drawing: MobileDrawing, now: number): AlertDraft | null {
  const base = blankDraft(symbol, interval, 0, now);
  const id = `draw:${drawing.id}`;
  switch (drawing.type) {
    case "trend-line":
      return { ...base, id, kind: "trendline", level: drawing.b.price, drawingId: drawing.id, a: drawing.a, b: drawing.b, ray: drawing.ray };
    case "horizontal-line":
      return { ...base, id, kind: "horizontal", level: drawing.price, drawingId: drawing.id, anchorTime: drawing.time };
    case "horizontal-ray":
      return { ...base, id, kind: "ray", level: drawing.price, drawingId: drawing.id, anchorTime: drawing.time };
    case "rectangle": {
      const lo = Math.min(drawing.a.price, drawing.b.price);
      const hi = Math.max(drawing.a.price, drawing.b.price);
      return { ...base, id, kind: "rectangle", level: lo, lo, hi, drawingId: drawing.id, a: drawing.a, b: drawing.b };
    }
    case "long":
    case "short":
    case "price-range":
    case "text":
      return null;
    default: {
      const neverDrawing: never = drawing;
      return neverDrawing;
    }
  }
}

export function beginCreate(state: AlertListState, draft: AlertDraft): AlertListState {
  return { ...state, draft: { ...draft, unsaved: true }, edit: null, expandedId: draft.id };
}

export function expandAlert(state: AlertListState, id: string): AlertListState {
  const found = state.alerts.find((alert) => alert.id === id);
  if (!found) return state;
  return { ...state, draft: null, edit: { ...found }, expandedId: id };
}

export function openOrCreateLiq(state: AlertListState, symbol: string, interval: ChartInterval, level: number, now: number): AlertListState {
  const existing = state.alerts.find((alert) => alert.kind === "liq" && alert.symbol === symbol);
  if (existing) return expandAlert(state, existing.id);
  return beginCreate(state, liqDraft(symbol, interval, level, now));
}

export function updateExpanded(state: AlertListState, next: GlobalAlert): AlertListState {
  if (state.draft && state.draft.id === next.id) return { ...state, draft: { ...next, unsaved: true } };
  if (state.edit && state.edit.id === next.id) return { ...state, edit: { ...next } };
  return state;
}

function withoutUnsaved(alert: GlobalAlert): GlobalAlert {
  const next = { ...alert };
  delete (next as { unsaved?: true }).unsaved;
  return next;
}

function storedAlert(source: GlobalAlert): GlobalAlert {
  const saved = withoutUnsaved(source);
  if (saved.kind === "liq") return { ...saved, id: `liq:${saved.symbol}` };
  return saved;
}

export function saveExpanded(state: AlertListState): AlertListState {
  const source = state.draft ?? state.edit;
  if (!source || !isSavable(source)) return state;
  const saved = storedAlert(source);
  let rest = state.alerts.filter((alert) => alert.id !== source.id && alert.id !== saved.id);
  if (saved.kind === "liq") rest = rest.filter((alert) => !(alert.kind === "liq" && alert.symbol === saved.symbol));
  if (state.draft) return { alerts: [saved, ...rest], draft: null, edit: null, expandedId: null };
  const index = state.alerts.findIndex((alert) => alert.id === source.id);
  const at = index < 0 ? rest.length : Math.min(index, rest.length);
  const alerts = [...rest.slice(0, at), saved, ...rest.slice(at)];
  return { alerts, draft: null, edit: null, expandedId: null };
}

export function formatAlertClock(at: number | null): string {
  if (at == null) return "—";
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function cancelExpanded(state: AlertListState): AlertListState {
  return { ...state, draft: null, edit: null, expandedId: null };
}

export function pauseAlert(state: AlertListState, id: string): AlertListState {
  const alerts = state.alerts.map((alert) => (alert.id === id ? { ...alert, paused: !alert.paused } : alert));
  const edit = state.edit && state.edit.id === id ? { ...state.edit, paused: !state.edit.paused } : state.edit;
  return { ...state, alerts, edit };
}

export function deleteAlert(state: AlertListState, id: string): AlertListState {
  return {
    alerts: state.alerts.filter((alert) => alert.id !== id),
    draft: state.draft?.id === id ? null : state.draft,
    edit: state.edit?.id === id ? null : state.edit,
    expandedId: state.expandedId === id ? null : state.expandedId,
  };
}

export function withDrawingAlerts(drawings: readonly MobileDrawing[], alerts: readonly GlobalAlert[], symbol: string, interval: string): MobileDrawing[] {
  const ids = new Set(alerts.filter((alert) => alert.symbol === symbol && alert.interval === interval && alert.drawingId).map((alert) => alert.drawingId));
  return drawings.map((drawing) => ({ ...drawing, alert: ids.has(drawing.id) }));
}

function watching(alert: GlobalAlert, now: number): boolean {
  if (alert.paused) return false;
  if (alert.expiresAt != null && now >= alert.expiresAt) return false;
  if (alert.triggerMode === "once" && alert.lastTriggeredAt != null) return false;
  return true;
}

export function planAlertPolls(alerts: readonly GlobalAlert[], screenSymbol: string, screenInterval: string, now: number): { symbol: string; interval: ChartInterval }[] {
  const seen = new Set<string>();
  const pairs: { symbol: string; interval: ChartInterval }[] = [];
  for (const alert of alerts) {
    if (!watching(alert, now)) continue;
    const key = quoteKey(alert.symbol, alert.interval);
    if (seen.has(key)) continue;
    seen.add(key);
    if (alert.symbol === screenSymbol && alert.interval === screenInterval) continue;
    pairs.push({ symbol: alert.symbol, interval: alert.interval });
  }
  return pairs;
}

export function nearestLiqZones(boxes: readonly MobileLiqBox[], price: number): { support: PriceBand | null; resistance: PriceBand | null } {
  let support: PriceBand | null = null;
  let resistance: PriceBand | null = null;
  for (const box of boxes) {
    if (box.role === "support" && box.hi <= price && (!support || box.hi > support.hi)) support = { lo: box.lo, hi: box.hi };
    if (box.role === "resistance" && box.lo >= price && (!resistance || box.lo < resistance.lo)) resistance = { lo: box.lo, hi: box.hi };
  }
  return { support, resistance };
}

function asDrawing(alert: GlobalAlert) {
  const id = alert.drawingId ?? alert.id;
  switch (alert.kind) {
    case "trendline":
      return alert.a && alert.b ? { id, type: "trend-line", alert: true, ray: alert.ray, a: alert.a, b: alert.b } : null;
    case "horizontal":
      return { id, type: "horizontal-line", alert: true, price: alert.level, time: alert.anchorTime ?? 0 };
    case "ray":
      return { id, type: "horizontal-ray", alert: true, price: alert.level, time: alert.anchorTime ?? 0, dir: "right" as const };
    case "rectangle":
      return finite(alert.lo) && finite(alert.hi)
        ? { id, type: "rectangle", alert: true, a: alert.a ?? { time: 0, price: alert.lo }, b: alert.b ?? { time: 1e12, price: alert.hi } }
        : null;
    case "liq":
      return null;
    default: {
      const neverKind: never = alert.kind;
      return neverKind;
    }
  }
}

function cooled(book: CooldownBook, key: string, now: number): boolean {
  const last = book[key];
  return typeof last === "number" && now - last < MOBILE_TOUCH_COOLDOWN_MS;
}

export function evaluateAlertBook(input: {
  alerts: readonly GlobalAlert[];
  quotes: Readonly<Record<string, AlertQuote>>;
  zones: Readonly<Record<string, readonly MobileLiqBox[]>>;
  now: number;
  cooldown: CooldownBook;
}): { alerts: GlobalAlert[]; fired: { alert: GlobalAlert; event: TouchFire }[]; cooldown: CooldownBook } {
  const cooldown: CooldownBook = { ...input.cooldown };
  const fired: { alert: GlobalAlert; event: TouchFire }[] = [];
  const alerts = input.alerts.map((original) => {
    let alert = original;
    if (!watching(alert, input.now)) return alert;
    const quote = input.quotes[quoteKey(alert.symbol, alert.interval)];
    if (!quote) return alert;
    const events: TouchFire[] = [];
    if (alert.kind === "liq") {
      if (Object.prototype.hasOwnProperty.call(input.zones, alert.symbol)) {
        const nearest = nearestLiqZones(input.zones[alert.symbol], quote.bar.close);
        alert = { ...alert, support: nearest.support, resistance: nearest.resistance, level: quote.bar.close };
      }
      const zoneBoxes: MobileLiqBox[] = [];
      if (alert.support) zoneBoxes.push({ id: `liq:${alert.symbol}:support`, role: "support", lo: alert.support.lo, hi: alert.support.hi, risk: "高", liq_m: 1 });
      if (alert.resistance) zoneBoxes.push({ id: `liq:${alert.symbol}:resistance`, role: "resistance", lo: alert.resistance.lo, hi: alert.resistance.hi, risk: "极高", liq_m: 1 });
      events.push(...evaluateTouches({
        prev: quote.prev, bar: quote.bar, drawings: [], zones: zoneBoxes, cooldown: {}, now: input.now, cooldownMs: 0, alertsArmed: true,
      }).fired);
    } else {
      const drawing = asDrawing(alert);
      if (!drawing) return alert;
      events.push(...evaluateTouches({
        prev: quote.prev, bar: quote.bar, drawings: [drawing], zones: [], cooldown: {}, now: input.now, cooldownMs: 0, alertsArmed: true,
      }).fired);
    }
    let marked = false;
    for (const event of events) {
      const key = `alert:${alert.id}:${event.id}`;
      if (cooled(cooldown, key, input.now)) continue;
      cooldown[key] = input.now;
      fired.push({ alert, event });
      marked = true;
      if (alert.triggerMode === "once") break;
    }
    if (marked) alert = { ...alert, lastTriggeredAt: input.now };
    return alert;
  });
  return { alerts, fired, cooldown };
}
