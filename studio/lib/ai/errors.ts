import { redactSecrets } from "./secrets.ts";

export type ProviderError = {
  status: number;
  code: "unauthorized" | "forbidden" | "invalid_model" | "rate_limited" | "unreachable" | "provider" | "empty";
  error: string;
};

function looksLikeInvalidModel(message: string) {
  const lower = message.toLowerCase();
  return /model.+(not found|does not exist|invalid|unknown)/i.test(message)
    || lower.includes("invalid model")
    || lower.includes("unknown model")
    || lower.includes("model_not_found");
}

export function extractProviderMessage(payload: Record<string, unknown>, raw: string): string {
  const error = payload.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof payload.message === "string") return payload.message;
  return raw;
}

export function classifyProviderStatus(status: number, rawMessage: string, apiKey?: string): ProviderError {
  const message = redactSecrets(rawMessage, [apiKey]);
  const lower = message.toLowerCase();

  if (status === 401 || lower.includes("invalid api key") || lower.includes("incorrect api key") || lower.includes("unauthorized")) {
    return { status: 401, code: "unauthorized", error: "The provider rejected this API key (401). Check the key and try Test connection again." };
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { status: 429, code: "rate_limited", error: "The provider rate-limited this key (429). Wait a moment and retry." };
  }
  if (status === 404 || looksLikeInvalidModel(message)) {
    return { status: 404, code: "invalid_model", error: "That model ID was not found. Check the model field for this provider." };
  }
  if (status === 403) {
    return { status: 403, code: "forbidden", error: "The provider denied access (403). This key may not be allowed to use that model." };
  }
  const detail = message.slice(0, 180).trim();
  return {
    status: 502,
    code: "provider",
    error: detail ? `The provider request failed (${status}). ${detail}` : `The provider request failed (${status}).`,
  };
}

export function classifyNetworkError(error: unknown, apiKey?: string): ProviderError {
  const raw = error instanceof Error ? error.message : "Unable to reach the model endpoint.";
  const message = redactSecrets(raw, [apiKey]).toLowerCase();
  if (
    message.includes("abort")
    || message.includes("timeout")
    || message.includes("enotfound")
    || message.includes("econnrefused")
    || message.includes("fetch failed")
    || message.includes("certificate")
    || message.includes("network")
  ) {
    return { status: 502, code: "unreachable", error: "Unable to reach that host. Confirm the HTTPS endpoint is public and reachable." };
  }
  return { status: 502, code: "unreachable", error: "Unable to reach the model endpoint." };
}

export function emptyModelReply(): ProviderError {
  return { status: 502, code: "empty", error: "The model returned no readable analysis." };
}
