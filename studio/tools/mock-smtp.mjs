#!/usr/bin/env node
/**
 * Local SMTP catcher for testing alerts without Gmail. Binds 127.0.0.1 only, accepts any message,
 * never relays. Each message is appended to the output file as one JSON line (headers + decoded text/html).
 *   node tools/mock-smtp.mjs --port 2525 --out captured-mail.jsonl
 * Then start the server with ALERTS_SMTP_HOST=127.0.0.1 ALERTS_SMTP_PORT=2525 ALERTS_SMTP_SECURE=0.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";

export function decodeMessage(raw) {
  const [head, ...rest] = raw.split(/\r\n\r\n/);
  const headers = {};
  for (const line of head.split(/\r\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const subjectRaw = headers.subject || "";
  const m = /^=\?UTF-8\?B\?(.*)\?=$/i.exec(subjectRaw);
  const subject = m ? Buffer.from(m[1], "base64").toString("utf8") : subjectRaw;
  const body = rest.join("\r\n\r\n");
  const parts = {};
  for (const part of body.split(/\r\n--[^\r\n]+/)) {
    const type = /Content-Type:\s*text\/(plain|html)/i.exec(part);
    if (!type) continue;
    const content = part.split(/\r\n\r\n/).slice(1).join("\r\n\r\n").replace(/\s+/g, "");
    parts[type[1].toLowerCase()] = Buffer.from(content, "base64").toString("utf8");
  }
  return { from: headers.from, to: headers.to, subject, text: parts.plain ?? "", html: parts.html ?? "" };
}

export function startMockSmtp({ port = 2525, onMessage = () => {} } = {}) {
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let data = [];
    const envelope = { from: null, to: [] };
    socket.write("220 mock-smtp ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            const raw = data.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
            data = [];
            onMessage({ envelope: { ...envelope }, raw, ...decodeMessage(raw), receivedAt: new Date().toISOString() });
            socket.write("250 OK queued\r\n");
          } else data.push(line);
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-mock-smtp\r\n250 AUTH PLAIN\r\n");
        else if (cmd === "AUTH") socket.write("235 OK\r\n");
        else if (cmd === "MAIL") { envelope.from = line.slice(10).trim(); envelope.to = []; socket.write("250 OK\r\n"); }
        else if (cmd === "RCPT") { envelope.to.push(line.slice(8).trim()); socket.write("250 OK\r\n"); }
        else if (cmd === "DATA") { inData = true; socket.write("354 go ahead\r\n"); }
        else if (cmd === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else if (cmd === "RSET" || cmd === "NOOP") socket.write("250 OK\r\n");
        else socket.write("502 not implemented\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
  const port = Number(arg("--port", "2525"));
  const out = arg("--out", "captured-mail.jsonl");
  await startMockSmtp({
    port,
    onMessage: (msg) => {
      const rest = { ...msg };
      delete rest.raw;
      appendFileSync(out, `${JSON.stringify(rest)}\n`);
      console.log(`captured: ${rest.subject} -> ${rest.envelope.to.join(",")}`);
    },
  });
  console.log(`mock-smtp listening on 127.0.0.1:${port}, writing ${out}`);
}
