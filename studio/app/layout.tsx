import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./theme-light.css";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme.ts";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trading Hub",
  description: "A focused crypto charting, Pine indicator, and experimental AI analysis workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The bootstrap script may add the theme class before hydration, so the
    // <html> class attribute is allowed to differ from the server render.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Static, constant script (no user input): applies the saved theme before first paint. */}
        <script id="th-theme-bootstrap" dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
