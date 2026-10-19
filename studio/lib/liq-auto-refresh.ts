/**
 * TH-BUG-06 — server-side liquidation auto-refresh (Tier C: background job that spawns the estimator).
 *
 * Root cause it fixes: TH-FEAT-11 made refresh click-only, so GET /api/liq-heatmap only ever restored the last
 * on-demand snapshot (also across restarts) and asOf never advanced on its own.
 *
 * Safety rails:
 *  - every run goes through the existing refresher (allowlisted symbol, argv/no shell, single-flight per symbol,
 *    global concurrency cap, 30 s per-symbol cooldown, 90 s timeout, validated swap-in); nothing here spawns directly
 *  - disabled unless the operator configured the estimator (LIQ_ESTIMATOR_CMD …); LIQ_AUTO_REFRESH_SEC=0|off disables
 *  - symbols: operator list (default BTCUSDT,ETHUSDT) + symbols viewed via a same-origin localhost GET; format-checked,
 *    capped at LIQ_AUTO_WATCH_MAX, viewed ones expire after a TTL; a cross-site request cannot enrol a symbol
 *  - one sequential tick at a time; a symbol is re-run only when its snapshot is older than the interval and it was not
 *    attempted within the interval (failures back off, unlisted symbols are dropped)
 */
import { isLiqSymbol } from "./liq-heatmap.ts";
import { estimatorArgvFromEnv } from "./liq-refresh.ts";

export const LIQ_AUTO_REFRESH_DEFAULT_SEC = 300;
export const LIQ_AUTO_REFRESH_MIN_SEC = 60;
export const LIQ_AUTO_REFRESH_MAX_SEC = 3600;
export const LIQ_AUTO_REFRESH_TICK_MS = 30_000;
export const LIQ_AUTO_WATCH_TTL_MS = 30 * 60_000;
export const LIQ_AUTO_WATCH_MAX = 6;
export const LIQ_AUTO_DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type AutoRefreshConfig = { enabled: true; intervalMs: number; symbols: string[] } | { enabled: false; reason: string };

type RefreshOutcome = { status: number; body: unknown };
export type AutoRefreshTarget = {
  refresh(symbol: string): Promise<RefreshOutcome>;
  restore(symbol: string): Promise<{ updatedAt: number } | null>;
};
type TimerHandle = { unref?: () => void } | number | undefined;

export type LiqAutoRefreshDeps = {
  refresher: AutoRefreshTarget;
  now(): number;
  intervalMs: number;
  symbols: readonly string[];
  watchTtlMs?: number;
  watchMax?: number;
  tickMs?: number;
  log?(message: string): void;
  setTimer?(fn: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
};

function symbolList(raw: string | undefined): string[] {
  if (raw == null || !raw.trim()) return [...LIQ_AUTO_DEFAULT_SYMBOLS];
  const out: string[] = [];
  for (const word of raw.split(",")) {
    const symbol = word.trim();
    if (isLiqSymbol(symbol) && !out.includes(symbol)) out.push(symbol);
    if (out.length >= LIQ_AUTO_WATCH_MAX) break;
  }
  return out;
}

/** Server env → scheduler config. Fails closed (disabled) when the estimator is not configured. */
export function autoRefreshConfigFromEnv(env: Readonly<Record<string, string | undefined>>): AutoRefreshConfig {
  if (!estimatorArgvFromEnv(env)) return { enabled: false, reason: "estimator not configured" };
  const rawSec = env.LIQ_AUTO_REFRESH_SEC?.trim().toLowerCase();
  if (rawSec === "0" || rawSec === "off" || rawSec === "false") return { enabled: false, reason: "disabled by LIQ_AUTO_REFRESH_SEC" };
  const parsed = rawSec ? Number(rawSec) : Number.NaN;
  const sec = Number.isFinite(parsed) && parsed > 0 ? Math.min(LIQ_AUTO_REFRESH_MAX_SEC, Math.max(LIQ_AUTO_REFRESH_MIN_SEC, parsed)) : LIQ_AUTO_REFRESH_DEFAULT_SEC;
  return { enabled: true, intervalMs: Math.round(sec * 1000), symbols: symbolList(env.LIQ_AUTO_REFRESH_SYMBOLS) };
}

/** May this GET enrol its symbol for auto-refresh? Only a same-origin browser request to localhost (missing header → no). */
export function autoRefreshWatchAllowed(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) return false;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function createLiqAutoRefresh(deps: LiqAutoRefreshDeps) {
  const seeds = deps.symbols.filter((s) => isLiqSymbol(s)).slice(0, LIQ_AUTO_WATCH_MAX);
  const ttl = deps.watchTtlMs ?? LIQ_AUTO_WATCH_TTL_MS;
  const max = deps.watchMax ?? LIQ_AUTO_WATCH_MAX;
  const log = deps.log ?? (() => {});
  const seen = new Map<string, number>(); // viewed symbol → last view (insertion order = oldest first)
  const lastAttempt = new Map<string, number>();
  let running = false;
  let timer: TimerHandle = undefined;
  let started = false;

  function watched(): string[] {
    const now = deps.now();
    for (const [symbol, at] of seen) if (now - at > ttl) seen.delete(symbol);
    return [...seen.keys()];
  }

  async function due(symbol: string, now: number): Promise<boolean> {
    const attempted = lastAttempt.get(symbol);
    if (attempted != null && now - attempted < deps.intervalMs) return false;
    const snapshot = await deps.refresher.restore(symbol).catch(() => null);
    return !snapshot || !(now - snapshot.updatedAt < deps.intervalMs);
  }

  async function tick(): Promise<{ skipped: true } | { skipped: false; ran: { symbol: string; status: number }[] }> {
    if (running) return { skipped: true };
    running = true;
    const ran: { symbol: string; status: number }[] = [];
    try {
      const targets = [...new Set([...seeds, ...watched()])];
      for (const symbol of targets) {
        const now = deps.now();
        if (!(await due(symbol, now))) continue;
        lastAttempt.set(symbol, now);
        let status: number;
        try {
          status = (await deps.refresher.refresh(symbol)).status;
        } catch {
          status = 502;
        }
        ran.push({ symbol, status });
        if (status === 422) seen.delete(symbol);
        else if (status !== 200 && status !== 409 && status !== 429) log(`liq auto-refresh ${symbol}: status ${status}`);
      }
      if (lastAttempt.size > 200) for (const [s, at] of lastAttempt) if (deps.now() - at >= deps.intervalMs) lastAttempt.delete(s);
    } finally {
      running = false;
    }
    return { skipped: false, ran };
  }

  return {
    tick,
    watched,
    /** Enrol a viewed symbol (caller must have checked {@link autoRefreshWatchAllowed}). */
    watch(symbol: unknown): void {
      if (!isLiqSymbol(symbol)) return;
      seen.delete(symbol);
      seen.set(symbol, deps.now());
      while (seen.size > max) seen.delete(seen.keys().next().value as string);
    },
    start(): void {
      if (started) return;
      started = true;
      const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as TimerHandle);
      const tickMs = Math.min(deps.tickMs ?? LIQ_AUTO_REFRESH_TICK_MS, 60_000);
      timer = setTimer(() => { void tick().catch(() => log("liq auto-refresh: tick failed")); }, tickMs);
      if (timer && typeof timer === "object") timer.unref?.();
    },
    stop(): void {
      if (!started) return;
      started = false;
      const clear = deps.clearTimer ?? ((h: TimerHandle) => clearInterval(h as unknown as ReturnType<typeof setInterval>));
      clear(timer);
      timer = undefined;
    },
  };
}

export type LiqAutoRefresh = ReturnType<typeof createLiqAutoRefresh>;
