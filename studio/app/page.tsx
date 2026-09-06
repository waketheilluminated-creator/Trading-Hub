import type { Metadata } from "next";
import { TradingWorkspace } from "./trading-workspace";

export const metadata: Metadata = {
  title: "Trading Hub — Live crypto charting",
  description: "Live perpetual charts, Pine indicators, derivatives data, alerts, and experimental AI analysis.",
};

export default function Home() {
  return <TradingWorkspace />;
}
