import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { layoutSeparatedWalls, visualWallBands, wallEdgeStyle, wallFillStyle, type OrderWall, type PlacedWallBand, type VisualWall } from "./market-depth.ts";

type PriceToCoordinate = (price: number) => number | null;

class LargeOrderSrRenderer implements IPrimitivePaneRenderer {
  private readonly getWalls: () => readonly VisualWall[];
  private readonly getPriceToCoordinate: () => PriceToCoordinate | null;

  constructor(getWalls: () => readonly VisualWall[], getPriceToCoordinate: () => PriceToCoordinate | null) {
    this.getWalls = getWalls;
    this.getPriceToCoordinate = getPriceToCoordinate;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const priceToCoordinate = this.getPriceToCoordinate();
    if (!priceToCoordinate) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const placed = layoutSeparatedWalls(this.getWalls(), priceToCoordinate);
      for (const band of placed) drawWallBand(context, band, mediaSize.width);
      for (const band of placed) drawWallEdges(context, band, mediaSize.width);
    });
  }
}

class LargeOrderSrPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: LargeOrderSrRenderer;

  constructor(paneRenderer: LargeOrderSrRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class LargeOrderSrPrimitive implements ISeriesPrimitive<Time> {
  private walls: readonly VisualWall[] = [];
  private priceToCoordinate: PriceToCoordinate | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer = new LargeOrderSrRenderer(() => this.walls, () => this.priceToCoordinate);
  private readonly views: readonly IPrimitivePaneView[] = [new LargeOrderSrPaneView(this.paneRenderer)];

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time, "Candlestick">): void {
    this.priceToCoordinate = (price) => series.priceToCoordinate(price);
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.priceToCoordinate = null;
    this.requestUpdate = null;
  }

  setWalls(walls: readonly OrderWall[]): void {
    this.walls = visualWallBands(walls);
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    // Coordinates are resolved during draw from the live price scale.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}

function drawWallBand(context: CanvasRenderingContext2D, band: PlacedWallBand, paneWidth: number): void {
  const top = band.centerY - band.thicknessPx / 2;
  context.fillStyle = wallFillStyle(band.wall);
  context.fillRect(0, top, paneWidth, Math.max(1, band.thicknessPx));
}

function drawWallEdges(context: CanvasRenderingContext2D, band: PlacedWallBand, paneWidth: number): void {
  context.fillStyle = wallEdgeStyle(band.wall);
  context.fillRect(0, Math.round(band.centerY), paneWidth, 1);
  if (Math.abs(band.edgeY - band.centerY) >= 1) {
    context.fillRect(0, Math.round(band.edgeY), paneWidth, 1);
  }
}
