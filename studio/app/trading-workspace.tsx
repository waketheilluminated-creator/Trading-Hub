"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  CandlestickSeries, ColorType, createChart, LineSeries,
  type CandlestickData, type IChartApi, type ISeriesApi,
  type LineData, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { loadAllMarketCatalogs, loadChartHistory, mergeLiveCandle, openKlineStream } from "@/lib/market-feed.ts";
import { fallbackCatalog, formatMarketId, nextRecentSymbols, parseMarketId, resolveRecentMarket } from "@/lib/market-symbols.js";
import { isMarketVenue, MARKET_VENUES, venueLabel, type MarketCandle, type MarketVenue } from "@/lib/market-venues.ts";
import { COLLAPSED_PANEL_HEIGHT, DEFAULT_PANEL_HEIGHT, isPanelCollapsed, resolvePanelHeight, snapPanelHeight } from "@/lib/panel-layout.js";
import { DrawingController, initialDrawingSession, type DrawingChangeKind, type DrawingSession } from "@/lib/drawings/controller.ts";
import { DrawingPrimitive } from "@/lib/drawings/primitive.ts";
import { DrawingSaveScheduler, createDrawingStorage, loadDrawings, type DrawingStorage } from "@/lib/drawings/store.ts";
import type { Drawing, DrawingPoint, DrawingTool } from "@/lib/drawings/types.ts";
import { chartDrawingMarket, type ChartDrawingMarket } from "@/lib/drawings/workspace-market.ts";
import { handleWorkspaceEscape } from "@/lib/drawings/workspace-shortcuts.ts";
import { DrawingToolbar } from "@/components/drawing-toolbar";
import { SymbolSearchDialog, type SymbolSearchMarket } from "@/components/symbol-search-dialog";
import { savePineSource, usePineSource } from "./pine-source";

type Candle = CandlestickData<Time> & { volume?: number };
type Interval = "1" | "5" | "15" | "60" | "240" | "D";
type MarketFeedStatus = { phase: "loading" | "live" | "polling" | "error"; notice: string | null; error: string | null };
type Derivatives = {
  openInterestValue: number | null; openInterestAmount: number | null;
  fundingRate: number | null; markPrice: number | null; indexPrice: number | null;
  nextFundingTimestamp: number | null; exchange: string; updatedAt: number;
};
type PinePlot = { title?: string; data?: (number | null)[] };
type AIMessage = { id: number; role: "user" | "assistant"; content: string };
type MarketOption = SymbolSearchMarket;

function venueOptions() {
  return MARKET_VENUES.map((venue) => <option key={venue} value={venue}>{venueLabel(venue)}</option>);
}

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "1m", value: "1" }, { label: "5m", value: "5" }, { label: "15m", value: "15" },
  { label: "1H", value: "60" }, { label: "4H", value: "240" }, { label: "1D", value: "D" },
];
function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1000
    ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function formatCompact(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
function toChartCandle(candle: MarketCandle): Candle {
  return { time: candle.time as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume };
}

function calculateEma(candles: Candle[], length: number): LineData<Time>[] {
  if (!candles.length) return [];
  const multiplier = 2 / (length + 1);
  let ema = candles[0].close;
  return candles.map((candle, index) => {
    ema = index === 0 ? candle.close : candle.close * multiplier + ema * (1 - multiplier);
    return { time: candle.time, value: ema };
  });
}

function isTextEditingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export function TradingWorkspace() {
  const chartHost = useRef<HTMLDivElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const lastExpandedPanelHeightRef = useRef(DEFAULT_PANEL_HEIGHT);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const slowSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const drawingPrimitiveRef = useRef<DrawingPrimitive | null>(null);
  const drawingControllerRef = useRef<DrawingController | null>(null);
  const drawingSaveSchedulerRef = useRef<DrawingSaveScheduler | null>(null);
  const drawingStorageRef = useRef<DrawingStorage | null>(null);
  const drawingsRef = useRef<Drawing[]>([]);
  const drawingMarketRef = useRef<ChartDrawingMarket>(chartDrawingMarket("BTCUSDT"));
  const candleTimesRef = useRef<number[]>([]);
  const activeDrawingToolRef = useRef<DrawingTool>("select");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [marketCatalog, setMarketCatalog] = useState<MarketOption[]>(() => fallbackCatalog() as MarketOption[]);
  const [symbolSearchOpen, setSymbolSearchOpen] = useState(false);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
  const [recentSymbols, setRecentSymbols] = useState<string[]>(() => {
    if (typeof window === "undefined") return ["BYBIT:BTCUSDT", "BYBIT:ETHUSDT"];
    try {
      const stored = JSON.parse(window.localStorage.getItem("pilab-recent-symbols") || "[]");
      return Array.isArray(stored) && stored.every((item) => typeof item === "string")
        ? stored.map((item) => { const parsed = parseMarketId(item); return formatMarketId(parsed.venue, parsed.symbol); })
        : ["BYBIT:BTCUSDT", "BYBIT:ETHUSDT"];
    } catch { return ["BYBIT:BTCUSDT", "BYBIT:ETHUSDT"]; }
  });
  const [interval, setInterval] = useState<Interval>("15");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showFast, setShowFast] = useState(true);
  const [showSlow, setShowSlow] = useState(true);
  const [activeTab, setActiveTab] = useState<"pine" | "console">("pine");
  const pine = usePineSource();
  const [consoleText, setConsoleText] = useState("Ready. Pine Script v5 subset loaded.");
  const [consoleKind, setConsoleKind] = useState<"normal" | "success" | "error">("normal");
  const [running, setRunning] = useState(false);
  const [derivatives, setDerivatives] = useState<Derivatives | null>(null);
  const [chartVenue, setChartVenue] = useState<MarketVenue>("bybit");
  const [activeVenue, setActiveVenue] = useState<MarketVenue>("bybit");
  const [marketStatus, setMarketStatus] = useState<MarketFeedStatus>({ phase: "loading", notice: null, error: null });
  const [derivativesExchange, setDerivativesExchange] = useState<MarketVenue>("bybit");
  const [alerts, setAlerts] = useState<{ id: number; direction: "above" | "below"; price: number; triggered: boolean }[]>([]);
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [alertDirection, setAlertDirection] = useState<"above" | "below">("above");
  const [alertPrice, setAlertPrice] = useState("");
  const [pinePlots, setPinePlots] = useState<PinePlot[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiEndpoint, setAiEndpoint] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [aiQuestion, setAiQuestion] = useState("Analyze the current market structure and identify the most important risk signals.");
  const [aiMessages, setAiMessages] = useState<AIMessage[]>([]);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState("");
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [consoleHeight, setConsoleHeight] = useState(82);
  const [pineApplied, setPineApplied] = useState(false);
  const [activeDrawingTool, setActiveDrawingTool] = useState<DrawingTool>("select");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [drawingSession, setDrawingSession] = useState<DrawingSession>(initialDrawingSession);
  const [textAnchor, setTextAnchor] = useState<DrawingPoint | null>(null);
  const [textInputPosition, setTextInputPosition] = useState<{ x: number; y: number } | null>(null);
  const [drawingText, setDrawingText] = useState("");

  const clearDrawingTextEntry = useCallback(() => {
    setTextAnchor(null);
    setTextInputPosition(null);
    setDrawingText("");
  }, []);

  const applyDrawingTool = useCallback((tool: DrawingTool) => {
    activeDrawingToolRef.current = tool;
    setActiveDrawingTool(tool);
  }, []);

  const changeDrawingToolFromToolbar = useCallback((tool: DrawingTool) => {
    const controller = drawingControllerRef.current;
    if (controller) controller.changeTool(tool);
    else {
      clearDrawingTextEntry();
      applyDrawingTool(tool);
    }
  }, [applyDrawingTool, clearDrawingTextEntry]);

  const last = candles.at(-1);
  const first = candles.at(0);
  const change = last && first ? ((last.close - first.open) / first.open) * 100 : 0;
  const lineCount = useMemo(() => pine.split("\n").map((_, i) => i + 1).join("\n"), [pine]);
  const recentMarkets = useMemo(
    () => recentSymbols.map((recent) => resolveRecentMarket(recent, marketCatalog) as MarketOption),
    [marketCatalog, recentSymbols],
  );
  const panelCollapsed = isPanelCollapsed(panelHeight);
  const visibleConsoleHeight = Math.min(consoleHeight, Math.max(20, panelHeight - COLLAPSED_PANEL_HEIGHT - 43));
  const drawingCursorClass = activeDrawingTool === "select"
    ? "drawing-cursor-select"
    : activeDrawingTool === "crosshair" ? "drawing-cursor-crosshair" : "drawing-cursor-placement";

  const openPineEditorTab = () => {
    savePineSource(pine);
    window.open("/pine-editor", "_blank", "noopener,noreferrer");
  };

  const beginMarketLoad = () => {
    setLoading(true);
    setMarketStatus({ phase: "loading", notice: null, error: null });
    setConnected(false);
  };

  const closeSymbolSearch = () => {
    setSourcesSheetOpen(false);
    setSymbolSearchOpen(false);
  };

  const selectMarket = (market: MarketOption) => {
    beginMarketLoad();
    setChartVenue(market.venue);
    setSymbol(market.symbol);
    closeSymbolSearch();
    setRecentSymbols((current) => {
      const next = nextRecentSymbols(current, formatMarketId(market.venue, market.symbol));
      try {
        window.localStorage.setItem("pilab-recent-symbols", JSON.stringify(next));
      } catch {
        // Recent symbols remain available in React state for this session.
      }
      return next;
    });
  };

  useEffect(() => {
    let active = true;
    loadAllMarketCatalogs()
      .then((markets) => {
        if (active && markets.length) setMarketCatalog(markets as MarketOption[]);
      })
      .catch(() => { /* The fallback catalog remains usable offline. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!chartHost.current) return;
    const chart = createChart(chartHost.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0b1017" }, textColor: "#748094", fontFamily: "var(--font-geist-mono)", fontSize: 10 },
      grid: { vertLines: { color: "#17202b" }, horzLines: { color: "#17202b" } },
      rightPriceScale: { borderColor: "#27313f", scaleMargins: { top: 0.09, bottom: 0.08 } },
      timeScale: { borderColor: "#27313f", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7 },
      crosshair: { vertLine: { color: "#59677a", width: 1, labelBackgroundColor: "#344154" }, horzLine: { color: "#59677a", width: 1, labelBackgroundColor: "#344154" } },
      handleScale: true, handleScroll: true,
    });
    const candleSeries = chart.addSeries(CandlestickSeries, { upColor: "#53c990", downColor: "#e76770", wickUpColor: "#53c990", wickDownColor: "#e76770", borderVisible: false });
    const drawingPrimitive = new DrawingPrimitive();
    const drawingStorage = drawingStorageRef.current ?? createDrawingStorage();
    drawingStorageRef.current = drawingStorage;
    const drawingSaveScheduler = new DrawingSaveScheduler(drawingStorage);
    candleSeries.attachPrimitive(drawingPrimitive);
    const replaceDrawings = (next: Drawing[], kind: DrawingChangeKind) => {
      drawingsRef.current = next;
      setDrawings(next);
      if (kind === "commit") {
        const market = drawingMarketRef.current;
        drawingSaveScheduler.schedule(market.venue, market.symbol, next);
      }
    };
    const drawingController = new DrawingController({
      chart,
      series: candleSeries,
      getDrawings: () => drawingsRef.current,
      replaceDrawings,
      getTool: () => activeDrawingToolRef.current,
      setTool: applyDrawingTool,
      setSession: setDrawingSession,
      onCancel: clearDrawingTextEntry,
      requestRender: () => drawingPrimitive.setState(drawingsRef.current, drawingController.getSession(), candleTimesRef.current),
      requestText: (point) => {
        const x = chart.timeScale().timeToCoordinate(point.time);
        const y = candleSeries.priceToCoordinate(point.price);
        setTextAnchor(point);
        setTextInputPosition(x == null || y == null ? null : { x, y });
        setDrawingText("");
      },
      hitTest: (point) => drawingPrimitive.hitTestDrawing(point),
    });
    const fastSeries = chart.addSeries(LineSeries, { color: "#62d6e8", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const slowSeries = chart.addSeries(LineSeries, { color: "#f2c66d", lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    chartRef.current = chart; candleSeriesRef.current = candleSeries; fastSeriesRef.current = fastSeries; slowSeriesRef.current = slowSeries;
    drawingPrimitiveRef.current = drawingPrimitive;
    drawingControllerRef.current = drawingController;
    drawingSaveSchedulerRef.current = drawingSaveScheduler;
    drawingController.attach(chartHost.current);
    drawingPrimitive.setState(drawingsRef.current, drawingController.getSession(), candleTimesRef.current);
    return () => {
      drawingSaveScheduler.flush();
      drawingController.detach();
      candleSeries.detachPrimitive(drawingPrimitive);
      if (drawingControllerRef.current === drawingController) drawingControllerRef.current = null;
      if (drawingPrimitiveRef.current === drawingPrimitive) drawingPrimitiveRef.current = null;
      if (drawingSaveSchedulerRef.current === drawingSaveScheduler) drawingSaveSchedulerRef.current = null;
      chart.remove();
      chartRef.current = null; candleSeriesRef.current = null; fastSeriesRef.current = null; slowSeriesRef.current = null;
    };
  }, [applyDrawingTool, clearDrawingTextEntry]);

  useEffect(() => {
    candleSeriesRef.current?.setData(candles);
    fastSeriesRef.current?.setData(showFast ? calculateEma(candles, 9) : []);
    slowSeriesRef.current?.setData(showSlow ? calculateEma(candles, 21) : []);
    const candleTimes = candles.map((candle) => Number(candle.time)).filter(Number.isFinite).sort((a, b) => a - b);
    candleTimesRef.current = candleTimes;
    drawingControllerRef.current?.setCandleTimes(candleTimes);
    drawingPrimitiveRef.current?.setState(
      drawingsRef.current,
      drawingControllerRef.current?.getSession() ?? initialDrawingSession,
      candleTimes,
    );
  }, [candles, showFast, showSlow]);

  useEffect(() => {
    drawingSaveSchedulerRef.current?.flush();
    drawingControllerRef.current?.cancel();
    const market = chartDrawingMarket(symbol, chartVenue);
    drawingMarketRef.current = market;
    const storage = drawingStorageRef.current ?? createDrawingStorage();
    drawingStorageRef.current = storage;
    const loaded = loadDrawings(storage, market.venue, market.symbol);
    drawingsRef.current = loaded;
    drawingPrimitiveRef.current?.setState(
      loaded,
      drawingControllerRef.current?.getSession() ?? initialDrawingSession,
      candleTimesRef.current,
    );
    const timer = window.setTimeout(() => {
      clearDrawingTextEntry();
      setDrawings(loaded);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [chartVenue, clearDrawingTextEntry, symbol]);

  useEffect(() => {
    let cancelled = false;
    let stream: { close(): void } | null = null;
    let pollTimer = 0;
    let liveOpened = false;

    const applyLiveCandle = (candle: MarketCandle) => {
      if (cancelled) return;
      setCandles((current) => mergeLiveCandle(current, toChartCandle(candle)));
    };

    const startPolling = (venue: MarketVenue) => {
      if (pollTimer) window.clearInterval(pollTimer);
      const poll = async () => {
        try {
          const response = await fetch(`/api/klines?exchange=${venue}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=2`);
          if (!response.ok || cancelled) return;
          const payload = await response.json() as { candles?: MarketCandle[] };
          const last = payload.candles?.at(-1);
          if (last) applyLiveCandle(last);
        } catch {
          // Keep the last good candles visible; polling retries on the next interval.
        }
      };
      pollTimer = window.setInterval(poll, 8000);
      if (!cancelled && !liveOpened) {
        setConnected(true);
        setMarketStatus((current) => ({ ...current, phase: "polling" }));
      }
    };

    loadChartHistory(chartVenue, symbol, interval)
      .then((result) => {
        if (cancelled) return;
        setActiveVenue(result.venue);
        setDerivativesExchange(result.venue);
        setCandles(result.candles.map(toChartCandle));
        setLoading(false);
        setMarketStatus({ phase: "polling", notice: result.notice, error: null });
        requestAnimationFrame(() => chartRef.current?.timeScale().fitContent());
        stream = openKlineStream(result.venue, symbol, interval, {
          onCandle: applyLiveCandle,
          onOpen: () => {
            if (cancelled) return;
            liveOpened = true;
            if (pollTimer) { window.clearInterval(pollTimer); pollTimer = 0; }
            setConnected(true);
            setMarketStatus((current) => ({ ...current, phase: "live", error: null }));
          },
          onClose: () => {
            if (cancelled) return;
            setConnected(false);
            startPolling(result.venue);
          },
          onError: () => {
            if (cancelled) return;
            setConnected(false);
            startPolling(result.venue);
          },
        });
        window.setTimeout(() => {
          if (!cancelled && !liveOpened) startPolling(result.venue);
        }, 4000);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        setConnected(false);
        setMarketStatus({
          phase: "error",
          notice: null,
          error: error instanceof Error ? error.message : "Live market data is unavailable.",
        });
      });

    return () => {
      cancelled = true;
      if (pollTimer) window.clearInterval(pollTimer);
      stream?.close();
      setConnected(false);
    };
  }, [symbol, interval, chartVenue]);

  useEffect(() => {
    let active = true;
    const load = () => fetch(`/api/derivatives?exchange=${derivativesExchange}&symbol=${encodeURIComponent(symbol.replace("USDT", "/USDT:USDT"))}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("Derivatives feed unavailable")))
      .then((data) => { if (active) setDerivatives(data); })
      .catch(() => { if (active) setDerivatives(null); });
    load(); const timer = window.setInterval(load, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [symbol, derivativesExchange]);

  useEffect(() => {
    const price = last?.close;
    if (!price) return;
    const timer = window.setTimeout(() => setAlerts((items) => items.map((alert) => {
        if (alert.triggered) return alert;
        const hit = alert.direction === "above" ? price >= alert.price : price <= alert.price;
        if (hit && "Notification" in window && Notification.permission === "granted") {
          new Notification(`${symbol} price alert`, { body: `${formatPrice(price)} crossed ${alert.direction} ${formatPrice(alert.price)}` });
        }
        return hit ? { ...alert, triggered: true } : alert;
      })), 0);
    return () => clearTimeout(timer);
  }, [last?.close, symbol]);

  const runPine = useCallback(async () => {
    setRunning(true);
    try {
      const { transpile } = await import("@/lib/pine/transpiler.js");
      const result = transpile(pine);
      if (!result.success || !result.code) throw new Error(result.error || "Pine compilation failed");
      const moduleUrl = URL.createObjectURL(new Blob([result.code], { type: "text/javascript" }));
      try {
        const generatedScript = await import(/* @vite-ignore */ moduleUrl);
        const data = { open: candles.map((c) => c.open), high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close), volume: candles.map((c) => c.volume ?? 0), time: candles.map((c) => Number(c.time) * 1000) };
        const analysisGlobals = globalThis as typeof globalThis & { open_interest: number | null; funding_rate: number | null; mark_price: number | null; index_price: number | null };
        analysisGlobals.open_interest = derivatives?.openInterestValue ?? null;
        analysisGlobals.funding_rate = derivatives?.fundingRate ?? null;
        analysisGlobals.mark_price = derivatives?.markPrice ?? null;
        analysisGlobals.index_price = derivatives?.indexPrice ?? null;
        const runtime = generatedScript.run(data);
        const plots = Object.values(runtime.plots || {}) as PinePlot[];
        setPinePlots(plots);
        const seriesData = (values: (number | null)[]) => values.map((value, i) => value == null ? null : { time: candles[i].time, value }).filter(Boolean) as LineData<Time>[];
        if (plots[0]?.data) fastSeriesRef.current?.setData(seriesData(plots[0].data));
        if (plots[1]?.data) slowSeriesRef.current?.setData(seriesData(plots[1].data));
        setPineApplied(true);
        setConsoleKind("success"); setConsoleText(`Compiled successfully · ${candles.length} bars · ${plots.length} plot${plots.length === 1 ? "" : "s"} · ${runtime.alerts?.length || 0} alert events`);
      } finally { URL.revokeObjectURL(moduleUrl); }
    } catch (error) { setConsoleKind("error"); setConsoleText(error instanceof Error ? error.message : "Pine execution failed"); }
    finally { setRunning(false); }
  }, [pine, candles, derivatives]);

  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        runPine();
      }
      if (event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setShowAlertForm(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSymbolSearchOpen(true);
      }
      if (event.key === "Escape") {
        handleWorkspaceEscape({
          searchOpen: symbolSearchOpen,
          sourcesOpen: sourcesSheetOpen,
          event,
          closeSources: () => setSourcesSheetOpen(false),
          closeSearch: closeSymbolSearch,
          cancelDrawing: () => {
            drawingControllerRef.current?.cancel();
            if (!drawingControllerRef.current) clearDrawingTextEntry();
          },
        });
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (isTextEditingElement(event.target)) return;
        if (drawingControllerRef.current?.deleteSelected()) event.preventDefault();
      }
    };
    window.addEventListener("keydown", handleWorkspaceShortcut, true);
    return () => window.removeEventListener("keydown", handleWorkspaceShortcut, true);
  }, [clearDrawingTextEntry, runPine, sourcesSheetOpen, symbolSearchOpen]);

  const commitDrawingText = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!drawingText.trim()) return;
    if (!drawingControllerRef.current?.commitText(drawingText)) return;
    clearDrawingTextEntry();
  };

  const createAlert = () => {
    const price = Number(alertPrice); if (!Number.isFinite(price)) return;
    setAlerts((items) => [...items, { id: Date.now(), direction: alertDirection, price, triggered: false }]);
    setAlertPrice(""); setShowAlertForm(false);
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  };

  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (pointer: PointerEvent) => {
      const nextHeight = resolvePanelHeight(window.innerHeight, pointer.clientY);
      if (!isPanelCollapsed(nextHeight)) lastExpandedPanelHeightRef.current = nextHeight;
      setPanelHeight(nextHeight);
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };

  const startConsoleResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (pointer: PointerEvent) => {
      const bounds = editorBodyRef.current?.getBoundingClientRect();
      if (bounds) setConsoleHeight(Math.max(20, Math.min(bounds.height - 43, bounds.bottom - pointer.clientY)));
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };

  const resizePanelWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (panelCollapsed && event.key === "ArrowUp") {
      setPanelHeight(lastExpandedPanelHeightRef.current);
      return;
    }
    setPanelHeight((height) => {
      const nextHeight = snapPanelHeight(height + (event.key === "ArrowUp" ? 20 : -20), window.innerHeight);
      if (!isPanelCollapsed(nextHeight)) lastExpandedPanelHeightRef.current = nextHeight;
      return nextHeight;
    });
  };

  const resizeConsoleWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault(); setConsoleHeight((height) => Math.max(20, Math.min(panelHeight - COLLAPSED_PANEL_HEIGHT - 43, height + (event.key === "ArrowUp" ? 16 : -16))));
  };

  const analyzeMarket = async () => {
    const question = aiQuestion.trim();
    if (!question || !aiEndpoint.trim() || !aiModel.trim()) {
      setAiError("Add a compatible endpoint and model ID, then enter a question.");
      return;
    }
    setAiRunning(true); setAiError("");
    setAiMessages((items) => [...items, { id: (items.at(-1)?.id ?? 0) + 1, role: "user", content: question }]);
    try {
      const ema9 = calculateEma(candles, 9);
      const ema21 = calculateEma(candles, 21);
      const context = {
        capturedAt: new Date().toISOString(),
        market: { symbol, venue: activeVenue, contract: "USDT perpetual", timeframe: INTERVALS.find((item) => item.value === interval)?.label, lastPrice: last?.close ?? null },
        candles: candles.slice(-120).map((candle) => ({ time: new Date(Number(candle.time) * 1000).toISOString(), open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume ?? null })),
        indicators: {
          builtIn: { ema9: ema9.at(-1)?.value ?? null, ema21: ema21.at(-1)?.value ?? null, ema9Visible: showFast, ema21Visible: showSlow },
          customPine: { source: pine, plots: pinePlots.map((plot, index) => ({ title: plot.title || `Plot ${index + 1}`, recentValues: plot.data?.slice(-30) ?? [] })) },
        },
        derivatives: derivatives ? { sourceExchange: derivativesExchange, openInterestUsd: derivatives.openInterestValue, openInterestBase: derivatives.openInterestAmount, fundingRate: derivatives.fundingRate, markPrice: derivatives.markPrice, indexPrice: derivatives.indexPrice, nextFundingTimestamp: derivatives.nextFundingTimestamp } : null,
      };
      const response = await fetch("/api/ai/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: aiEndpoint, apiKey: aiKey, model: aiModel, question, context }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "AI analysis failed");
      setAiMessages((items) => [...items, { id: (items.at(-1)?.id ?? 0) + 1, role: "assistant", content: payload.analysis }]);
      setAiQuestion("");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "AI analysis failed");
    } finally { setAiRunning(false); }
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">π</span><span>πlab</span><small>crypto workspace</small></div>
        <button className="market-switcher" aria-label="Search symbols (Cmd/Ctrl+K)" title="Search symbols (Cmd/Ctrl+K)" onClick={() => setSymbolSearchOpen(true)}><span className="coin-badge">{symbol === "BTCUSDT" ? "₿" : symbol.slice(0, 1)}</span><span className="market-copy"><strong>{symbol.replace("USDT", " / USDT")}</strong><span>Perpetual · {venueLabel(chartVenue)}</span></span><span className="market-chevron">⌄</span></button>
        <div className="top-actions"><button className="ai-button" onClick={() => setAiOpen(true)}><span>✦</span> AI Analyst <em>LAB</em></button></div>
      </header>

      <section className="workspace">
        <section className="main-area" style={{ gridTemplateRows: `45px minmax(220px, 1fr) ${panelHeight}px` }}>
          <div className="chart-toolbar">
            <div className="toolbar-cluster">
              <button className="toolbar-symbol-button" aria-label="Search symbols (Cmd/Ctrl+K)" title="Search symbols (Cmd/Ctrl+K)" onClick={() => setSymbolSearchOpen(true)}><strong>{symbol.replace("USDT", " / USDT")}</strong><span>⌄</span></button><span className="toolbar-separator" />
              {INTERVALS.map((item) => <button key={item.value} onClick={() => { beginMarketLoad(); setInterval(item.value); }} className={`time-button ${interval === item.value ? "active" : ""}`}>{item.label}</button>)}
            </div>
            <div className="toolbar-cluster"><button className="chart-alert-button" aria-label="Create alert (Alt+A)" title="Create alert (Alt+A)" onClick={() => setShowAlertForm(true)}><span aria-hidden="true">◷</span> Alert</button><span className="toolbar-separator" /><select aria-label="Chart market venue" className="toolbar-venue-select" value={chartVenue} onChange={(event) => { const venue = event.target.value; if (!isMarketVenue(venue)) return; beginMarketLoad(); setChartVenue(venue); }}>{venueOptions()}</select><span className="toolbar-separator" /><span className={`live-dot ${marketStatus.phase === "error" ? "error" : connected ? "online" : marketStatus.phase === "polling" ? "polling" : ""}`} /><span className="live-copy">{marketStatus.phase === "error" ? "Market error" : marketStatus.phase === "live" ? `Live · ${venueLabel(activeVenue)}` : marketStatus.phase === "polling" ? `Polling · ${venueLabel(activeVenue)}` : "Connecting"}</span><span className="toolbar-separator" /><button className="time-button" onClick={() => chartRef.current?.timeScale().fitContent()}>Fit</button></div>
          </div>

          <div className="chart-region">
            <DrawingToolbar activeTool={activeDrawingTool} onToolChange={changeDrawingToolFromToolbar} />
            <div className={`chart-stage ${drawingCursorClass}`} data-drawing-phase={drawingSession.phase} data-drawing-count={drawings.length}>
            <div className="chart-legend">
              <div className="market-head"><h1>{symbol.replace("USDT", "/USDT")} Perpetual</h1><span className="exchange-pill">{venueLabel(activeVenue).toUpperCase()}</span></div>
              <div className="quote-line"><span className="price">{formatPrice(last?.close ?? null)}</span><span className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</span><span>H {formatPrice(last?.high ?? null)}</span><span>L {formatPrice(last?.low ?? null)}</span></div>
              {showFast && <div className="indicator-label"><span><i style={{ background: "var(--cyan)" }} />EMA 9</span><button className="indicator-remove" aria-label="Remove EMA 9 indicator" title="Remove indicator" onClick={() => setShowFast(false)}>×</button></div>}
              {showSlow && <div className="indicator-label"><span><i style={{ background: "var(--amber)" }} />EMA 21</span><button className="indicator-remove" aria-label="Remove EMA 21 indicator" title="Remove indicator" onClick={() => setShowSlow(false)}>×</button></div>}
            </div>
            <div className="chart-canvas" ref={chartHost} />
            {textAnchor && textInputPosition && <form className="drawing-text-input" style={{ left: textInputPosition.x, top: textInputPosition.y }} onSubmit={commitDrawingText}>
              <label><span>Chart label</span>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus -- Text placement is a deliberate inline-edit action and should accept typing immediately. */}
                <input autoFocus value={drawingText} onChange={(event) => setDrawingText(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  drawingControllerRef.current?.cancel();
                  if (!drawingControllerRef.current) clearDrawingTextEntry();
                }
              }} /></label>
            </form>}
            {marketStatus.notice && candles.length > 0 && <div className="market-banner" role="status">{marketStatus.notice} Switch venue to try another feed.</div>}
            {loading && !marketStatus.error && <div className="chart-loading">Loading market data…</div>}
            {marketStatus.error && !candles.length && <div className="chart-loading market-feed-error" role="alert">{marketStatus.error}</div>}
            </div>
          </div>

          <section className={`bottom-panel ${panelCollapsed ? "collapsed" : ""}`}>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- ARIA separators become interactive when focusable and expose aria-valuenow. */}
            <div className="panel-resize-handle" role="separator" aria-label="Resize Pine editor panel" aria-orientation="horizontal" aria-valuemin={COLLAPSED_PANEL_HEIGHT} aria-valuemax={700} aria-valuenow={Math.round(panelHeight)} tabIndex={0} onPointerDown={startPanelResize} onKeyDown={resizePanelWithKeyboard} onDoubleClick={() => {
              if (panelCollapsed) setPanelHeight(lastExpandedPanelHeightRef.current);
              else { lastExpandedPanelHeightRef.current = panelHeight; setPanelHeight(COLLAPSED_PANEL_HEIGHT); }
            }}><span /></div>
            <div className="panel-header"><div className="tabs"><button className={`tab-button ${activeTab === "pine" ? "active" : ""}`} onClick={() => { setActiveTab("pine"); if (panelCollapsed) setPanelHeight(lastExpandedPanelHeightRef.current); }}>Pine Editor</button><button className={`tab-button ${activeTab === "console" ? "active" : ""}`} onClick={() => { setActiveTab("console"); if (panelCollapsed) setPanelHeight(lastExpandedPanelHeightRef.current); }}>Console</button></div><div className="editor-actions">{panelCollapsed ? <button className="panel-collapse-button" aria-label="Expand bottom panel" title="Expand bottom panel" onClick={() => setPanelHeight(lastExpandedPanelHeightRef.current)}>⌃</button> : <><button className="popout-button" aria-label="Open Pine editor in new tab" title="Open Pine editor in new tab" onClick={openPineEditorTab}>↗ New tab</button><button className="run-button" onClick={runPine} disabled={running} title="Add or update script on chart (Cmd/Ctrl+Enter)">{running ? "Applying…" : pineApplied ? "↻ Update on chart" : "▶ Add to chart"}</button><button className="panel-collapse-button" aria-label="Collapse bottom panel" title="Collapse bottom panel" onClick={() => { lastExpandedPanelHeightRef.current = panelHeight; setPanelHeight(COLLAPSED_PANEL_HEIGHT); }}>⌄</button></>}</div></div>
            {!panelCollapsed && <div className="editor-body" ref={editorBodyRef} style={{ gridTemplateRows: `minmax(36px, 1fr) 7px ${visibleConsoleHeight}px` }}>
              <div className="code-wrap"><pre className="line-numbers">{lineCount}</pre><textarea aria-label="Pine Script editor" className="code-editor" spellCheck={false} value={pine} onChange={(e) => savePineSource(e.target.value)} /></div>
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- ARIA separators become interactive when focusable and expose aria-valuenow. */}
              <div className="editor-splitter" role="separator" aria-label="Resize compiler console" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={Math.max(20, panelHeight - COLLAPSED_PANEL_HEIGHT - 43)} aria-valuenow={Math.round(visibleConsoleHeight)} tabIndex={0} onPointerDown={startConsoleResize} onKeyDown={resizeConsoleWithKeyboard} onDoubleClick={() => setConsoleHeight(82)}><span /></div>
              <aside className="console"><strong>Compiler output</strong><span className={consoleKind === "normal" ? "" : consoleKind}>{consoleText}</span></aside>
            </div>}
          </section>
        </section>

        <aside className="right-panel">
          <section className="side-section">
            <div className="section-title-row"><h2 className="section-kicker">Derivatives pulse</h2><select aria-label="Derivatives exchange" value={derivativesExchange} onChange={(event) => { const venue = event.target.value; if (isMarketVenue(venue)) setDerivativesExchange(venue); }}>{venueOptions()}</select></div>
            <div className="metric-grid">
              <div className="metric-card"><span>Open interest</span><strong>${formatCompact(derivatives?.openInterestValue ?? null)}</strong><small>{formatCompact(derivatives?.openInterestAmount ?? null)} {symbol.replace("USDT", "")}</small></div>
              <div className="metric-card"><span>Funding / 8h</span><strong className={(derivatives?.fundingRate ?? 0) >= 0 ? "positive" : "negative"}>{derivatives?.fundingRate == null ? "—" : `${(derivatives.fundingRate * 100).toFixed(4)}%`}</strong><small>{derivatives?.nextFundingTimestamp ? `Next ${new Date(derivatives.nextFundingTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Current rate"}</small></div>
              <div className="metric-card"><span>Mark price</span><strong>{formatPrice(derivatives?.markPrice ?? null)}</strong><small>Fair price</small></div>
              <div className="metric-card"><span>Basis</span><strong className={((derivatives?.markPrice ?? 0) - (derivatives?.indexPrice ?? 0)) >= 0 ? "positive" : "negative"}>{derivatives?.markPrice && derivatives?.indexPrice ? `${(((derivatives.markPrice - derivatives.indexPrice) / derivatives.indexPrice) * 100).toFixed(3)}%` : "—"}</strong><small>Mark vs index</small></div>
            </div>
            <div className="data-source"><span>Pine: open_interest · funding_rate</span><code>CCXT · {derivatives?.exchange || derivativesExchange}</code></div>
          </section>
          <section className="side-section">
            <h2 className="section-kicker">Indicators</h2>
            <div className="indicator-row"><div className="indicator-copy"><strong>EMA 9</strong><span>Built-in · close</span></div><button aria-label="Toggle EMA 9" className={`metric-toggle ${showFast ? "active" : ""}`} onClick={() => setShowFast(!showFast)} /></div>
            <div className="indicator-row"><div className="indicator-copy"><strong>EMA 21</strong><span>Built-in · close</span></div><button aria-label="Toggle EMA 21" className={`metric-toggle ${showSlow ? "active" : ""}`} onClick={() => setShowSlow(!showSlow)} /></div>
            <div className="indicator-row"><div className="indicator-copy"><strong>Custom Pine</strong><span>Editor output · overlay</span></div><button aria-label="Run custom Pine" className="metric-toggle active" onClick={runPine} /></div>
          </section>
          <section className="side-section">
            <h2 className="section-kicker">Alerts</h2>
            {alerts.length === 0 && <div style={{ color: "var(--faint)", fontSize: 10, lineHeight: 1.5 }}>No active alerts for this market.</div>}
            {alerts.map((alert) => <div className="alert-row" key={alert.id}><div className="alert-copy"><strong>{symbol} {alert.direction} {formatPrice(alert.price)}</strong><span className={alert.triggered ? "positive" : ""}>{alert.triggered ? "Triggered" : "Watching live price"}</span></div><button className="tool-button" style={{ width: 25, height: 25 }} onClick={() => setAlerts((items) => items.filter((item) => item.id !== alert.id))}>×</button></div>)}
            {showAlertForm ? <div className="alert-form"><select value={alertDirection} onChange={(e) => setAlertDirection(e.target.value as "above" | "below")}><option value="above">Crosses above</option><option value="below">Crosses below</option></select><input aria-label="Alert price" inputMode="decimal" placeholder={last ? formatPrice(last.close) : "Price"} value={alertPrice} onChange={(e) => setAlertPrice(e.target.value)} /><button onClick={createAlert}>Create price alert</button></div> : <button className="add-alert" onClick={() => setShowAlertForm(true)}>＋ Create alert</button>}
          </section>
        </aside>
      </section>
      <SymbolSearchDialog
        open={symbolSearchOpen}
        sourcesOpen={sourcesSheetOpen}
        catalog={marketCatalog}
        recentMarkets={recentMarkets}
        onSourcesOpenChange={setSourcesSheetOpen}
        onClose={closeSymbolSearch}
        onSelectMarket={selectMarket}
      />
      {aiOpen && <button className="ai-backdrop" aria-label="Close AI Analyst" onClick={() => setAiOpen(false)} />}
      <aside className={`ai-drawer ${aiOpen ? "open" : ""}`} aria-hidden={!aiOpen} aria-label="πlab AI Analyst">
        <div className="ai-header">
          <div><span className="ai-orb">✦</span><strong>πlab AI Analyst</strong><small>Experimental · current chart context</small></div>
          <button aria-label="Close AI Analyst" onClick={() => setAiOpen(false)}>×</button>
        </div>
        <div className="ai-context-strip">
          <span>{symbol}</span><span>{INTERVALS.find((item) => item.value === interval)?.label}</span><span>{candles.length} candles</span><span>{pinePlots.length || 2} indicators</span>
        </div>
        <section className="ai-connection">
          <div className="ai-section-title"><span>Model connection</span><code>OpenAI-compatible</code></div>
          <label>Endpoint<input type="url" placeholder="https://your-host/v1/chat/completions" value={aiEndpoint} onChange={(event) => setAiEndpoint(event.target.value)} /></label>
          <div className="ai-field-row">
            <label>Model ID<input placeholder="your-model-id" value={aiModel} onChange={(event) => setAiModel(event.target.value)} /></label>
            <label>API key<input type="password" autoComplete="off" placeholder="Session only" value={aiKey} onChange={(event) => setAiKey(event.target.value)} /></label>
          </div>
          <p>The key stays in this browser session and is sent only when you analyze.</p>
        </section>
        <div className="ai-messages" aria-live="polite">
          {aiMessages.length === 0 && <div className="ai-empty"><span>✦</span><strong>Chart context is ready</strong><p>The model receives 120 recent OHLCV candles, EMA outputs, custom Pine plots, open interest, funding, mark price, and index price.</p></div>}
          {aiMessages.map((message) => <article key={message.id} className={`ai-message ${message.role}`}><small>{message.role === "assistant" ? "πlab AI" : "You"}</small><div>{message.content}</div></article>)}
          {aiRunning && <article className="ai-message assistant thinking"><small>πlab AI</small><div><i /><i /><i /> Analyzing chart context…</div></article>}
        </div>
        <div className="ai-composer">
          <div className="ai-quick-prompts"><button onClick={() => setAiQuestion("What is the current trend, momentum, and likely invalidation level?")}>Trend</button><button onClick={() => setAiQuestion("Do funding and open interest confirm or contradict the price move?")}>OI + funding</button><button onClick={() => setAiQuestion("Explain the current Pine indicator outputs and any conflicts between them.")}>Indicators</button></div>
          <textarea aria-label="Ask AI about the current chart" placeholder="Ask about this chart…" value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") analyzeMarket(); }} />
          {aiError && <div className="ai-error">{aiError}</div>}
          <div className="ai-send-row"><span>⌘ Enter to send · analysis only</span><button onClick={analyzeMarket} disabled={aiRunning}>{aiRunning ? "Analyzing…" : "Analyze current chart"}</button></div>
        </div>
      </aside>
      <footer className="footer"><div className="status-group"><span className="tiny-dot" /><span>{venueLabel(activeVenue)} public feed</span><span>CCXT normalized</span><span>Pine v5 subset</span><span>AI context ready</span></div><span>UTC · Data for analysis only</span></footer>
    </main>
  );
}
