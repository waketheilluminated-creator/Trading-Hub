export const CONTEXT_CAPTURE = "backend-market-series" as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const MAX_LOOKBACK_MS = 2 * YEAR_MS;
const RECENT_BAR_LIMIT = 80;
const EARLIER_BUCKETS = 10;

export const HISTORY_SERVER_REASON = "Lookback history is packed on the analyze route from exchange history APIs, never from chart screenshots.";
export const CVD_LOOKBACK_NOTE = "CVD is computed from the latest public trades, not the full lookback. Missing books are omitted rather than invented.";
export const OI_LOOKBACK_NOTE = "Open interest and funding are the current snapshot, not a historical OI series.";

export type HistoryLookback = {
  requested: boolean;
  phrase: string | null;
};

export type LookbackSource = "explicit" | "question" | "none";
export type LookbackKind = "duration" | "calendar" | "listing" | "none";

export type ParsedLookback = {
  requested: boolean;
  phrase: string | null;
  source: LookbackSource;
  kind: LookbackKind;
  durationMs: number | null;
  startMs: number | null;
  endMs: number | null;
  parseError: string | null;
};

export type ContextSource = {
  kind: typeof CONTEXT_CAPTURE;
  inputs: ["candles", "derivatives", "indicators", "cvd", "history"];
  screenshots: false;
  capture: "never-screenshots";
};

export type HistoryBar = { t: number; o: number; h: number; l: number; c: number; v: number | null };

export type HistoryBucket = {
  start: string;
  end: string;
  bars: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  changePct: number | null;
};

export type HistorySummary = {
  start: string;
  end: string;
  bars: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  changePct: number | null;
  rangePct: number | null;
  regime: "uptrend" | "downtrend" | "range" | "unknown";
  buckets: HistoryBucket[];
};

export type HistoryCvdSummary = {
  available: boolean;
  windowNote: string;
  perpDelta: number | null;
  spotDelta: number | null;
  interpretation: string | null;
  reason: string | null;
};

export type HistoryOiSummary = {
  available: boolean;
  windowNote: string;
  openInterestUsd: number | null;
  fundingRate: number | null;
  reason: string | null;
};

export type HistoryPackExtras = {
  interval?: string;
  earlierBars?: HistoryBar[];
  earlierInterval?: string;
  startMs?: number;
  endMs?: number;
  partialReason?: string | null;
  venue?: string | null;
  source?: "official" | "public-mirror" | string | null;
  cvd?: {
    available: boolean;
    perpDelta?: number | null;
    spotDelta?: number | null;
    interpretation?: string | null;
    reason?: string | null;
  } | null;
  openInterest?: {
    available: boolean;
    openInterestUsd?: number | null;
    fundingRate?: number | null;
    reason?: string | null;
  } | null;
};

export type HistoryWindow =
  | {
      available: true;
      status: "current-window";
      window: "attached-chart-series";
      requested: null;
      screenshots: false;
    }
  | {
      available: true;
      status: "packed" | "partial";
      requested: string;
      source: "backend-history-api";
      screenshots: false;
      capture: "never-screenshots";
      venue: string | null;
      interval: string;
      start: string;
      end: string;
      recent: HistoryBar[];
      earlier: HistorySummary | null;
      cvd: HistoryCvdSummary;
      openInterest: HistoryOiSummary;
      reason: string | null;
    }
  | {
      available: false;
      status: "unavailable";
      requested: string;
      source: "backend-history-api";
      screenshots: false;
      capture: "never-screenshots";
      reason: string;
    };

const LOOKBACK_PATTERN = /(?:last|past|previous|over(?:\s+the)?(?:\s+past)?|for)\s+(?:few\s+)?(?:\d+(?:\.\d+)?\s*)?(?:hours?|days?|weeks?|months?|years?|hrs?|h|d|w)\b|\b\d+(?:\.\d+)?\s*(?:hours?|days?|weeks?|months?|years?|hrs?)\b|\b\d+(?:\.\d+)?\s*(?:h|d|w|mo)\b|(?:近|过去)\s*\d+(?:\.\d+)?\s*(?:小时|天|周|星期|个月|月|年)|(?:近)?(?:三个月|半年|一年)|本周|本月|今年|\b(?:YTD|year[-\s]?to[-\s]?date|this (?:week|month|year)|since listing|from listing)\b|自上市|上线以来/i;

const COMPACT_RANGE = /^(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|y)$/i;
const ENGLISH_RANGE = /(?:last|past|previous|over(?:\s+the)?(?:\s+past)?|for)\s+(?:(few)|\s*)?(\d+(?:\.\d+)?)?\s*(hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|y)\b/i;
const BARE_ENGLISH_RANGE = /\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|days?|weeks?|months?|years?)\b/i;
const ZH_RANGE = /(?:近|过去)\s*(\d+(?:\.\d+)?)\s*(小时|天|周|星期|个月|月|年)/;
const UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: WEEK_MS,
  week: WEEK_MS,
  weeks: WEEK_MS,
  mo: MONTH_MS,
  month: MONTH_MS,
  months: MONTH_MS,
  y: YEAR_MS,
  year: YEAR_MS,
  years: YEAR_MS,
  小时: HOUR_MS,
  天: DAY_MS,
  周: WEEK_MS,
  星期: WEEK_MS,
  月: MONTH_MS,
  个月: MONTH_MS,
  年: YEAR_MS,
};

export function detectHistoryLookback(question: string): HistoryLookback {
  const match = String(question ?? "").match(LOOKBACK_PATTERN);
  return {
    requested: Boolean(match),
    phrase: match?.[0]?.trim() || null,
  };
}

export function contextSource(): ContextSource {
  return {
    kind: CONTEXT_CAPTURE,
    inputs: ["candles", "derivatives", "indicators", "cvd", "history"],
    screenshots: false,
    capture: "never-screenshots",
  };
}

export function emptyLookback(now = Date.now()): ParsedLookback {
  return {
    requested: false,
    phrase: null,
    source: "none",
    kind: "none",
    durationMs: null,
    startMs: null,
    endMs: now,
    parseError: null,
  };
}

export function parseRangePhrase(phrase: string, now = Date.now()): ParsedLookback {
  const requested = String(phrase ?? "").trim();
  if (!requested) return emptyLookback(now);

  const listing = /since listing|from listing|自上市|上线以来/i.exec(requested);
  if (listing) {
    return {
      requested: true,
      phrase: requested,
      source: "question",
      kind: "listing",
      durationMs: null,
      startMs: null,
      endMs: now,
      parseError: null,
    };
  }

  const calendar = parseCalendarPhrase(requested, now);
  if (calendar) return { ...calendar, phrase: requested, source: "question" };

  const named = parseNamedDuration(requested);
  if (named != null) return durationLookback(requested, named, now);

  const english = requested.match(ENGLISH_RANGE);
  if (english) {
    const amount = english[1] === "few" ? 3 : Number(english[2] || 1);
    const unit = english[3].toLowerCase();
    const unitMs = UNIT_MS[unit];
    if (Number.isFinite(amount) && amount > 0 && unitMs) {
      return durationLookback(requested, amount * unitMs, now);
    }
  }
  const compact = requested.match(COMPACT_RANGE) || requested.match(ZH_RANGE) || requested.match(BARE_ENGLISH_RANGE);
  if (compact) {
    const amount = Number(compact[1]);
    const unit = compact[2].toLowerCase();
    const unitMs = UNIT_MS[unit] ?? UNIT_MS[compact[2]];
    if (Number.isFinite(amount) && amount > 0 && unitMs) {
      return durationLookback(requested, amount * unitMs, now);
    }
  }

  return {
    requested: true,
    phrase: requested,
    source: "question",
    kind: "duration",
    durationMs: null,
    startMs: null,
    endMs: now,
    parseError: `Could not parse lookback "${requested}" into a duration.`,
  };
}

export function resolveLookback(input: { explicit?: unknown; question?: string; now?: number } = {}): ParsedLookback {
  const now = input.now ?? Date.now();
  const explicit = normalizeExplicitRange(input.explicit, now);
  if (explicit) return { ...explicit, source: "explicit" };
  const detected = detectHistoryLookback(input.question ?? "");
  if (!detected.requested || !detected.phrase) return emptyLookback(now);
  return { ...parseRangePhrase(detected.phrase, now), source: "question", phrase: detected.phrase };
}

export function packHistoryRange(range: string, bars: HistoryBar[] = [], extras: HistoryPackExtras = {}): HistoryWindow {
  const requested = String(range ?? "").trim();
  if (!requested) {
    return { available: true, status: "current-window", window: "attached-chart-series", requested: null, screenshots: false };
  }

  const allBars = sortBars(bars);
  const earlierInput = sortBars(extras.earlierBars ?? []);
  if (!allBars.length && !earlierInput.length) {
    const parsed = parseRangePhrase(requested, extras.endMs ?? Date.now());
    return {
      available: false,
      status: "unavailable",
      requested,
      source: "backend-history-api",
      screenshots: false,
      capture: "never-screenshots",
      reason: parsed.parseError
        || (parsed.kind === "listing"
          ? "Listing date is not known and no exchange history bars were supplied."
          : "No historical OHLCV bars were packed for this lookback. Chart screenshots are never captured."),
    };
  }

  const recent = allBars.slice(-RECENT_BAR_LIMIT);
  const recentStart = recent[0] ? barMs(recent[0].t) : null;
  const earlierFromSame = recentStart == null ? allBars.slice(0, -recent.length) : allBars.filter((bar) => barMs(bar.t) < recentStart);
  const earlierBars = (earlierInput.length ? earlierInput.filter((bar) => recentStart == null || barMs(bar.t) < recentStart) : earlierFromSame);
  const coverageStart = extras.startMs ?? barMs((earlierBars[0] ?? recent[0]).t);
  const coverageEnd = extras.endMs ?? barMs((recent.at(-1) ?? earlierBars.at(-1))!.t);
  const parsed = parseRangePhrase(requested, coverageEnd);
  const requestedStart = parsed.startMs ?? (parsed.durationMs != null ? coverageEnd - parsed.durationMs : coverageStart);
  const coveredMs = coverageEnd - (earlierBars[0] ? barMs(earlierBars[0].t) : coverageStart);
  const requestedMs = parsed.durationMs ?? (parsed.startMs != null ? coverageEnd - parsed.startMs : null);
  const listingReason = parsed.kind === "listing"
    ? "Listing date is not known for this symbol. Packed the oldest available exchange history instead of inventing a listing window."
    : null;
  const truncated = Boolean(
    extras.partialReason
    || listingReason
    || (requestedMs != null && coveredMs + DAY_MS < requestedMs * 0.85)
    || (parsed.durationMs != null && parsed.durationMs > MAX_LOOKBACK_MS),
  );

  return {
    available: true,
    status: truncated ? "partial" : "packed",
    requested,
    source: "backend-history-api",
    screenshots: false,
    capture: "never-screenshots",
    venue: extras.venue ?? null,
    interval: extras.interval ?? extras.earlierInterval ?? "unknown",
    start: new Date(requestedStart || coverageStart).toISOString(),
    end: new Date(coverageEnd).toISOString(),
    recent,
    earlier: summarizeBars(earlierBars),
    cvd: slimCvd(extras.cvd),
    openInterest: slimOi(extras.openInterest),
    reason: extras.partialReason || listingReason || (truncated
      ? `Packed ${recent.length + earlierBars.length} available bars; the requested lookback is longer than the fetched history.`
      : null),
  };
}

export function historyWindow(question = "", explicit?: unknown): HistoryWindow {
  const lookback = resolveLookback({ explicit, question });
  if (!lookback.requested) return packHistoryRange("");
  return {
    available: false,
    status: "unavailable",
    requested: lookback.phrase ?? "",
    source: "backend-history-api",
    screenshots: false,
    capture: "never-screenshots",
    reason: HISTORY_SERVER_REASON,
  };
}

export function unavailableHistory(requested: string, reason: string): HistoryWindow {
  return {
    available: false,
    status: "unavailable",
    requested,
    source: "backend-history-api",
    screenshots: false,
    capture: "never-screenshots",
    reason,
  };
}

export function formatLookbackDuration(durationMs: number): string {
  if (durationMs >= YEAR_MS) return `${roundUnit(durationMs / YEAR_MS)}y`;
  if (durationMs >= MONTH_MS) return `${roundUnit(durationMs / MONTH_MS)}mo`;
  if (durationMs >= WEEK_MS) return `${roundUnit(durationMs / WEEK_MS)}w`;
  if (durationMs >= DAY_MS) return `${roundUnit(durationMs / DAY_MS)}d`;
  return `${roundUnit(durationMs / HOUR_MS)}h`;
}

export function maxLookbackMs(): number {
  return MAX_LOOKBACK_MS;
}

export function recentBarLimit(): number {
  return RECENT_BAR_LIMIT;
}

function normalizeExplicitRange(value: unknown, now: number): ParsedLookback | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? parseRangePhrase(trimmed, now) : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const durationMs = value > YEAR_MS / 12 ? value : value * HOUR_MS;
    return durationLookback(`${value}`, durationMs, now);
  }
  if (typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.range === "string" && raw.range.trim()) return parseRangePhrase(raw.range, now);
  if (typeof raw.lookback === "string" && raw.lookback.trim()) return parseRangePhrase(raw.lookback, now);
  if (typeof raw.phrase === "string" && raw.phrase.trim()) return parseRangePhrase(raw.phrase, now);
  if (typeof raw.from === "string" || typeof raw.to === "string") {
    const endMs = parseTime(raw.to) ?? now;
    const startMs = parseTime(raw.from);
    if (startMs != null && endMs > startMs) {
      return {
        requested: true,
        phrase: `${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
        source: "explicit",
        kind: "calendar",
        durationMs: endMs - startMs,
        startMs,
        endMs,
        parseError: null,
      };
    }
  }
  const hours = numeric(raw.hours);
  const days = numeric(raw.days);
  const weeks = numeric(raw.weeks);
  const months = numeric(raw.months);
  const durationMs = (hours ?? 0) * HOUR_MS + (days ?? 0) * DAY_MS + (weeks ?? 0) * WEEK_MS + (months ?? 0) * MONTH_MS;
  if (durationMs > 0) return durationLookback(JSON.stringify(raw), durationMs, now);
  return null;
}

function parseNamedDuration(phrase: string): number | null {
  const normalized = phrase.replace(/\s+/g, "").toLowerCase();
  if (normalized.includes("三个月")) return 90 * DAY_MS;
  if (normalized.includes("半年")) return 182 * DAY_MS;
  if (normalized.includes("一年")) return YEAR_MS;
  return null;
}

function parseCalendarPhrase(phrase: string, now: number): Omit<ParsedLookback, "phrase" | "source"> | null {
  const text = phrase.trim().toLowerCase();
  const date = new Date(now);
  if (/\bytd\b|year[-\s]?to[-\s]?date|this year|今年/.test(text)) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    return calendarLookback(start, now);
  }
  if (/this month|本月/.test(text)) {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return calendarLookback(start, now);
  }
  if (/this week|本周/.test(text)) {
    const weekday = date.getUTCDay() || 7;
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - (weekday - 1) * DAY_MS;
    return calendarLookback(start, now);
  }
  return null;
}

function calendarLookback(startMs: number, endMs: number): Omit<ParsedLookback, "phrase" | "source"> {
  return {
    requested: true,
    kind: "calendar",
    durationMs: Math.max(0, endMs - startMs),
    startMs,
    endMs,
    parseError: null,
  };
}

function durationLookback(phrase: string, durationMs: number, now: number): ParsedLookback {
  const capped = Math.min(durationMs, MAX_LOOKBACK_MS);
  return {
    requested: true,
    phrase,
    source: "question",
    kind: "duration",
    durationMs: capped,
    startMs: now - capped,
    endMs: now,
    parseError: durationMs > MAX_LOOKBACK_MS ? `Lookbacks longer than ${formatLookbackDuration(MAX_LOOKBACK_MS)} are capped.` : null,
  };
}

function summarizeBars(bars: HistoryBar[]): HistorySummary | null {
  if (!bars.length) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  const high = Math.max(...bars.map((bar) => bar.h));
  const low = Math.min(...bars.map((bar) => bar.l));
  const volumeValues = bars.map((bar) => bar.v).filter((value): value is number => value != null);
  const volume = volumeValues.length ? volumeValues.reduce((sum, value) => sum + value, 0) : null;
  const changePct = first.o ? ((last.c - first.o) / first.o) * 100 : null;
  const rangePct = first.o ? ((high - low) / first.o) * 100 : null;
  return {
    start: barIso(first.t),
    end: barIso(last.t),
    bars: bars.length,
    open: first.o,
    high,
    low,
    close: last.c,
    volume,
    changePct,
    rangePct,
    regime: inferRegime(changePct, rangePct),
    buckets: bucketBars(bars, EARLIER_BUCKETS),
  };
}

function bucketBars(bars: HistoryBar[], count: number): HistoryBucket[] {
  const size = Math.max(1, Math.ceil(bars.length / count));
  const buckets: HistoryBucket[] = [];
  for (let index = 0; index < bars.length; index += size) {
    const slice = bars.slice(index, index + size);
    const open = slice[0].o;
    const close = slice[slice.length - 1].c;
    const volumes = slice.map((bar) => bar.v).filter((value): value is number => value != null);
    buckets.push({
      start: barIso(slice[0].t),
      end: barIso(slice[slice.length - 1].t),
      bars: slice.length,
      high: Math.max(...slice.map((bar) => bar.h)),
      low: Math.min(...slice.map((bar) => bar.l)),
      close,
      volume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : null,
      changePct: open ? ((close - open) / open) * 100 : null,
    });
  }
  return buckets;
}

function inferRegime(changePct: number | null, rangePct: number | null): HistorySummary["regime"] {
  if (changePct == null) return "unknown";
  if (rangePct != null && Math.abs(changePct) < rangePct * 0.35) return "range";
  if (changePct > 1) return "uptrend";
  if (changePct < -1) return "downtrend";
  return "range";
}

function slimCvd(cvd: HistoryPackExtras["cvd"]): HistoryCvdSummary {
  if (!cvd?.available) {
    return {
      available: false,
      windowNote: CVD_LOOKBACK_NOTE,
      perpDelta: null,
      spotDelta: null,
      interpretation: null,
      reason: cvd?.reason || "CVD summary is unavailable for this lookback.",
    };
  }
  return {
    available: true,
    windowNote: CVD_LOOKBACK_NOTE,
    perpDelta: cvd.perpDelta ?? null,
    spotDelta: cvd.spotDelta ?? null,
    interpretation: cvd.interpretation ?? null,
    reason: null,
  };
}

function slimOi(openInterest: HistoryPackExtras["openInterest"]): HistoryOiSummary {
  if (!openInterest?.available) {
    return {
      available: false,
      windowNote: OI_LOOKBACK_NOTE,
      openInterestUsd: null,
      fundingRate: null,
      reason: openInterest?.reason || "Open interest summary is unavailable for this lookback.",
    };
  }
  return {
    available: true,
    windowNote: OI_LOOKBACK_NOTE,
    openInterestUsd: openInterest.openInterestUsd ?? null,
    fundingRate: openInterest.fundingRate ?? null,
    reason: null,
  };
}

function sortBars(bars: HistoryBar[]): HistoryBar[] {
  return [...bars].sort((left, right) => left.t - right.t);
}

function barMs(time: number): number {
  return time > 1e12 ? time : time * 1000;
}

function barIso(time: number): string {
  return new Date(barMs(time)).toISOString();
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numeric(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function roundUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
