import type { Metadata } from "next";
import cexNetflowFixture from "../../fixtures/cex_netflow.sample.json";
import { sanitizeCexNetflowSnapshot } from "@/lib/cex-netflow.ts";
import { CexNetflowView } from "./cex-netflow-view";

export const metadata: Metadata = {
  title: "Exchange Net Flow Pulse — Trading Hub",
  description: "Bitcoin exchange reserve proxy versus its 90-day average, with BTC price, from the Trading Hub sample fixture.",
};

export default function CexNetflowPage() {
  const parsed = sanitizeCexNetflowSnapshot(cexNetflowFixture);
  return <CexNetflowView snapshot={parsed.ok ? parsed.snapshot : null} problem={parsed.ok ? null : parsed.error} />;
}
