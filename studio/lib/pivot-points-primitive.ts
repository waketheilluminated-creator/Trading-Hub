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
import {
  PIVOT_LABEL_TEXT,
  layoutPivotLabel,
  type PivotLabelModel,
  type PivotLabelSide,
} from "./pivot-points-high-low.ts";

type TimeToCoordinate = (time: Time) => number | null;
type PriceToCoordinate = (price: number) => number | null;

// Labels are pixel decorations around the pivot price, so they stay off the price range.
class PivotPointsRenderer implements IPrimitivePaneRenderer {
  private readonly getLabels: () => readonly PivotLabelModel[];
  private readonly getTimeToCoordinate: () => TimeToCoordinate | null;
  private readonly getPriceToCoordinate: () => PriceToCoordinate | null;

  constructor(
    getLabels: () => readonly PivotLabelModel[],
    getTimeToCoordinate: () => TimeToCoordinate | null,
    getPriceToCoordinate: () => PriceToCoordinate | null,
  ) {
    this.getLabels = getLabels;
    this.getTimeToCoordinate = getTimeToCoordinate;
    this.getPriceToCoordinate = getPriceToCoordinate;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const timeToCoordinate = this.getTimeToCoordinate();
    const priceToCoordinate = this.getPriceToCoordinate();
    if (!timeToCoordinate || !priceToCoordinate) return;
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      for (const label of this.getLabels()) drawPivotLabel(context, label, timeToCoordinate, priceToCoordinate);
      context.restore();
    });
  }
}

class PivotPointsPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: PivotPointsRenderer;

  constructor(paneRenderer: PivotPointsRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class PivotPointsPrimitive implements ISeriesPrimitive<Time> {
  private labels: readonly PivotLabelModel[] = [];
  private timeToCoordinate: TimeToCoordinate | null = null;
  private priceToCoordinate: PriceToCoordinate | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer = new PivotPointsRenderer(
    () => this.labels,
    () => this.timeToCoordinate,
    () => this.priceToCoordinate,
  );
  private readonly views: readonly IPrimitivePaneView[] = [new PivotPointsPaneView(this.paneRenderer)];

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

  setLabels(labels: readonly PivotLabelModel[]): void {
    this.labels = labels;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    // Coordinates are resolved during draw from the live scales.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}

function drawPivotLabel(
  context: CanvasRenderingContext2D,
  label: PivotLabelModel,
  timeToCoordinate: TimeToCoordinate,
  priceToCoordinate: PriceToCoordinate,
): void {
  if (!Number.isFinite(label.time) || !Number.isFinite(label.price) || !label.text) return;
  const x = timeToCoordinate(label.time as UTCTimestamp);
  const y = priceToCoordinate(label.price);
  if (x == null || y == null) return;
  const box = layoutPivotLabel(label.side, x, y, context.measureText(label.text).width);
  roundedRect(context, box.left, box.top, box.width, box.height, 3);
  context.fillStyle = label.color;
  context.fill();
  tracePointer(context, label.side, x, box.top, box.height, box.tipY);
  context.fill();
  context.fillStyle = PIVOT_LABEL_TEXT;
  context.fillText(label.text, x, box.top + box.height / 2);
}

function tracePointer(
  context: CanvasRenderingContext2D,
  side: PivotLabelSide,
  anchorX: number,
  top: number,
  height: number,
  tipY: number,
): void {
  const half = 4;
  context.beginPath();
  switch (side) {
    case "above":
      context.moveTo(anchorX - half, top + height - 1);
      context.lineTo(anchorX + half, top + height - 1);
      context.lineTo(anchorX, tipY);
      break;
    case "below":
      context.moveTo(anchorX - half, top + 1);
      context.lineTo(anchorX + half, top + 1);
      context.lineTo(anchorX, tipY);
      break;
    default: {
      const unreachable: never = side;
      void unreachable;
      return;
    }
  }
  context.closePath();
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
