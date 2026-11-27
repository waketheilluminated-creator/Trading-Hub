import type { ScreenPoint } from "./geometry.ts";

export const DRAG_COMMIT_PX = 4;
export const MAGNET_X_PX = 16;
export const MAGNET_Y_PX = 8;

export type MagnetCandle = { time: number; open: number; high: number; low: number; close: number };
export type MagnetProjector = {
  timeToX(time: number): number | null;
  priceToY(price: number): number | null;
};

/** TradingView Shift: lock the free end to the nearest 45° step, keeping the segment length. */
export function constrainToOctant(start: ScreenPoint, end: ScreenPoint): ScreenPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: end.x, y: end.y };
  const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: start.x + Math.cos(snapped) * length,
    y: start.y + Math.sin(snapped) * length,
  };
}

export function pointerPastThreshold(start: ScreenPoint, end: ScreenPoint, threshold = DRAG_COMMIT_PX): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= threshold;
}

/**
 * Weak magnet: the bar under the cursor (within a few px on X) and the OHLC
 * price on that bar within a few px on Y. Anything farther stays free.
 */
export function snapToOhlc(
  pointer: ScreenPoint,
  candles: readonly MagnetCandle[],
  project: MagnetProjector,
  radiusX = MAGNET_X_PX,
  radiusY = MAGNET_Y_PX,
): { time: number; price: number } | null {
  let nearestBar: { time: number; distance: number } | null = null;
  for (const candle of candles) {
    const x = project.timeToX(candle.time);
    if (x == null || !Number.isFinite(x)) continue;
    const distance = Math.abs(x - pointer.x);
    if (!nearestBar || distance < nearestBar.distance) nearestBar = { time: candle.time, distance };
  }
  if (!nearestBar || nearestBar.distance > radiusX) return null;
  const candle = candles.find((item) => item.time === nearestBar.time);
  if (!candle) return null;
  let nearestPrice: { price: number; distance: number } | null = null;
  for (const price of [candle.open, candle.high, candle.low, candle.close]) {
    if (!Number.isFinite(price)) continue;
    const y = project.priceToY(price);
    if (y == null || !Number.isFinite(y)) continue;
    const distance = Math.abs(y - pointer.y);
    if (!nearestPrice || distance < nearestPrice.distance) nearestPrice = { price, distance };
  }
  if (!nearestPrice || nearestPrice.distance > radiusY) return null;
  return { time: candle.time, price: nearestPrice.price };
}
