"use client";

import { useMemo, useState } from "react";
import {
  AI_PROVIDERS,
  aiProvider,
  applyProviderPreset,
  providerFromEndpoint,
  type AiProviderId,
} from "@/lib/ai/providers.ts";
import { buildContextPack, summarizeContextPack, type AnalystSnapshot } from "@/lib/ai/context-pack.ts";
import { browserSessionStorage, loadByokSession, saveByokSession, type ByokSession } from "@/lib/ai/session.ts";

type AIMessage = { id: number; role: "user" | "assistant"; content: string };
type ConnectionStatus = { kind: "idle" | "testing" | "ok" | "error"; message: string };

export function AiAnalystDrawer({
  open,
  onClose,
  snapshot,
}: {
  open: boolean;
  onClose: () => void;
  snapshot: AnalystSnapshot;
}) {
  const [session, setSession] = useState<ByokSession>(() => loadByokSession(browserSessionStorage()));
  const { providerId, endpoint, model, apiKey, rememberKey } = session;
  const [question, setQuestion] = useState("Analyze the current market structure and identify the most important risk signals.");
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle", message: "Not tested this session" });

  const provider = aiProvider(providerId);
  const pack = useMemo(() => buildContextPack(snapshot), [snapshot]);
  const summary = useMemo(() => summarizeContextPack(pack), [pack]);

  const updateSession = (patch: Partial<ByokSession>) => {
    setSession((current) => {
      const next = { ...current, ...patch };
      saveByokSession(browserSessionStorage(), next);
      return next;
    });
  };

  const chooseProvider = (nextId: AiProviderId) => {
    updateSession(applyProviderPreset(nextId, { providerId, endpoint, model }));
    setStatus({ kind: "idle", message: "Preset updated · test the connection" });
  };

  const changeEndpoint = (value: string) => {
    updateSession({ endpoint: value, providerId: providerFromEndpoint(value) });
  };

  const requestAnalyst = async (mode: "analyze" | "test") => {
    const nextQuestion = question.trim();
    if (!endpoint.trim() || !model.trim() || (mode === "analyze" && !nextQuestion)) {
      const message = mode === "test"
        ? "Add a compatible HTTPS endpoint and model ID before testing."
        : "Add a compatible endpoint and model ID, then enter a question.";
      setError(message);
      if (mode === "test") setStatus({ kind: "error", message });
      return;
    }

    if (mode === "analyze") {
      setRunning(true);
      setError("");
      setMessages((items) => [...items, { id: (items.at(-1)?.id ?? 0) + 1, role: "user", content: nextQuestion }]);
    } else {
      setStatus({ kind: "testing", message: "Checking endpoint, model, and key…" });
      setError("");
    }

    try {
      const response = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          endpoint,
          apiKey,
          model,
          question: mode === "analyze" ? nextQuestion : undefined,
          context: mode === "analyze" ? buildContextPack(snapshot, undefined, nextQuestion) : undefined,
        }),
      });
      const payload = await response.json() as { analysis?: string; error?: string; ok?: boolean };
      if (!response.ok) throw new Error(payload.error || (mode === "test" ? "Connection test failed" : "AI analysis failed"));
      if (mode === "test") {
        setStatus({ kind: "ok", message: `Connected · ${model}` });
        return;
      }
      setMessages((items) => [...items, { id: (items.at(-1)?.id ?? 0) + 1, role: "assistant", content: payload.analysis || "" }]);
      setQuestion("");
      setStatus((current) => current.kind === "ok" ? current : { kind: "ok", message: `Ready · ${model}` });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : (mode === "test" ? "Connection test failed" : "AI analysis failed");
      setError(message);
      if (mode === "test") setStatus({ kind: "error", message });
    } finally {
      if (mode === "analyze") setRunning(false);
    }
  };

  return (
    <>
      {open && <button className="ai-backdrop" aria-label="Close AI Analyst" onClick={onClose} />}
      <aside className={`ai-drawer ${open ? "open" : ""}`} aria-hidden={!open} aria-label="Trading Hub AI Analyst">
        <div className="ai-header">
          <div>
            <span className="ai-orb">✦</span>
            <strong>Trading Hub AI Analyst</strong>
            <small>BYOK · backend Context Pack</small>
          </div>
          <button aria-label="Close AI Analyst" onClick={onClose}>×</button>
        </div>
        <div className="ai-context-strip">
          <span>{snapshot.symbol}</span>
          <span>{snapshot.timeframe}</span>
          <span>{summary.candles} candles</span>
          <span>{summary.indicators} indicators</span>
          <span>{summary.hasDerivatives ? "OI / funding" : "Derivatives unavailable"}</span>
          <span>{summary.hasCvd ? "CVD" : "CVD unavailable"}</span>
          <span>Backend series</span>
        </div>
        <section className="ai-connection">
          <div className="ai-section-title"><span>Bring your own key</span><code>OpenAI-compatible</code></div>
          <label>Provider
            <select aria-label="AI provider preset" value={providerId} onChange={(event) => chooseProvider(event.target.value as AiProviderId)}>
              {AI_PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>Endpoint
            <input type="url" placeholder="https://api.openai.com/v1/chat/completions" value={endpoint} onChange={(event) => changeEndpoint(event.target.value)} />
          </label>
          <p className="ai-field-hint">Public HTTPS chat-completions URL. Base `/v1` paths are completed automatically.</p>
          <div className="ai-field-row">
            <label>Model ID
              <input placeholder={provider.defaultModel || "your-model-id"} value={model} onChange={(event) => updateSession({ model: event.target.value })} />
            </label>
            <label>
              <span className="ai-key-label">API key <em>Session only</em></span>
              <input type="password" autoComplete="off" placeholder="Bearer key · not stored on the server" value={apiKey} onChange={(event) => updateSession({ apiKey: event.target.value })} />
            </label>
          </div>
          <p className="ai-field-hint">{provider.modelHelp} {provider.keyHelp}</p>
          <label className="ai-persist">
            <input type="checkbox" checked={rememberKey} onChange={(event) => updateSession({ rememberKey: event.target.checked })} />
            <span>Remember the key in this tab’s sessionStorage. Closing the tab clears it. The key is never written to localStorage or server logs.</span>
          </label>
          <div className="ai-test-row">
            <span className={`ai-status ${status.kind}`} role="status">{status.message}</span>
            <button type="button" onClick={() => requestAnalyst("test")} disabled={status.kind === "testing" || running} aria-busy={status.kind === "testing"}>
              {status.kind === "testing" ? "Testing…" : "Test connection"}
            </button>
          </div>
        </section>
        <div className="ai-messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="ai-empty">
              <span>✦</span>
              <strong>Context Pack is attached on every ask</strong>
              <p>Each ask sends backend market series — OHLCV, EMA and Pine outputs, open interest, funding, and CVD when that series exists. Longer lookbacks will be packed from history APIs, never from screenshots.</p>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`ai-message ${message.role}`}>
              <small>{message.role === "assistant" ? "Trading Hub AI" : "You"}</small>
              <div>{message.content}</div>
            </article>
          ))}
          {running && <article className="ai-message assistant thinking"><small>Trading Hub AI</small><div><i /><i /><i /> Analyzing market context…</div></article>}
        </div>
        <div className="ai-composer">
          <div className="ai-quick-prompts">
            <button type="button" onClick={() => setQuestion("What is the current trend, momentum, and likely invalidation level?")}>Trend</button>
            <button type="button" onClick={() => setQuestion("Do funding and open interest confirm or contradict the price move?")}>OI + funding</button>
            <button type="button" onClick={() => setQuestion("Explain the current Pine indicator outputs and any conflicts between them.")}>Indicators</button>
          </div>
          <textarea aria-label="Ask AI about the current chart" placeholder="Ask about this chart…" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") requestAnalyst("analyze"); }} />
          {error && <div className="ai-error" role="alert">{error}</div>}
          <div className="ai-send-row">
            <span>⌘ Enter to send · research, not advice</span>
            <button type="button" onClick={() => requestAnalyst("analyze")} disabled={running}>{running ? "Analyzing…" : "Analyze current chart"}</button>
          </div>
        </div>
      </aside>
    </>
  );
}
