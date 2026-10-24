import assert from "node:assert/strict";
import test from "node:test";
import { parseChartInterval, toBinanceInterval, toBitgetBar, toOkxBar } from "../lib/market-venues.ts";
import {
  classifyLevelTouch,
  defaultTouchTolerance,
  evaluateTouches,
  formatAlertPrice,
  formatTouchMessage,
  mergeAdjacentExtreme,
  rebindCooldown,
  selectMobileLiqBoxes,
  stackBadgeYs,
  trendlineDomain,
  trendlinePriceAt,
} from "../lib/mobile/touch.ts";

const bar = (time, open, high, low, close) => ({ time, open, high, low, close });

test("trendline price is linear in time and null on a vertical line", () => {
  assert.equal(trendlinePriceAt(150, 100, 100, 130, 200), 115);
  assert.equal(trendlinePriceAt(50, 100, 100, 130, 200), 85);
  assert.equal(trendlinePriceAt(100, 10, 5, 20, 5), null);
  assert.equal(trendlinePriceAt(Number.NaN, 1, 0, 2, 1), null);
});

test("segment domain stays between anchors and a ray continues past the second point only", () => {
  assert.equal(trendlineDomain(150, 100, 200, false), true);
  assert.equal(trendlineDomain(250, 100, 200, false), false);
  assert.equal(trendlineDomain(50, 100, 200, false), false);
  assert.equal(trendlineDomain(250, 100, 200, true), true);
  assert.equal(trendlineDomain(50, 100, 200, true), false);
  assert.equal(trendlineDomain(50, 200, 100, true), true);
});

test("upward cross, downward cross, and wick touch", () => {
  assert.equal(classifyLevelTouch(100, bar(2, 100, 112, 99, 111), 110, 0.5), "up");
  assert.equal(classifyLevelTouch(120, bar(2, 120, 121, 108, 109), 110, 0.5), "down");
  assert.equal(classifyLevelTouch(100, bar(2, 100, 110.2, 99, 105), 110, 0.5), "wick");
  assert.equal(classifyLevelTouch(100, bar(2, 100, 104, 99, 103), 110, 0.5), null);
  assert.equal(classifyLevelTouch(null, bar(2, 100, 112, 99, 111), 110, 0.5), null);
});

test("out-of-range trendline does not fire; an in-range upward cross does", () => {
  const line = {
    id: "t1", type: "trend-line", alert: true, ray: false,
    a: { time: 100, price: 100 }, b: { time: 200, price: 100 },
  };
  const outside = evaluateTouches({
    prev: bar(240, 90, 90, 90, 90),
    bar: bar(250, 90, 120, 90, 115),
    drawings: [line],
    zones: [],
    cooldown: {},
    now: 1_000,
    tolerance: 0.5,
    alertsArmed: true,
  });
  assert.deepEqual(outside.fired, []);

  const inside = evaluateTouches({
    prev: bar(140, 90, 90, 90, 90),
    bar: bar(150, 90, 120, 90, 115),
    drawings: [line],
    zones: [],
    cooldown: {},
    now: 1_000,
    tolerance: 0.5,
    alertsArmed: true,
  });
  assert.equal(inside.fired.length, 1);
  assert.equal(inside.fired[0].kind, "up");
  assert.equal(inside.fired[0].message, formatTouchMessage(inside.fired[0]));
  assert.match(inside.fired[0].message, /^触碰趋势线 @ \$/);
});

test("cooldown dedupes a second entry and allows a later one", () => {
  const line = {
    id: "t1", type: "trend-line", alert: true, ray: true,
    a: { time: 0, price: 110 }, b: { time: 10, price: 110 },
  };
  const args = (prevClose, close, now, cooldown) => evaluateTouches({
    prev: bar(20, prevClose, Math.max(prevClose, close), Math.min(prevClose, close), prevClose),
    bar: bar(30, prevClose, Math.max(prevClose, close) + 1, Math.min(prevClose, close) - 1, close),
    drawings: [line],
    zones: [],
    cooldown,
    now,
    cooldownMs: 60_000,
    tolerance: 0.5,
    alertsArmed: true,
  });
  const first = args(100, 115, 10_000, {});
  assert.equal(first.fired.length, 1);
  const again = args(100, 116, 20_000, first.cooldown);
  assert.equal(again.fired.length, 0);
  assert.equal(again.cooldown["draw:t1"], first.cooldown["draw:t1"]);
  const later = args(100, 117, 80_000, again.cooldown);
  assert.equal(later.fired.length, 1);
});

test("liquidation support and resistance fire, and a refresh rebinds cooldown", () => {
  const support = { id: "liq:support:79460:79620", role: "support", lo: 79460, hi: 79620, risk: "高", liq_m: 12 };
  const resistance = { id: "liq:resistance:82000:82200", role: "resistance", lo: 82000, hi: 82200, risk: "极高", liq_m: 20 };
  const entered = evaluateTouches({
    prev: bar(1, 80000, 80000, 80000, 80000),
    bar: bar(2, 79800, 79800, 79400, 79500),
    drawings: [],
    zones: [support, resistance],
    cooldown: {},
    now: 5_000,
    tolerance: 1,
    alertsArmed: true,
  });
  assert.equal(entered.fired.length, 1);
  assert.equal(entered.fired[0].target, "support");
  assert.equal(entered.fired[0].message, "触碰清算支撑区 $79,460–$79,620");

  const stillInside = evaluateTouches({
    prev: bar(2, 79500, 79500, 79500, 79500),
    bar: bar(3, 79510, 79540, 79480, 79520),
    drawings: [],
    zones: [support],
    cooldown: entered.cooldown,
    now: 6_000,
    tolerance: 1,
    alertsArmed: true,
  });
  assert.equal(stillInside.fired.length, 0);

  const rebound = rebindCooldown(entered.cooldown, [support.id]);
  assert.equal(rebound[support.id], entered.cooldown[support.id]);
  assert.equal(rebound[resistance.id], undefined);

  const replaced = { ...resistance, id: "liq:resistance:83000:83200", lo: 83000, hi: 83200 };
  const fresh = evaluateTouches({
    prev: bar(4, 82000, 82000, 82000, 82000),
    bar: bar(5, 82800, 83100, 82700, 83050),
    drawings: [],
    zones: [replaced],
    cooldown: rebindCooldown(entered.cooldown, [replaced.id]),
    now: 7_000,
    tolerance: 1,
    alertsArmed: true,
  });
  assert.equal(fresh.fired.length, 1);
  assert.equal(fresh.fired[0].target, "resistance");
  assert.match(fresh.fired[0].message, /^触碰清算阻力区 \$/);
});

test("draws only short liquidations above price and long liquidations below, merging adjacent extreme bins", () => {
  const price = 90;
  const bands = [
    { lo: 100, hi: 101, side: "short", risk: "极高", liq_m: 2, dist_pct: 12 },
    { lo: 101, hi: 102, side: "short", risk: "极高", liq_m: 3, dist_pct: 13 },
    { lo: 110, hi: 111, side: "short", risk: "高", liq_m: 1, dist_pct: 20 },
    { lo: 70, hi: 71, side: "short", risk: "极高", liq_m: 9, dist_pct: -20 },
    { lo: 80, hi: 81, side: "long", risk: "中", liq_m: 4, dist_pct: -10 },
    { lo: 95, hi: 96, side: "long", risk: "高", liq_m: 8, dist_pct: 5 },
  ];
  const boxes = selectMobileLiqBoxes([], bands, price);
  assert.deepEqual(boxes.map((box) => [box.role, box.lo, box.hi, box.risk]), [
    ["support", 80, 81, "中"],
    ["resistance", 100, 102, "极高"],
    ["resistance", 110, 111, "高"],
  ]);
  assert.equal(mergeAdjacentExtreme(boxes).length, 3);
  assert.deepEqual(selectMobileLiqBoxes([], [], price), []);
});

test("alert copy and badge stacking", () => {
  assert.equal(formatAlertPrice(81392.1), "81,392");
  assert.equal(formatAlertPrice(79460), "79,460");
  assert.equal(formatTouchMessage({ target: "trendline", price: 81392.4, lo: null, hi: null }), "触碰趋势线 @ $81,392");
  assert.deepEqual(stackBadgeYs([10, 12, 40], 16, 0, 200), [10, 26, 42]);
  assert.ok(defaultTouchTolerance(80_000) > 0);
  assert.ok(defaultTouchTolerance(0.00012) < 0.00012);
});

test("30m is a first-class chart interval for the mobile timeframe picker", () => {
  assert.equal(parseChartInterval("30m"), "30");
  assert.equal(parseChartInterval("30"), "30");
  assert.equal(toBinanceInterval("30"), "30m");
  assert.equal(toOkxBar("30"), "30m");
  assert.equal(toBitgetBar("30"), "30m");
});
