export const AI_PROVIDER_IDS = ["openai", "deepseek", "groq", "together", "custom"] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type AiProviderPreset = {
  id: AiProviderId;
  label: string;
  endpoint: string;
  defaultModel: string;
  modelHelp: string;
  keyHelp: string;
};

export const AI_PROVIDERS: readonly AiProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4.1-mini",
    modelHelp: "Use a chat model ID such as gpt-4.1-mini or gpt-4o.",
    keyHelp: "Paste a secret key from the OpenAI dashboard. It is sent only through Trading Hub’s proxy.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    defaultModel: "deepseek-chat",
    modelHelp: "Typical IDs: deepseek-chat or deepseek-reasoner.",
    keyHelp: "Paste a DeepSeek API key. It stays in this tab unless you opt into sessionStorage.",
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    modelHelp: "Use a Groq model ID from their OpenAI-compatible catalog.",
    keyHelp: "Paste a Groq API key. Trading Hub does not keep it on the server.",
  },
  {
    id: "together",
    label: "Together",
    endpoint: "https://api.together.xyz/v1/chat/completions",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    modelHelp: "Use the full Together model path, for example meta-llama/…",
    keyHelp: "Paste a Together API key. It is used only for this browser session’s proxy calls.",
  },
  {
    id: "custom",
    label: "Custom",
    endpoint: "",
    defaultModel: "",
    modelHelp: "Any OpenAI-compatible chat completions model ID.",
    keyHelp: "Optional Bearer key for your HTTPS gateway. Session only unless you remember it in this tab.",
  },
];

export function isAiProviderId(value: string): value is AiProviderId {
  return AI_PROVIDER_IDS.includes(value as AiProviderId);
}

export function aiProvider(id: string | undefined): AiProviderPreset {
  return AI_PROVIDERS.find((provider) => provider.id === id) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

export function providerFromEndpoint(endpoint: string): AiProviderId {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host === "api.openai.com" || host.endsWith(".openai.com")) return "openai";
    if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) return "deepseek";
    if (host === "api.groq.com" || host.endsWith(".groq.com")) return "groq";
    if (host.endsWith("together.xyz") || host.endsWith("together.ai")) return "together";
  } catch {
    // Fall through to custom when the field is still a draft URL.
  }
  return "custom";
}

export function applyProviderPreset(
  nextId: AiProviderId,
  current: { providerId: AiProviderId; endpoint: string; model: string },
): { providerId: AiProviderId; endpoint: string; model: string } {
  const next = aiProvider(nextId);
  const previous = aiProvider(current.providerId);
  const keepModel = current.model.trim() !== "" && current.model.trim() !== previous.defaultModel;
  return {
    providerId: nextId,
    endpoint: next.endpoint || current.endpoint,
    model: keepModel ? current.model : next.defaultModel,
  };
}
