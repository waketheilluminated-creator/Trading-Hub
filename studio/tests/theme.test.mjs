import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { THEME_BOOTSTRAP_SCRIPT, THEME_LIGHT_CLASS, THEME_STORAGE_KEY, parseTheme, readStoredTheme, writeStoredTheme } from "../lib/theme.ts";
import { candleThemeOptions, chartPalette, chartThemeOptions } from "../lib/chart-theme.ts";
import { buildLightTheme } from "../tools/gen-light-theme.mjs";
import { hasColor, lightenForLightTheme, rgbToHsl } from "../lib/theme-colors.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

function runBootstrap(stored, { throwOnRead = false } = {}) {
  const classes = new Set();
  const documentElement = { classList: { add: (c) => classes.add(c) }, style: {} };
  const localStorage = { getItem: (k) => { if (throwOnRead) throw new Error("denied"); return k === THEME_STORAGE_KEY ? stored : null; } };
  vm.runInNewContext(THEME_BOOTSTRAP_SCRIPT, { window: { localStorage }, document: { documentElement } });
  return { classes, colorScheme: documentElement.style.colorScheme };
}

// WCAG relative luminance contrast.
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("only the exact stored value 'light' selects the light theme", () => {
  assert.equal(parseTheme("light"), "light");
  for (const forged of ["dark", "LIGHT", " light", "light;", "<script>", "", null, undefined, 1, {}]) {
    assert.equal(parseTheme(forged), "dark", `forged ${String(forged)}`);
  }
  assert.equal(readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "light" })), "light");
  assert.equal(readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "solarized" })), "dark");
  assert.equal(readStoredTheme({ getItem() { throw new Error("denied"); } }), "dark");
});

test("writes only normalized theme values and tolerates blocked storage", () => {
  const storage = memoryStorage();
  writeStoredTheme(storage, "light");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "light");
  writeStoredTheme(storage, "evil");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark");
  assert.doesNotThrow(() => writeStoredTheme({ setItem() { throw new Error("quota"); } }, "light"));
});

test("pre-paint bootstrap adds the light class only for a stored light theme", () => {
  assert.deepEqual([...runBootstrap("light").classes], [THEME_LIGHT_CLASS]);
  assert.equal(runBootstrap("light").colorScheme, "light");
  assert.deepEqual([...runBootstrap("dark").classes], []);
  assert.deepEqual([...runBootstrap(null).classes], []);
  assert.deepEqual([...runBootstrap("light\"><img>").classes], []);
  assert.doesNotThrow(() => runBootstrap("light", { throwOnRead: true }));
  assert.doesNotMatch(THEME_BOOTSTRAP_SCRIPT, /<\/script/i);
});

test("light chart palette is readable on white and differs from dark", () => {
  const light = chartPalette("light");
  const dark = chartPalette("dark");
  assert.equal(light.background, "#ffffff");
  assert.notEqual(light.background, dark.background);
  assert.ok(contrast(light.text, light.background) >= 4.5, "axis text contrast");
  assert.ok(contrast(light.up, light.background) >= 3, "up candle contrast");
  assert.ok(contrast(light.down, light.background) >= 3, "down candle contrast");
  assert.ok(contrast(light.grid, light.background) < 1.3, "grid stays subtle");
  assert.equal(chartThemeOptions("light").layout.background.color, "#ffffff");
  assert.equal(chartThemeOptions("light").crosshair.vertLine.labelBackgroundColor, light.crosshairLabel);
  assert.equal(candleThemeOptions("light").wickDownColor, light.down);
  assert.deepEqual(chartPalette("bogus"), dark);
});

test("colour mapping turns dark surfaces light and light text dark", () => {
  const surface = lightenForLightTheme(13, 18, 25); // #0d1219 right panel
  assert.ok(rgbToHsl(surface.r, surface.g, surface.b).l > 0.9);
  const text = lightenForLightTheme(213, 220, 230); // #d5dce6 body text
  assert.ok(rgbToHsl(text.r, text.g, text.b).l < 0.25);
  const paleAccent = lightenForLightTheme(200, 239, 214); // #c8efd6 accent text
  assert.ok(rgbToHsl(paleAccent.r, paleAccent.g, paleAccent.b).l < 0.4);
});

test("committed theme-light.css is generated from globals.css and covers every hard-coded colour rule", () => {
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const committed = readFileSync(new URL("../app/theme-light.css", import.meta.url), "utf8");
  assert.equal(committed, buildLightTheme(globals), "run: node tools/gen-light-theme.mjs");
  for (const selector of [".chart-stage", ".right-panel", ".metric-card", ".code-editor", ".chart-toolbar", ".indicators-popover", ".study-legend-row:hover", ".symbol-search-dialog", ".ai-drawer", ".footer"]) {
    assert.ok(committed.includes(`html.theme-light ${selector}`), `missing light override for ${selector}`);
  }
  assert.match(committed, /--bg: #f5f7fa/);
  // Console has no hard-coded colours: it follows the overridden tokens.
  assert.match(globals, /\.console \{[^}]*color:var\(--muted\)/);
  assert.doesNotMatch(committed, /html\.theme-light \.cvd-oi-chart/, "embedded light charts are left alone");
  assert.equal(hasColor("1px solid var(--line)"), false);
});

test("layout ships the bootstrap script and the light stylesheet", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /import "\.\/theme-light\.css";/);
  assert.ok(layout.indexOf('import "./globals.css"') < layout.indexOf('import "./theme-light.css"'), "light overrides load after globals");
  assert.match(layout, /THEME_BOOTSTRAP_SCRIPT/);
  assert.match(layout, /suppressHydrationWarning/);
});
