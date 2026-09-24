import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { planTradeMarkers, type LargeTrade, type PlannedTradeMarker } from "./market-trades.ts";
import type { ChartInterval } from "./market-venues.ts";

type TimeToCoordinate = (time: Time) => number | null;
type PriceToCoordinate = (price: number) => number | null;

class LargeTradeMarkerRenderer implements IPrimitivePaneRenderer {
  private readonly getMarkers: () => readonly PlannedTradeMarker[];
  private readonly getTimeToCoordinate: () => TimeToCoordinate | null;
  private readonly getPriceToCoordinate: () => PriceToCoordinate | null;

  constructor(
    getMarkers: () => readonly PlannedTradeMarker[],
    getTimeToCoordinate: () => TimeToCoordinate | null,
    getPriceToCoordinate: () => PriceToCoordinate | null,
  ) {
    this.getMarkers = getMarkers;
    this.getTimeToCoordinate = getTimeToCoordinate;
    this.getPriceToCoordinate = getPriceToCoordinate;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const timeToCoordinate = this.getTimeToCoordinate();
    const priceToCoordinate = this.getPriceToCoordinate();
    if (!timeToCoordinate || !priceToCoordinate) return;
    target.useMediaCoordinateSpace(({ context }) => {
      for (const marker of this.getMarkers()) {
        const x = timeToCoordinate(marker.time as UTCTimestamp);
        const y = priceToCoordinate(marker.price);
        if (x == null || y == null) continue;
        const radius = Math.max(marker.radius, 6);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = marker.color;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = "#f4f7fb";
        context.stroke();
      }
    });
  }
}

class LargeTradeMarkerPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: LargeTradeMarkerRenderer;

  constructor(paneRenderer: LargeTradeMarkerRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class LargeTradeMarkersPrimitive implements ISeriesPrimitive<Time> {
  private markers: readonly PlannedTradeMarker[] = [];
  private timeToCoordinate: TimeToCoordinate | null = null;
  private priceToCoordinate: PriceToCoordinate | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer = new LargeTradeMarkerRenderer(
    () => this.markers,
    () => this.timeToCoordinate,
    () => this.priceToCoordinate,
  );
  private readonly views: readonly IPrimitivePaneView[] = [new LargeTradeMarkerPaneView(this.paneRenderer)];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, "Candlestick">): void {
    const scale = chart.timeScale();
    this.timeToCoordinate = (time) => {
      const exact = scale.timeToCoordinate(time);
      if (exact != null) return exact;
      const index = scale.timeToIndex(time, true);
      return index == null ? null : scale.logicalToCoordinate(index as unknown as Logical);
    };
    this.priceToCoordinate = (price) => series.priceToCoordinate(price);
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.timeToCoordinate = null;
    this.priceToCoordinate = null;
    this.requestUpdate = null;
  }

  setTrades(trades: readonly LargeTrade[], interval: ChartInterval): void {
    this.markers = planTradeMarkers(trades, interval);
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    // Coordinates are resolved during draw from the live scales.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
