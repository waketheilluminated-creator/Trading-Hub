// Turns the Pine runtime output (plots / plotshapes / bgcolors / boxes) into a
// chart-agnostic render model. Pine semantics:
//   - indicator(overlay=false) (Pine's default) → plots go to a separate study pane.
//   - force_overlay=true on a plot / plotshape / bgcolor / box → drawn on the price pane.
export type PinePane = "price" | "study";

export type PinePoint = { time: number; value?: number; color?: string };
export type PineSeriesModel = {
  key: string;
  title: string;
  kind: "line" | "histogram";
  stepped: boolean;
  pane: PinePane;
  color: string;
  lineWidth: number;
  points: PinePoint[];
};
export type PineMarkerModel = {
  pane: PinePane;
  time: number;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  size: number;
  text?: string;
};
export type PineBackgroundModel = { pane: PinePane; time: number; color: string };
export type PineBoxModel = {
  pane: PinePane;
  leftTime: number;
  rightTime: number;
  top: number;
  bottom: number;
  borderColor: string;
  borderWidth: number;
  fill: string | null;
};
export type PineRenderModel = {
  title: string;
  overlay: boolean;
  series: PineSeriesModel[];
  markers: PineMarkerModel[];
  backgrounds: PineBackgroundModel[];
  boxes: PineBoxModel[];
};

type RuntimePlot = {
  title?: string; data?: (number | null)[]; colors?: (string | null)[]; color?: string | null;
  linewidth?: number; style?: string; forceOverlay?: boolean;
};
type RuntimeShape = {
  title?: string; data?: boolean[]; style?: string; location?: string; color?: string | null;
  size?: string; text?: string; forceOverlay?: boolean;
};
type RuntimeBg = { title?: string; data?: (string | null)[]; forceOverlay?: boolean };
type RuntimeBox = {
  left?: number | null; right?: number | null; top?: number | null; bottom?: number | null; xloc?: string;
  borderColor?: string | null; borderWidth?: number; bgcolor?: string | null; forceOverlay?: boolean;
};
export type PineRuntimeOutput = {
  indicator?: { title?: string; overlay?: boolean } | null;
  plots?: Record<string, RuntimePlot> | RuntimePlot[];
  plotshapes?: Record<string, RuntimeShape>;
  bgcolors?: Record<string, RuntimeBg>;
  boxes?: RuntimeBox[];
};

const DEFAULT_COLOR = "rgba(41, 98, 255, 1)";
const MAX_BOXES = 500;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function paneFor(forceOverlay: boolean | undefined, overlay: boolean): PinePane {
  return forceOverlay || overlay ? "price" : "study";
}

function markerShape(style: string | undefined): PineMarkerModel["shape"] {
  switch (style) {
    case "triangleup": case "arrowup": case "labelup": return "arrowUp";
    case "triangledown": case "arrowdown": case "labeldown": return "arrowDown";
    case "square": case "diamond": return "square";
    default: return "circle";
  }
}

function markerPosition(location: string | undefined): PineMarkerModel["position"] {
  if (location === "belowbar" || location === "bottom") return "belowBar";
  if (location === "abovebar" || location === "top") return "aboveBar";
  return "inBar";
}

function markerSize(size: string | undefined): number {
  switch (size) {
    case "tiny": return 0.5;
    case "small": return 1;
    case "large": return 2;
    case "huge": return 2.5;
    case "normal": return 1.5;
    default: return 1;
  }
}

function barTime(index: number | null | undefined, xloc: string | undefined, times: readonly number[]): number | null {
  if (!finite(index) || !times.length) return null;
  if (xloc === "bar_time") return Math.floor(index > 10_000_000_000 ? index / 1000 : index);
  const i = Math.round(index);
  if (i < 0 || i >= times.length) return null;
  return times[i];
}

export function buildPineRenderModel(runtime: PineRuntimeOutput | null | undefined, times: readonly number[]): PineRenderModel {
  const overlay = runtime?.indicator?.overlay === true;
  const model: PineRenderModel = {
    title: runtime?.indicator?.title || "Pine script",
    overlay,
    series: [],
    markers: [],
    backgrounds: [],
    boxes: [],
  };
  if (!runtime) return model;

  const plots = Array.isArray(runtime.plots) ? runtime.plots : Object.values(runtime.plots ?? {});
  plots.forEach((plot, index) => {
    const data = plot.data ?? [];
    const points: PinePoint[] = [];
    for (let i = 0; i < times.length; i += 1) {
      const value = data[i];
      if (!finite(value)) { points.push({ time: times[i] }); continue; }
      const color = plot.colors?.[i];
      if (plot.colors && color == null) { points.push({ time: times[i] }); continue; }
      points.push(color ? { time: times[i], value, color } : { time: times[i], value });
    }
    const style = plot.style ?? "line";
    model.series.push({
      key: `${plot.title || "plot"}#${index}`,
      title: plot.title || `Plot ${index + 1}`,
      kind: style === "columns" || style === "histogram" ? "histogram" : "line",
      stepped: style === "stepline",
      pane: paneFor(plot.forceOverlay, overlay),
      color: plot.color || DEFAULT_COLOR,
      lineWidth: Math.max(1, Math.min(4, Math.round(plot.linewidth ?? 1))),
      points,
    });
  });

  for (const shape of Object.values(runtime.plotshapes ?? {})) {
    const data = shape.data ?? [];
    for (let i = 0; i < times.length; i += 1) {
      if (!data[i]) continue;
      model.markers.push({
        pane: paneFor(shape.forceOverlay, overlay),
        time: times[i],
        position: markerPosition(shape.location),
        shape: markerShape(shape.style),
        color: shape.color || DEFAULT_COLOR,
        size: markerSize(shape.size),
        ...(shape.text ? { text: shape.text } : {}),
      });
    }
  }

  for (const bg of Object.values(runtime.bgcolors ?? {})) {
    const data = bg.data ?? [];
    for (let i = 0; i < times.length; i += 1) {
      const color = data[i];
      if (color) model.backgrounds.push({ pane: paneFor(bg.forceOverlay, overlay), time: times[i], color });
    }
  }

  for (const box of (runtime.boxes ?? []).slice(-MAX_BOXES)) {
    const left = barTime(box.left, box.xloc, times);
    const right = barTime(box.right, box.xloc, times);
    if (left == null || right == null || !finite(box.top) || !finite(box.bottom)) continue;
    model.boxes.push({
      pane: paneFor(box.forceOverlay, overlay),
      leftTime: Math.min(left, right),
      rightTime: Math.max(left, right),
      top: Math.max(box.top, box.bottom),
      bottom: Math.min(box.top, box.bottom),
      borderColor: box.borderColor || DEFAULT_COLOR,
      borderWidth: Math.max(1, Math.min(4, Math.round(box.borderWidth ?? 1))),
      fill: box.bgcolor ?? null,
    });
  }
  return model;
}

export function pineModelHasOutput(model: PineRenderModel): boolean {
  return model.series.length > 0 || model.markers.length > 0 || model.backgrounds.length > 0 || model.boxes.length > 0;
}

export function pineModelNeedsStudyPane(model: PineRenderModel): boolean {
  return model.series.some((series) => series.pane === "study");
}

export function describePineModel(model: PineRenderModel, bars: number): string {
  const studyPlots = model.series.filter((series) => series.pane === "study").length;
  const pricePlots = model.series.length - studyPlots;
  const parts = [
    `${bars} bars`,
    `${model.series.length} plot${model.series.length === 1 ? "" : "s"} (${pricePlots} on price, ${studyPlots} in pane)`,
    `${model.markers.length} shape${model.markers.length === 1 ? "" : "s"}`,
    `${model.backgrounds.length} background bar${model.backgrounds.length === 1 ? "" : "s"}`,
    `${model.boxes.length} box${model.boxes.length === 1 ? "" : "es"}`,
  ];
  return parts.join(" · ");
}
