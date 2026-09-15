import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { visualWallBands, type OrderWall, type VisualWall } from "./market-depth.ts";

type PriceToCoordinate = (price: number) => number | null;

const BID_RGB = "83, 201, 144";
const ASK_RGB = "231, 103, 112";

class LargeOrderSrRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly getWalls: () => readonly VisualWall[], private readonly priceToCoordinate: () => PriceToCoordinate | null) {}

  draw(target: CanvasRenderingTarget2D): void {
    const priceToCoordinate = this.priceToCoordinate();
    if (!priceToCoordinate) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const wall of this.getWalls()) {
        drawWall(context, wall, mediaSize.width, priceToCoordinate);
      }
    });
  }
}

class LargeOrderSrPaneView implements IPrimitivePaneView {
  constructor(private readonly paneRenderer: LargeOrderSrRenderer) {}

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

export function wallFillStyle(wall: VisualWall): string {
  return `rgba(${wall.side === "bid" ? BID_RGB : ASK_RGB}, ${wall.opacity.toFixed(3)})`;
}

function drawWall(
  context: CanvasRenderingContext2D,
  wall: VisualWall,
  paneWidth: number,
  priceToCoordinate: PriceToCoordinate,
): void {
  const yPrice = priceToCoordinate(wall.price);
  const yLow = priceToCoordinate(wall.low);
  const yHigh = priceToCoordinate(wall.high);
  if (yPrice == null && yLow == null && yHigh == null) return;
  const topRaw = Math.min(yLow ?? yPrice ?? 0, yHigh ?? yPrice ?? 0);
  const bottomRaw = Math.max(yLow ?? yPrice ?? 0, yHigh ?? yPrice ?? 0);
  const mid = yPrice ?? (topRaw + bottomRaw) / 2;
  let top = topRaw;
  let bottom = bottomRaw;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom - top < wall.thicknessPx) {
    top = mid - wall.thicknessPx / 2;
    bottom = mid + wall.thicknessPx / 2;
  }
  context.fillStyle = wallFillStyle(wall);
  context.fillRect(0, top, paneWidth, Math.max(1, bottom - top));
}
