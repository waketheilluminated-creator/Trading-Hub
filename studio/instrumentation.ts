/**
 * Server boot hook (vinext/Next `register()`; skipped during prerender).
 * TH-BUG-06: start the liquidation auto-refresh so the live heatmap advances without a click or an open tab.
 */
export async function register(): Promise<void> {
  if (typeof process === "undefined" || !process.versions?.node) return;
  const { startLiqAutoRefresh } = await import("./lib/liq-refresh-server.ts");
  await startLiqAutoRefresh();
}
