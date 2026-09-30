import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { CEX_NETFLOW_COLORS, type RegimeBand } from "./cex-netflow.ts";

type PaintedBand = { left: number; right: number; signal: RegimeBand["signal"] };

class RegimeBandRenderer implements IPrimitivePaneRenderer {
  private readonly getBands: () => readonly RegimeBand[];
  private readonly getChart: () => IChartApiBase<Time> | null;

  constructor(getBands: () => readonly RegimeBand[], getChart: () => IChartApiBase<Time> | null) {
    this.getBands = getBands;
    this.getChart = getChart;
  }

  draw(): void {
    // Regime color is painted behind the series.
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    const chart = this.getChart();
    const bands = this.getBands();
    if (!chart || bands.length === 0) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const painted = paintBands(chart, bands, mediaSize.width);
      for (const band of painted) {
        const width = band.right - band.left;
        if (!(width > 0)) continue;
        context.fillStyle = band.signal === "bull" ? CEX_NETFLOW_COLORS.bull : CEX_NETFLOW_COLORS.bear;
        context.fillRect(band.left, 0, width, mediaSize.height);
      }
    });
  }
}

class RegimeBandPaneView implements IPrimitivePaneView {
  private readonly paneRenderer: RegimeBandRenderer;

  constructor(paneRenderer: RegimeBandRenderer) {
    this.paneRenderer = paneRenderer;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

export class RegimeBandPrimitive implements ISeriesPrimitive<Time> {
  private bands: readonly RegimeBand[];
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly paneRenderer: RegimeBandRenderer;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(bands: readonly RegimeBand[] = []) {
    this.bands = bands;
    this.paneRenderer = new RegimeBandRenderer(() => this.bands, () => this.chart);
    this.views = [new RegimeBandPaneView(this.paneRenderer)];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
    param.requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }

  setBands(bands: readonly RegimeBand[]): void {
    this.bands = bands;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    // Band edges are resolved during draw from the live time scale.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}

function asTime(time: number): UTCTimestamp {
  return time as UTCTimestamp;
}

function paintBands(chart: IChartApiBase<Time>, bands: readonly RegimeBand[], paneWidth: number): PaintedBand[] {
  const timeScale = chart.timeScale();
  const painted: PaintedBand[] = [];
  for (const band of bands) {
    const x1 = timeScale.timeToCoordinate(asTime(band.from));
    if (x1 == null) continue;
    let x2 = band.to == null ? null : timeScale.timeToCoordinate(asTime(band.to));
    if (x2 == null) {
      const index = timeScale.timeToIndex(asTime(band.from), false);
      x2 = index == null ? null : timeScale.logicalToCoordinate((index + 1) as Logical);
    }
    if (x2 == null) continue;
    painted.push({ left: Math.min(x1, x2), right: Math.max(x1, x2), signal: band.signal });
  }
  const first = painted[0];
  const last = painted[painted.length - 1];
  if (first && first.left > 0 && first.left < paneWidth) first.left = 0;
  if (last && last.right < paneWidth && last.right > 0) last.right = paneWidth;
  return painted;
}
