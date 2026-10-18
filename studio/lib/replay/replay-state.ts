/** TH-FEAT-17 Bar Replay client state helpers (pure). Times are lightweight-charts UNIX seconds. */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 10] as const; // bars per second
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export type ReplayState =
  | { phase: "pick" }
  | { phase: "active"; cursor: number; playing: boolean; speed: ReplaySpeed };
export const REPLAY_PICK_HINT = "点击K线选择回放起点 · Click a candle to start replay";
export const REPLAY_EXIT_LABEL = "回到实时 Exit replay";

type Timed = { time: unknown };

/** Bars visible in replay: everything up to and including the replay candle. Later bars are hidden. */
export function sliceReplayCandles<T extends Timed>(candles: readonly T[], cursor: number): T[] {
  let end = candles.length;
  while (end > 0 && Number(candles[end - 1].time) > cursor) end -= 1;
  return candles.slice(0, end);
}

export function nextReplayTime(candles: readonly Timed[], cursor: number): number | null {
  for (const c of candles) { const t = Number(c.time); if (t > cursor) return t; }
  return null;
}

export function prevReplayTime(candles: readonly Timed[], cursor: number): number | null {
  let best: number | null = null;
  for (const c of candles) { const t = Number(c.time); if (t < cursor) best = t; else break; }
  return best;
}

/** Snap a clicked time to the candle containing it (the latest candle opening at or before it). */
export function snapReplayStart(candles: readonly Timed[], time: number): number | null {
  let best: number | null = null;
  for (const c of candles) { const t = Number(c.time); if (t <= time) best = t; else break; }
  return best ?? (candles.length ? Number(candles[0].time) : null);
}

export function intervalSeconds(interval: string): number {
  if (interval === "D") return 86_400;
  const n = Number(interval);
  return Number.isFinite(n) && n > 0 ? n * 60 : 60;
}

/** Close time (ms) of the replay candle: the server may use data up to here, never later. */
export function replayCutoffMs(cursor: number, interval: string, now: number): number {
  return Math.min((cursor + intervalSeconds(interval)) * 1000, Math.floor(now / 60_000) * 60_000);
}

export function replayStepMs(speed: ReplaySpeed): number {
  return Math.round(1000 / speed);
}
