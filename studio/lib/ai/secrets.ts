const KEY_PATTERN = /\b(?:sk-proj-|sk-|gsk_|xai-)[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /(Bearer\s+)[^\s,;]+/gi;

export function redactSecrets(text: string, secrets: Array<string | undefined | null> = []): string {
  let next = String(text ?? "");
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 4) continue;
    next = next.split(value).join("[redacted]");
  }
  return next
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(KEY_PATTERN, "[redacted]");
}

export function containsSecret(text: string, secrets: Array<string | undefined | null> = []): boolean {
  const value = String(text ?? "");
  if (/(?:sk-proj-|sk-|gsk_|xai-)[A-Za-z0-9_-]{8,}/.test(value)) return true;
  if (/Bearer\s+(?!\[redacted\])[^\s,;]+/i.test(value)) return true;
  return secrets.some((secret) => {
    const token = secret?.trim();
    return Boolean(token && token.length >= 4 && value.includes(token));
  });
}
