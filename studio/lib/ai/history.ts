export const CONTEXT_CAPTURE = "backend-market-series" as const;

export type HistoryLookback = {
  requested: boolean;
  phrase: string | null;
};

export type ContextSource = {
  kind: typeof CONTEXT_CAPTURE;
  inputs: ["candles", "derivatives", "indicators", "cvd"];
  screenshots: false;
  capture: "never-screenshots";
};

export type HistoryWindow =
  | {
      available: true;
      status: "current-window";
      window: "attached-chart-series";
    }
  | {
      available: false;
      status: "deferred";
      requested: string;
      reason: string;
    };

const LOOKBACK_PATTERN = /(?:(?:last|past|previous|over|for|since)\s+)?(?:\d+\s*)?\b(?:days?|weeks?|months?|years?|hours?)\b|(?:近|过去)\s*(?:\d+\s*)?(?:小时|天|周|月|年)|(?:三个月|半年|一年|本周|本月|今年|\bYTD\b)/i;

export const DEFERRED_HISTORY_REASON = "Longer lookbacks will be fetched from exchange history APIs and summarized into this Context Pack. Chart screenshots are never captured.";

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
    inputs: ["candles", "derivatives", "indicators", "cvd"],
    screenshots: false,
    capture: "never-screenshots",
  };
}

export function packHistoryRange(range: string): HistoryWindow {
  const requested = String(range ?? "").trim();
  if (!requested) {
    return { available: true, status: "current-window", window: "attached-chart-series" };
  }
  return {
    available: false,
    status: "deferred",
    requested,
    reason: DEFERRED_HISTORY_REASON,
  };
}

export function historyWindow(question = ""): HistoryWindow {
  const lookback = detectHistoryLookback(question);
  return packHistoryRange(lookback.phrase ?? "");
}
