/**
 * TH-FEAT-13 — unfilled large orders (L2 walls) drawn as zone boxes, the same way as liquidation zones:
 * semi-transparent boxes on the main chart from the LATEST candle to the right edge (no history).
 * Same-side walls within a small price gap are merged into one box spanning lo–hi.
 */
import { formatNotionalUsd, formatWallPrice, type BookSide, type OrderWall } from "./market-depth.ts";

export type WallZone = { side: BookSide; lo: number; hi: number; notional: number; count: number };
export type PlacedWallZone = { zone: WallZone; left: number; top: number; width: number; height: number; fill: string; edge: string };

/** Default merge gap: walls closer than this (in bps of price) on the same side become one box. */
export const WALL_ZONE_MERGE_BPS = 10;
export const WALL_ZONE_MIN_HEIGHT_PX = 3;
export const WALL_ZONE_REDRAW_MS = 250;

const finite = (value: number) => Number.isFinite(value);

export function mergeWallZones(walls: readonly OrderWall[], mergeBps = WALL_ZONE_MERGE_BPS): WallZone[] {
  const bps = finite(mergeBps) && mergeBps >= 0 ? Math.min(mergeBps, 500) : WALL_ZONE_MERGE_BPS;
  const zones: WallZone[] = [];
  for (const side of ["bid", "ask"] as const) {
    const rows = walls
      .filter((wall) => wall.side === side && finite(wall.price) && wall.price > 0 && finite(wall.notional) && wall.notional > 0)
      .map((wall) => {
        const lo = finite(wall.low) && wall.low > 0 ? Math.min(wall.low, wall.price) : wall.price;
        const hi = finite(wall.high) && wall.high > 0 ? Math.max(wall.high, wall.price) : wall.price;
        return { lo, hi, notional: wall.notional };
      })
      .sort((a, b) => a.lo - b.lo);
    let current: WallZone | null = null;
    for (const row of rows) {
      const gap = ((current ? current.hi : row.lo) * bps) / 10_000;
      if (current && row.lo - current.hi <= gap) {
        current.hi = Math.max(current.hi, row.hi);
        current.notional += row.notional;
        current.count += 1;
      } else {
        current = { side, lo: row.lo, hi: row.hi, notional: row.notional, count: 1 };
        zones.push(current);
      }
    }
  }
  return zones.sort((a, b) => a.lo - b.lo);
}

export function wallZoneColors(side: BookSide): { fill: string; edge: string } {
  const rgb = side === "bid" ? "83, 201, 144" : "231, 103, 112";
  return { fill: `rgba(${rgb}, 0.2)`, edge: `rgba(${rgb}, 0.85)` };
}

/** Boxes start at the latest candle's x and run to the pane's right edge; single walls get a thin box. */
export function placeWallZones(
  zones: readonly WallZone[],
  priceToY: (price: number) => number | null,
  latestX: number | null,
  paneWidth: number,
): PlacedWallZone[] {
  if (latestX == null || !finite(latestX) || !(paneWidth > 0)) return [];
  const left = Math.max(0, Math.min(paneWidth, latestX));
  const width = paneWidth - left;
  if (!(width > 0)) return [];
  const placed: PlacedWallZone[] = [];
  for (const zone of zones) {
    const a = priceToY(zone.lo);
    const b = priceToY(zone.hi);
    if (a == null || b == null || !finite(a) || !finite(b)) continue;
    const mid = (a + b) / 2;
    const height = Math.max(WALL_ZONE_MIN_HEIGHT_PX, Math.abs(a - b));
    placed.push({ zone, left, top: mid - height / 2, width, height, ...wallZoneColors(zone.side) });
  }
  return placed;
}

export function findWallZoneAt(zones: readonly WallZone[], price: number, tolerance = 0): WallZone | null {
  if (!finite(price)) return null;
  let best: WallZone | null = null;
  for (const zone of zones) {
    if (price >= zone.lo - tolerance && price <= zone.hi + tolerance && (!best || zone.notional > best.notional)) best = zone;
  }
  return best;
}

export function formatWallZoneTooltip(zone: WallZone): string {
  const side = zone.side === "bid" ? "Bid wall 买墙" : "Ask wall 卖墙";
  const range = zone.lo === zone.hi ? formatWallPrice(zone.lo) : `${formatWallPrice(zone.lo)}–${formatWallPrice(zone.hi)}`;
  return `${side} · ${formatNotionalUsd(zone.notional)} · ${range} · ${zone.count} wall${zone.count === 1 ? "" : "s"}`;
}
