"use client";

import { useCallback, useEffect, useState } from "react";
import { DeskHeader } from "@/components/desk-header";
import { alertsApi, type SettingsResponse } from "@/lib/alerts/client.ts";

export function SettingsView() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await alertsApi.settings();
      setData(next);
      return next;
    } catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Settings unavailable." }); return null; }
  }, []);

  useEffect(() => {
    let live = true;
    alertsApi.settings().then((next) => { if (live) { setData(next); setEmail(next.settings.email ?? ""); } })
      .catch((e) => { if (live) setNotice({ kind: "error", text: e instanceof Error ? e.message : "Settings unavailable." }); });
    return () => { live = false; };
  }, []);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); setNotice({ kind: "ok", text: success }); }
    catch (e) { setNotice({ kind: "error", text: e instanceof Error ? e.message : "Request failed." }); await load(); }
    finally { setBusy(false); }
  };

  const s = data?.settings;
  const changed = (s?.email ?? "") !== email.trim();
  return (
    <main className="desk-shell" data-page="settings">
      <DeskHeader section="Settings" />
      <div className="desk-body settings-body">
        <div className="desk-title-row"><div><p className="desk-kicker">Alerts</p><h1>通知邮箱</h1></div></div>
        <section className="settings-card" data-settings-email>
          <h2>Notification email</h2>
          <p className="desk-meta">Alert emails go to one verified address. Changing it resets verification; alerts only email after 「发送测试邮件」 and entering the code.</p>
          <div className="settings-row">
            <input aria-label="通知邮箱" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="primary-button" disabled={busy || !email.trim() || !changed} onClick={() => void run(() => alertsApi.setEmail(email.trim()), "Saved. Send a test email to verify it.")}>保存</button>
          </div>
          <div className="settings-status">
            {s?.email ? (s.verified ? <span className="positive">✓ Verified: {s.email}</span> : <span className="amber">Not verified: {s.email}</span>) : <span className="muted">No address set.</span>}
          </div>
          <div className="settings-row">
            <button className="ghost-button settings-test" disabled={busy || !s?.email || changed} onClick={() => void run(() => alertsApi.sendTest(), "Test email sent. Enter the 6-digit code from it below.")}>发送测试邮件</button>
            {s?.codePending && (
              <>
                <input aria-label="Verification code" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <button className="primary-button" disabled={busy || code.length !== 6} onClick={() => void run(async () => { await alertsApi.verify(code); setCode(""); }, "Email verified. Alerts will be delivered here.")}>Verify</button>
              </>
            )}
            {s?.email && <button className="ghost-button" disabled={busy} onClick={() => void run(async () => { await alertsApi.clear(); setEmail(""); }, "Notification email removed.")}>Remove</button>}
          </div>
          {notice && <p className={notice.kind === "ok" ? "settings-notice positive" : "settings-notice negative"} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}
        </section>
        <section className="settings-card" data-settings-smtp>
          <h2>Sender (Gmail SMTP)</h2>
          {data ? (data.smtpConfigured
            ? <p className="positive">✓ Sender configured on this machine.</p>
            : <p className="amber">{data.smtpReason}</p>) : <p className="muted">Checking…</p>}
          <p className="desk-meta">Credentials are read only from a local file on the alert host and are never shown here or sent to the browser:</p>
          <code className="settings-path">{data?.envPath ?? "…"}</code>
          <p className="desk-meta">File contents: <code>GMAIL_USER=…</code> and <code>GMAIL_APP_PASSWORD=…</code> (a Google app password). Restart Trading Hub isn&apos;t needed; it is read when sending.</p>
        </section>
      </div>
    </main>
  );
}
