/**
 * Gmail SMTP credentials live ONLY in a local, untracked env file on the alert host:
 *   Windows: %USERPROFILE%\.tradinghub\alerts.env    macOS/Linux: ~/.tradinghub/alerts.env
 * (override with ALERTS_ENV_FILE). Keys: GMAIL_USER, GMAIL_APP_PASSWORD.
 * The file is read at send time, never returned by any API, never logged, never stored in SQLite.
 * On POSIX the file must be owner-only (mode & 0o077 === 0) or it is refused.
 */
import type { SmtpConfig } from "./smtp.ts";

export const ENV_FILE_KEYS = ["GMAIL_USER", "GMAIL_APP_PASSWORD"] as const;

export type FsLike = {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ mode: number }>;
};

export function alertsEnvPath(env: Readonly<Record<string, string | undefined>>, platform: string, homedir: string, join: (...p: string[]) => string): string {
  const override = env.ALERTS_ENV_FILE;
  if (override && override.trim()) return override.trim();
  return join(platform === "win32" ? env.USERPROFILE || homedir : homedir, ".tradinghub", "alerts.env");
}

/** KEY=VALUE lines; # comments; optional surrounding quotes. Only whitelisted keys are kept. */
export function parseEnvFile(text: string): Partial<Record<(typeof ENV_FILE_KEYS)[number], string>> {
  const out: Partial<Record<(typeof ENV_FILE_KEYS)[number], string>> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if ((ENV_FILE_KEYS as readonly string[]).includes(key) && value) out[key as (typeof ENV_FILE_KEYS)[number]] = value;
  }
  return out;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export type SmtpResolution = { ok: true; config: SmtpConfig } | { ok: false; reason: string };

/**
 * Resolve the SMTP config. Production: smtp.gmail.com:465 implicit TLS with the env-file credentials.
 * ALERTS_SMTP_HOST/PORT/SECURE override exists for a local mock catcher; plaintext is only allowed to loopback,
 * and credentials are never sent over plaintext.
 */
export async function resolveSmtp(env: Readonly<Record<string, string | undefined>>, envPath: string, fs: FsLike, platform: string): Promise<SmtpResolution> {
  const host = (env.ALERTS_SMTP_HOST || "smtp.gmail.com").trim();
  const port = Number(env.ALERTS_SMTP_PORT || 465);
  const secure = (env.ALERTS_SMTP_SECURE ?? (host === "smtp.gmail.com" ? "1" : "0")) !== "0";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) && !LOOPBACK.has(host)) return { ok: false, reason: "Invalid ALERTS_SMTP_HOST." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "Invalid ALERTS_SMTP_PORT." };
  if (!secure && !LOOPBACK.has(host)) return { ok: false, reason: "Plaintext SMTP is only allowed to a loopback mock server." };

  const mock = !secure && LOOPBACK.has(host);
  let creds: ReturnType<typeof parseEnvFile> = {};
  try {
    if (platform !== "win32") {
      const { mode } = await fs.stat(envPath);
      if ((mode & 0o077) !== 0) return { ok: false, reason: "alerts.env must be owner-only (chmod 600)." };
    }
    creds = parseEnvFile(await fs.readFile(envPath));
  } catch {
    if (!mock) return { ok: false, reason: "Email is not configured: alerts.env not found." };
  }
  const user = creds.GMAIL_USER ?? null;
  const pass = creds.GMAIL_APP_PASSWORD ?? null;
  if (!mock && (!user || !pass)) return { ok: false, reason: "Email is not configured: GMAIL_USER / GMAIL_APP_PASSWORD missing in alerts.env." };
  return {
    ok: true,
    config: {
      host, port, secure,
      // Never send real credentials over plaintext (mock only).
      user: secure ? user : null,
      pass: secure ? pass : null,
      from: user || "alerts@tradinghub.local",
    },
  };
}
