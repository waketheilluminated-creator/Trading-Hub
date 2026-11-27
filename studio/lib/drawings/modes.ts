export type DrawingModeKey = "magnet" | "continuous" | "locked" | "hidden";
export type DrawingModes = Record<DrawingModeKey, boolean>;

export const initialDrawingModes: DrawingModes = {
  magnet: false,
  continuous: false,
  locked: false,
  hidden: false,
};

export function toggleDrawingMode(modes: DrawingModes, key: DrawingModeKey): DrawingModes {
  return { ...modes, [key]: !modes[key] };
}
