/**
 * TH-FEAT-16 liquidation-zone alerts (pure logic, no I/O).
 * One group per symbol + venue. Each zone keeps its own state:
 *   - phase: where price was last seen relative to [lo, hi] (null = not observed yet)
 *   - armed: may fire on the next entry. A zone is NOT armed when price is already inside at creation/refresh;
 *     after a fire it re-arms only once price leaves the zone by more than the buffer.
 * Fires on entering (outside → inside, or a jump straight through the zone between two polls), at most once
 * per entry and at most once per minute per zone.
 */
import { headerSafe } from "./core.ts";
import type { MarketVenue } from "../market-venues.ts";

export const ZONE_REARM_BUFFER = 0.001; // 0.1% beyond the zone edge
export const ZONE_MIN_FIRE_INTERVAL_MS = 60_000;
export const MAX_ZONE_GROUPS = 20;
export const MAX_ZONES_PER_GROUP = 40;

export type ZoneRole = "support" | "resistance";
export type ZonePhase = "below" | "inside" | "above";
export type ZoneSpec = { role: ZoneRole; lo: number; hi: number; liqM: number; test?: boolean };
export type ZoneState = ZoneSpec & { key: string; phase: ZonePhase | null; armed: boolean; lastFiredAt: number | null; firedCount: number };
export type ZoneGroup = {
  id: string; symbol: string; venue: MarketVenue; createdAt: number; asOf: string | null; syncedAt: number;
  zones: ZoneState[]; firedCount: number; lastFiredAt: number | null;
};
export type ZoneFire = { zone: ZoneState; direction: "from_below" | "from_above"; price: number };

export function zoneKey(z: Pick<ZoneSpec, "role" | "lo" | "hi">): string {
  return `${z.role}:${z.lo}:${z.hi}`;
}

export function zonePhase(price: number, lo: number, hi: number): ZonePhase {
  return price < lo ? "below" : price > hi ? "above" : "inside";
}

/** Clean, bounded zone list from an estimator snapshot (or the test fixture). Invalid rows are dropped. */
export function normalizeZoneSpecs(raw: unknown, test = false): ZoneSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ZoneSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const z = item as Record<string, unknown>;
    const lo = Number(z.lo), hi = Number(z.hi), liqM = Number(z.liq_m ?? z.liqM ?? 0);
    if (z.role !== "support" && z.role !== "resistance") continue;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) continue;
    out.push({ role: z.role, lo, hi, liqM: Number.isFinite(liqM) && liqM >= 0 ? liqM : 0, ...(test || z.test === true ? { test: true } : {}) });
    if (out.length >= MAX_ZONES_PER_GROUP) break;
  }
  return out;
}

/**
 * Zone refresh (刷新清算 / new asOf): zones with the same role+lo+hi keep their state; new zones start
 * unobserved (phase null, not armed) so a zone that appears around the current price never fires instantly.
 */
export function syncZoneStates(prev: readonly ZoneState[], specs: readonly ZoneSpec[]): ZoneState[] {
  const byKey = new Map(prev.map((z) => [z.key, z]));
  return specs.map((spec) => {
    const key = zoneKey(spec);
    const old = byKey.get(key);
    return old ? { ...old, liqM: spec.liqM, test: spec.test } : { ...spec, key, phase: null, armed: false, lastFiredAt: null, firedCount: 0 };
  });
}

/** Advance one zone with a new price sample. */
export function evaluateZone(zone: ZoneState, price: number, now: number, buffer = ZONE_REARM_BUFFER): { next: ZoneState; fire: ZoneFire | null } {
  if (!Number.isFinite(price) || price <= 0) return { next: zone, fire: null };
  const phase = zonePhase(price, zone.lo, zone.hi);
  const clearOutside = price < zone.lo * (1 - buffer) || price > zone.hi * (1 + buffer);
  if (zone.phase == null) {
    // First observation: already inside → wait for an exit (+buffer) before arming.
    return { next: { ...zone, phase, armed: phase !== "inside" && clearOutside }, fire: null };
  }
  const prev = zone.phase;
  const entered = phase === "inside" && prev !== "inside";
  const traversed = (prev === "below" && phase === "above") || (prev === "above" && phase === "below");
  if (zone.armed && (entered || traversed)) {
    const direction: ZoneFire["direction"] = prev === "below" ? "from_below" : "from_above";
    const rateOk = zone.lastFiredAt == null || now - zone.lastFiredAt >= ZONE_MIN_FIRE_INTERVAL_MS;
    // The entry is consumed either way: rate-limited entries do not fire later while price sits in the zone.
    const next: ZoneState = { ...zone, phase, armed: false };
    if (!rateOk) return { next, fire: null };
    return { next: { ...next, lastFiredAt: now, firedCount: zone.firedCount + 1 }, fire: { zone, direction, price } };
  }
  return { next: { ...zone, phase, armed: zone.armed || clearOutside }, fire: null };
}

export function formatZonePrice(value: number, decimals: number | null): string {
  if (decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 10) return value.toFixed(decimals);
  return String(Math.round(value * 1e8) / 1e8);
}

export function zoneRoleLabel(role: ZoneRole): string {
  return role === "support" ? "支撑区 support" : "阻力区 resistance";
}

/** Fire message: symbol, support/resistance, zone lo–hi, liq_m, price. Test zones are labeled. */
export function zoneFireMessage(symbol: string, venue: MarketVenue, fire: ZoneFire, decimals: number | null = null): { title: string; message: string; subject: string } {
  const { zone, price } = fire;
  const tag = zone.test ? "[TEST ZONE] " : "";
  const from = fire.direction === "from_below" ? "从下方 from below" : "从上方 from above";
  const range = `${formatZonePrice(zone.lo, decimals)}–${formatZonePrice(zone.hi, decimals)}`;
  const liq = `$${zone.liqM.toFixed(zone.liqM >= 100 ? 0 : 1)}M`;
  const title = `${tag}清算区提醒 ${symbol}`;
  const message = `${tag}${symbol} 价格触及${zoneRoleLabel(zone.role)} ${range}（${from}）· 估算清算 ${liq} · 价格 ${formatZonePrice(price, decimals)} · ${venue.toUpperCase()}`;
  return { title, message, subject: headerSafe(`[Trading Hub] ${tag}${symbol} ${zone.role === "support" ? "支撑" : "阻力"} ${range}`) };
}

/** Strict body for POST /api/alerts/zones. */
export function validateZoneAction(body: unknown, isVenue: (v: unknown) => v is MarketVenue): { ok: true; value: { action: "enable" | "disable"; symbol: string; venue: MarketVenue } } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object." };
  const { action, symbol, venue, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length) return { ok: false, error: "Unknown field." };
  if (action !== "enable" && action !== "disable") return { ok: false, error: "action must be enable or disable." };
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return { ok: false, error: "Invalid symbol." };
  if (!isVenue(venue)) return { ok: false, error: "Invalid venue." };
  return { ok: true, value: { action, symbol, venue } };
}
