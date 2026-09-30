import type { Metadata } from "next";
import cvdOiFixture from "../../fixtures/cvd_oi.sample.json";
import { sanitizeCvdOiSnapshot } from "@/lib/cvd-oi.ts";
import { CvdOiView } from "./cvd-oi-view";

export const metadata: Metadata = {
  title: "CVD / OI — Trading Hub",
  description: "Binance BTCUSDT price, open interest, and rolling cumulative volume delta from the Trading Hub sample fixture.",
};

export default function CvdOiPage() {
  const parsed = sanitizeCvdOiSnapshot(cvdOiFixture);
  return <CvdOiView snapshot={parsed.ok ? parsed.snapshot : null} problem={parsed.ok ? null : parsed.error} />;
}
