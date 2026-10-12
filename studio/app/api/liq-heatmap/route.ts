/// <reference types="vite/client" />
import liqHeatmapFixture from "../../../fixtures/liq_heatmap_bands.sample.json";
import { LIQ_HEATMAP_NO_SNAPSHOT, buildLiqHeatmapPayload, parseLiqHeatmapQuery, selectLiqSnapshotSource } from "@/lib/liq-heatmap.ts";

// Live per-symbol snapshots (e.g. fixtures/liq_heatmap_bands.ZECUSDT.json, liq_heatmap_bands.PYTHUSDT.json)
// are bundled at build time when present; until they are delivered only the ZEC sample is served.
const liveFixtures = import.meta.glob("../../../fixtures/liq_heatmap_bands.*.json", { eager: true, import: "default" }) as Record<string, unknown>;

export async function GET(request: Request) {
  const parsed = parseLiqHeatmapQuery(new URL(request.url));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const selected = selectLiqSnapshotSource(parsed.symbol, liveFixtures, liqHeatmapFixture);
  if (!selected) {
    return Response.json({ error: LIQ_HEATMAP_NO_SNAPSHOT }, { status: 404 });
  }
  const result = buildLiqHeatmapPayload(parsed.symbol, selected.raw);
  if (!result.ok) {
    return Response.json({ error: "Liquidation heatmap sample is unavailable." }, { status: 500 });
  }
  return Response.json(result.body, { headers: { "Cache-Control": "public, max-age=60" } });
}
