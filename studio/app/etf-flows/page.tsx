import type { Metadata } from "next";
import etfFlowsFixture from "../../fixtures/etf_flows.sample.json";
import { sanitizeEtfFlowsSnapshot } from "@/lib/etf-flows.ts";
import { EtfFlowsView } from "./etf-flows-view";

export const metadata: Metadata = {
  title: "BTC ETF Flows — Trading Hub",
  description: "US spot Bitcoin ETF flow summary cards and daily ticker flows from the Trading Hub sample fixture.",
};

export default function EtfFlowsPage() {
  const parsed = sanitizeEtfFlowsSnapshot(etfFlowsFixture);
  return <EtfFlowsView snapshot={parsed.ok ? parsed.snapshot : null} problem={parsed.ok ? null : parsed.error} />;
}
