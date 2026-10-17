/// <reference types="vite/client" />
/**
 * TH-FEAT-16 server-side zone source: the same sanitized zones the chart shows
 * (a validated 刷新清算 snapshot wins over the bundled fixture), plus an optional operator-only test fixture.
 * Imported only by lib/alerts/server.ts (Node runtime, Vite-bundled).
 */
import liqHeatmapFixture from "../../fixtures/liq_heatmap_bands.sample.json";
import { buildLiqHeatmapPayload, selectLiqSnapshotSource } from "../liq-heatmap.ts";
import { allowlistedSymbol } from "../liq-refresh.ts";
import { liqRefresher } from "../liq-refresh-server.ts";
import { normalizeZoneSpecs, type ZoneSpec } from "./zones.ts";
import type { ZoneSource } from "./engine.ts";

const liveFixtures = import.meta.glob("../../fixtures/liq_heatmap_bands.*.json", { eager: true, import: "default" }) as Record<string, unknown>;

/**
 * ALERTS_TEST_ZONES_FILE (env, set by the operator for a live test only — never request-controlled):
 * JSON { "symbol": "BTCUSDT", "zones": [{ "role": "support", "lo": 1, "hi": 2, "liq_m": 0 }] }.
 * Those zones are tagged [TEST ZONE] in every message.
 */
export function createZoneSource(env: Readonly<Record<string, string | undefined>>, readFile: (path: string) => Promise<string>): ZoneSource {
  return async (symbol) => {
    let asOf: string | null = null;
    let decimals: number | null = null;
    let zones: ZoneSpec[] = [];
    const refreshable = allowlistedSymbol(symbol);
    const refreshed = refreshable ? await liqRefresher().then((r) => r.restore(refreshable)).catch(() => null) : null;
    const built = refreshed
      ? buildLiqHeatmapPayload(symbol, null, refreshed)
      : (() => { const selected = selectLiqSnapshotSource(symbol, liveFixtures, liqHeatmapFixture); return selected ? buildLiqHeatmapPayload(symbol, selected.raw) : null; })();
    if (built?.ok) {
      asOf = built.body.asOf ?? null;
      decimals = built.body.priceDecimals ?? null;
      zones = normalizeZoneSpecs(built.body.zones);
    }
    const testFile = env.ALERTS_TEST_ZONES_FILE;
    if (testFile) {
      try {
        const raw = JSON.parse(await readFile(testFile)) as { symbol?: unknown; zones?: unknown };
        if (raw.symbol === symbol) zones = [...zones, ...normalizeZoneSpecs(raw.zones, true)];
      } catch { /* ignore a missing/broken test fixture */ }
    }
    if (!zones.length && !built?.ok) return null;
    return { asOf, zones, decimals };
  };
}
