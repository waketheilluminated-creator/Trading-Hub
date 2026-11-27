import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAWING_FAVORITES_KEY,
  LEGACY_DRAWING_FAVORITES_KEY,
  MAX_DRAWING_FAVORITES,
  readDrawingFavorites,
  toggleDrawingFavorite,
  writeDrawingFavorites,
} from "../lib/drawings/favorites.ts";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    dump: () => values,
  };
}

test("favorites start empty, keep star order, and persist under the versioned key", () => {
  assert.equal(MAX_DRAWING_FAVORITES, 10);
  const storage = memoryStorage();
  assert.deepEqual(readDrawingFavorites(storage), []);
  writeDrawingFavorites(storage, ["horizontal-line", "text", "trend-line"]);
  assert.equal(storage.getItem(DRAWING_FAVORITES_KEY), JSON.stringify(["horizontal-line", "text", "trend-line"]));
  assert.deepEqual(readDrawingFavorites(storage), ["horizontal-line", "text", "trend-line"]);
});

test("starring appends and unstarring removes without reordering the rest", () => {
  let next = toggleDrawingFavorite([], "trend-line");
  assert.equal(next.blocked, false);
  assert.deepEqual(next.favorites, ["trend-line"]);
  next = toggleDrawingFavorite(next.favorites, "text");
  next = toggleDrawingFavorite(next.favorites, "arrow");
  assert.deepEqual(next.favorites, ["trend-line", "text", "arrow"]);
  next = toggleDrawingFavorite(next.favorites, "text");
  assert.deepEqual(next.favorites, ["trend-line", "arrow"]);
  assert.equal(next.blocked, false);
});

test("a full rail blocks another star and leaves the existing order untouched", () => {
  const full = ["select", "crosshair", "trend-line", "horizontal-line", "arrow", "text"];
  const blocked = toggleDrawingFavorite(full, "trend-line", 6);
  assert.equal(blocked.blocked, false);
  assert.deepEqual(blocked.favorites, ["select", "crosshair", "horizontal-line", "arrow", "text"]);
  const capped = toggleDrawingFavorite(blocked.favorites, "trend-line", 5);
  assert.equal(capped.blocked, true);
  assert.deepEqual(capped.favorites, blocked.favorites);
  assert.equal(toggleDrawingFavorite(["nope"], "trend-line").favorites[0], "trend-line");
});

test("legacy favorite lists migrate once and a stored empty list stays empty", () => {
  const storage = memoryStorage({
    [LEGACY_DRAWING_FAVORITES_KEY]: JSON.stringify(["text", "not-a-tool", "trend-line", "text"]),
  });
  assert.deepEqual(readDrawingFavorites(storage), ["text", "trend-line"]);
  assert.deepEqual(JSON.parse(storage.getItem(DRAWING_FAVORITES_KEY)), ["text", "trend-line"]);

  storage.setItem(DRAWING_FAVORITES_KEY, "[]");
  storage.setItem(LEGACY_DRAWING_FAVORITES_KEY, JSON.stringify(["arrow"]));
  assert.deepEqual(readDrawingFavorites(storage), []);

  storage.setItem(DRAWING_FAVORITES_KEY, "{");
  assert.deepEqual(readDrawingFavorites(storage), []);
  writeDrawingFavorites({ getItem: () => null, setItem() { throw new Error("blocked"); } }, ["text"]);
});
