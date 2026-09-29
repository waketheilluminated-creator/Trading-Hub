import liqHeatmapFixture from "../../../fixtures/liq_heatmap_bands.sample.json";
import { buildLiqHeatmapPayload, parseLiqHeatmapQuery } from "@/lib/liq-heatmap.ts";

export async function GET(request: Request) {
  const parsed = parseLiqHeatmapQuery(new URL(request.url));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const result = buildLiqHeatmapPayload(parsed.symbol, liqHeatmapFixture);
  if (!result.ok) {
    return Response.json({ error: "Liquidation heatmap sample is unavailable." }, { status: 500 });
  }
  return Response.json(result.body, { headers: { "Cache-Control": "public, max-age=60" } });
}
