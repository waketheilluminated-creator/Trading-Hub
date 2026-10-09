import type { ThemeName } from "./theme.ts";

export type ChartPalette = {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  crosshairLabel: string;
  paneSeparator: string;
  paneSeparatorHover: string;
  up: string;
  down: string;
  ema9: string;
  ema21: string;
  oi: string;
};

// Dark keeps the original studio colours; light follows TradingView's light chart.
const PALETTES: Record<ThemeName, ChartPalette> = {
  dark: {
    background: "#0b1017", text: "#748094", grid: "#17202b", border: "#27313f",
    crosshair: "#59677a", crosshairLabel: "#344154",
    paneSeparator: "#27313f", paneSeparatorHover: "rgba(118, 231, 164, 0.16)",
    up: "#53c990", down: "#e76770", ema9: "#62d6e8", ema21: "#f2c66d", oi: "#62d6e8",
  },
  light: {
    background: "#ffffff", text: "#434651", grid: "#eef1f5", border: "#d6dbe3",
    crosshair: "#9598a1", crosshairLabel: "#131722",
    paneSeparator: "#d6dbe3", paneSeparatorHover: "rgba(15, 143, 85, 0.18)",
    up: "#089981", down: "#f23645", ema9: "#0b84a0", ema21: "#c77c02", oi: "#0b84a0",
  },
};

export function chartPalette(theme: ThemeName): ChartPalette {
  return PALETTES[theme === "light" ? "light" : "dark"];
}

/** Options for chart.applyOptions(); merges into lightweight-charts' layout/grid/scales/crosshair. */
export function chartThemeOptions(theme: ThemeName) {
  const p = chartPalette(theme);
  return {
    layout: {
      background: { color: p.background },
      textColor: p.text,
      panes: { separatorColor: p.paneSeparator, separatorHoverColor: p.paneSeparatorHover },
    },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.border },
    timeScale: { borderColor: p.border },
    crosshair: {
      vertLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
      horzLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
    },
  };
}

export function candleThemeOptions(theme: ThemeName) {
  const p = chartPalette(theme);
  return { upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down };
}
