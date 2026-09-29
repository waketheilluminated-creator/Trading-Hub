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
  liqBandDrawHeight,
  placeLiqHeatmapBands,
  type LiqBand,
  type PlacedLiqBand,
} from "./liq-heatmap.ts";

type PriceToCoordinate = (price: number) => number | null;

class LiqHeatmapRenderer implements IPrimitivePaneRenderer {
  private readonly getBands: () => readonly LiqBand[];
  private readonly getPriceToCoordinate: () => PriceToCoordinate | null;

  constructor(getBands: () => readonly LiqBand[], getPriceToCoordinate: () => PriceToCoordinate | null) {
    this.getBands = getBands;
    this.getPriceToCoordinate = getPriceToCoordinate;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const priceToCoordinate = this.getPriceToCoordinate();
    if (!priceToCoordinate) return;
    const placed = placeLiqHeatmapBands(this.getBands(), priceToCoordinate);
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const band of placed) drawLiqBand(context, band, mediaSize.width);
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
  private priceToCoordinate: PriceToCoordinate | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer = new LiqHeatmapRenderer(() => this.bands, () => this.priceToCoordinate);
  private readonly views: readonly IPrimitivePaneView[] = [new LiqHeatmapPaneView(this.paneRenderer)];

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time, "Candlestick">): void {
    this.priceToCoordinate = (price) => series.priceToCoordinate(price);
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.priceToCoordinate = null;
    this.requestUpdate = null;
  }

  setBands(bands: readonly LiqBand[]): void {
    this.bands = bands;
    this.requestUpdate?.();
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
