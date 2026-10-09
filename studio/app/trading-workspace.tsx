"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  BaselineSeries, CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, LineStyle, LineType,
  type CandlestickData, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi,
  type LineData, type MouseEventParams, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from "lightweight-charts";
import {
  applyIndicatorPaneStretch,
  CVD_PANE_EMPTY,
  CVD_PANE_STORAGE_KEY,
  cvdPaneModel,
  indicatorPaneIndex,
  indicatorPaneStack,
  OI_PANE_EMPTY,
  OI_PANE_STORAGE_KEY,
  oiPaneModel,
  notifyPanePrefs,
  panePrefsAreLive,
  readClientPaneFlag,
  readStoredFlag,
  subscribePanePrefs,
  toBarTimeSeconds,
  writeStoredFlag,
} from "@/lib/chart-indicator-panes.ts";
import { DrawingController, initialDrawingSession, type DrawingChangeKind, type DrawingSession } from "@/lib/drawings/controller.ts";
import { DrawingPrimitive } from "@/lib/drawings/primitive.ts";
import { DrawingSaveScheduler, createDrawingStorage, loadDrawings, type DrawingStorage } from "@/lib/drawings/store.ts";
import type { Drawing, DrawingPoint, DrawingTool } from "@/lib/drawings/types.ts";
import { chartDrawingMarket, type ChartDrawingMarket } from "@/lib/drawings/workspace-market.ts";
import { handleWorkspaceEscape } from "@/lib/drawings/workspace-shortcuts.ts";
import { LargeTradeMarkersPrimitive } from "@/lib/large-trade-markers-primitive.ts";
import { LargeOrderSrPrimitive } from "@/lib/large-order-sr-primitive.ts";
import { LiqHeatmapPrimitive } from "@/lib/liq-heatmap-primitive.ts";
import {
  LIQ_HEATMAP_STORAGE_KEY,
  LIQ_HEATMAP_UNAVAILABLE,
  findLiqBandAtPrice,
  formatLiqBandTooltip,
  liqSymbolsMatch,
  loadLiqHeatmapBands,
  type LiqBand,
} from "@/lib/liq-heatmap.ts";
import {
  DEFAULT_MIN_WALL_NOTIONAL_USD,
  LARGE_ORDER_SR_EMPTY,
  LARGE_ORDER_SR_STORAGE_KEY,
  clampMinNotional,
  filterWallsForRange,
  loadLargeOrderWalls,
  priceSpanFromVisibleRange,
  readStoredMinNotional,
  readStoredWallRange,
  readStoredWallTracker,
  trackOrderWalls,
  writeStoredMinNotional,
  writeStoredWallRange,
  writeStoredWallTracker,
  type PriceSpan,
  type TrackedWall,
  type WallRangeSettings,
} from "@/lib/market-depth.ts";
import {
  LARGE_TRADES_EMPTY,
  LARGE_TRADES_STORAGE_KEY,
  loadLargeTrades,
  type LargeTrade,
} from "@/lib/market-trades.ts";
import { summarizeCvdWindow, type CvdBar, type CvdSnapshot } from "@/lib/market-cvd.ts";
import { loadAllMarketCatalogs, loadChartHistory, loadOlderCandles, mergeLiveCandle, openKlineStream, prependOlderCandles } from "@/lib/market-feed.ts";
import { CHART_BAR_COUNT_OPTIONS, DEFAULT_CHART_BARS, LAZY_LOAD_BARS, MAX_LOADED_BARS } from "@/lib/kline-history.ts";
import { readBarCountPref, subscribeBarCountPref, writeBarCountPref } from "@/lib/bar-count-pref.ts";
import type { OiHistorySnapshot } from "@/lib/market-oi.ts";
import { loadDerivativesPulse, loadOpenInterestSeries, loadOrderFlowCvd } from "@/lib/market-pulse.ts";
import { fallbackCatalog, formatMarketId, nextRecentSymbols, parseMarketId, resolveRecentMarket } from "@/lib/market-symbols.js";
import { isMarketVenue, MARKET_VENUES, sanitizeMarketCopy, venueLabel, type MarketCandle, type MarketVenue } from "@/lib/market-venues.ts";
import { COLLAPSED_PANEL_HEIGHT, DEFAULT_PANEL_HEIGHT, isPanelCollapsed, resolvePanelHeight, snapPanelHeight } from "@/lib/panel-layout.js";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_KEYBOARD_STEP,
  SIDE_PANEL_MIN_WIDTH,
  clampSidePanelWidth,
  maxSidePanelWidth,
  readSidePanelPrefs,
  resolveSidePanelDrag,
  writeSidePanelPrefs,
} from "@/lib/side-panel-layout.js";
import { legendEntries, studyDefinition, type StudyId } from "@/lib/chart-studies.ts";
import { buildPineRenderModel, describePineModel, pineModelHasOutput, type PineMarkerModel, type PineRenderModel, type PineRuntimeOutput } from "@/lib/pine-chart-model.ts";
import { PineOverlayPrimitive } from "@/lib/pine-overlay-primitive.ts";
import { ChartStudyLegend, type ChartLegendRow } from "@/components/chart-study-legend";
import { IndicatorsMenu } from "@/components/indicators-menu";
import { applyTheme, currentDocumentTheme, subscribeTheme, type ThemeName } from "@/lib/theme.ts";
import { candleThemeOptions, chartPalette, chartThemeOptions } from "@/lib/chart-theme.ts";
import { AiAnalystDrawer } from "@/components/ai-analyst-drawer";
import { DrawingToolbar } from "@/components/drawing-toolbar";
import { LargeOrderDock } from "@/components/large-order-dock";
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
type MarketOption = SymbolSearchMarket;

function venueOptions() {
  return MARKET_VENUES.map((venue) => <option key={venue} value={venue}>{venueLabel(venue)}</option>);
}

const BOOK_WALL_RANGE: WallRangeSettings = { mode: "book", low: null, high: null };
let liveWallRangeSnapshot: WallRangeSettings = BOOK_WALL_RANGE;
let liveWallRangeToken = "book::";

function readLiveMinNotional(): number {
  if (!panePrefsAreLive()) return DEFAULT_MIN_WALL_NOTIONAL_USD;
  return readStoredMinNotional(window.localStorage);
}

function readLiveWallRange(): WallRangeSettings {
  if (!panePrefsAreLive()) return BOOK_WALL_RANGE;
  const next = readStoredWallRange(window.localStorage);
  const token = `${next.mode}:${next.low ?? ""}:${next.high ?? ""}`;
  if (token !== liveWallRangeToken) {
    liveWallRangeToken = token;
    liveWallRangeSnapshot = next;
  }
  return liveWallRangeSnapshot;
}

const INTERVALS: { label: string; value: Interval }[] = [
  { label: "1m", value: "1" }, { label: "5m", value: "5" }, { label: "15m", value: "15" },
  { label: "1H", value: "60" }, { label: "4H", value: "240" }, { label: "1D", value: "D" },
];
const CVD_SERIES_OPTIONS = {
  baseValue: { type: "price" as const, price: 0 },
  relativeGradient: true,
  topLineColor: "#53c990",
  topFillColor1: "rgba(83, 201, 144, 0.22)",
  topFillColor2: "rgba(83, 201, 144, 0.02)",
  bottomLineColor: "#e76770",
  bottomFillColor1: "rgba(231, 103, 112, 0.22)",
  bottomFillColor2: "rgba(231, 103, 112, 0.02)",
  lineWidth: 2 as const,
  priceLineVisible: false,
  lastValueVisible: true,
  priceFormat: { type: "volume" as const, precision: 2, minMove: 0.01 },
};
/** Bars in view right after a history load; older history is reached by scrolling / zooming out. */
const INITIAL_VISIBLE_BARS = 220;
/** Start fetching older bars when the left edge is within this many bars of the oldest loaded bar. */
const LAZY_LOAD_TRIGGER = 40;

const OI_SERIES_OPTIONS = {
  color: "#62d6e8",
  lineWidth: 2 as const,
  priceLineVisible: false,
  lastValueVisible: true,
  priceFormat: {
    type: "custom" as const,
    minMove: 1,
    formatter: (price: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(price),
  },
};
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
function formatSigned(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const compact = formatCompact(Math.abs(value));
  if (value > 0) return `+${compact}`;
  if (value < 0) return `-${compact}`;
  return compact;
}
function signedClass(value: number | null) {
  if (value == null || value === 0) return "";
  return value > 0 ? "positive" : "negative";
}
function CvdSpark({ bars }: { bars: CvdBar[] }) {
  if (bars.length < 2) return null;
  const values = bars.map((bar) => bar.cvd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 72;
  const height = 18;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return `${x},${y}`;
  }).join(" ");
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg className="cvd-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline fill="none" stroke={rising ? "var(--accent)" : "var(--red)"} strokeWidth="1.5" points={points} />
    </svg>
  );
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

const DERIVATIVES_SECTION_KEY = "th-section-derivatives-open";
const ORDER_FLOW_SECTION_KEY = "th-section-order-flow-open";

function readSectionOpen(key: string, fallback = true): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    return fallback;
  }
  return fallback;
}

function shortCopy(value: string | null | undefined, fallback = ""): string {
  return sanitizeMarketCopy(value) || fallback;
}

function SideSection({
  title,
  storageKey,
  extra,
  children,
}: {
  title: string;
  storageKey: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readSectionOpen(storageKey, true));
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, open ? "1" : "0"); } catch { /* ignore quota / private mode */ }
  }, [open, storageKey]);
  const panelId = `${storageKey}-body`;
  return (
    <section className={`side-section${open ? "" : " collapsed"}`}>
      <div className="section-title-row">
        <h2 className="section-kicker">
          <button type="button" className="section-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
            <span className={`section-chevron${open ? " open" : ""}`} aria-hidden="true">›</span>
            {title}
          </button>
        </h2>
        {extra}
      </div>
      <div id={panelId} hidden={!open}>{children}</div>
    </section>
  );
}

function useStoredFlag(key: string): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const value = useSyncExternalStore(
    subscribePanePrefs,
    () => readClientPaneFlag(window.localStorage, key, false),
    () => false,
  );
  const setValue = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const current = readStoredFlag(window.localStorage, key, false);
    writeStoredFlag(window.localStorage, key, typeof next === "function" ? next(current) : next);
    notifyPanePrefs();
  }, [key]);
  return [value, setValue];
}

function readLiveSidePanelWidth(): number {
  if (!panePrefsAreLive()) return SIDE_PANEL_DEFAULT_WIDTH;
  return readSidePanelPrefs(window.localStorage).width;
}

function readLiveSidePanelCollapsed(): boolean {
  if (!panePrefsAreLive()) return false;
  return readSidePanelPrefs(window.localStorage).collapsed;
}

function toChartMarkers(markers: readonly PineMarkerModel[]): SeriesMarker<Time>[] {
  return [...markers]
    .sort((left, right) => left.time - right.time)
    .map((marker) => ({
      time: marker.time as UTCTimestamp,
      position: marker.position,
      shape: marker.shape,
      color: marker.color,
      size: marker.size,
      ...(marker.text ? { text: marker.text } : {}),
    }));
}

function ThemeIcon({ theme }: { theme: ThemeName }) {
  // Shows the theme you would switch to: sun in dark mode, moon in light mode.
  return theme === "dark"
    ? (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" data-icon="sun">
        <circle cx="9" cy="9" r="3.2" />
        <path d="M9 1.8v1.6M9 14.6v1.6M1.8 9h1.6M14.6 9h1.6M3.9 3.9l1.1 1.1M13 13l1.1 1.1M3.9 14.1 5 13M13 5l1.1-1.1" />
      </svg>
    )
    : (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" data-icon="moon">
        <path d="M14.8 11.2A6.2 6.2 0 0 1 6.8 3.2a6.2 6.2 0 1 0 8 8Z" />
      </svg>
    );
}

function PanelRightIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" data-icon={collapsed ? "panel-expand" : "panel-collapse"}>
      <rect x="2" y="3" width="14" height="12" rx="2" />
      <path d="M11.5 3v12" />
      {collapsed ? <path d="m8 7-2 2 2 2" /> : <path d="m6 7 2 2-2 2" />}
    </svg>
  );
}

export function TradingWorkspace() {
  const chartHost = useRef<HTMLDivElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const lastExpandedPanelHeightRef = useRef(DEFAULT_PANEL_HEIGHT);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fastSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const slowSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cvdSeriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const oiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const pineSeriesRef = useRef<ISeriesApi<SeriesType>[]>([]);
  const pineMarkersRef = useRef<ISeriesMarkersPluginApi<Time>[]>([]);
  const pineOverlaysRef = useRef<{ series: ISeriesApi<SeriesType>; primitive: PineOverlayPrimitive }[]>([]);
  const drawingPrimitiveRef = useRef<DrawingPrimitive | null>(null);
  const largeOrderPrimitiveRef = useRef<LargeOrderSrPrimitive | null>(null);
  const largeTradePrimitiveRef = useRef<LargeTradeMarkersPrimitive | null>(null);
  const liqHeatmapPrimitiveRef = useRef<LiqHeatmapPrimitive | null>(null);
  const liqBandsRef = useRef<LiqBand[]>([]);
  const liqTipRef = useRef<HTMLDivElement>(null);
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
  const [showFast, setShowFast] = useStoredFlag(studyDefinition("ema9").addedKey);
  const [showSlow, setShowSlow] = useStoredFlag(studyDefinition("ema21").addedKey);
  const [fastHidden, setFastHidden] = useStoredFlag(studyDefinition("ema9").hiddenKey);
  const [slowHidden, setSlowHidden] = useStoredFlag(studyDefinition("ema21").hiddenKey);
  const [cvdHidden, setCvdHidden] = useStoredFlag(studyDefinition("cvd").hiddenKey);
  const [oiHidden, setOiHidden] = useStoredFlag(studyDefinition("oi").hiddenKey);
  const [pineModel, setPineModel] = useState<PineRenderModel | null>(null);
  const [pineHidden, setPineHidden] = useState(false);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const sidePanelWidth = useSyncExternalStore(subscribePanePrefs, readLiveSidePanelWidth, () => SIDE_PANEL_DEFAULT_WIDTH);
  const sidePanelCollapsed = useSyncExternalStore(subscribePanePrefs, readLiveSidePanelCollapsed, () => false);
  const theme = useSyncExternalStore(subscribeTheme, currentDocumentTheme, (): ThemeName => "dark");
  const [activeTab, setActiveTab] = useState<"pine" | "console">("pine");
  const pine = usePineSource();
  const [consoleText, setConsoleText] = useState("Ready. Pine Script v5 subset loaded.");
  const [consoleKind, setConsoleKind] = useState<"normal" | "success" | "error">("normal");
  const [running, setRunning] = useState(false);
  const [derivatives, setDerivatives] = useState<Derivatives | null>(null);
  const [derivativesNotice, setDerivativesNotice] = useState<string | null>(null);
  const [cvd, setCvd] = useState<CvdSnapshot | null>(null);
  const [cvdError, setCvdError] = useState<string | null>(null);
  const [oiHistory, setOiHistory] = useState<OiHistorySnapshot | null>(null);
  const [oiHistoryNotice, setOiHistoryNotice] = useState<string | null>(null);
  const [chartVersion, setChartVersion] = useState(0);
  const showCvdPane = useSyncExternalStore(
    subscribePanePrefs,
    () => readClientPaneFlag(window.localStorage, CVD_PANE_STORAGE_KEY, false),
    () => false,
  );
  const showOiPane = useSyncExternalStore(
    subscribePanePrefs,
    () => readClientPaneFlag(window.localStorage, OI_PANE_STORAGE_KEY, false),
    () => false,
  );
  const setShowCvdPane = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const current = readStoredFlag(window.localStorage, CVD_PANE_STORAGE_KEY, false);
    writeStoredFlag(window.localStorage, CVD_PANE_STORAGE_KEY, typeof next === "function" ? next(current) : next);
    notifyPanePrefs();
  }, []);
  const setShowOiPane = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const current = readStoredFlag(window.localStorage, OI_PANE_STORAGE_KEY, false);
    writeStoredFlag(window.localStorage, OI_PANE_STORAGE_KEY, typeof next === "function" ? next(current) : next);
    notifyPanePrefs();
  }, []);
  const showLargeOrderSr = useSyncExternalStore(
    subscribePanePrefs,
    () => readClientPaneFlag(window.localStorage, LARGE_ORDER_SR_STORAGE_KEY, false),
    () => false,
  );
  const setShowLargeOrderSr = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const current = readStoredFlag(window.localStorage, LARGE_ORDER_SR_STORAGE_KEY, false);
    writeStoredFlag(window.localStorage, LARGE_ORDER_SR_STORAGE_KEY, typeof next === "function" ? next(current) : next);
    notifyPanePrefs();
  }, []);
  const showLargeTrades = useSyncExternalStore(
    subscribePanePrefs,
    () => readClientPaneFlag(window.localStorage, LARGE_TRADES_STORAGE_KEY, false),
    () => false,
  );
  const setShowLargeTrades = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const current = readStoredFlag(window.localStorage, LARGE_TRADES_STORAGE_KEY, false);
    writeStoredFlag(window.localStorage, LARGE_TRADES_STORAGE_KEY, typeof next === "function" ? next(current) : next);
    notifyPanePrefs();
  }, []);
  const showLiqHeatmap = useSyncExternalStore(
    subscribePanePrefs,
    () => readClientPaneFlag(window.localStorage, LIQ_HEATMAP_STORAGE_KEY, false),
    () => false,
  );
  const setShowLiqHeatmap = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const current = readStoredFlag(window.localStorage, LIQ_HEATMAP_STORAGE_KEY, false);
    writeStoredFlag(window.localStorage, LIQ_HEATMAP_STORAGE_KEY, typeof next === "function" ? next(current) : next);
    notifyPanePrefs();
  }, []);
  const [liqModel, setLiqModel] = useState<{ symbol: string; bands: LiqBand[]; notice: string | null } | null>(null);
  const liqForChart = showLiqHeatmap && liqModel && liqSymbolsMatch(liqModel.symbol, symbol) ? liqModel : null;
  const liqBands = useMemo(() => liqForChart?.bands ?? [], [liqForChart]);
  const liqNotice = liqForChart?.notice ?? null;
  liqBandsRef.current = liqBands;
  const [largeOrderWalls, setLargeOrderWalls] = useState<TrackedWall[]>([]);
  const [largeOrderNotice, setLargeOrderNotice] = useState<string | null>(null);
  const [largeTrades, setLargeTrades] = useState<LargeTrade[]>([]);
  const [largeTradeNotice, setLargeTradeNotice] = useState<string | null>(null);
  const [wallClock, setWallClock] = useState(() => Date.now());
  const minNotional = useSyncExternalStore(subscribePanePrefs, readLiveMinNotional, () => DEFAULT_MIN_WALL_NOTIONAL_USD);
  const wallRange = useSyncExternalStore(subscribePanePrefs, readLiveWallRange, () => BOOK_WALL_RANGE);
  const [visiblePriceSpan, setVisiblePriceSpan] = useState<PriceSpan | null>(null);
  const [chartVenue, setChartVenue] = useState<MarketVenue>("bybit");
  const [activeVenue, setActiveVenue] = useState<MarketVenue>("bybit");
  const barCount = useSyncExternalStore(subscribeBarCountPref, readBarCountPref, () => DEFAULT_CHART_BARS);
  const [olderLoading, setOlderLoading] = useState(false);
  // Lazy-load bookkeeping: which feed the loaded candles belong to, and whether it has older bars.
  const historyFeedRef = useRef<{ token: number; venue: MarketVenue; symbol: string; interval: Interval; exhausted: boolean; loading: boolean } | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const feedTokenRef = useRef(0);
  const [marketStatus, setMarketStatus] = useState<MarketFeedStatus>({ phase: "loading", notice: null, error: null });
  const [derivativesExchange, setDerivativesExchange] = useState<MarketVenue>("bybit");
  const [alerts, setAlerts] = useState<{ id: number; direction: "above" | "below"; price: number; triggered: boolean }[]>([]);
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [alertDirection, setAlertDirection] = useState<"above" | "below">("above");
  const [alertPrice, setAlertPrice] = useState("");
  const [pinePlots, setPinePlots] = useState<PinePlot[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
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

  useEffect(() => {
    const palette = chartPalette(theme);
    chartRef.current?.applyOptions(chartThemeOptions(theme));
    candleSeriesRef.current?.applyOptions(candleThemeOptions(theme));
    fastSeriesRef.current?.applyOptions({ color: palette.ema9 });
    slowSeriesRef.current?.applyOptions({ color: palette.ema21 });
  }, [chartVersion, theme]);

  useEffect(() => {
    oiSeriesRef.current?.applyOptions({ color: chartPalette(theme).oi });
  }, [chartVersion, showOiPane, theme]);

  const last = candles.at(-1);
  // TradingView legend semantics: change of the last bar vs the previous close. Measuring from the first
  // loaded bar would make the number depend on how much history (300 vs 5000 bars) happens to be loaded.
  const previous = candles.at(-2);
  const change = last && previous && previous.close ? ((last.close - previous.close) / previous.close) * 100 : 0;
  const cvdModel = useMemo(() => cvdPaneModel(cvd), [cvd]);
  const oiModel = useMemo(() => oiPaneModel({
    history: oiHistory,
    liveValue: derivatives?.openInterestValue ?? (oiHistory?.unit === "usd" ? null : derivatives?.openInterestAmount) ?? null,
    liveAmount: derivatives?.openInterestAmount ?? null,
    liveTime: last ? Number(last.time) : (derivatives ? toBarTimeSeconds(derivatives.updatedAt, interval) : null),
  }), [derivatives, interval, last, oiHistory]);
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
      layout: {
        background: { type: ColorType.Solid, color: "#0b1017" },
        textColor: "#748094",
        fontFamily: "var(--font-geist-mono)",
        fontSize: 10,
        panes: { separatorColor: "#27313f", separatorHoverColor: "rgba(118, 231, 164, 0.16)", enableResize: true },
      },
      grid: { vertLines: { color: "#17202b" }, horzLines: { color: "#17202b" } },
      rightPriceScale: { borderColor: "#27313f", scaleMargins: { top: 0.09, bottom: 0.08 } },
      timeScale: { borderColor: "#27313f", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7, minBarSpacing: 0.1 },
      crosshair: { vertLine: { color: "#59677a", width: 1, labelBackgroundColor: "#344154" }, horzLine: { color: "#59677a", width: 1, labelBackgroundColor: "#344154" } },
      handleScale: true, handleScroll: true,
    });
    // Apply the saved theme synchronously so a light reload never paints a dark chart frame.
    const initialTheme = currentDocumentTheme();
    chart.applyOptions(chartThemeOptions(initialTheme));
    const candleSeries = chart.addSeries(CandlestickSeries, { ...candleThemeOptions(initialTheme), borderVisible: false });
    const drawingPrimitive = new DrawingPrimitive();
    const largeOrderPrimitive = new LargeOrderSrPrimitive();
    const largeTradePrimitive = new LargeTradeMarkersPrimitive();
    const liqHeatmapPrimitive = new LiqHeatmapPrimitive();
    const drawingStorage = drawingStorageRef.current ?? createDrawingStorage();
    drawingStorageRef.current = drawingStorage;
    const drawingSaveScheduler = new DrawingSaveScheduler(drawingStorage);
    candleSeries.attachPrimitive(drawingPrimitive);
    candleSeries.attachPrimitive(largeOrderPrimitive);
    candleSeries.attachPrimitive(largeTradePrimitive);
    candleSeries.attachPrimitive(liqHeatmapPrimitive);
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
    cvdSeriesRef.current = null; oiSeriesRef.current = null;
    drawingPrimitiveRef.current = drawingPrimitive;
    largeOrderPrimitiveRef.current = largeOrderPrimitive;
    largeTradePrimitiveRef.current = largeTradePrimitive;
    liqHeatmapPrimitiveRef.current = liqHeatmapPrimitive;
    drawingControllerRef.current = drawingController;
    drawingSaveSchedulerRef.current = drawingSaveScheduler;
    drawingController.attach(chartHost.current);
    drawingPrimitive.setState(drawingsRef.current, drawingController.getSession(), candleTimesRef.current);
    setChartVersion((value) => value + 1);
    return () => {
      drawingSaveScheduler.flush();
      drawingController.detach();
      candleSeries.detachPrimitive(liqHeatmapPrimitive);
      candleSeries.detachPrimitive(largeTradePrimitive);
      candleSeries.detachPrimitive(largeOrderPrimitive);
      candleSeries.detachPrimitive(drawingPrimitive);
      if (drawingControllerRef.current === drawingController) drawingControllerRef.current = null;
      if (drawingPrimitiveRef.current === drawingPrimitive) drawingPrimitiveRef.current = null;
      if (largeOrderPrimitiveRef.current === largeOrderPrimitive) largeOrderPrimitiveRef.current = null;
      if (largeTradePrimitiveRef.current === largeTradePrimitive) largeTradePrimitiveRef.current = null;
      if (liqHeatmapPrimitiveRef.current === liqHeatmapPrimitive) liqHeatmapPrimitiveRef.current = null;
      if (drawingSaveSchedulerRef.current === drawingSaveScheduler) drawingSaveSchedulerRef.current = null;
      chart.remove();
      chartRef.current = null; candleSeriesRef.current = null; fastSeriesRef.current = null; slowSeriesRef.current = null;
      cvdSeriesRef.current = null; oiSeriesRef.current = null;
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
    fastSeriesRef.current?.applyOptions({ visible: !fastHidden });
    slowSeriesRef.current?.applyOptions({ visible: !slowHidden });
  }, [chartVersion, fastHidden, slowHidden]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (cvdSeriesRef.current) {
      try { chart.removeSeries(cvdSeriesRef.current); } catch { /* Chart teardown already dropped the series. */ }
      cvdSeriesRef.current = null;
    }
    if (oiSeriesRef.current) {
      try { chart.removeSeries(oiSeriesRef.current); } catch { /* Chart teardown already dropped the series. */ }
      oiSeriesRef.current = null;
    }
    const stack = indicatorPaneStack({ cvd: showCvdPane, oi: showOiPane });
    if (showCvdPane) {
      const series = chart.addSeries(BaselineSeries, CVD_SERIES_OPTIONS, indicatorPaneIndex("cvd", stack));
      series.createPriceLine({ price: 0, color: "#344154", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });
      cvdSeriesRef.current = series;
    }
    if (showOiPane) {
      oiSeriesRef.current = chart.addSeries(LineSeries, OI_SERIES_OPTIONS, indicatorPaneIndex("oi", stack));
    }
    applyIndicatorPaneStretch(chart.panes());
  }, [chartVersion, showCvdPane, showOiPane]);

  useEffect(() => {
    cvdSeriesRef.current?.applyOptions({ visible: !cvdHidden });
    oiSeriesRef.current?.applyOptions({ visible: !oiHidden });
  }, [chartVersion, cvdHidden, oiHidden, showCvdPane, showOiPane]);

  // Pine output: overlay=false plots get their own study pane below CVD/OI;
  // force_overlay plots, shapes, bgcolor and boxes are drawn on the price pane.
  // Runs after the CVD/OI pane effect so the study pane always sits last.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries) return;
    const clear = () => {
      for (const markers of pineMarkersRef.current) { try { markers.detach(); } catch { /* chart already torn down */ } }
      pineMarkersRef.current = [];
      for (const overlay of pineOverlaysRef.current) { try { overlay.series.detachPrimitive(overlay.primitive); } catch { /* chart already torn down */ } }
      pineOverlaysRef.current = [];
      for (const series of pineSeriesRef.current) { try { chart.removeSeries(series); } catch { /* chart already torn down */ } }
      pineSeriesRef.current = [];
    };
    clear();
    if (!pineModel) {
      applyIndicatorPaneStretch(chart.panes());
      return clear;
    }
    const studyPane = 1 + indicatorPaneStack({ cvd: showCvdPane, oi: showOiPane }).length;
    let firstStudySeries: ISeriesApi<SeriesType> | null = null;
    for (const model of pineModel.series) {
      const paneIndex = model.pane === "price" ? 0 : studyPane;
      const data = model.points.map((point) => (point.value == null
        ? { time: point.time as UTCTimestamp }
        : { time: point.time as UTCTimestamp, value: point.value, ...(point.color ? { color: point.color } : {}) }));
      const series: ISeriesApi<SeriesType> = model.kind === "histogram"
        ? chart.addSeries(HistogramSeries, { color: model.color, priceLineVisible: false, lastValueVisible: true, visible: !pineHidden, priceFormat: { type: "volume" } }, paneIndex)
        : chart.addSeries(LineSeries, { color: model.color, lineWidth: model.lineWidth as 1 | 2 | 3 | 4, lineType: model.stepped ? LineType.WithSteps : LineType.Simple, priceLineVisible: false, lastValueVisible: model.pane !== "price", visible: !pineHidden }, paneIndex);
      series.setData(data);
      pineSeriesRef.current.push(series);
      if (model.pane === "study" && !firstStudySeries) firstStudySeries = series;
    }
    if (!pineHidden) {
      const priceMarkers = pineModel.markers.filter((marker) => marker.pane === "price");
      if (priceMarkers.length) pineMarkersRef.current.push(createSeriesMarkers(candleSeries, toChartMarkers(priceMarkers)));
      const studyMarkers = pineModel.markers.filter((marker) => marker.pane === "study");
      if (studyMarkers.length && firstStudySeries) pineMarkersRef.current.push(createSeriesMarkers(firstStudySeries, toChartMarkers(studyMarkers)));
      const attachOverlay = (series: ISeriesApi<SeriesType> | null, pane: "price" | "study") => {
        if (!series) return;
        const backgrounds = pineModel.backgrounds.filter((bg) => bg.pane === pane);
        const boxes = pineModel.boxes.filter((box) => box.pane === pane);
        if (!backgrounds.length && !boxes.length) return;
        const primitive = new PineOverlayPrimitive();
        series.attachPrimitive(primitive);
        primitive.setData(backgrounds, boxes);
        pineOverlaysRef.current.push({ series, primitive });
      };
      attachOverlay(candleSeries, "price");
      attachOverlay(firstStudySeries, "study");
    }
    applyIndicatorPaneStretch(chart.panes());
    return clear;
  }, [chartVersion, pineHidden, pineModel, showCvdPane, showOiPane]);

  useEffect(() => {
    if (!showCvdPane) return;
    cvdSeriesRef.current?.setData(cvdModel.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })));
  }, [chartVersion, cvdModel, showCvdPane]);

  useEffect(() => {
    if (!showOiPane) return;
    oiSeriesRef.current?.setData(oiModel.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })));
  }, [chartVersion, oiModel, showOiPane]);

  const displayedWalls = useMemo(
    () => filterWallsForRange(largeOrderWalls, wallRange.mode, {
      visible: visiblePriceSpan,
      customLow: wallRange.low,
      customHigh: wallRange.high,
    }),
    [largeOrderWalls, visiblePriceSpan, wallRange],
  );

  const applyMinNotional = useCallback((value: number) => {
    writeStoredMinNotional(window.localStorage, clampMinNotional(value));
    notifyPanePrefs();
  }, []);

  const applyWallRange = useCallback((next: WallRangeSettings) => {
    writeStoredWallRange(window.localStorage, next);
    notifyPanePrefs();
  }, []);

  useEffect(() => {
    largeOrderPrimitiveRef.current?.setWalls(showLargeOrderSr ? displayedWalls : []);
  }, [chartVersion, displayedWalls, showLargeOrderSr]);

  useEffect(() => {
    largeTradePrimitiveRef.current?.setTrades(showLargeTrades ? largeTrades : [], interval);
  }, [chartVersion, interval, largeTrades, showLargeTrades]);

  useEffect(() => {
    liqHeatmapPrimitiveRef.current?.setBands(showLiqHeatmap ? liqBands : []);
  }, [chartVersion, liqBands, showLiqHeatmap]);

  useEffect(() => {
    if (!showLiqHeatmap) return;
    let active = true;
    const sample = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("liqSample") === "1";
    loadLiqHeatmapBands(symbol, fetch, { sample })
      .then((result) => {
        if (!active) return;
        setLiqModel({ symbol, bands: result.bands, notice: result.notice });
      })
      .catch(() => {
        if (!active) return;
        setLiqModel({ symbol, bands: [], notice: LIQ_HEATMAP_UNAVAILABLE });
      });
    return () => { active = false; };
  }, [showLiqHeatmap, symbol]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const tip = liqTipRef.current;
    if (!chart || !series || !tip || !showLiqHeatmap) {
      if (tip) tip.hidden = true;
      return;
    }
    const onMove = (param: MouseEventParams<Time>) => {
      const node = liqTipRef.current;
      if (!node) return;
      const point = param.point;
      if (!point || (param.paneIndex != null && param.paneIndex !== 0)) {
        node.hidden = true;
        return;
      }
      const price = series.coordinateToPrice(point.y);
      const band = price == null ? null : findLiqBandAtPrice(liqBandsRef.current, price);
      if (!band) {
        node.hidden = true;
        return;
      }
      const host = chartHost.current;
      const width = host?.clientWidth ?? 0;
      const height = host?.clientHeight ?? 0;
      node.hidden = false;
      node.dataset.side = band.side;
      node.textContent = formatLiqBandTooltip(band);
      node.style.left = `${Math.min(point.x + 12, Math.max(8, width - 240))}px`;
      node.style.top = `${Math.min(point.y + 14, Math.max(8, height - 32))}px`;
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      tip.hidden = true;
    };
  }, [chartVersion, showLiqHeatmap, liqBands]);

  useEffect(() => {
    if (!showLargeOrderSr) return;
    const timer = window.setInterval(() => setWallClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [showLargeOrderSr]);

  useEffect(() => {
    if (!showLargeOrderSr || wallRange.mode !== "visible") return;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;
    const read = () => {
      const next = priceSpanFromVisibleRange(series.priceScale().getVisibleRange());
      setVisiblePriceSpan((current) => {
        if (!current && !next) return current;
        if (current && next && current.low === next.low && current.high === next.high) return current;
        return next;
      });
    };
    const scheduleRead = () => { requestAnimationFrame(() => requestAnimationFrame(read)); };
    read();
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleRead);
    const host = chartHost.current;
    host?.addEventListener("wheel", scheduleRead, { passive: true });
    host?.addEventListener("pointerup", scheduleRead);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleRead);
      host?.removeEventListener("wheel", scheduleRead);
      host?.removeEventListener("pointerup", scheduleRead);
    };
  }, [candles.length, chartVersion, showLargeOrderSr, wallRange.mode]);

  useEffect(() => {
    if (!showLargeOrderSr) return;
    let active = true;
    let retryPreferred = true;
    let seeded = true;
    let previous = readStoredWallTracker(window.localStorage, activeVenue, symbol);
    const load = () => loadLargeOrderWalls(activeVenue, symbol, fetch, { retryPreferred, minNotional })
      .then((result) => {
        retryPreferred = false;
        if (!active) return;
        const now = Date.now();
        const tracked = trackOrderWalls(previous, result.snapshot.walls, now, { dropUnmatched: seeded });
        seeded = false;
        previous = tracked;
        writeStoredWallTracker(window.localStorage, activeVenue, symbol, tracked);
        setWallClock(now);
        setLargeOrderWalls(tracked);
        setLargeOrderNotice(result.notice);
      })
      .catch((error) => {
        if (!active) return;
        setLargeOrderWalls([]);
        setLargeOrderNotice(shortCopy(error instanceof Error ? error.message : LARGE_ORDER_SR_EMPTY, LARGE_ORDER_SR_EMPTY));
      });
    load();
    const timer = window.setInterval(load, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [activeVenue, minNotional, showLargeOrderSr, symbol]);

  useEffect(() => {
    if (!showLargeTrades) return;
    let active = true;
    let retryPreferred = true;
    const load = () => loadLargeTrades(activeVenue, symbol, fetch, { retryPreferred, minNotional })
      .then((result) => {
        retryPreferred = false;
        if (!active) return;
        setLargeTrades(result.snapshot.trades);
        setLargeTradeNotice(result.notice);
      })
      .catch((error) => {
        if (!active) return;
        setLargeTrades([]);
        setLargeTradeNotice(shortCopy(error instanceof Error ? error.message : LARGE_TRADES_EMPTY, LARGE_TRADES_EMPTY));
      });
    load();
    const timer = window.setInterval(load, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [activeVenue, minNotional, showLargeTrades, symbol]);

  useEffect(() => {
    if (!showOiPane) return;
    let active = true;
    let retryPreferred = true;
    const load = () => loadOpenInterestSeries(derivativesExchange, symbol, interval, fetch, { retryPreferred })
      .then((result) => {
        retryPreferred = false;
        if (!active) return;
        setOiHistory(result.snapshot);
        setOiHistoryNotice(result.notice);
      })
      .catch((error) => {
        if (!active) return;
        setOiHistory(null);
        setOiHistoryNotice(shortCopy(error instanceof Error ? error.message : OI_PANE_EMPTY, OI_PANE_EMPTY));
      });
    load();
    const timer = window.setInterval(load, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [derivativesExchange, interval, showOiPane, symbol]);

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

    feedTokenRef.current += 1;
    const feedToken = feedTokenRef.current;
    historyFeedRef.current = null;
    loadChartHistory(chartVenue, symbol, interval, fetch, { limit: barCount })
      .then((result) => {
        if (cancelled) return;
        setActiveVenue(result.venue);
        setDerivativesExchange(result.venue);
        const loaded = result.candles.map(toChartCandle);
        setCandles(loaded);
        historyFeedRef.current = { token: feedToken, venue: result.venue, symbol, interval, exhausted: result.exhausted, loading: false };
        setLoading(false);
        setMarketStatus({ phase: "polling", notice: result.notice ?? result.warning, error: null });
        // Open on the most recent bars (like TradingView); the full history is a scroll / zoom away.
        requestAnimationFrame(() => {
          const count = loaded.length;
          if (count > INITIAL_VISIBLE_BARS) chartRef.current?.timeScale().setVisibleLogicalRange({ from: count - INITIAL_VISIBLE_BARS, to: count + 4 });
          else chartRef.current?.timeScale().fitContent();
        });
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
  }, [symbol, interval, chartVenue, barCount]);

  useEffect(() => { candlesRef.current = candles; }, [candles]);

  // TradingView-style lazy history: when the left edge comes within LAZY_LOAD_TRIGGER bars, fetch older bars.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const timeScale = chart.timeScale();
    const onRange = (range: { from: number; to: number } | null) => {
      const feed = historyFeedRef.current;
      const current = candlesRef.current;
      if (!range || !feed || feed.exhausted || feed.loading || !current.length) return;
      if (range.from > LAZY_LOAD_TRIGGER || current.length >= MAX_LOADED_BARS) return;
      feed.loading = true;
      setOlderLoading(true);
      const oldest = Number(current[0].time);
      loadOlderCandles(feed.venue, feed.symbol, feed.interval, oldest, LAZY_LOAD_BARS)
        .then((older) => {
          if (historyFeedRef.current?.token !== feed.token) return;
          feed.exhausted = older.exhausted;
          if (older.candles.length) setCandles((prev) => prependOlderCandles(prev, older.candles.map(toChartCandle)));
        })
        .catch(() => {
          // Leave the loaded range visible; the next scroll to the edge retries.
        })
        .finally(() => {
          feed.loading = false;
          if (historyFeedRef.current?.token === feed.token || !historyFeedRef.current) setOlderLoading(false);
        });
    };
    timeScale.subscribeVisibleLogicalRangeChange(onRange);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
  }, [chartVersion]);

  useEffect(() => {
    let active = true;
    let retryPreferred = true;
    const load = () => loadDerivativesPulse(derivativesExchange, symbol, fetch, { retryPreferred })
      .then((result) => {
        retryPreferred = false;
        if (!active) return;
        setDerivatives(result.snapshot);
        setDerivativesNotice(result.notice);
      })
      .catch((error) => {
        if (!active) return;
        setDerivatives(null);
        setDerivativesNotice(shortCopy(error instanceof Error ? error.message : "Open interest unavailable.", "Open interest unavailable."));
      });
    load(); const timer = window.setInterval(load, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [symbol, derivativesExchange]);

  useEffect(() => {
    let active = true;
    let retryPreferred = true;
    const load = () => loadOrderFlowCvd(derivativesExchange, symbol, interval, fetch, { retryPreferred })
      .then((result) => {
        retryPreferred = false;
        if (!active) return;
        setCvd(result.snapshot);
        setCvdError(null);
      })
      .catch((error) => {
        if (!active) return;
        setCvd(null);
        setCvdError(shortCopy(error instanceof Error ? error.message : "Order flow unavailable.", "Order flow unavailable."));
      });
    load(); const timer = window.setInterval(load, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [symbol, interval, derivativesExchange]);

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
        const analysisGlobals = globalThis as typeof globalThis & {
          open_interest: number | null; funding_rate: number | null; mark_price: number | null; index_price: number | null;
          cvd_perp: number | null; cvd_spot: number | null; cvd_spread: number | null;
        };
        analysisGlobals.open_interest = derivatives?.openInterestValue ?? null;
        analysisGlobals.funding_rate = derivatives?.fundingRate ?? null;
        analysisGlobals.mark_price = derivatives?.markPrice ?? null;
        analysisGlobals.index_price = derivatives?.indexPrice ?? null;
        analysisGlobals.cvd_perp = cvd?.perp.available ? cvd.perp.cvd : null;
        analysisGlobals.cvd_spot = cvd?.spot.available ? cvd.spot.cvd : null;
        analysisGlobals.cvd_spread = cvd?.comparison.perpMinusSpotDelta ?? null;
        if (typeof generatedScript.run !== "function") throw new Error("Pine runtime error: compiled script has no run() entry point.");
        let runtime: PineRuntimeOutput & { alerts?: unknown[] };
        try {
          runtime = generatedScript.run(data);
        } catch (error) {
          throw new Error(`Pine runtime error: ${error instanceof Error ? error.message : String(error)}`);
        }
        const plots = (Object.values(runtime.plots || {}) as PinePlot[]).map((plot) => ({ title: plot.title, data: plot.data }));
        setPinePlots(plots);
        const model = buildPineRenderModel(runtime, candles.map((candle) => Number(candle.time)));
        setPineModel(model);
        setPineHidden(false);
        setPineApplied(true);
        if (pineModelHasOutput(model)) {
          setConsoleKind("success");
          setConsoleText(`Compiled successfully · ${model.title} · ${describePineModel(model, candles.length)} · ${runtime.alerts?.length || 0} alert events`);
        } else {
          setConsoleKind("error");
          setConsoleText(`Compiled, but the script produced nothing to draw (no plot / plotshape / bgcolor / box output) over ${candles.length} bars.`);
          setActiveTab("console");
        }
      } finally { URL.revokeObjectURL(moduleUrl); }
    } catch (error) {
      setConsoleKind("error");
      const message = error instanceof Error ? error.message : "Pine execution failed";
      setConsoleText(/^Pine (runtime|compile) error/.test(message) ? message : `Pine compile error: ${message}`);
      setActiveTab("console");
      setPanelHeight((height) => (isPanelCollapsed(height) ? lastExpandedPanelHeightRef.current : height));
    }
    finally { setRunning(false); }
  }, [pine, candles, derivatives, cvd]);

  const removePine = useCallback(() => {
    setPineModel(null);
    setPineApplied(false);
    setPinePlots([]);
    setPineHidden(false);
  }, []);

  const setSidePanelPrefs = useCallback((prefs: { width?: number | null; collapsed?: boolean }) => {
    writeSidePanelPrefs(window.localStorage, prefs);
    notifyPanePrefs();
  }, []);

  const toggleSidePanel = useCallback(() => {
    setSidePanelPrefs({ collapsed: !sidePanelCollapsed });
  }, [setSidePanelPrefs, sidePanelCollapsed]);

  const startSidePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    document.body.classList.add("side-panel-resizing");
    // Collapsing by drag passes through the minimum width; remember the width the
    // drag started from so expanding again restores it instead of the minimum.
    const restoreWidth = sidePanelWidth;
    const move = (pointer: PointerEvent) => {
      const next = resolveSidePanelDrag(window.innerWidth, pointer.clientX);
      setSidePanelPrefs(next.collapsed ? { width: restoreWidth, collapsed: true } : { width: next.width, collapsed: false });
    };
    const stop = () => {
      document.body.classList.remove("side-panel-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };

  const resizeSidePanelWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleSidePanel(); return; }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    if (sidePanelCollapsed) {
      if (event.key === "ArrowLeft") setSidePanelPrefs({ collapsed: false });
      return;
    }
    const next = sidePanelWidth + (event.key === "ArrowLeft" ? SIDE_PANEL_KEYBOARD_STEP : -SIDE_PANEL_KEYBOARD_STEP);
    if (next < SIDE_PANEL_MIN_WIDTH) setSidePanelPrefs({ collapsed: true });
    else setSidePanelPrefs({ width: clampSidePanelWidth(next, window.innerWidth), collapsed: false });
  };

  const studyAdded: Record<StudyId, boolean> = { ema9: showFast, ema21: showSlow, cvd: showCvdPane, oi: showOiPane };
  const studyHidden: Record<StudyId, boolean> = { ema9: fastHidden, ema21: slowHidden, cvd: cvdHidden, oi: oiHidden };
  const legendRows: ChartLegendRow[] = [
    ...legendEntries(
      Object.fromEntries((Object.keys(studyAdded) as StudyId[]).map((id) => [id, { added: studyAdded[id], hidden: studyHidden[id] }])),
      { cvd: cvdModel.label, oi: oiModel.label },
    ).map((entry) => ({ id: entry.id, title: entry.title, params: entry.id === "cvd" || entry.id === "oi" ? undefined : entry.params, color: entry.color, visible: entry.visible })),
    ...(pineModel ? [{ id: "pine", title: pineModel.title, params: pineModel.overlay ? undefined : "pane", color: "#b48cf2", visible: !pineHidden }] : []),
  ];
  const setStudyAdded: Record<StudyId, (next: boolean) => void> = { ema9: setShowFast, ema21: setShowSlow, cvd: setShowCvdPane, oi: setShowOiPane };
  const setStudyHidden: Record<StudyId, (next: boolean | ((current: boolean) => boolean)) => void> = { ema9: setFastHidden, ema21: setSlowHidden, cvd: setCvdHidden, oi: setOiHidden };
  const toggleStudyVisible = (id: string) => {
    if (id === "pine") { setPineHidden((value) => !value); return; }
    setStudyHidden[id as StudyId]((value) => !value);
  };
  const removeStudy = (id: string) => {
    if (id === "pine") { removePine(); return; }
    setStudyAdded[id as StudyId](false);
    setStudyHidden[id as StudyId](false);
  };
  const toggleStudyFromMenu = (id: StudyId) => {
    if (studyAdded[id]) { removeStudy(id); return; }
    setStudyHidden[id](false);
    setStudyAdded[id](true);
  };

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
      if (event.key === "Escape" && indicatorsOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setIndicatorsOpen(false);
        return;
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
  }, [clearDrawingTextEntry, indicatorsOpen, runPine, sourcesSheetOpen, symbolSearchOpen]);

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

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">TH</span><span>Trading Hub</span><small>crypto workspace</small></div>
        <button className="market-switcher" aria-label="Search symbols (Cmd/Ctrl+K)" title="Search symbols (Cmd/Ctrl+K)" onClick={() => setSymbolSearchOpen(true)}><span className="coin-badge">{symbol === "BTCUSDT" ? "₿" : symbol.slice(0, 1)}</span><span className="market-copy"><strong>{symbol.replace("USDT", " / USDT")}</strong><span>Perpetual · {venueLabel(chartVenue)}</span></span><span className="market-chevron">⌄</span></button>
        <div className="top-actions"><nav className="desk-nav" aria-label="Data pages"><Link className="desk-link" href="/etf-flows">ETF Flows</Link><Link className="desk-link" href="/cvd-oi">CVD / OI</Link><Link className="desk-link" href="/cex-netflow" aria-label="Exchange Net Flow Pulse (proxy)">Net Flow</Link></nav><button className="ai-button" onClick={() => setAiOpen(true)}><span>✦</span> AI Analyst <em>BYOK</em></button><button type="button" className="theme-toggle" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} aria-pressed={theme === "light"} data-theme-current={theme} onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}><ThemeIcon theme={theme} /></button><button type="button" className={`side-panel-toggle${sidePanelCollapsed ? " collapsed" : ""}`} aria-label={sidePanelCollapsed ? "Expand right panel" : "Collapse right panel"} title={sidePanelCollapsed ? "Expand right panel" : "Collapse right panel"} aria-expanded={!sidePanelCollapsed} aria-controls="th-right-panel" onClick={toggleSidePanel}><PanelRightIcon collapsed={sidePanelCollapsed} /></button></div>
      </header>

      <section className={`workspace${sidePanelCollapsed ? " side-collapsed" : ""}`} style={{ ["--side-panel-width" as string]: `${sidePanelCollapsed ? 0 : sidePanelWidth}px` }}>
        <section className="main-area" style={{ gridTemplateRows: `45px minmax(220px, 1fr) ${panelHeight}px` }}>
          <div className="chart-toolbar">
            <div className="toolbar-cluster">
              <button className="toolbar-symbol-button" aria-label="Search symbols (Cmd/Ctrl+K)" title="Search symbols (Cmd/Ctrl+K)" onClick={() => setSymbolSearchOpen(true)}><strong>{symbol.replace("USDT", " / USDT")}</strong><span>⌄</span></button><span className="toolbar-separator" />
              {INTERVALS.map((item) => <button key={item.value} onClick={() => { beginMarketLoad(); setInterval(item.value); }} className={`time-button ${interval === item.value ? "active" : ""}`}>{item.label}</button>)}
              <span className="toolbar-separator" />
              <IndicatorsMenu added={studyAdded} pineApplied={pineApplied} onToggleStudy={toggleStudyFromMenu} onAddPine={runPine} open={indicatorsOpen} onOpenChange={setIndicatorsOpen} />
            </div>
            <div className="toolbar-cluster"><button className="chart-alert-button" aria-label="Create alert (Alt+A)" title="Create alert (Alt+A)" onClick={() => setShowAlertForm(true)}><span aria-hidden="true">◷</span> Alert</button><span className="toolbar-separator" /><select aria-label="Chart market venue" className="toolbar-venue-select" value={chartVenue} onChange={(event) => { const venue = event.target.value; if (!isMarketVenue(venue)) return; beginMarketLoad(); setChartVenue(venue); }}>{venueOptions()}</select><span className="toolbar-separator" /><span className={`live-dot ${marketStatus.phase === "error" ? "error" : connected ? "online" : marketStatus.phase === "polling" ? "polling" : ""}`} /><span className="live-copy">{marketStatus.phase === "error" ? "Market error" : marketStatus.phase === "live" ? `Live · ${venueLabel(activeVenue)}` : marketStatus.phase === "polling" ? `Polling · ${venueLabel(activeVenue)}` : "Connecting"}</span><span className="toolbar-separator" /><select aria-label="History bars" title="Bars of history to load" className="toolbar-venue-select toolbar-bars-select" value={barCount} onChange={(event) => writeBarCountPref(Number(event.target.value))}>{CHART_BAR_COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count.toLocaleString("en-US")} bars</option>)}</select><button className="time-button" onClick={() => chartRef.current?.timeScale().fitContent()}>Fit</button></div>
          </div>

          <div className="chart-region">
            <DrawingToolbar
              activeTool={activeDrawingTool}
              onToolChange={changeDrawingToolFromToolbar}
              unfilledLargeOrdersVisible={showLargeOrderSr}
              onUnfilledLargeOrdersToggle={() => setShowLargeOrderSr((value) => !value)}
              executedLargeTradesVisible={showLargeTrades}
              onExecutedLargeTradesToggle={() => setShowLargeTrades((value) => !value)}
              liqHeatmapVisible={showLiqHeatmap}
              onLiqHeatmapToggle={() => setShowLiqHeatmap((value) => !value)}
            />
            <div className={`chart-stage ${drawingCursorClass}`} data-drawing-phase={drawingSession.phase} data-drawing-count={drawings.length} data-cvd-pane={showCvdPane ? "on" : "off"} data-oi-pane={showOiPane ? "on" : "off"} data-large-order-sr={showLargeOrderSr ? "on" : "off"} data-large-trades={showLargeTrades ? "on" : "off"} data-large-order-list={showLargeOrderSr || showLargeTrades ? "on" : "off"} data-liq-heatmap={showLiqHeatmap ? "on" : "off"}>
            <div className="chart-legend">
              <div className="market-head"><h1>{symbol.replace("USDT", "/USDT")} Perpetual</h1><span className="exchange-pill">{venueLabel(activeVenue).toUpperCase()}</span></div>
              <div className="quote-line"><span className="price">{formatPrice(last?.close ?? null)}</span><span className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</span><span>H {formatPrice(last?.high ?? null)}</span><span>L {formatPrice(last?.low ?? null)}</span></div>
              <ChartStudyLegend rows={legendRows} onToggleVisible={toggleStudyVisible} onRemove={removeStudy} />
              {showLiqHeatmap && <div className="indicator-label" data-liq-heatmap-legend="on"><span><i style={{ background: "#e76770" }} />Long liq</span><span><i style={{ background: "#53c990" }} />Short liq</span><button type="button" className="indicator-remove" aria-label="Remove liquidation heatmap" title="Hide liquidation heatmap" onClick={() => setShowLiqHeatmap(false)}>×</button></div>}
            </div>
            {(showLargeOrderSr || showLargeTrades) && <LargeOrderDock
              showUnfilled={showLargeOrderSr}
              showExecuted={showLargeTrades}
              walls={displayedWalls}
              trades={largeTrades}
              now={wallClock}
              minNotional={minNotional}
              onMinNotional={applyMinNotional}
              range={wallRange}
              onRange={applyWallRange}
              notice={[showLargeOrderSr ? largeOrderNotice : null, showLargeTrades ? largeTradeNotice : null].filter(Boolean).join(" ") || null}
            />}
            <div className="chart-canvas" ref={chartHost} />
            {showLiqHeatmap && <div ref={liqTipRef} className="liq-heatmap-tip" role="tooltip" hidden />}
            {showLiqHeatmap && liqNotice && <div className="liq-heatmap-notice" role="status" data-liq-heatmap-notice>{liqNotice}</div>}
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
            {((showCvdPane && !cvdModel.available) || (showOiPane && !oiModel.available) || (showLargeOrderSr && largeOrderNotice) || (showLargeTrades && largeTradeNotice)) && (
              <div className="pane-empty-notice" role="status">
                {[
                  showCvdPane && !cvdModel.available ? (cvdModel.emptyNotice || cvdError || CVD_PANE_EMPTY) : null,
                  showOiPane && !oiModel.available ? shortCopy(oiHistoryNotice, oiModel.emptyNotice || OI_PANE_EMPTY) : null,
                  showLargeOrderSr && largeOrderNotice ? largeOrderNotice : null,
                  showLargeTrades && largeTradeNotice ? largeTradeNotice : null,
                ].filter(Boolean).join(" ")}
              </div>
            )}
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

        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- ARIA separators become interactive when focusable and expose aria-valuenow. */}
        <div className="side-panel-resize-handle" role="separator" aria-label="Resize right panel" aria-orientation="vertical" aria-controls="th-right-panel" aria-valuemin={0} aria-valuemax={maxSidePanelWidth(typeof window === "undefined" ? 0 : window.innerWidth)} aria-valuenow={sidePanelCollapsed ? 0 : sidePanelWidth} tabIndex={0} onPointerDown={startSidePanelResize} onKeyDown={resizeSidePanelWithKeyboard} onDoubleClick={toggleSidePanel}><span /></div>
        <aside className="right-panel" id="th-right-panel" hidden={sidePanelCollapsed}>
          <SideSection
            title="Derivatives pulse"
            storageKey={DERIVATIVES_SECTION_KEY}
            extra={<select aria-label="Derivatives exchange" value={derivativesExchange} onChange={(event) => { const venue = event.target.value; if (isMarketVenue(venue)) setDerivativesExchange(venue); }}>{venueOptions()}</select>}
          >
            <div className="metric-grid">
              <button type="button" className={`metric-card pane-toggle ${showOiPane ? "active" : ""}`} aria-label="Toggle open interest pane" aria-pressed={showOiPane} title={showOiPane ? "Hide open interest pane" : "Show open interest pane"} onClick={() => setShowOiPane((value) => !value)}>
                <span>Open interest</span>
                <strong>${formatCompact(derivatives?.openInterestValue ?? null)}</strong>
                <small>{formatCompact(derivatives?.openInterestAmount ?? null)} {symbol.replace("USDT", "")}</small>
              </button>
              <div className="metric-card"><span>Funding / 8h</span><strong className={(derivatives?.fundingRate ?? 0) >= 0 ? "positive" : "negative"}>{derivatives?.fundingRate == null ? "—" : `${(derivatives.fundingRate * 100).toFixed(4)}%`}</strong><small>{derivatives?.nextFundingTimestamp ? `Next ${new Date(derivatives.nextFundingTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Current rate"}</small></div>
              <div className="metric-card"><span>Mark price</span><strong>{formatPrice(derivatives?.markPrice ?? null)}</strong><small>Fair price</small></div>
              <div className="metric-card"><span>Basis</span><strong className={((derivatives?.markPrice ?? 0) - (derivatives?.indexPrice ?? 0)) >= 0 ? "positive" : "negative"}>{derivatives?.markPrice && derivatives?.indexPrice ? `${(((derivatives.markPrice - derivatives.indexPrice) / derivatives.indexPrice) * 100).toFixed(3)}%` : "—"}</strong><small>Mark vs index</small></div>
            </div>
            <div className="data-source"><span>{derivativesNotice || "Pine: open_interest · funding_rate · cvd_perp"}</span><code>CCXT · {derivatives?.exchange || derivativesExchange}</code></div>
          </SideSection>
          <SideSection title="Order flow" storageKey={ORDER_FLOW_SECTION_KEY}>
            <div className="metric-grid">
              <button type="button" className={`metric-card pane-toggle ${showCvdPane ? "active" : ""}`} aria-label="Toggle CVD pane" aria-pressed={showCvdPane} title={showCvdPane ? "Hide CVD pane" : "Show CVD pane"} onClick={() => setShowCvdPane((value) => !value)}>
                <span>Perp CVD</span>
                <strong className={signedClass(cvd?.perp.available ? cvd.perp.cvd : null)}>{cvd?.perp.available ? formatSigned(cvd.perp.cvd) : "—"}</strong>
                <small>{cvd?.perp.available ? summarizeCvdWindow(cvd.perp) : shortCopy(cvd?.perp.reason, "No perp trades")}</small>
                {cvd?.perp.available && <CvdSpark bars={cvd.perp.spark.length > 1 ? cvd.perp.spark : cvd.perp.bars} />}
              </button>
              <button type="button" className={`metric-card pane-toggle ${showCvdPane ? "active" : ""}`} aria-label="Toggle CVD pane" aria-pressed={showCvdPane} title={showCvdPane ? "Hide CVD pane" : "Show CVD pane"} onClick={() => setShowCvdPane((value) => !value)}>
                <span>Spot CVD</span>
                <strong className={signedClass(cvd?.spot.available ? cvd.spot.cvd : null)}>{cvd?.spot.available ? formatSigned(cvd.spot.cvd) : "—"}</strong>
                <small>{cvd?.spot.available ? summarizeCvdWindow(cvd.spot) : shortCopy(cvd?.spot.reason, "No spot trades")}</small>
                {cvd?.spot.available && <CvdSpark bars={cvd.spot.spark.length > 1 ? cvd.spot.spark : cvd.spot.bars} />}
              </button>
              <div className="metric-card">
                <span>Futures − spot</span>
                <strong className={signedClass(cvd?.comparison.perpMinusSpotDelta ?? null)}>{formatSigned(cvd?.comparison.perpMinusSpotDelta ?? null)}</strong>
                <small>{cvd?.comparison.available ? "CVD spread · base size" : "Comparison unavailable"}</small>
              </div>
              <div className="metric-card">
                <span>Force source</span>
                <strong>{cvd?.comparison.dominantBook === "perp" ? "Perps" : cvd?.comparison.dominantBook === "spot" ? "Spot" : cvd?.comparison.dominantBook === "balanced" ? "Balanced" : "—"}</strong>
                <small>Perp {cvd?.comparison.perpAggression ?? "—"} · spot {cvd?.comparison.spotAggression ?? "—"}</small>
              </div>
            </div>
            <p className="force-read">{shortCopy(cvd?.comparison.interpretation, cvd ? "Waiting for public trades." : (cvdError || "Waiting for public trades."))}</p>
            {cvd?.notice ? <p className="force-read muted">{shortCopy(cvd.notice)}</p> : null}
            <div className="data-source"><span>CVD from public trades</span><code>{venueLabel(cvd?.venue || derivativesExchange)} · {INTERVALS.find((item) => item.value === interval)?.label}</code></div>
          </SideSection>
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
      <AiAnalystDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        snapshot={{
          symbol,
          venue: activeVenue,
          timeframe: INTERVALS.find((item) => item.value === interval)?.label ?? interval,
          interval,
          derivativesVenue: derivativesExchange,
          candles,
          lastPrice: last?.close ?? null,
          ema9Visible: showFast && !fastHidden,
          ema21Visible: showSlow && !slowHidden,
          pineSource: pine,
          pinePlots,
          derivatives: derivatives ? {
            sourceExchange: derivativesExchange,
            openInterestUsd: derivatives.openInterestValue,
            openInterestBase: derivatives.openInterestAmount,
            fundingRate: derivatives.fundingRate,
            markPrice: derivatives.markPrice,
            indexPrice: derivatives.indexPrice,
            nextFundingTimestamp: derivatives.nextFundingTimestamp,
          } : null,
          cvd: cvd?.perp.available
            ? {
                last: cvd.perp.cvd,
                recent: (cvd.perp.spark.length > 1 ? cvd.perp.spark : cvd.perp.bars).slice(-30).map((bar) => ({
                  time: String(bar.time),
                  value: bar.cvd,
                })),
              }
            : cvd?.spot.available
              ? {
                  last: cvd.spot.cvd,
                  recent: (cvd.spot.spark.length > 1 ? cvd.spot.spark : cvd.spot.bars).slice(-30).map((bar) => ({
                    time: String(bar.time),
                    value: bar.cvd,
                  })),
                }
              : null,
        }}
      />
      <footer className="footer"><div className="status-group"><span className="tiny-dot" /><span>{venueLabel(activeVenue)} public feed</span><span data-bar-count={candles.length}>{candles.length.toLocaleString("en-US")} bars{olderLoading ? " · loading older…" : ""}</span><span>CCXT normalized</span><span>Pine v5 subset</span><span>AI context ready</span></div><span>UTC · Data for analysis only</span></footer>
    </main>
  );
}
