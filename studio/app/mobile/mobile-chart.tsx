"use client";

/**
 * Page 1 of Trading Hub mobile: K-line chart, drawing tools, liquidation boxes, touch alerts.
 * Pine Script is intentionally not on this page.
 * Overlay toggles (showLiq, showDrawings, alertsOn) only swap primitive data — they never fit or rescale.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { fitChartView } from "@/lib/chart-fit.ts";
import { candleThemeOptions, chartThemeOptions } from "@/lib/chart-theme.ts";
import { LIQ_HEATMAP_POLL_MS, loadLiqHeatmapBands, requestLiqRefresh, type LiqBand, type LiqZone } from "@/lib/liq-heatmap.ts";
import { LiqHeatmapPrimitive } from "@/lib/liq-heatmap-primitive.ts";
import { inferTickFromCandles, precisionFromTick, priceFormatForTick } from "@/lib/price-precision.ts";
import { currentDocumentTheme, subscribeTheme } from "@/lib/theme.ts";
import { createMobileAlertSound, type MobileAlertSound } from "@/lib/mobile-alert-sound.ts";
import {
  applyTap,
  historyCommit,
  historyInit,
  historyRedo,
  historyUndo,
  hitMobileDrawing,
  loadMobileDrawings,
  saveMobileDrawings,
  type DrawingHistory,
  type HitPart,
  type MobileDraft,
  type MobileDrawing,
  type MobilePoint,
  type MobileTool,
} from "@/lib/mobile/drawings.ts";
import { MobileDrawingPrimitive, previewDrawing } from "@/lib/mobile/drawing-primitive.ts";
import {
  formatAlertPrice,
  selectMobileLiqBoxes,
  stackBadgeYs,
  type MobileLiqBox,
  type TouchFire,
} from "@/lib/mobile/touch.ts";
import {
  MOBILE_ALERT_POLL_MS,
  beginCreate,
  blankDraft,
  cancelExpanded,
  centerPriceRange,
  deleteAlert,
  draftFromDrawing,
  evaluateAlertBook,
  expandAlert,
  loadGlobalAlerts,
  openOrCreateLiq,
  pauseAlert,
  planAlertPolls,
  quoteKey,
  saveExpanded,
  saveGlobalAlerts,
  updateExpanded,
  withDrawingAlerts,
  type AlertListState,
  type AlertQuote,
  type AlertSegment,
  type GlobalAlert,
} from "@/lib/mobile/alerts.ts";
import { AlertsPanel } from "./alerts-panel.tsx";
import type { ChartInterval, MarketCandle, MarketVenue } from "@/lib/market-venues.ts";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "PYTHUSDT", "ZECUSDT"] as const;
const INTERVALS: { id: ChartInterval; label: string }[] = [
  { id: "1", label: "1m" },
  { id: "5", label: "5m" },
  { id: "15", label: "15m" },
  { id: "30", label: "30m" },
  { id: "60", label: "1h" },
  { id: "240", label: "4h" },
  { id: "D", label: "1D" },
];
const TOOLS: { id: MobileTool; label: string }[] = [
  { id: "select", label: "Select drawing" },
  { id: "rectangle", label: "Rectangle" },
  { id: "long", label: "Long position" },
  { id: "short", label: "Short position" },
  { id: "text", label: "Text annotation" },
  { id: "trend-line", label: "Trendline" },
  { id: "horizontal-line", label: "Horizontal line" },
  { id: "horizontal-ray", label: "Horizontal ray" },
  { id: "price-range", label: "Price range" },
  { id: "crosshair", label: "Crosshair" },
];

type FeedStatus = "loading" | "online" | "polling" | "error";
type TabId = "chart" | "alerts";
type Badge = { id: string; y: number; label: string; role: "support" | "resistance" };

const VENUES: MarketVenue[] = ["binance", "bybit", "okx", "bitget"];

function titleFor(symbol: string): string {
  return `${symbol.replace(/USDT$/, "")} / Tether PERPETUAL FUT…`;
}

function toCandle(candle: MarketCandle) {
  return {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function toLiqZone(box: MobileLiqBox, price: number): LiqZone {
  const mid = (box.lo + box.hi) / 2;
  return {
    lo: box.lo,
    hi: box.hi,
    role: box.role,
    liq_m: box.liq_m,
    risk_max: box.risk,
    dist_pct: price ? ((mid - price) / price) * 100 : 0,
    bucket_count: 2,
    side: box.role === "support" ? "long" : "short",
    band_idx: null,
  };
}

function notifyKind(target: TouchFire["target"]): "trendline" | "horizontal" | "ray" | "rectangle" | "liq-support" | "liq-resistance" {
  switch (target) {
    case "trendline": return "trendline";
    case "horizontal": return "horizontal";
    case "ray": return "ray";
    case "rectangle": return "rectangle";
    case "support": return "liq-support";
    case "resistance": return "liq-resistance";
    default: {
      const neverTarget: never = target;
      return neverTarget;
    }
  }
}

function movePoint(drawing: MobileDrawing, part: HitPart, point: MobilePoint): MobileDrawing {
  switch (drawing.type) {
    case "trend-line":
    case "rectangle":
    case "long":
    case "short":
    case "price-range": {
      if (part === "body") {
        const dt = point.time - drawing.a.time;
        const dp = point.price - drawing.a.price;
        return { ...drawing, a: point, b: { time: drawing.b.time + dt, price: drawing.b.price + dp } };
      }
      return part === "p0" ? { ...drawing, a: point } : { ...drawing, b: point };
    }
    case "horizontal-line":
      return { ...drawing, time: point.time, price: point.price };
    case "horizontal-ray":
      return { ...drawing, time: point.time, price: point.price };
    case "text":
      return { ...drawing, time: point.time, price: point.price };
    default: {
      const neverDrawing: never = drawing;
      return neverDrawing;
    }
  }
}

async function fetchCandles(symbol: string, interval: ChartInterval, limit: number, signal?: AbortSignal): Promise<{ candles: MarketCandle[]; venue: MarketVenue }> {
  let lastError = "No candles";
  for (const exchange of VENUES) {
    const response = await fetch(`/api/klines?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`, {
      signal, cache: "no-store", credentials: "same-origin",
    });
    const body = await response.json().catch(() => null) as { candles?: MarketCandle[]; error?: string } | null;
    if (response.ok && body?.candles?.length) return { candles: body.candles, venue: exchange };
    if (body?.error) lastError = body.error;
  }
  throw new Error(lastError);
}

function ToolGlyph({ tool }: { tool: MobileTool }) {
  const common = { width: 18, height: 18, viewBox: "0 0 18 18", fill: "none", "aria-hidden": true as const };
  switch (tool) {
    case "select":
      return <svg {...common}><path d="M4 2.5 14 9.2l-4.6.9L7.6 15.5 4 2.5Z" stroke="currentColor" strokeWidth="1.4" /></svg>;
    case "rectangle":
      return <svg {...common}><rect x="3" y="4" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.4" /></svg>;
    case "long":
      return <svg {...common}><path d="M9 14V4M5.5 7.5 9 4l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
    case "short":
      return <svg {...common}><path d="M9 4v10M5.5 10.5 9 14l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
    case "text":
      return <svg {...common}><path d="M4 4h10M9 4v10M6.5 14h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
    case "trend-line":
      return <svg {...common}><path d="M3 14 15 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="3" cy="14" r="1.2" fill="currentColor" /><circle cx="15" cy="4" r="1.2" fill="currentColor" /></svg>;
    case "horizontal-line":
      return <svg {...common}><path d="M2 9h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="3" cy="9" r="1.2" fill="currentColor" /><circle cx="15" cy="9" r="1.2" fill="currentColor" /></svg>;
    case "horizontal-ray":
      return <svg {...common}><path d="M3 9h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="3" cy="9" r="1.3" fill="currentColor" /></svg>;
    case "price-range":
      return <svg {...common}><path d="M4 13 14 5" stroke="currentColor" strokeWidth="1.4" /><path d="M4 6v7h7" stroke="currentColor" strokeWidth="1.2" /></svg>;
    case "crosshair":
      return <svg {...common}><path d="M9 2v14M2 9h14" stroke="currentColor" strokeWidth="1.4" /></svg>;
    default: {
      const neverTool: never = tool;
      return neverTool;
    }
  }
}

export function MobileChart() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const liqRef = useRef<LiqHeatmapPrimitive | null>(null);
  const drawRef = useRef<MobileDrawingPrimitive | null>(null);
  const symbolRef = useRef("BTCUSDT");
  const intervalRef = useRef<ChartInterval>("30");
  const venueRef = useRef<MarketVenue>("binance");
  const toolRef = useRef<MobileTool>("select");
  const draftRef = useRef<MobileDraft>(null);
  const drawingsRef = useRef<MobileDrawing[]>([]);
  const selectedRef = useRef<string | null>(null);
  const showDrawingsRef = useRef(true);
  const showLiqRef = useRef(true);
  const layoutRef = useRef<() => void>(() => {});
  const boxesRef = useRef<MobileLiqBox[]>([]);
  const cooldownRef = useRef<Record<string, number>>({});
  const soundRef = useRef<MobileAlertSound | null>(null);
  const postedRef = useRef(new Set<string>());
  const readyRef = useRef(false);
  const tabRef = useRef<TabId>("chart");
  const soundOnRef = useRef(false);
  const notifyOnRef = useRef(false);
  const candlesRef = useRef<MarketCandle[]>([]);
  const bookRef = useRef<AlertListState>({ alerts: [], draft: null, edit: null, expandedId: null });
  const focusRef = useRef<{ from: number; to: number } | null>(null);
  const alertsReadyRef = useRef(false);
  const pollAlertsRef = useRef<(live: () => boolean) => Promise<void>>(async () => {});
  const idRef = useRef(1);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState<ChartInterval>("30");
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [feedError, setFeedError] = useState<string | null>(null);
  const [tool, setTool] = useState<MobileTool>("select");
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [drawings, setDrawings] = useState<MobileDrawing[]>([]);
  const [history, setHistory] = useState<DrawingHistory>(() => historyInit([]));
  const [draft, setDraft] = useState<MobileDraft>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MobileDrawing | null>(null);
  const [showLiq, setShowLiq] = useState(true);
  const [showDrawings, setShowDrawings] = useState(true);
  const [alertsOn] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [unread, setUnread] = useState(0);
  const [book, setBook] = useState<AlertListState>({ alerts: [], draft: null, edit: null, expandedId: null });
  const [alertSymbol, setAlertSymbol] = useState("ALL");
  const [alertSegment, setAlertSegment] = useState<AlertSegment>("active");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rawZones, setRawZones] = useState<LiqZone[]>([]);
  const [rawBands, setRawBands] = useState<LiqBand[]>([]);
  const [liqNotice, setLiqNotice] = useState<string | null>(null);
  const [coolSec, setCoolSec] = useState(0);
  const [tab, setTab] = useState<TabId>("chart");
  const [toast, setToast] = useState<string | null>(null);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [now, setNow] = useState(0);

  const price = candles.length ? candles[candles.length - 1].close : 0;
  const boxes = useMemo(() => selectMobileLiqBoxes(rawZones, rawBands, price || Number.NaN), [rawZones, rawBands, price]);
  const quote = useMemo(() => {
    if (candles.length < 1) return { price: "—", delta: "", up: true };
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2] ?? last;
    const diff = last.close - prev.close;
    const pct = prev.close ? (diff / prev.close) * 100 : 0;
    const sign = diff > 0 ? "+" : "";
    const digits = precisionFromTick(inferTickFromCandles(candles) ?? 0.1);
    return {
      price: last.close.toLocaleString("en-US", { minimumFractionDigits: Math.min(1, digits), maximumFractionDigits: digits }),
      delta: `${sign}${Math.abs(diff) >= 100 ? diff.toFixed(1) : diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`,
      up: diff >= 0,
    };
  }, [candles]);
  const selected = drawings.find((drawing) => drawing.id === selectedId) ?? null;

  const layoutBadges = useCallback(() => {
    const series = candleRef.current;
    const host = hostRef.current;
    if (!series || !host || !showLiqRef.current) { setBadges([]); return; }
    const height = host.clientHeight || 0;
    const rows = boxesRef.current.flatMap((box) => {
      const y = series.priceToCoordinate((box.lo + box.hi) / 2);
      if (y == null || !Number.isFinite(y)) return [];
      const edge = box.role === "support" ? box.hi : box.lo;
      return [{ id: box.id, y, label: formatAlertPrice(edge), role: box.role }];
    });
    const ys = stackBadgeYs(rows.map((row) => row.y), 18, 12, Math.max(12, height - 28));
    setBadges(rows.map((row, index) => ({ ...row, y: ys[index] ?? row.y })));
  }, []);

  const paintReplace = useCallback((next: MarketCandle[]) => {
    const series = candleRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.applyOptions({ priceFormat: priceFormatForTick(inferTickFromCandles(next)) });
    series.setData(next.map(toCandle));
    fitChartView(chart);
    const focus = focusRef.current;
    if (focus) {
      series.priceScale().setVisibleRange(focus);
      focusRef.current = null;
    }
    layoutBadges();
  }, [layoutBadges]);

  const paintTick = useCallback((next: MarketCandle) => {
    candleRef.current?.update(toCandle(next));
  }, []);

  useEffect(() => {
    symbolRef.current = symbol;
    intervalRef.current = interval;
    toolRef.current = tool;
    draftRef.current = draft;
    drawingsRef.current = drawings;
    selectedRef.current = selectedId;
    showDrawingsRef.current = showDrawings;
    showLiqRef.current = showLiq;
    boxesRef.current = boxes;
    layoutRef.current = layoutBadges;
    tabRef.current = tab;
    soundOnRef.current = soundOn;
    notifyOnRef.current = notifyOn;
    candlesRef.current = candles;
    bookRef.current = book;
  }, [symbol, interval, tool, draft, drawings, selectedId, showDrawings, showLiq, boxes, layoutBadges, tab, soundOn, notifyOn, candles, book]);

  function commitDrawings(next: MobileDrawing[]) {
    drawingsRef.current = next;
    setDrawings(next);
    setHistory((current) => historyCommit(current, next));
  }

  function pointFromEvent(x: number, y: number): MobilePoint | null {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return null;
    const priceAt = series.coordinateToPrice(y);
    const time = chart.timeScale().coordinateToTime(x);
    if (priceAt == null || typeof time !== "number") return null;
    return { time, price: priceAt };
  }

  async function deliver(event: TouchFire, gate: { sound: boolean; notify: boolean; symbol?: string; interval?: ChartInterval } = { sound: true, notify: true }) {
    const message = event.message;
    const alertSymbol = gate.symbol ?? symbolRef.current;
    const alertInterval = gate.interval ?? intervalRef.current;
    setToast(message);
    if (tabRef.current !== "alerts") setUnread((count) => Math.min(99, count + 1));
    const sound = soundRef.current;
    if (gate.sound && soundOnRef.current && sound?.unlocked) void sound.play();
    const title = "Trading Hub";
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (gate.notify && notifyOnRef.current && registration && typeof Notification !== "undefined" && Notification.permission === "granted") {
        await registration.showNotification(title, { body: message, silent: false });
      }
    } catch { /* notification unavailable until the PWA is installed */ }
    const kind = notifyKind(event.target);
    const ranged = kind === "liq-support" || kind === "liq-resistance" || kind === "rectangle";
    const payload = { symbol: alertSymbol, kind, price: event.price, lo: ranged ? event.lo : null, hi: ranged ? event.hi : null };
    try {
      await fetch("/api/mobile/notify", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
    } catch { /* local alert already shown */ }
    if (!postedRef.current.has(event.id)) {
      postedRef.current.add(event.id);
      try {
        await fetch("/api/alerts", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            symbol: alertSymbol,
            venue: venueRef.current,
            interval: alertInterval,
            operator: "crossing",
            level: event.price,
            frequency: "every",
            name: message.slice(0, 80),
            message,
          }),
        });
      } catch { /* alerts backend is optional */ }
    }
  }

  function soundEngine(): MobileAlertSound {
    const sound = soundRef.current ?? createMobileAlertSound();
    soundRef.current = sound;
    return sound;
  }

  async function toggleSound() {
    if (soundOnRef.current) {
      soundOnRef.current = false;
      setSoundOn(false);
      return;
    }
    await soundEngine().unlock();
    soundOnRef.current = true;
    setSoundOn(true);
  }

  async function testSound() {
    const sound = soundEngine();
    await sound.unlock();
    soundOnRef.current = true;
    setSoundOn(true);
    await sound.play();
    setToast("Test Sound");
  }

  async function toggleNotify() {
    if (notifyOnRef.current) {
      notifyOnRef.current = false;
      setNotifyOn(false);
      return;
    }
    try {
      if (typeof Notification === "undefined") {
        setToast("Notifications unavailable");
        return;
      }
      if (Notification.permission !== "granted") {
        const result = await Notification.requestPermission();
        if (result !== "granted") {
          setToast("Notifications blocked");
          return;
        }
      }
    } catch {
      setToast("Notifications blocked");
      return;
    }
    notifyOnRef.current = true;
    setNotifyOn(true);
  }

  function showAlerts() {
    tabRef.current = "alerts";
    setTab("alerts");
    setUnread(0);
  }

  function syncDrawingFlags(next: AlertListState) {
    const linked = withDrawingAlerts(drawingsRef.current, next.alerts, symbolRef.current, intervalRef.current);
    if (JSON.stringify(linked) !== JSON.stringify(drawingsRef.current)) {
      drawingsRef.current = linked;
      setDrawings(linked);
    }
    const seen = new Set<string>();
    for (const alert of next.alerts) {
      if (!alert.drawingId) continue;
      const key = `${alert.symbol}:${alert.interval}`;
      if (seen.has(key) || (alert.symbol === symbolRef.current && alert.interval === intervalRef.current)) continue;
      seen.add(key);
      const stored = loadMobileDrawings(window.localStorage, alert.symbol, alert.interval);
      saveMobileDrawings(window.localStorage, alert.symbol, alert.interval, withDrawingAlerts(stored, next.alerts, alert.symbol, alert.interval));
    }
  }

  function applyBook(update: (state: AlertListState) => AlertListState) {
    const next = update(bookRef.current);
    bookRef.current = next;
    setBook(next);
    syncDrawingFlags(next);
  }

  function armDrawing(drawing: MobileDrawing) {
    applyBook((state) => {
      const id = `draw:${drawing.id}`;
      if (state.alerts.some((alert) => alert.id === id)) return expandAlert(state, id);
      const draft = draftFromDrawing(symbolRef.current, intervalRef.current, drawing, Date.now());
      return draft ? beginCreate(state, draft) : state;
    });
    showAlerts();
  }

  function armLiq() {
    const level = candlesRef.current.at(-1)?.close ?? 0;
    applyBook((state) => openOrCreateLiq(state, symbolRef.current, intervalRef.current, level, Date.now()));
    showAlerts();
  }

  function createAlert() {
    const level = candlesRef.current.at(-1)?.close ?? 0;
    applyBook((state) => beginCreate(state, blankDraft(symbolRef.current, intervalRef.current, level, Date.now())));
    showAlerts();
  }

  function showOnChart(alert: GlobalAlert) {
    const range = centerPriceRange(alert.level);
    focusRef.current = range;
    if (alert.symbol !== symbolRef.current || alert.interval !== intervalRef.current) switchMarket(alert.symbol, alert.interval);
    else if (range) {
      candleRef.current?.priceScale().setVisibleRange(range);
      focusRef.current = null;
    }
    tabRef.current = "chart";
    setTab("chart");
  }

  async function pollAlerts(live: () => boolean) {
    await Promise.resolve();
    if (!live()) return;
    const current = bookRef.current;
    const pairs = planAlertPolls(current.alerts, symbolRef.current, intervalRef.current, Date.now());
    const quotes: Record<string, AlertQuote> = {};
    const bars = candlesRef.current;
    if (bars.length > 0) {
      const last = bars[bars.length - 1];
      quotes[quoteKey(symbolRef.current, intervalRef.current)] = { prev: bars.length > 1 ? bars[bars.length - 2] : null, bar: last };
    }
    for (const pair of pairs) {
      try {
        const result = await fetchCandles(pair.symbol, pair.interval, 2);
        if (!live()) return;
        const last = result.candles[result.candles.length - 1];
        const prev = result.candles[result.candles.length - 2] ?? null;
        if (last) quotes[quoteKey(pair.symbol, pair.interval)] = { prev, bar: last };
      } catch { /* this symbol is retried on the next poll */ }
    }
    const zones: Record<string, MobileLiqBox[]> = {};
    const liqSymbols = [...new Set(current.alerts.filter((alert) => alert.kind === "liq").map((alert) => alert.symbol))];
    for (const sym of liqSymbols) {
      let price = 0;
      for (const [key, quote] of Object.entries(quotes)) if (key.startsWith(`${sym}:`)) price = quote.bar.close;
      if (!(price > 0)) continue;
      if (sym === symbolRef.current && boxesRef.current.length > 0) {
        zones[sym] = boxesRef.current;
        continue;
      }
      try {
        const model = await loadLiqHeatmapBands(sym);
        if (!live()) return;
        const fresh = selectMobileLiqBoxes(model.zones, model.bands, price);
        if (fresh.length > 0) zones[sym] = fresh;
      } catch { /* keep the zones already stored on the alert */ }
    }
    if (!live()) return;
    const result = evaluateAlertBook({ alerts: current.alerts, quotes, zones, now: Date.now(), cooldown: cooldownRef.current });
    cooldownRef.current = result.cooldown;
    if (JSON.stringify(result.alerts) !== JSON.stringify(bookRef.current.alerts)) {
      const next = { ...bookRef.current, alerts: result.alerts };
      bookRef.current = next;
      setBook(next);
    }
    for (const fire of result.fired) {
      void deliver(fire.event, { sound: fire.alert.sound, notify: fire.alert.notify, symbol: fire.alert.symbol, interval: fire.alert.interval });
    }
  }

  useEffect(() => {
    pollAlertsRef.current = pollAlerts;
  });

  async function reloadZones(current = symbolRef.current) {
    const model = await loadLiqHeatmapBands(current);
    if (symbolRef.current !== current) return;
    setRawZones(model.zones);
    setRawBands(model.bands);
    setLiqNotice(model.notice);
  }

  async function refreshZones() {
    if (coolSec > 0) return;
    setCoolSec(30);
    const result = await requestLiqRefresh(symbolRef.current);
    if (!result.ok) {
      if (result.retryAfterSec) setCoolSec(result.retryAfterSec);
      setLiqNotice(result.error);
      return;
    }
    setRawZones(result.model.zones);
    setRawBands(result.model.bands);
    setLiqNotice(result.model.notice);
    setCoolSec(result.cooldownSec || 30);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#434651",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: 10,
      },
      grid: { vertLines: { color: "#f0f3fa" }, horzLines: { color: "#f0f3fa" } },
      rightPriceScale: { borderColor: "#e0e3eb", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "#e0e3eb", timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 6, minBarSpacing: 0.5 },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      kineticScroll: { touch: true, mouse: false },
    });
    chart.applyOptions(chartThemeOptions(currentDocumentTheme()));
    const series = chart.addSeries(CandlestickSeries, { ...candleThemeOptions(currentDocumentTheme()), borderVisible: false, priceLineVisible: true });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    const liq = new LiqHeatmapPrimitive();
    const draws = new MobileDrawingPrimitive();
    series.attachPrimitive(liq);
    series.attachPrimitive(draws);
    chartRef.current = chart;
    candleRef.current = series;
    liqRef.current = liq;
    drawRef.current = draws;
    soundRef.current = createMobileAlertSound();
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});

    const project = (point: MobilePoint) => {
      const x = chart.timeScale().timeToCoordinate(point.time as UTCTimestamp);
      const y = series.priceToCoordinate(point.price);
      if (x == null || y == null) return null;
      return { x, y };
    };
    const hitAt = (at: { x: number; y: number }) => {
      const width = host.clientWidth || 390;
      for (let index = drawingsRef.current.length - 1; index >= 0; index -= 1) {
        const hit = hitMobileDrawing(drawingsRef.current[index], at, project, 14, width);
        if (hit) return hit;
      }
      return null;
    };
    const onClick = (param: { point?: { x: number; y: number }; time?: Time }) => {
      if (!param.point || !showDrawingsRef.current) return;
      const at = pointFromEvent(param.point.x, param.point.y);
      if (!at) return;
      const active = toolRef.current;
      if (active === "select" || active === "crosshair") {
        const hit = hitAt(param.point);
        setSelectedId(hit?.id ?? null);
        return;
      }
      const placed = applyTap(active, draftRef.current, drawingsRef.current, at, Date.now(), `m-${idRef.current++}`);
      setDraft(placed.draft);
      setPreview(null);
      if (placed.committed) {
        commitDrawings(placed.drawings);
        setSelectedId(placed.drawings[placed.drawings.length - 1]?.id ?? null);
      }
    };
    chart.subscribeClick(onClick);
    chart.subscribeCrosshairMove((param) => {
      const pending = draftRef.current;
      if (!pending || !param.point) { setPreview((current) => current ? null : current); return; }
      const at = pointFromEvent(param.point.x, param.point.y);
      if (!at) return;
      const ghost = applyTap(pending.tool, pending, [], at, Date.now(), "preview");
      const created = ghost.drawings[0];
      setPreview(created ? previewDrawing(created) : null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => layoutRef.current());

    let drag: { id: string; part: HitPart } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (toolRef.current !== "select" || !showDrawingsRef.current) return;
      const rect = host.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const hit = hitAt(at);
      if (!hit || hit.part === "body") return;
      drag = hit;
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const rect = host.getBoundingClientRect();
      const at = pointFromEvent(event.clientX - rect.left, event.clientY - rect.top);
      if (!at) return;
      const next = drawingsRef.current.map((drawing) => drawing.id === drag?.id ? movePoint(drawing, drag.part, at) : drawing);
      drawingsRef.current = next;
      setDrawings(next);
    };
    const onPointerUp = () => {
      if (!drag) return;
      drag = null;
      setHistory((current) => historyCommit(current, drawingsRef.current));
    };
    host.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    const applyThemeToChart = () => {
      const theme = currentDocumentTheme();
      chart.applyOptions(chartThemeOptions(theme));
      series.applyOptions(candleThemeOptions(theme));
    };
    const unsubscribe = subscribeTheme(applyThemeToChart);
    return () => {
      unsubscribe();
      host.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const placing = tool !== "select" && tool !== "crosshair";
    chart.applyOptions({
      handleScroll: { pressedMouseMove: !placing, horzTouchDrag: !placing, vertTouchDrag: false, mouseWheel: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: !placing },
    });
  }, [tool]);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    fetchCandles(symbol, interval, 300, controller.signal).then((result) => {
      if (!live) return;
      venueRef.current = result.venue;
      setCandles(result.candles);
      setStatus("online");
      paintReplace(result.candles);
    }).catch((error: unknown) => {
      if (!live || (error instanceof DOMException && error.name === "AbortError")) return;
      setStatus("error");
      setFeedError(error instanceof Error ? error.message : "Chart data unavailable");
    });
    const poll = window.setInterval(() => {
      fetchCandles(symbolRef.current, intervalRef.current, 5).then((result) => {
        if (!live || result.candles.length === 0) return;
        const last = result.candles[result.candles.length - 1];
        paintTick(last);
        setCandles((prev) => {
          const map = new Map(prev.map((candle) => [candle.time, candle]));
          for (const candle of result.candles) map.set(candle.time, candle);
          return [...map.values()].sort((a, b) => a.time - b.time);
        });
        setStatus("online");
      }).catch(() => { if (live) setStatus("error"); });
    }, 15_000);
    return () => { live = false; controller.abort(); window.clearInterval(poll); };
  }, [symbol, interval, paintReplace, paintTick]);

  useEffect(() => {
    let live = true;
    void reloadZones(symbol).catch(() => { if (live) setLiqNotice("∅"); });
    return () => { live = false; };
  }, [symbol]);

  useEffect(() => {
    if (!showLiq) return;
    const id = window.setInterval(() => { void reloadZones(symbolRef.current).catch(() => {}); }, LIQ_HEATMAP_POLL_MS);
    return () => window.clearInterval(id);
  }, [showLiq, symbol]);

  useEffect(() => {
    if (coolSec <= 0) return;
    const id = window.setInterval(() => setCoolSec((value) => (value <= 1 ? 0 : value - 1)), 1000);
    return () => window.clearInterval(id);
  }, [coolSec]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      readyRef.current = true;
      if (symbolRef.current !== "BTCUSDT" || intervalRef.current !== "30" || drawingsRef.current.length > 0) return;
      const loaded = loadMobileDrawings(window.localStorage, "BTCUSDT", "30");
      if (loaded.length === 0) return;
      drawingsRef.current = loaded;
      setDrawings(loaded);
      setHistory(historyInit(loaded));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!readyRef.current) return;
    saveMobileDrawings(window.localStorage, symbol, interval, drawings);
  }, [drawings, symbol, interval]);

  useEffect(() => {
    liqRef.current?.setBands([]);
    const anchor = candles.length ? candles[candles.length - 1].time as Time : null;
    liqRef.current?.setZones(showLiq ? boxes.map((box) => toLiqZone(box, price)) : [], anchor, null);
    layoutBadges();
  }, [showLiq, boxes, candles, price, layoutBadges]);

  useEffect(() => {
    drawRef.current?.setState(showDrawings ? drawings : [], showDrawings ? selectedId : null, showDrawings ? preview : null);
  }, [showDrawings, drawings, selectedId, preview]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      alertsReadyRef.current = true;
      setBook((current) => ({ ...current, alerts: loadGlobalAlerts(window.localStorage) }));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!alertsReadyRef.current) return;
    saveGlobalAlerts(window.localStorage, book.alerts);
  }, [book.alerts]);

  useEffect(() => {
    if (!alertsOn) return;
    let live = true;
    const run = () => { void pollAlertsRef.current(() => live); };
    run();
    const timer = window.setInterval(run, MOBILE_ALERT_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [alertsOn, book.alerts, symbol, interval]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (tab !== "alerts") return;
    let live = true;
    const tick = () => { if (live) setNow(Date.now()); };
    const kick = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 30_000);
    return () => { live = false; window.clearTimeout(kick); window.clearInterval(id); };
  }, [tab]);

  function switchMarket(nextSymbol: string, nextInterval: ChartInterval) {
    const same = nextSymbol === symbolRef.current && nextInterval === intervalRef.current;
    if (!same) {
      if (readyRef.current) {
        saveMobileDrawings(window.localStorage, symbolRef.current, intervalRef.current, drawingsRef.current);
      }
      const loaded = loadMobileDrawings(window.localStorage, nextSymbol, nextInterval);
      drawingsRef.current = loaded;
      symbolRef.current = nextSymbol;
      intervalRef.current = nextInterval;
      setDrawings(loaded);
      setHistory(historyInit(loaded));
      setDraft(null);
      setPreview(null);
      setSelectedId(null);
      setSymbol(nextSymbol);
      setInterval(nextInterval);
      setStatus("loading");
      setFeedError(null);
    }
  }

  function undo() {
    setHistory((current) => {
      const next = historyUndo(current);
      setDrawings(next.present);
      return next;
    });
  }

  function redo() {
    setHistory((current) => {
      const next = historyRedo(current);
      setDrawings(next.present);
      return next;
    });
  }

  function patchSelected(update: (drawing: MobileDrawing) => MobileDrawing | null) {
    if (!selectedId) return;
    const next = drawings.flatMap((drawing) => {
      if (drawing.id !== selectedId) return [drawing];
      const patched = update(drawing);
      return patched ? [patched] : [];
    });
    const removed = !next.some((drawing) => drawing.id === selectedId);
    commitDrawings(next);
    if (removed) {
      applyBook((state) => deleteAlert(state, `draw:${selectedId}`));
      setSelectedId(null);
    }
  }

  return (
    <div className="m-app" data-mobile-page="chart">
      <header className="m-head">
        <div className="m-head-top">
          <span className="m-coin" aria-hidden="true">₿</span>
          <div className="m-title" aria-label={`${symbol} symbol`}>
            <strong>{titleFor(symbol)}</strong>
          </div>
          <span className={`live-dot ${status === "loading" ? "" : status}`} data-feed={status} aria-label={status === "online" ? "Live" : status} />
          <span className="m-quote" aria-label="Quote currency USDT">USDT</span>
        </div>
        <div className="m-quote-line">
          <span className="m-price">{quote.price}</span>
          <span className={quote.up ? "m-up" : "m-down"}>{quote.delta}</span>
        </div>
      </header>

      <div className="m-stage">
        <div ref={hostRef} className="m-chart" data-hidden={tab === "chart" ? "false" : "true"} aria-label={`${symbol} ${interval} chart`} />
        {showLiq && tab === "chart" && badges.map((badge) => (
          <span key={badge.id} className={`m-badge m-badge-${badge.role}`} style={{ top: badge.y }}>{badge.label}</span>
        ))}
        {showLiq && boxes.length === 0 && tab === "chart" && (
          <div className="m-empty" role="status" data-liq-empty="true" aria-label={liqNotice || "暂无符合条件的清算区"}>∅</div>
        )}
        {feedError && tab === "chart" && <div className="m-feed-error" role="status">{feedError}</div>}
        {toast && <div className="m-toast" role="status">{toast}</div>}
        {tab === "chart" && showDrawings && (
          <div className={`m-tools ${toolbarOpen ? "" : "is-collapsed"}`} role="toolbar" aria-label="Drawing tools">
            <button type="button" className="m-tool" aria-label={toolbarOpen ? "Collapse drawing tools" : "Expand drawing tools"} title={toolbarOpen ? "Collapse" : "Expand"} onClick={() => setToolbarOpen((open) => !open)}>
              <span aria-hidden="true">{toolbarOpen ? "⌃" : "⌄"}</span>
            </button>
            {toolbarOpen && TOOLS.map((item) => (
              <button key={item.id} type="button" className={`m-tool ${tool === item.id ? "is-on" : ""}`} data-tool={item.id} aria-label={item.label} aria-pressed={tool === item.id} title={item.label} onClick={() => { setTool(item.id); setDraft(null); setPreview(null); }}>
                <ToolGlyph tool={item.id} />
              </button>
            ))}
          </div>
        )}
        {tab === "chart" && selected && (
          <div className="m-selection" role="group" aria-label="Selected drawing">
            {selected.type === "text" && (
              <input aria-label="Text annotation" value={selected.text} onChange={(event) => patchSelected((drawing) => drawing.type === "text" ? { ...drawing, text: event.target.value.slice(0, 40) || "注" } : drawing)} />
            )}
            {selected.type === "trend-line" && (
              <button type="button" className={`m-tool ${selected.ray ? "is-on" : ""}`} aria-label={selected.ray ? "Stop ray extension" : "Extend trendline as ray"} aria-pressed={selected.ray} title="Ray" onClick={() => patchSelected((drawing) => drawing.type === "trend-line" ? { ...drawing, ray: !drawing.ray } : drawing)}>↗</button>
            )}
            <button type="button" className={`m-tool ${selected.alert ? "is-on" : ""}`} aria-label="Create alert from drawing" aria-pressed={selected.alert} title="Alert" onClick={() => armDrawing(selected)}>🔔</button>
            <button type="button" className="m-tool" aria-label="Delete drawing" title="Delete" onClick={() => patchSelected(() => null)}>✕</button>
          </div>
        )}

        {tab === "alerts" && (
          <AlertsPanel
            book={book}
            symbols={book.alerts.map((alert) => alert.symbol)}
            intervals={INTERVALS}
            symbolChoices={SYMBOLS}
            filterSymbol={alertSymbol}
            segment={alertSegment}
            settingsOpen={settingsOpen}
            notifyOn={notifyOn}
            soundOn={soundOn}
            now={now}
            onFilterSymbol={setAlertSymbol}
            onSegment={setAlertSegment}
            onToggleSettings={() => setSettingsOpen((open) => !open)}
            onToggleNotify={() => void toggleNotify()}
            onToggleSound={() => void toggleSound()}
            onTestSound={() => void testSound()}
            onCreate={createAlert}
            onExpand={(id) => applyBook((state) => expandAlert(state, id))}
            onChange={(next) => applyBook((state) => updateExpanded(state, next))}
            onSave={() => applyBook((state) => saveExpanded(state))}
            onCancel={() => applyBook((state) => cancelExpanded(state))}
            onPause={(id) => applyBook((state) => pauseAlert(state, id))}
            onDelete={(id) => applyBook((state) => deleteAlert(state, id))}
            onShowChart={showOnChart}
          />
        )}
      </div>

      {tab === "chart" && <div className="m-controls">
        <div className="m-scroll" role="group" aria-label="Symbols">
          {SYMBOLS.map((item) => (
            <button key={item} type="button" className={`m-chip ${item === symbol ? "is-on" : ""}`} aria-pressed={item === symbol} onClick={() => switchMarket(item, interval)}>{item}</button>
          ))}
        </div>
        <div className="m-scroll" role="group" aria-label="Timeframe">
          {INTERVALS.map((item) => (
            <button key={item.id} type="button" className={`m-chip ${item.id === interval ? "is-on" : ""}`} aria-pressed={item.id === interval} onClick={() => switchMarket(symbol, item.id)}>{item.label}</button>
          ))}
        </div>
        <div className="m-iconbar" role="toolbar" aria-label="Chart actions">
          <button type="button" className={`m-icon ${showDrawings ? "is-on" : ""}`} aria-label={showDrawings ? "Hide drawings" : "Show drawings"} aria-pressed={showDrawings} title="Drawings" onClick={() => setShowDrawings((value) => !value)}>✎</button>
          <button type="button" className={`m-icon ${showLiq ? "is-on" : ""}`} aria-label={showLiq ? "Hide liquidation map" : "Show liquidation map"} aria-pressed={showLiq} title="Liquidation" data-action="liq" onClick={() => setShowLiq((value) => !value)}>▣</button>
          <button type="button" className="m-icon" aria-label="刷新清算" title="Refresh liquidation" disabled={coolSec > 0} data-liq-refresh={coolSec > 0 ? "cooldown" : "idle"} onClick={() => void refreshZones()}>{coolSec > 0 ? coolSec : "↻"}</button>
          <button type="button" className="m-icon" aria-label="Create liquidation alert" title="Liquidation alert" onClick={armLiq}>⚑</button>
          <button type="button" className="m-icon" aria-label="Open alerts" title="Alerts" data-action="alerts" onClick={showAlerts}>🔔</button>
          <button type="button" className="m-icon" aria-label="Undo" title="Undo" disabled={history.past.length === 0} onClick={undo}>↶</button>
          <button type="button" className="m-icon" aria-label="Redo" title="Redo" disabled={history.future.length === 0} onClick={redo}>↷</button>
          <button type="button" className="m-icon" aria-label="Fit chart" title="Fit" data-action="fit" onClick={() => fitChartView(chartRef.current)}>⤢</button>
        </div>
      </div>}

      <nav className="m-tabs" aria-label="Sections">
        <button type="button" className={tab === "chart" ? "is-on" : ""} aria-current={tab === "chart" ? "page" : undefined} onClick={() => setTab("chart")}>Chart</button>
        <button type="button" className={tab === "alerts" ? "is-on" : ""} aria-current={tab === "alerts" ? "page" : undefined} onClick={showAlerts}>
          Alerts
          {unread > 0 ? <span className="m-tab-count" data-unread={unread}>{unread}</span> : null}
        </button>
      </nav>
    </div>
  );
}
