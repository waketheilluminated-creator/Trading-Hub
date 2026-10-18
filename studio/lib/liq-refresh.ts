/**
 * TH-FEAT-11 — on-demand liquidation zone refresh (Tier C: command execution).
 *
 * POST /api/liq-zones/refresh?symbol=ZECUSDT runs the 订单流研发 estimator once, on click only (no timers).
 * Safety rails (secure-industrial-coding, Tier C):
 *  - command comes only from server env LIQ_ESTIMATOR_CMD; unset → 503
 *  - spawned with an argv array, shell:false; the only request-derived argv value is an allowlisted symbol
 *  - output path is chosen server-side (temp dir + random name); never from the request
 *  - minimal child env (PATH/HOME/LANG + LIQ_SOCKS_PROXY only if set), 90 s timeout → SIGKILL
 *  - single-flight per symbol (409), 30 s cooldown per symbol (429 + Retry-After)
 *  - POST only, localhost host + same-origin Origin required
 *  - output JSON must pass sanitizeLiqHeatmapSnapshot and match the symbol before it replaces the last good snapshot;
 *    any failure keeps the last good snapshot.
 *
 * Estimator CLI contract: `<LIQ_ESTIMATOR_CMD...> --symbol <ZECUSDT|PYTHUSDT> --out <abs path>`;
 * exit 0 after writing a liq_heatmap_bands JSON (schemaVersion 1, optional venues_failed[]) to --out;
 * non-zero exit + stderr on failure.
 */
import { LIQ_UNLISTED_NOTICE, isLiqSymbol, sanitizeLiqHeatmapSnapshot, sanitizeVenuesFailed, type LiqHeatmapSnapshot } from "./liq-heatmap.ts";

export { sanitizeVenuesFailed };

export type LiqRefreshSymbol = string;

export const LIQ_REFRESH_TIMEOUT_MS = 90_000;
export const LIQ_REFRESH_COOLDOWN_MS = 30_000; // per symbol; the 90 s child timeout is separate
export const LIQ_REFRESH_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const LIQ_REFRESH_STDERR_CAP = 4096;
export const LIQ_REFRESH_UNCONFIGURED = "Liquidation estimator is not configured on this server (set LIQ_ESTIMATOR_CMD).";
export const LIQ_REFRESH_CHILD_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "VIRTUAL_ENV", "PYTHONPATH"] as const;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type ChildLike = {
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): unknown;
};
export type SpawnLike = (command: string, args: readonly string[], options: { shell: false; env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }) => ChildLike;

export type LiqRefreshDeps = {
  spawn: SpawnLike;
  env: Readonly<Record<string, string | undefined>>;
  outDir: string;
  randomId(): string;
  readFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  now(): number;
  log?(message: string): void;
  timeoutMs?: number;
  cooldownMs?: number;
  maxConcurrent?: number;
  maxCached?: number;
};

export type LiqRefreshResult =
  | { status: 200; body: { ok: true; snapshot: LiqHeatmapSnapshot; cooldownSec: number } }
  | { status: 400 | 403 | 405 | 409 | 422 | 429 | 502 | 503 | 504; body: { ok: false; error: string; code?: string; retryAfterSec?: number }; retryAfterSec?: number };

/** TH-FEAT-12: strict format instead of an allowlist; the exact request string must match (no normalisation). */
export function allowlistedSymbol(value: unknown): LiqRefreshSymbol | null {
  return isLiqSymbol(value) ? value : null;
}

/** Global cap on concurrent estimator runs (all symbols). */
export const LIQ_REFRESH_MAX_CONCURRENT = 2;
/** Cap on cached last-good snapshots (memory + disk); oldest refresh is evicted first. */
export const LIQ_REFRESH_MAX_CACHED = 40;

/** LIQ_ESTIMATOR_CMD: a JSON string array (preferred) or whitespace-separated words. Never run through a shell. */
export function parseEstimatorCommand(raw: string | undefined): string[] | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text) return null;
  let argv: unknown;
  if (text.startsWith("[")) {
    try { argv = JSON.parse(text); } catch { return null; }
  } else {
    argv = text.split(/\s+/);
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32) return null;
  if (!argv.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4096 && !part.includes("\0"))) return null;
  return argv as string[];
}

/**
 * Resolve the estimator argv: LIQ_ESTIMATOR_PYTHON + LIQ_ESTIMATOR_SCRIPT (both set) win, else LIQ_ESTIMATOR_CMD.
 * A leading "$HOME" / "${HOME}" / "~" in a word is expanded from the server env (no other expansion, no shell).
 */
export function estimatorArgvFromEnv(env: Readonly<Record<string, string | undefined>>): string[] | null {
  const python = env.LIQ_ESTIMATOR_PYTHON?.trim();
  const script = env.LIQ_ESTIMATOR_SCRIPT?.trim();
  const argv = python && script ? parseEstimatorCommand(JSON.stringify([python, script])) : parseEstimatorCommand(env.LIQ_ESTIMATOR_CMD);
  if (!argv) return null;
  const home = env.HOME;
  const expanded = argv.map((word) => {
    const match = /^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/.exec(word);
    if (!match) return word;
    return home && home.startsWith("/") ? home + word.slice(match[0].length) : null;
  });
  if (expanded.some((word) => word == null || /\$|`/.test(word))) return null;
  return expanded as string[];
}

export function estimatorChildEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const child: Record<string, string> = {};
  for (const key of LIQ_REFRESH_CHILD_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value) child[key] = value;
  }
  // Tor/SOCKS is optional: forwarded only when the operator set it.
  const proxy = env.LIQ_SOCKS_PROXY;
  if (typeof proxy === "string" && /^socks5h?:\/\/[A-Za-z0-9.\-_:@[\]]{1,200}$/.test(proxy)) child.LIQ_SOCKS_PROXY = proxy;
  return child;
}

/** Same-origin, localhost-only guard for a state-changing request. */
export function refreshRequestGuard(request: Request): { ok: true } | { ok: false; status: 403 | 405; error: string } {
  if (request.method !== "POST") return { ok: false, status: 405, error: "Use POST to refresh liquidation zones." };
  const url = new URL(request.url);
  if (!LOCAL_HOSTS.has(url.hostname)) return { ok: false, status: 403, error: "Liquidation refresh is only available on localhost." };
  const origin = request.headers.get("origin");
  if (!origin || origin !== url.origin) return { ok: false, status: 403, error: "Cross-origin liquidation refresh is not allowed." };
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return { ok: false, status: 403, error: "Cross-origin liquidation refresh is not allowed." };
  return { ok: true };
}

type RunOutcome = { kind: "exit"; code: number | null; signal: string | null; stderr: string } | { kind: "timeout"; stderr: string } | { kind: "error"; message: string };

function runOnce(spawn: SpawnLike, command: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let child: ChildLike;
    try {
      child = spawn(command, args, { shell: false, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ kind: "error", message: error instanceof Error ? error.message : "spawn failed" });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (outcome: RunOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ kind: "timeout", stderr });
    }, timeoutMs);
    child.stdout?.on("data", () => { /* drained, ignored */ });
    child.stderr?.on("data", (chunk) => { if (stderr.length < LIQ_REFRESH_STDERR_CAP) stderr = (stderr + String(chunk)).slice(0, LIQ_REFRESH_STDERR_CAP); });
    child.on("error", (error) => finish({ kind: "error", message: error.message }));
    child.on("close", (code, signal) => finish({ kind: "exit", code, signal, stderr }));
  });
}

function fail(status: 400 | 403 | 405 | 409 | 422 | 429 | 502 | 503 | 504, error: string, retryAfterSec?: number): LiqRefreshResult {
  return retryAfterSec == null ? { status, body: { ok: false, error } } : { status, body: { ok: false, error, retryAfterSec }, retryAfterSec };
}

export function liqLastGoodPath(outDir: string, symbol: LiqRefreshSymbol): string {
  // Defence in depth: the symbol is the only request-derived part of any path; re-check its format here.
  if (!isLiqSymbol(symbol)) throw new Error("invalid liquidation symbol");
  return `${outDir}/liq_heatmap_bands.${symbol}.json`;
}

export function createLiqRefresher(deps: LiqRefreshDeps) {
  const inflight = new Map<LiqRefreshSymbol, Promise<LiqRefreshResult>>();
  const lastStart = new Map<LiqRefreshSymbol, number>();
  const lastGood = new Map<LiqRefreshSymbol, LiqHeatmapSnapshot>();
  const timeoutMs = deps.timeoutMs ?? LIQ_REFRESH_TIMEOUT_MS;
  const cooldownMs = deps.cooldownMs ?? LIQ_REFRESH_COOLDOWN_MS;
  const log = deps.log ?? (() => {});
  const maxConcurrent = deps.maxConcurrent ?? LIQ_REFRESH_MAX_CONCURRENT;
  const maxCached = deps.maxCached ?? LIQ_REFRESH_MAX_CACHED;

  /** Insert as most recent; evict the oldest snapshots (memory and file) beyond the cap. */
  function remember(symbol: LiqRefreshSymbol, snapshot: LiqHeatmapSnapshot): void {
    lastGood.delete(symbol);
    lastGood.set(symbol, snapshot);
    while (lastGood.size > maxCached) {
      const oldest = lastGood.keys().next().value as LiqRefreshSymbol;
      lastGood.delete(oldest);
      deps.remove(liqLastGoodPath(deps.outDir, oldest)).catch(() => {});
    }
  }

  async function execute(symbol: LiqRefreshSymbol, argv: string[]): Promise<LiqRefreshResult> {
    await deps.mkdir(deps.outDir);
    const tmpPath = `${deps.outDir}/run-${symbol}-${deps.randomId().replace(/[^A-Za-z0-9-]/g, "")}.json`;
    const args = [...argv.slice(1), "--symbol", symbol, "--out", tmpPath];
    try {
      const outcome = await runOnce(deps.spawn, argv[0], args, estimatorChildEnv(deps.env), timeoutMs);
      if (outcome.kind === "error") {
        log(`liq refresh ${symbol}: spawn error ${outcome.message}`);
        return fail(502, "Liquidation estimator could not be started; showing the last good zones.");
      }
      if (outcome.kind === "timeout") {
        log(`liq refresh ${symbol}: timed out after ${timeoutMs} ms; stderr: ${outcome.stderr}`);
        return fail(504, `Liquidation estimator timed out after ${Math.round(timeoutMs / 1000)} s; showing the last good zones.`);
      }
      if (outcome.code === 3) {
        // Estimator contract: exit 3 = no venue lists this symbol (no output file).
        return { status: 422, body: { ok: false, error: LIQ_UNLISTED_NOTICE, code: "unlisted" } };
      }
      if (outcome.code === 2) {
        log(`liq refresh ${symbol}: estimator rejected its arguments; stderr: ${outcome.stderr}`);
        return fail(502, "Liquidation estimator rejected the request (exit 2); showing the last good zones.");
      }
      if (outcome.code !== 0) {
        log(`liq refresh ${symbol}: exit ${outcome.code ?? outcome.signal}; stderr: ${outcome.stderr}`);
        return fail(502, `Liquidation estimator failed (exit ${outcome.code ?? outcome.signal ?? "?"}); showing the last good zones.`);
      }
      let size: number;
      try { size = await deps.fileSize(tmpPath); } catch { return fail(502, "Liquidation estimator wrote no output; showing the last good zones."); }
      if (size > LIQ_REFRESH_MAX_OUTPUT_BYTES) return fail(502, "Liquidation estimator output is too large; showing the last good zones.");
      let raw: unknown;
      try { raw = JSON.parse(await deps.readFile(tmpPath)); } catch { return fail(502, "Liquidation estimator output is not valid JSON; showing the last good zones."); }
      const parsed = sanitizeLiqHeatmapSnapshot(raw);
      if (!parsed.ok) return fail(502, `Liquidation estimator output rejected: ${parsed.error} Showing the last good zones.`);
      if (parsed.snapshot.symbol !== symbol) return fail(502, "Liquidation estimator output is for a different symbol; showing the last good zones.");
      if (parsed.snapshot.schemaVersion !== 1) return fail(502, "Liquidation estimator output lacks schemaVersion 1; showing the last good zones.");
      const snapshot: LiqHeatmapSnapshot = parsed.snapshot;
      await deps.rename(tmpPath, liqLastGoodPath(deps.outDir, symbol));
      remember(symbol, snapshot);
      return { status: 200, body: { ok: true, snapshot, cooldownSec: Math.ceil(cooldownMs / 1000) } };
    } finally {
      await deps.remove(tmpPath).catch(() => {});
    }
  }

  return {
    /** Run the estimator for an already-guarded request. */
    async refresh(symbolParam: string | null): Promise<LiqRefreshResult> {
      const symbol = allowlistedSymbol(symbolParam);
      if (!symbol) return fail(400, "symbol must be a USDT perpetual such as BTCUSDT (A–Z, 0–9, ending in USDT).");
      const argv = estimatorArgvFromEnv(deps.env);
      if (!argv) return fail(503, LIQ_REFRESH_UNCONFIGURED);
      if (inflight.has(symbol)) return fail(409, "A liquidation refresh for this symbol is already running.", Math.ceil(timeoutMs / 1000));
      if (inflight.size >= maxConcurrent) return fail(429, "Another liquidation refresh is running; try again shortly.", 15);
      const started = lastStart.get(symbol);
      const now = deps.now();
      if (started != null && now - started < cooldownMs) {
        return fail(429, "Liquidation refresh is cooling down.", Math.max(1, Math.ceil((cooldownMs - (now - started)) / 1000)));
      }
      lastStart.set(symbol, now);
      if (lastStart.size > 1000) for (const [key, at] of lastStart) if (now - at >= cooldownMs) lastStart.delete(key);
      const run = execute(symbol, argv).catch((error: unknown) => {
        log(`liq refresh ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
        return fail(502, "Liquidation refresh failed; showing the last good zones.");
      }).finally(() => inflight.delete(symbol));
      inflight.set(symbol, run);
      return run;
    },
    /** Last snapshot that passed validation in this server process, if any. */
    lastGood(symbol: string): LiqHeatmapSnapshot | null {
      const allowed = allowlistedSymbol(symbol);
      return allowed ? lastGood.get(allowed) ?? null : null;
    },
    /** Reload a last-good file written by an earlier process (validated again). */
    async restore(symbol: LiqRefreshSymbol): Promise<LiqHeatmapSnapshot | null> {
      if (!isLiqSymbol(symbol)) return null;
      if (lastGood.has(symbol)) return lastGood.get(symbol) ?? null;
      try {
        const raw: unknown = JSON.parse(await deps.readFile(liqLastGoodPath(deps.outDir, symbol)));
        const parsed = sanitizeLiqHeatmapSnapshot(raw);
        if (!parsed.ok || parsed.snapshot.symbol !== symbol) return null;
        const snapshot = parsed.snapshot;
        remember(symbol, snapshot);
        return snapshot;
      } catch {
        return null;
      }
    },
  };
}

export type LiqRefresher = ReturnType<typeof createLiqRefresher>;
