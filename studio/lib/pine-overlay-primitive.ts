import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { PineBackgroundModel, PineBoxModel } from "./pine-chart-model.ts";

type Projector = {
  timeToX(time: number): number | null;
  priceToY(price: number): number | null;
  barSpacing(): number;
};

class PineOverlayRenderer implements IPrimitivePaneRenderer {
  private readonly getBackgrounds: () => readonly PineBackgroundModel[];
  private readonly getBoxes: () => readonly PineBoxModel[];
  private readonly getProjector: () => Projector | null;

  constructor(
    getBackgrounds: () => readonly PineBackgroundModel[],
    getBoxes: () => readonly PineBoxModel[],
    getProjector: () => Projector | null,
  ) {
    this.getBackgrounds = getBackgrounds;
    this.getBoxes = getBoxes;
    this.getProjector = getProjector;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const projector = this.getProjector();
    if (!projector) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const spacing = Math.max(1, projector.barSpacing());
      for (const bg of this.getBackgrounds()) {
        const x = projector.timeToX(bg.time);
        if (x == null) continue;
        context.fillStyle = bg.color;
        context.fillRect(x - spacing / 2, 0, spacing, mediaSize.height);
      }
      for (const box of this.getBoxes()) {
        const x1 = projector.timeToX(box.leftTime);
        const x2 = projector.timeToX(box.rightTime);
        const y1 = projector.priceToY(box.top);
        const y2 = projector.priceToY(box.bottom);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.max(1, Math.abs(x2 - x1));
        const height = Math.max(1, Math.abs(y2 - y1));
        if (box.fill) {
          context.fillStyle = box.fill;
          context.fillRect(left, top, width, height);
        }
        context.strokeStyle = box.borderColor;
        context.lineWidth = box.borderWidth;
        context.strokeRect(left, top, width, height);
      }
    });
  }
}

class PineOverlayPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: PineOverlayRenderer;
  constructor(paneRenderer: PineOverlayRenderer) { this.paneRenderer = paneRenderer; }
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return this.paneRenderer; }
}

/** Draws Pine bgcolor() bars and box.new() rectangles on the pane of the series it is attached to. */
export class PineOverlayPrimitive implements ISeriesPrimitive<Time> {
  private backgrounds: readonly PineBackgroundModel[] = [];
  private boxes: readonly PineBoxModel[] = [];
  private projector: Projector | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[] = [
    new PineOverlayPaneView(new PineOverlayRenderer(() => this.backgrounds, () => this.boxes, () => this.projector)),
  ];

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time, SeriesType>): void {
    this.projector = {
      timeToX: (time) => chart.timeScale().timeToCoordinate(time as Time),
      priceToY: (price) => series.priceToCoordinate(price),
      barSpacing: () => chart.timeScale().options().barSpacing,
    };
    this.requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached(): void {
    this.projector = null;
    this.requestUpdate = null;
  }

  setData(backgrounds: readonly PineBackgroundModel[], boxes: readonly PineBoxModel[]): void {
    this.backgrounds = backgrounds;
    this.boxes = boxes;
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
