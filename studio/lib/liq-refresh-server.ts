/** Process-wide refresher (Node runtime). Kept out of the client bundle; imported only by API routes. */
import { createLiqRefresher, type ChildLike, type LiqRefresher } from "./liq-refresh.ts";

let refresher: Promise<LiqRefresher> | null = null;

export function liqRefresher(): Promise<LiqRefresher> {
  refresher ??= (async () => {
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
  return refresher;
}
