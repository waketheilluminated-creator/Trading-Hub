"use client";

import Link from "next/link";

export type DeskSection = "ETF Flows" | "CVD / OI" | "Net Flow";

const PAGES: { href: string; label: string; section: DeskSection; ariaLabel?: string }[] = [
  { href: "/etf-flows", label: "ETF Flows", section: "ETF Flows" },
  { href: "/cvd-oi", label: "CVD / OI", section: "CVD / OI" },
  { href: "/cex-netflow", label: "Net Flow", section: "Net Flow", ariaLabel: "Exchange Net Flow Pulse (proxy)" },
];

export function DeskHeader({ section }: { section: DeskSection }) {
  return (
    <header className="desk-header">
      <div className="brand"><span className="brand-mark">TH</span><span>Trading Hub</span><small>{section}</small></div>
      <nav className="desk-nav" aria-label="Studio pages">
        {PAGES.map((page) => (
          <Link key={page.href} className="desk-link" href={page.href} aria-current={section === page.section ? "page" : undefined} aria-label={page.ariaLabel}>{page.label}</Link>
        ))}
        <Link className="desk-link desk-link-accent" href="/">Back to workspace</Link>
      </nav>
    </header>
  );
}
