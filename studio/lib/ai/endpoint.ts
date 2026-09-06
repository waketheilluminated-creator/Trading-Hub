export type EndpointValidation =
  | { ok: true; url: URL }
  | { ok: false; error: string };

function isBlockedHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host === "host.docker.internal"
    || host === "metadata.google.internal"
    || host === "::1"
    || host === "0.0.0.0"
  ) return true;
  if (host.startsWith("fe80:") || /^(fc|fd)[0-9a-f]{0,4}:/i.test(host)) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function normalizeChatCompletionsUrl(url: URL): URL {
  const normalized = new URL(url.href);
  const path = normalized.pathname.replace(/\/+$/, "") || "/";
  if (path.endsWith("/chat/completions")) return normalized;
  if (path === "/" || path === "") {
    normalized.pathname = "/v1/chat/completions";
    return normalized;
  }
  if (path.endsWith("/v1") || path.endsWith("/openai/v1")) {
    normalized.pathname = `${path}/chat/completions`;
    return normalized;
  }
  return normalized;
}

export function validatePublicHttpsEndpoint(endpoint: string): EndpointValidation {
  const trimmed = endpoint.trim();
  if (!trimmed) return { ok: false, error: "Enter a public HTTPS chat-completions endpoint." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter a valid HTTPS model endpoint." };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "Only public HTTPS model endpoints are allowed." };
  }
  return { ok: true, url: normalizeChatCompletionsUrl(parsed) };
}
