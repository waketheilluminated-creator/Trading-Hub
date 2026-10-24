import type { Metadata, Viewport } from "next";
import "./mobile.css";
import { MobileChart } from "./mobile-chart";

export const metadata: Metadata = {
  title: "Trading Hub — Chart",
  description: "Mobile perpetual chart with drawings, liquidation zones, and touch alerts.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Trading Hub",
    statusBarStyle: "black-translucent",
  },
  icons: { icon: "/favicon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#131722",
};

/** Page 1 of the mobile chart. Indicator source editing is not part of this screen. */
export default function MobilePage() {
  return <MobileChart />;
}
