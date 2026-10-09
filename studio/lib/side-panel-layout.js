export const SIDE_PANEL_DEFAULT_WIDTH = 292;
export const SIDE_PANEL_MIN_WIDTH = 220;
export const SIDE_PANEL_MAX_WIDTH = 640;
export const SIDE_PANEL_COLLAPSE_THRESHOLD = 140;
export const SIDE_PANEL_KEYBOARD_STEP = 24;
export const SIDE_PANEL_WIDTH_KEY = "th-side-panel-width";
export const SIDE_PANEL_COLLAPSED_KEY = "th-side-panel-collapsed";

export function maxSidePanelWidth(viewportWidth) {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return SIDE_PANEL_MAX_WIDTH;
  return Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, Math.round(viewportWidth * 0.5)));
}

export function clampSidePanelWidth(width, viewportWidth) {
  if (!Number.isFinite(width)) return SIDE_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(maxSidePanelWidth(viewportWidth), width)));
}

/**
 * Map a divider drag to the right panel width. Dragging the divider past the
 * collapse threshold (toward the right edge) collapses the panel instead of
 * shrinking it below its minimum usable width.
 */
export function resolveSidePanelDrag(viewportWidth, pointerX) {
  const raw = viewportWidth - pointerX;
  if (!Number.isFinite(raw) || raw < SIDE_PANEL_COLLAPSE_THRESHOLD) return { collapsed: true, width: null };
  return { collapsed: false, width: clampSidePanelWidth(raw, viewportWidth) };
}

export function readSidePanelPrefs(storage) {
  const fallback = { width: SIDE_PANEL_DEFAULT_WIDTH, collapsed: false };
  if (!storage) return fallback;
  try {
    const rawWidth = storage.getItem(SIDE_PANEL_WIDTH_KEY);
    const parsed = rawWidth == null ? Number.NaN : Number(rawWidth.trim());
    const width = Number.isFinite(parsed) && rawWidth.trim() !== ""
      ? Math.round(Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, parsed)))
      : SIDE_PANEL_DEFAULT_WIDTH;
    return { width, collapsed: storage.getItem(SIDE_PANEL_COLLAPSED_KEY) === "1" };
  } catch {
    return fallback;
  }
}

export function writeSidePanelPrefs(storage, prefs) {
  if (!storage) return;
  try {
    if (prefs.width != null && Number.isFinite(prefs.width)) {
      storage.setItem(SIDE_PANEL_WIDTH_KEY, String(Math.round(Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, prefs.width)))));
    }
    if (typeof prefs.collapsed === "boolean") storage.setItem(SIDE_PANEL_COLLAPSED_KEY, prefs.collapsed ? "1" : "0");
  } catch {
    // Quota / private mode: layout still works for this session.
  }
}
