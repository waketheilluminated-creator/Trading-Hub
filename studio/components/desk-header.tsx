"use client";

import Link from "next/link";

export function DeskHeader({ section }: { section: "ETF Flows" | "CVD / OI" }) {
  return (
    <header className="desk-header">
      <div className="brand"><span className="brand-mark">TH</span><span>Trading Hub</span><small>{section}</small></div>
      <nav className="desk-nav" aria-label="Studio pages">
        <Link className="desk-link" href="/etf-flows" aria-current={section === "ETF Flows" ? "page" : undefined}>ETF Flows</Link>
        <Link className="desk-link" href="/cvd-oi" aria-current={section === "CVD / OI" ? "page" : undefined}>CVD / OI</Link>
        <Link className="desk-link desk-link-accent" href="/">Back to workspace</Link>
      </nav>
    </header>
  );
}
