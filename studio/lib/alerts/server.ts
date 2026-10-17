/** Process-wide alerts engine (Node runtime). Imported only by API routes; never by client code. */
import { createAlertEngine, ENGINE_POLL_MS, type AlertEngine } from "./engine.ts";
import { createAlertStore, type Db } from "./store.ts";
import { sendMail } from "./smtp.ts";
import { alertsEnvPath, resolveSmtp } from "./secrets.ts";
import { fetchVenueKlines } from "../market-rest.ts";
import { createZoneSource } from "./zone-source.ts";

export type AlertsRuntime = { engine: AlertEngine; running: boolean };

const KEY = Symbol.for("tradinghub.alerts.runtime");
type GlobalWithAlerts = typeof globalThis & { [KEY]?: Promise<AlertsRuntime> };

export function alertsRuntime(): Promise<AlertsRuntime> {
  const g = globalThis as GlobalWithAlerts;
  g[KEY] ??= (async () => {
    const [sqlite, fs, os, path, crypto] = await Promise.all([
      import("node:sqlite"), import("node:fs/promises"), import("node:os"), import("node:path"), import("node:crypto"),
    ]);
    const home = process.platform === "win32" ? process.env.USERPROFILE || os.homedir() : os.homedir();
    const dbPath = path.resolve(process.env.ALERTS_DB_PATH || path.join(home, ".tradinghub", "alerts.db"));
    await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new sqlite.DatabaseSync(dbPath) as unknown as Db;
    const store = createAlertStore(db);
    const envPath = alertsEnvPath(process.env, process.platform, os.homedir(), path.join);
    const engine = createAlertEngine({
      store,
      envPath,
      fetchKlines: async (venue, symbol, interval) => (await fetchVenueKlines(venue, symbol, interval, 3)).candles,
      resolveSmtp: () => resolveSmtp(process.env, envPath, { readFile: (p) => fs.readFile(p, "utf8"), stat: (p) => fs.stat(p) }, process.platform),
      sendMail: (config, message) => sendMail(config, message),
      now: () => Date.now(),
      randomId: () => crypto.randomUUID(),
      randomCode: () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"),
      hash: (text) => crypto.createHash("sha256").update(`tradinghub-verify:${text}`).digest("hex"),
      safeEqual: (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)),
      log: (message) => console.warn(message),
      loadZones: createZoneSource(process.env, (p) => fs.readFile(p, "utf8")),
    });
    const running = process.env.ALERTS_ENGINE === "1";
    if (running) {
      const loop = async () => {
        try { await engine.tick(); await engine.pump(); } catch { console.warn("alerts: engine tick failed"); }
      };
      const timer = setInterval(loop, ENGINE_POLL_MS);
      (timer as { unref?: () => void }).unref?.();
      void loop();
      console.warn(`alerts: engine running (db ${dbPath})`);
    }
    return { engine, running };
  })();
  return g[KEY];
}
