import { aiProvider, isAiProviderId, type AiProviderId } from "./providers.ts";

export const BYOK_SESSION_KEY = "trading-hub:ai-byok:v1";

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type ByokSession = {
  providerId: AiProviderId;
  endpoint: string;
  model: string;
  rememberKey: boolean;
  apiKey: string;
};

export function defaultByokSession(): ByokSession {
  const openai = aiProvider("openai");
  return {
    providerId: openai.id,
    endpoint: openai.endpoint,
    model: openai.defaultModel,
    rememberKey: false,
    apiKey: "",
  };
}

export function parseByokSession(raw: string | null): ByokSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ByokSession>;
    if (!parsed || typeof parsed !== "object") return null;
    const providerId = isAiProviderId(String(parsed.providerId ?? "")) ? parsed.providerId : "custom";
    const rememberKey = parsed.rememberKey === true;
    const apiKey = rememberKey && typeof parsed.apiKey === "string" ? parsed.apiKey : "";
    return {
      providerId,
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      rememberKey,
      apiKey,
    };
  } catch {
    return null;
  }
}

export function serializeByokSession(session: ByokSession): string {
  return JSON.stringify({
    providerId: session.providerId,
    endpoint: session.endpoint,
    model: session.model,
    rememberKey: session.rememberKey,
    ...(session.rememberKey && session.apiKey ? { apiKey: session.apiKey } : {}),
  });
}

export function loadByokSession(storage: StorageLike | null | undefined): ByokSession {
  if (!storage) return defaultByokSession();
  try {
    return parseByokSession(storage.getItem(BYOK_SESSION_KEY)) ?? defaultByokSession();
  } catch {
    return defaultByokSession();
  }
}

export function saveByokSession(storage: StorageLike | null | undefined, session: ByokSession): boolean {
  if (!storage) return false;
  try {
    storage.setItem(BYOK_SESSION_KEY, serializeByokSession(session));
    return true;
  } catch {
    return false;
  }
}

export function browserSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
