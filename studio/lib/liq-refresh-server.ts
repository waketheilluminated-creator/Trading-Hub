/** Process-wide refresher (Node runtime). Kept out of the client bundle; imported only by API routes. */
import { createLiqRefresher, type ChildLike, type LiqRefresher } from "./liq-refresh.ts";
import { autoRefreshConfigFromEnv, createLiqAutoRefresh, type LiqAutoRefresh } from "./liq-auto-refresh.ts";

// One refresher + one scheduler per server process, shared by every route bundle and instrumentation
// (globalThis, not module scope, so cooldown/single-flight state cannot fork between bundles).
const KEY = Symbol.for("tradinghub.liq.refresher");
const AUTO_KEY = Symbol.for("tradinghub.liq.autoRefresh");
type GlobalWithLiq = typeof globalThis & { [KEY]?: Promise<LiqRefresher>; [AUTO_KEY]?: Promise<LiqAutoRefresh | null> };

export function liqRefresher(): Promise<LiqRefresher> {
  const g = globalThis as GlobalWithLiq;
  g[KEY] ??= (async () => {
    const [{ spawn }, fs, os, path, crypto] = await Promise.all([
      import("node:child_process"),
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
      import("node:crypto"),
    ]);
    // Server-chosen output dir; LIQ_REFRESH_OUT_DIR lets the operator pin it (e.g. to studio/fixtures/live).
    const outDir = path.resolve(process.env.LIQ_REFRESH_OUT_DIR || path.join(os.tmpdir(), "th-liq-refresh"));
    return createLiqRefresher({
      spawn: (command, args, options) => spawn(command, [...args], { ...options, env: options.env as NodeJS.ProcessEnv }) as unknown as ChildLike,
      env: process.env,
      outDir,
      randomId: () => crypto.randomUUID(),
      readFile: (file) => fs.readFile(file, "utf8"),
      fileSize: async (file) => (await fs.stat(file)).size,
      writeFile: (file, data) => fs.writeFile(file, data, { mode: 0o600 }),
      rename: (from, to) => fs.rename(from, to),
      remove: (file) => fs.rm(file, { force: true }),
      mkdir: async (dir) => { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); },
      now: () => Date.now(),
      log: (message) => console.warn(message),
    });
  })();
  return g[KEY];
}

/**
 * TH-BUG-06: start the background auto-refresh once per process (idempotent). Returns null when disabled
 * (estimator unconfigured or LIQ_AUTO_REFRESH_SEC=0). Runs only through {@link liqRefresher}'s rails.
 */
export function startLiqAutoRefresh(): Promise<LiqAutoRefresh | null> {
  const g = globalThis as GlobalWithLiq;
  g[AUTO_KEY] ??= (async () => {
    const config = autoRefreshConfigFromEnv(process.env);
    if (!config.enabled) {
      console.warn(`liq auto-refresh: off (${config.reason})`);
      return null;
    }
    const refresher = await liqRefresher();
    const auto = createLiqAutoRefresh({
      refresher,
      now: () => Date.now(),
      intervalMs: config.intervalMs,
      symbols: config.symbols,
      log: (message) => console.warn(message),
    });
    auto.start();
    void auto.tick().catch(() => console.warn("liq auto-refresh: first tick failed"));
    console.warn(`liq auto-refresh: every ${Math.round(config.intervalMs / 1000)} s for ${config.symbols.join(",")} + viewed symbols`);
    return auto;
  })().catch(() => {
    console.warn("liq auto-refresh: failed to start");
    return null;
  });
  return g[AUTO_KEY];
}
