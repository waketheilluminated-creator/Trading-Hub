import { DEFAULT_CHART_BARS, CHART_BAR_COUNT_OPTIONS } from "./kline-history.ts";

export const BAR_COUNT_STORAGE_KEY = "th-bar-count";
const BAR_COUNT_EVENT = "th-bar-count-change";

/** Only the offered presets are accepted from storage; anything else falls back to the default. */
export function parseBarCountPref(value: unknown): number {
  const n = Number(value);
  return (CHART_BAR_COUNT_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_CHART_BARS;
}

export function readBarCountPref(): number {
  if (typeof window === "undefined") return DEFAULT_CHART_BARS;
  try {
    return parseBarCountPref(window.localStorage.getItem(BAR_COUNT_STORAGE_KEY));
  } catch {
    return DEFAULT_CHART_BARS;
  }
}

export function writeBarCountPref(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BAR_COUNT_STORAGE_KEY, String(parseBarCountPref(value)));
  } catch {
    // Storage blocked: the choice still applies for this view via the event below.
  }
  window.dispatchEvent(new Event(BAR_COUNT_EVENT));
}

export function subscribeBarCountPref(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => { if (event.key === BAR_COUNT_STORAGE_KEY) onChange(); };
  window.addEventListener(BAR_COUNT_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(BAR_COUNT_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
