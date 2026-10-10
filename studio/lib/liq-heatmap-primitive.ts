import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import {
  findLiqZoneAt,
  formatLiqZoneLabel,
  liqBandDrawHeight,
  placeLiqHeatmapBands,
  placeLiqZones,
  type LiqBand,
  type LiqZone,
  type PlacedLiqBand,
  type PlacedLiqZone,
} from "./liq-heatmap.ts";

type PriceToCoordinate = (price: number) => number | null;
type LatestX = () => number | null;

class LiqHeatmapRenderer implements IPrimitivePaneRenderer {
  private readonly getBands: () => readonly LiqBand[];
  private readonly getPriceToCoordinate: () => PriceToCoordinate | null;

  private readonly getZones: () => readonly LiqZone[];
  private readonly getLatestX: LatestX;

  constructor(getBands: () => readonly LiqBand[], getPriceToCoordinate: () => PriceToCoordinate | null, getZones: () => readonly LiqZone[], getLatestX: LatestX) {
    this.getBands = getBands;
    this.getPriceToCoordinate = getPriceToCoordinate;
    this.getZones = getZones;
    this.getLatestX = getLatestX;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const priceToCoordinate = this.getPriceToCoordinate();
    if (!priceToCoordinate) return;
    const placed = placeLiqHeatmapBands(this.getBands(), priceToCoordinate);
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const band of placed) drawLiqBand(context, band, mediaSize.width);
      const zones = placeLiqZones(this.getZones(), priceToCoordinate, this.getLatestX(), mediaSize.width);
      for (const zone of zones) drawLiqZone(context, zone);
    });
  }
}

class LiqHeatmapPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: LiqHeatmapRenderer;

  constructor(paneRenderer: LiqHeatmapRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class LiqHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private bands: readonly LiqBand[] = [];
  private zones: readonly LiqZone[] = [];
  private latestTime: Time | null = null;
  private priceToCoordinate: PriceToCoordinate | null = null;
  private timeToCoordinate: ((time: Time) => number | null) | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer = new LiqHeatmapRenderer(() => this.bands, () => this.priceToCoordinate, () => this.zones, () => this.latestX());
  private readonly views: readonly IPrimitivePaneView[] = [new LiqHeatmapPaneView(this.paneRenderer)];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, "Candlestick">): void {
    this.priceToCoordinate = (price) => series.priceToCoordinate(price);
    this.timeToCoordinate = (time) => chart.timeScale().timeToCoordinate(time);
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.priceToCoordinate = null;
    this.timeToCoordinate = null;
    this.requestUpdate = null;
  }

  setBands(bands: readonly LiqBand[]): void {
    this.bands = bands;
    this.requestUpdate?.();
  }

  /** Zones draw from the latest candle (boxStart=latest_candle) to the right edge. */
  setZones(zones: readonly LiqZone[], latestTime: Time | null): void {
    this.zones = zones;
    this.latestTime = latestTime;
    this.requestUpdate?.();
  }

  latestX(): number | null {
    if (this.latestTime == null || !this.timeToCoordinate) return null;
    const x = this.timeToCoordinate(this.latestTime);
    return x == null || !Number.isFinite(x) ? null : x;
  }

  zoneAt(x: number, price: number | null): LiqZone | null {
    const left = this.latestX();
    if (left == null || price == null || x < left) return null;
    return findLiqZoneAt(this.zones, price);
  }

  updateAllViews(): void {
    // Zones are resolved during draw from the live price scale so lo/hi stay pinned.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const priceToCoordinate = this.priceToCoordinate;
    if (!priceToCoordinate || x < 0) return null;
    const left = this.latestX();
    if (left != null && x >= left) {
      const zone = this.zones.find((item) => {
        const a = priceToCoordinate(item.lo);
        const b = priceToCoordinate(item.hi);
        return a != null && b != null && y >= Math.min(a, b) && y <= Math.max(a, b);
      });
      if (zone) return { externalId: `liq-zone:${this.zones.indexOf(zone)}`, cursorStyle: "pointer", zOrder: "normal", distance: 0, hitTestPriority: 1 };
    }
    const band = bandAtY(y, priceToCoordinate, this.bands);
    if (!band) return null;
    return {
      externalId: `liq:${this.bands.indexOf(band)}`,
      cursorStyle: "pointer",
      zOrder: "normal",
      distance: 0,
      hitTestPriority: 0,
    };
  }
}

function bandAtY(y: number, priceToCoordinate: PriceToCoordinate, bands: readonly LiqBand[]): LiqBand | null {
  let best: LiqBand | null = null;
  for (const band of bands) {
    const yLo = priceToCoordinate(band.lo);
    const yHi = priceToCoordinate(band.hi);
    if (yLo == null || yHi == null || !Number.isFinite(yLo) || !Number.isFinite(yHi)) continue;
    const top = Math.min(yLo, yHi);
    const height = liqBandDrawHeight(Math.abs(yHi - yLo));
    if (y < top || y > top + height) continue;
    if (!best || band.liq_m > best.liq_m) best = band;
  }
  return best;
}

function drawLiqBand(context: CanvasRenderingContext2D, band: PlacedLiqBand, paneWidth: number): void {
  const height = liqBandDrawHeight(band.height);
  if (!(height > 0)) return;
  context.fillStyle = band.fill;
  context.fillRect(0, band.top, paneWidth, height);
  context.fillStyle = band.edge;
  context.fillRect(0, Math.round(band.top), paneWidth, 1);
  const bottom = band.top + band.height;
  if (Math.abs(bottom - band.top) >= 1) context.fillRect(0, Math.round(bottom), paneWidth, 1);
}

function drawLiqZone(context: CanvasRenderingContext2D, zone: PlacedLiqZone): void {
  context.fillStyle = zone.fill;
  context.fillRect(zone.left, zone.top, zone.width, zone.height);
  context.strokeStyle = zone.edge;
  context.lineWidth = 1;
  context.strokeRect(Math.round(zone.left) + 0.5, Math.round(zone.top) + 0.5, Math.max(0, Math.round(zone.width) - 1), Math.max(1, Math.round(zone.height) - 1));
  // Label: liq_m · risk_max · dist_pct, inside the box when tall enough, otherwise just above it.
  const label = formatLiqZoneLabel(zone.zone);
  context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textBaseline = "middle";
  const textWidth = context.measureText(label).width;
  if (zone.width < textWidth + 12) return;
  const y = zone.height >= 14 ? zone.top + zone.height / 2 : zone.top - 7;
  context.fillStyle = zone.text;
  context.fillText(label, zone.left + 6, y);
}
