/** Time-scale zoom only. Price autoscale and the visible logical range are left alone. */
export const MIN_BAR_SPACING = 0.1;
export const MAX_BAR_SPACING = 80;
export const ZOOM_FACTOR = 1.25;

export type BarSpacingChart = {
  timeScale(): {
    options(): { barSpacing: number };
    applyOptions(options: { barSpacing: number }): void;
  };
};

export function nextBarSpacing(current: number, direction: "in" | "out"): number {
  const next = current * (direction === "in" ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
  return Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, next));
}

export function applyBarSpacingZoom(chart: BarSpacingChart | null | undefined, direction: "in" | "out"): void {
  if (!chart) return;
  const timeScale = chart.timeScale();
  timeScale.applyOptions({ barSpacing: nextBarSpacing(timeScale.options().barSpacing, direction) });
}
