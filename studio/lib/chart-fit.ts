/**
 * TH-BUG-07: the toolbar "Fit" action. A vertical pan or a price-axis drag switches lightweight-charts' price
 * scale to manual (autoScale: false); `timeScale().fitContent()` alone then leaves the price range frozen, so
 * candles stay off-screen — most visible on sub-cent coins where one drag moves the range by orders of magnitude.
 * Fit must therefore re-enable autoscale on every pane's price scales as well as fit the time range. Autoscale is
 * relative to the data, so this works for any price magnitude (no absolute epsilon).
 *
 * Only the explicit Fit button calls this; overlay toggles must never rescale the chart (TH-BUG-03).
 */
export type FitPriceScale = { applyOptions(options: { autoScale: boolean }): void };
export type FitPane = { priceScale(id: string): FitPriceScale };
export type FitChart = { panes(): readonly FitPane[]; timeScale(): { fitContent(): void } };

export const FIT_PRICE_SCALE_IDS = ["right", "left"] as const;

export function fitChartView(chart: FitChart | null | undefined): void {
  if (!chart) return;
  for (const pane of chart.panes()) {
    for (const id of FIT_PRICE_SCALE_IDS) {
      try { pane.priceScale(id).applyOptions({ autoScale: true }); } catch { /* scale not present on this pane */ }
    }
  }
  chart.timeScale().fitContent();
}
