/// <reference types="vite/client" />
import liqHeatmapFixture from "../../../fixtures/liq_heatmap_bands.sample.json";
import { liqRefresher, startLiqAutoRefresh } from "@/lib/liq-refresh-server.ts";
import { autoRefreshWatchAllowed } from "@/lib/liq-auto-refresh.ts";
import { allowlistedSymbol } from "@/lib/liq-refresh.ts";
import { LIQ_HEATMAP_NO_SNAPSHOT, buildLiqHeatmapPayload, parseLiqHeatmapQuery, selectLiqSnapshotSource } from "@/lib/liq-heatmap.ts";

// Live per-symbol snapshots (e.g. fixtures/liq_heatmap_bands.ZECUSDT.json, liq_heatmap_bands.PYTHUSDT.json)
// are bundled at build time when present; until they are delivered only the ZEC sample is served.
const liveFixtures = import.meta.glob("../../../fixtures/liq_heatmap_bands.*.json", { eager: true, import: "default" }) as Record<string, unknown>;

export async function GET(request: Request) {
  const parsed = parseLiqHeatmapQuery(new URL(request.url));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  // TH-FEAT-11: a snapshot refreshed on demand (validated before swap-in) wins over the bundled fixture.
  const refreshable = allowlistedSymbol(parsed.symbol);
  if (refreshable) {
    // TH-BUG-06: keep the viewed symbol fresh in the background (same-origin localhost overlay loads only, not the
    // default-on probe; idempotent start).
    const watch = autoRefreshWatchAllowed(request) && new URL(request.url).searchParams.get("probe") !== "1";
    void startLiqAutoRefresh().then((auto) => { if (watch) auto?.watch(refreshable); }).catch(() => {});
    const refreshed = await liqRefresher().then((r) => r.restore(refreshable)).catch(() => null);
    if (refreshed) {
      const fresh = buildLiqHeatmapPayload(parsed.symbol, null, refreshed);
      if (fresh.ok) return Response.json(fresh.body, { headers: { "Cache-Control": "no-store" } });
    }
  }
  const selected = selectLiqSnapshotSource(parsed.symbol, liveFixtures, liqHeatmapFixture);
  if (!selected) {
    if (new URL(request.url).searchParams.get("probe") === "1") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: LIQ_HEATMAP_NO_SNAPSHOT }, { status: 404 });
  }
  const result = buildLiqHeatmapPayload(parsed.symbol, selected.raw);
  if (!result.ok) {
    return Response.json({ error: "Liquidation heatmap sample is unavailable." }, { status: 500 });
  }
  return Response.json(result.body, { headers: { "Cache-Control": "no-cache" } });
}
