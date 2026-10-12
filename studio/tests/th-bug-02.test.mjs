import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BINANCE_DEPTH_LIMIT, depthRequestUrl } from "../lib/market-depth.ts";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("Binance depth uses a limit the futures API accepts (200 returned HTTP 400 → walls 502)", () => {
  assert.ok([5, 10, 20, 50, 100, 500, 1000].includes(BINANCE_DEPTH_LIMIT));
  const url = new URL(depthRequestUrl("binance", "BTCUSDT"));
  assert.equal(url.origin + url.pathname, "https://fapi.binance.com/fapi/v1/depth");
  assert.equal(url.searchParams.get("limit"), String(BINANCE_DEPTH_LIMIT));
  assert.notEqual(url.searchParams.get("limit"), "200");
});

test("Links opt out of the vinext beta RSC prefetch that throws 'f is not a function'", () => {
  for (const file of ["../app/trading-workspace.tsx", "../components/desk-header.tsx", "../app/pine-editor/pine-editor-tab.tsx"]) {
    const src = read(file);
    const links = src.match(/<Link\b[^>]*>/g) ?? [];
    assert.ok(links.length > 0, file);
    for (const link of links) assert.match(link, /prefetch=\{false\}/, `${file}: ${link}`);
  }
});

test("liq snapshot probe uses probe=1 and only treats 200 as a snapshot", () => {
  const src = read("../app/trading-workspace.tsx");
  assert.match(src, /\/api\/liq-heatmap\?symbol=\$\{[^}]+\}&probe=1/);
  assert.match(src, /has: response\.status === 200/);
});

test("symbol search selects the previous query on open so typing replaces it", () => {
  const src = read("../components/symbol-search-dialog.tsx");
  assert.match(src, /symbolSearchRef\.current\?\.focus\(\);\s*\/\/[^\n]*\n\s*symbolSearchRef\.current\?\.select\(\);/);
});

test("layout declares the SVG favicon so browsers stop requesting a missing /favicon.ico", () => {
  assert.match(read("../app/layout.tsx"), /icons:\s*\{\s*icon:\s*"\/favicon\.svg"\s*\}/);
});
