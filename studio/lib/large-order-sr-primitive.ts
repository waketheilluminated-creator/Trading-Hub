import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { OrderWall } from "./market-depth.ts";
import { WALL_ZONE_MERGE_BPS, WALL_ZONE_REDRAW_MS, findWallZoneAt, mergeWallZones, placeWallZones, type PlacedWallZone, type WallZone } from "./wall-zones.ts";

type PriceToCoordinate = (price: number) => number | null;

/** TH-FEAT-13: unfilled large-order walls as zone boxes from the latest candle rightward only (nothing drawn left of the latest bar). */
class WallZoneRenderer implements IPrimitivePaneRenderer {
  private readonly owner: LargeOrderSrPrimitive;

  constructor(owner: LargeOrderSrPrimitive) {
    this.owner = owner;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const priceToCoordinate = this.owner.priceScale();
    if (!priceToCoordinate) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const box of placeWallZones(this.owner.zones(), priceToCoordinate, this.owner.latestX(), mediaSize.width)) drawWallZone(context, box);
    });
  }
}

class WallZonePaneView implements IPrimitivePaneView {
  private readonly paneRenderer: WallZoneRenderer;

  constructor(paneRenderer: WallZoneRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class LargeOrderSrPrimitive implements ISeriesPrimitive<Time> {
  private merged: readonly WallZone[] = [];
  private latestTime: Time | null = null;
  private mergeBps = WALL_ZONE_MERGE_BPS;
  private priceToCoordinate: PriceToCoordinate | null = null;
  private coordinateToPrice: ((y: number) => number | null) | null = null;
  private timeToCoordinate: ((time: Time) => number | null) | null = null;
  private requestUpdate: (() => void) | null = null;
  private lastRedraw = 0;
  private pendingRedraw: ReturnType<typeof setTimeout> | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [new WallZonePaneView(new WallZoneRenderer(this))];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, "Candlestick">): void {
    this.priceToCoordinate = (price) => series.priceToCoordinate(price);
    this.coordinateToPrice = (y) => series.coordinateToPrice(y);
    this.timeToCoordinate = (time) => chart.timeScale().timeToCoordinate(time);
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    if (this.pendingRedraw) clearTimeout(this.pendingRedraw);
    this.pendingRedraw = null;
    this.priceToCoordinate = null;
    this.coordinateToPrice = null;
    this.timeToCoordinate = null;
    this.requestUpdate = null;
  }

  /** Live book updates: merge, then redraw at most every WALL_ZONE_REDRAW_MS. The anchor follows the latest candle. */
  setWalls(walls: readonly OrderWall[], latestTime: Time | null = this.latestTime, mergeBps = this.mergeBps): void {
    this.mergeBps = mergeBps;
    this.merged = mergeWallZones(walls, mergeBps);
    this.latestTime = latestTime;
    this.scheduleRedraw();
  }

  zones(): readonly WallZone[] {
    return this.merged;
  }

  priceScale(): PriceToCoordinate | null {
    return this.priceToCoordinate;
  }

  latestX(): number | null {
    if (this.latestTime == null || !this.timeToCoordinate) return null;
    const x = this.timeToCoordinate(this.latestTime);
    return x == null || !Number.isFinite(x) ? null : x;
  }

  zoneAt(x: number, y: number): WallZone | null {
    const left = this.latestX();
    if (left == null || x < left || !this.coordinateToPrice || !this.priceToCoordinate) return null;
    const price = this.coordinateToPrice(y);
    if (price == null) return null;
    // Thin single-wall boxes: accept a couple of pixels of slack around the line.
    const nearby = this.coordinateToPrice(y + 2);
    const tolerance = nearby == null ? 0 : Math.abs(nearby - price);
    return findWallZoneAt(this.merged, price, tolerance);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const zone = this.zoneAt(x, y);
    if (!zone) return null;
    return { externalId: `wall-zone:${this.merged.indexOf(zone)}`, cursorStyle: "pointer", zOrder: "top", distance: 0 };
  }

  updateAllViews(): void {
    // Coordinates are resolved during draw from the live price/time scales.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private scheduleRedraw(): void {
    const now = Date.now();
    const wait = WALL_ZONE_REDRAW_MS - (now - this.lastRedraw);
    if (wait <= 0) {
      this.lastRedraw = now;
      this.requestUpdate?.();
      return;
    }
    if (this.pendingRedraw) return;
    this.pendingRedraw = setTimeout(() => {
      this.pendingRedraw = null;
      this.lastRedraw = Date.now();
      this.requestUpdate?.();
    }, wait);
  }
}

function drawWallZone(context: CanvasRenderingContext2D, box: PlacedWallZone): void {
  context.fillStyle = box.fill;
  context.fillRect(box.left, box.top, box.width, box.height);
  context.strokeStyle = box.edge;
  context.lineWidth = 1;
  context.strokeRect(Math.round(box.left) + 0.5, Math.round(box.top) + 0.5, Math.max(0, Math.round(box.width) - 1), Math.max(1, Math.round(box.height) - 1));
}
