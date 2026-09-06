"use client";

import Link from "next/link";
import { useMemo } from "react";
import { savePineSource, usePineSource } from "../pine-source";

export function PineEditorTab() {
  const source = usePineSource();
  const lineCount = useMemo(() => source.split("\n").map((_, index) => index + 1).join("\n"), [source]);

  return (
    <main className="pine-popout-shell">
      <header className="pine-popout-header">
        <div className="brand"><span className="brand-mark">TH</span><span>Trading Hub</span><small>Pine Editor</small></div>
        <div className="pine-popout-actions"><span><i /> Synced live</span><Link href="/">Return to chart</Link></div>
      </header>
      <section className="pine-popout-toolbar">
        <div><strong>Custom indicator</strong><span>Pine Script v5 subset</span></div>
        <p>Changes sync automatically with every open Trading Hub tab.</p>
      </section>
      <section className="pine-popout-editor">
        <pre className="line-numbers" aria-hidden="true">{lineCount}</pre>
        <textarea aria-label="Pine Script editor in separate tab" className="code-editor" spellCheck={false} value={source} onChange={(event) => savePineSource(event.target.value)} />
      </section>
      <footer className="pine-popout-footer"><span>Pine v5 subset</span><span>{source.split("\n").length} lines · edits saved in this browser</span></footer>
    </main>
  );
}
