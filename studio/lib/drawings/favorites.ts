import { catalogTool } from "./catalog.ts";
import type { DrawingTool } from "./types.ts";

export const DRAWING_FAVORITES_KEY = "th-drawing-favorites-v1";
export const LEGACY_DRAWING_FAVORITES_KEY = "th-drawing-favorites";
export const MAX_DRAWING_FAVORITES = 10;

const FAVORITE_TOOLS = new Set<DrawingTool>(["select", "crosshair", "trend-line", "horizontal-line", "arrow", "text"]);

type FavoriteStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function isFavoriteTool(value: unknown): value is DrawingTool {
  return typeof value === "string" && (FAVORITE_TOOLS.has(value as DrawingTool) || catalogTool(value as DrawingTool) !== undefined);
}

function sanitize(value: unknown, max = MAX_DRAWING_FAVORITES): DrawingTool[] {
  if (!Array.isArray(value)) return [];
  const favorites: DrawingTool[] = [];
  for (const item of value) {
    if (!isFavoriteTool(item) || favorites.includes(item)) continue;
    favorites.push(item);
    if (favorites.length >= max) break;
  }
  return favorites;
}

export function readDrawingFavorites(storage: FavoriteStorage | null | undefined): DrawingTool[] {
  if (!storage) return [];
  try {
    const current = storage.getItem(DRAWING_FAVORITES_KEY);
    if (current != null) return sanitize(JSON.parse(current));
  } catch {
    return [];
  }
  try {
    const legacy = storage.getItem(LEGACY_DRAWING_FAVORITES_KEY);
    if (legacy == null) return [];
    const favorites = sanitize(JSON.parse(legacy));
    if (favorites.length) writeDrawingFavorites(storage, favorites);
    return favorites;
  } catch {
    return [];
  }
}

const FAVORITES_EVENT = "th-drawing-favorites";
export const EMPTY_DRAWING_FAVORITES: DrawingTool[] = [];
let cachedFavoriteRaw: string | null | undefined;
let cachedFavorites: DrawingTool[] = EMPTY_DRAWING_FAVORITES;

export function subscribeDrawingFavorites(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(FAVORITES_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(FAVORITES_EVENT, onChange);
  };
}

export function notifyDrawingFavorites(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(FAVORITES_EVENT));
}

export function readClientDrawingFavorites(): DrawingTool[] {
  if (typeof window === "undefined") return EMPTY_DRAWING_FAVORITES;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(DRAWING_FAVORITES_KEY);
  } catch {
    return EMPTY_DRAWING_FAVORITES;
  }
  if (cachedFavoriteRaw !== undefined && raw === cachedFavoriteRaw) return cachedFavorites;
  const favorites = readDrawingFavorites(window.localStorage);
  try {
    cachedFavoriteRaw = window.localStorage.getItem(DRAWING_FAVORITES_KEY);
  } catch {
    cachedFavoriteRaw = raw;
  }
  cachedFavorites = favorites;
  return cachedFavorites;
}

export function writeDrawingFavorites(storage: FavoriteStorage | null | undefined, favorites: readonly string[]): void {
  try {
    storage?.setItem(DRAWING_FAVORITES_KEY, JSON.stringify(sanitize(favorites)));
  } catch {
    // Private mode and quota errors leave the in-memory rail usable.
  }
}

export function toggleDrawingFavorite(
  favorites: readonly string[],
  tool: string,
  max = MAX_DRAWING_FAVORITES,
): { favorites: DrawingTool[]; blocked: boolean } {
  const current = sanitize(favorites, max);
  if (!isFavoriteTool(tool)) return { favorites: current, blocked: false };
  if (current.includes(tool)) return { favorites: current.filter((item) => item !== tool), blocked: false };
  if (current.length >= max) return { favorites: current, blocked: true };
  return { favorites: [...current, tool], blocked: false };
}
