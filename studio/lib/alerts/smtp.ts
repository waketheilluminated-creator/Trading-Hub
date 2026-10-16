/**
 * Minimal SMTP submission client (no dependencies): implicit TLS (Gmail smtp.gmail.com:465) or plain TCP
 * for a local mock catcher in tests. AUTH PLAIN, one recipient, text + HTML multipart.
 * Credentials are passed per call and never logged; errors never echo them.
 */
import { headerSafe } from "./core.ts";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean; // implicit TLS
  user: string | null;
  pass: string | null;
  from: string;
  timeoutMs?: number;
};

export type MailMessage = { to: string; subject: string; text: string; html: string };

export class SmtpError extends Error {
  readonly code: number | null;
  readonly permanent: boolean;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    // 5xx are permanent except 5.4.x-ish transient conditions are rare; 421/45x are retryable.
    this.permanent = code != null && code >= 500 && code < 600;
  }
}

type Socket = {
  write(data: string): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "close", cb: () => void): void;
  end(): void;
  destroy(): void;
  setTimeout?(ms: number, cb: () => void): void;
};

export type Connector = (config: SmtpConfig) => Promise<Socket>;

export const nodeConnector: Connector = async (config) => {
  if (config.secure) {
    const tls = await import("node:tls");
    return await new Promise<Socket>((resolve, reject) => {
      const socket = tls.connect({ host: config.host, port: config.port, servername: config.host, minVersion: "TLSv1.2" }, () => resolve(socket as unknown as Socket));
      socket.once("error", reject);
    });
  }
  const net = await import("node:net");
  return await new Promise<Socket>((resolve, reject) => {
    const socket = net.connect({ host: config.host, port: config.port }, () => resolve(socket as unknown as Socket));
    socket.once("error", reject);
  });
};

function dotStuff(body: string): string {
  return body.replace(/\r?\n/g, "\r\n").split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
}

function encodeHeader(text: string): string {
  const safe = headerSafe(text);
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

export function buildMime(config: SmtpConfig, message: MailMessage, boundary: string, date: Date, messageId: string): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
  return [
    `From: Trading Hub <${headerSafe(config.from)}>`,
    `To: <${headerSafe(message.to)}>`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Sends one message. Resolves on 250 after DATA; throws SmtpError (credentials never included). */
export async function sendMail(config: SmtpConfig, message: MailMessage, connector: Connector = nodeConnector): Promise<void> {
  if (/[\r\n]/.test(message.to) || /[\r\n]/.test(config.from)) throw new SmtpError("Invalid address.", null);
  const socket = await connector(config);
  let buffer = "";
  let waiting: ((reply: { code: number; text: string }) => void) | null = null;
  let failure: Error | null = null;
  const pending: { code: number; text: string }[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0 || (index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) continue;
      if (match[2] === " ") {
        const reply = { code: Number(match[1]), text: match[3].slice(0, 200) };
        if (waiting) { const w = waiting; waiting = null; w(reply); } else pending.push(reply);
      }
    }
  });
  socket.on("error", (error) => { failure = error; if (waiting) { const w = waiting; waiting = null; w({ code: 0, text: "connection error" }); } });
  socket.on("close", () => { if (waiting) { const w = waiting; waiting = null; w({ code: 0, text: "connection closed" }); } });
  const timeoutMs = config.timeoutMs ?? 20_000;
  const read = () => new Promise<{ code: number; text: string }>((resolve) => {
    const ready = pending.shift();
    if (ready) return resolve(ready);
    const timer = setTimeout(() => { waiting = null; resolve({ code: 0, text: "timeout" }); }, timeoutMs);
    waiting = (reply) => { clearTimeout(timer); resolve(reply); };
  });
  const expect = async (accepted: number[], step: string) => {
    const reply = await read();
    if (!accepted.includes(reply.code)) {
      throw new SmtpError(`SMTP ${step} failed (${reply.code || "no reply"}${failure ? "" : ""})`, reply.code || null);
    }
    return reply;
  };
  try {
    await expect([220], "greeting");
    socket.write("EHLO tradinghub.local\r\n");
    await expect([250], "EHLO");
    if (config.user && config.pass) {
      const token = Buffer.from(`\u0000${config.user}\u0000${config.pass}`, "utf8").toString("base64");
      socket.write(`AUTH PLAIN ${token}\r\n`);
      await expect([235], "AUTH");
    }
    socket.write(`MAIL FROM:<${config.from}>\r\n`);
    await expect([250], "MAIL FROM");
    socket.write(`RCPT TO:<${message.to}>\r\n`);
    await expect([250, 251], "RCPT TO");
    socket.write("DATA\r\n");
    await expect([354], "DATA");
    const boundary = `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const domain = config.from.split("@")[1] || "tradinghub.local";
    socket.write(`${dotStuff(buildMime(config, message, boundary, new Date(), `${boundary}@${domain}`))}\r\n.\r\n`);
    await expect([250], "message");
    socket.write("QUIT\r\n");
  } finally {
    try { socket.end(); } catch { /* ignore */ }
  }
}
