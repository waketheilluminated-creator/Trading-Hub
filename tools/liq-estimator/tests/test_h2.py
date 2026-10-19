"""Unit + golden OOS tests for H2 (TH-FEAT-19)."""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oi_liq.h2 import (  # noqa: E402
    BTC_TIER_EXTREME_USD,
    BTC_TIER_HIGH_USD,
    BTC_TIER_MEDIUM_USD,
    DONGYI_REF_BIN_WIDTH_PCT,
    Bar1h,
    aggregate_h2_buckets,
    apply_h2_tiers,
    h2_distribute,
    long_liq_price,
    matched_oi_totals,
    scale_tier_thresholds,
    short_liq_price,
)

GOLDEN = Path(__file__).resolve().parents[3] / ".." / "golden"
# Prefer repo-relative goldens copied next to tests, else workspace path.
for cand in (
    Path(__file__).resolve().parents[1] / "golden",
    Path("/workspace/th-h2/golden"),
    Path("/workspace/btc-liq-compare/oos"),
):
    if cand.exists() and list(cand.glob("s*.json")):
        GOLDEN = cand
        break


def test_scale_tier_thresholds_btc_unchanged():
    t = scale_tier_thresholds(12e9, 12e9)
    assert t.extreme_usd == BTC_TIER_EXTREME_USD
    assert t.high_usd == BTC_TIER_HIGH_USD
    assert t.medium_usd == BTC_TIER_MEDIUM_USD
    assert t.risk(100e6) == "极高"
    assert t.risk(70e6) == "高"
    assert t.risk(15e6) == "中"
    assert t.risk(14.9e6) == "低"


def test_scale_tier_thresholds_alt_scales_with_oi_ratio():
    # Alt with 1% of BTC OI → cutoffs at 1% of BTC floors.
    t = scale_tier_thresholds(50e6, 5e9)  # ratio 0.01
    assert t.extreme_usd == pytest.approx(1e6)
    assert t.high_usd == pytest.approx(0.7e6)
    assert t.medium_usd == pytest.approx(0.15e6)
    assert t.risk(1e6) == "极高"
    assert t.risk(0.5e6) == "中"


def test_scale_tier_thresholds_missing_btc_falls_back():
    t = scale_tier_thresholds(50e6, 0)
    assert t.extreme_usd == BTC_TIER_EXTREME_USD


# --- TH-BUG-06: tier cutoffs scale with bucket width (calibrated on Dongyi ~0.19% BTC bins) ---


def test_bucket_scaling_default_is_reference_bin():
    """No bucket width → Dongyi reference bin → BTC floors unchanged (golden OOS contract)."""
    assert DONGYI_REF_BIN_WIDTH_PCT == pytest.approx(0.0019)
    t = scale_tier_thresholds(12e9, 12e9)
    ref = scale_tier_thresholds(12e9, 12e9, bucket_width_pct=DONGYI_REF_BIN_WIDTH_PCT)
    assert (t.extreme_usd, t.high_usd, t.medium_usd) == (ref.extreme_usd, ref.high_usd, ref.medium_usd)


def test_bucket_scaling_btc_live_half_percent():
    t = scale_tier_thresholds(12e9, 12e9, bucket_width_pct=0.005)
    f = 0.005 / 0.0019
    assert t.extreme_usd == pytest.approx(BTC_TIER_EXTREME_USD * f)
    assert t.high_usd == pytest.approx(BTC_TIER_HIGH_USD * f)
    assert t.medium_usd == pytest.approx(BTC_TIER_MEDIUM_USD * f)
    # high/extreme ratio unchanged (no ETH-specific ratio yet)
    assert t.high_usd / t.extreme_usd == pytest.approx(BTC_TIER_HIGH_USD / BTC_TIER_EXTREME_USD)


def test_bucket_scaling_composes_with_oi_share_for_alts():
    t = scale_tier_thresholds(6.2e9, 10e9, bucket_width_pct=0.005)  # ETH-like OI share 0.62
    f = 0.62 * 0.005 / 0.0019
    assert t.extreme_usd == pytest.approx(BTC_TIER_EXTREME_USD * f)
    assert t.high_usd == pytest.approx(BTC_TIER_HIGH_USD * f)
    assert t.medium_usd == pytest.approx(BTC_TIER_MEDIUM_USD * f)


@pytest.mark.parametrize("bad", [0.0, -0.005, float("nan"), float("inf"), None])
def test_bucket_scaling_invalid_width_falls_back_to_reference(bad):
    """Deny path: a bogus bucket width must not zero or explode the cutoffs."""
    t = scale_tier_thresholds(12e9, 12e9, bucket_width_pct=bad)
    assert t.extreme_usd == BTC_TIER_EXTREME_USD
    assert t.high_usd == BTC_TIER_HIGH_USD


def test_bucket_scaling_is_clamped():
    tiny = scale_tier_thresholds(12e9, 12e9, bucket_width_pct=1e-9)
    huge = scale_tier_thresholds(12e9, 12e9, bucket_width_pct=5.0)
    assert tiny.extreme_usd >= BTC_TIER_EXTREME_USD * 0.05 - 1e-6
    assert huge.extreme_usd <= BTC_TIER_EXTREME_USD * 50 + 1e-6


def _live_btc_rows():
    data = json.loads((Path(__file__).parent / "fixture_btc_live_0p5.json").read_text(encoding="utf-8"))
    return data, [dict(b) for b in data["buckets"]]


def test_live_btc_half_percent_no_longer_mostly_extreme():
    """Real H2 output (2026-10-19 18:47Z, 0.5% buckets): fixed 0.19%-bin cutoffs marked most buckets 极高."""
    data, rows = _live_btc_rows()
    assert len(rows) >= 30
    old = apply_h2_tiers([dict(r) for r in rows], scale_tier_thresholds(1.0, 1.0))
    old_x = sum(r["risk"] == "极高" for r in old)
    assert old_x / len(old) > 0.5  # reproduces the bug
    new = apply_h2_tiers(rows, scale_tier_thresholds(1.0, 1.0, bucket_width_pct=data["bucket_width_pct"]))
    new_x = sum(r["risk"] == "极高" for r in new)
    assert new_x / len(new) < 0.5, f"{new_x}/{len(new)} buckets still 极高"
    assert new_x >= 1  # the real clusters still surface
    tiers = {r["risk"] for r in new}
    assert {"极高", "高", "中"} <= tiers


def test_matched_oi_totals_compares_like_with_like():
    """TH-BUG-06b: alt OI share must use BTC OI over the same venues as the symbol total."""
    eth = {"binance": 5.482e9, "okx": 1.408e9, "bybit": 0.95e9}
    btc = {"binance": 7.823e9, "okx": 2.446e9, "bybit": 2.377e9}
    sym, ref = matched_oi_totals(eth, btc)
    assert sym == pytest.approx(7.84e9)
    assert ref == pytest.approx(12.646e9)
    t = scale_tier_thresholds(sym, ref, bucket_width_pct=0.005)
    assert t.extreme_usd == pytest.approx(100e6 * (7.84 / 12.646) * 0.005 / 0.0019, rel=1e-6)


def test_matched_oi_regression_binance_only_btc_snapped_eth_to_btc_floors():
    """The live bug: 3-venue ETH (7.84B) vs Binance-only BTC (7.82B) → ratio≈1 → BTC floors for ETH."""
    snapped = scale_tier_thresholds(7.8407e9, 7.8167e9)
    assert snapped.extreme_usd == BTC_TIER_EXTREME_USD
    sym, ref = matched_oi_totals({"binance": 5.482e9, "okx": 1.408e9, "bybit": 0.95e9}, {"binance": 7.8167e9, "okx": 2.446e9, "bybit": 2.377e9})
    assert scale_tier_thresholds(sym, ref).extreme_usd < 0.7 * BTC_TIER_EXTREME_USD


def test_matched_oi_totals_only_shared_positive_venues():
    sym, ref = matched_oi_totals({"binance": 1e9, "okx": 2e8, "bybit": 0.0}, {"binance": 8e9, "bybit": 2e9, "gate": 1e9})
    assert sym == pytest.approx(1e9) and ref == pytest.approx(8e9)  # okx missing on BTC side, bybit zero on symbol side


@pytest.mark.parametrize("btc", [{}, None, {"binance": 0.0}, {"binance": float("nan")}, {"okx": 5e9}])
def test_matched_oi_totals_no_overlap_fails_to_reference(btc):
    """Deny path: no comparable BTC OI → ref None → scale_tier_thresholds keeps BTC floors (never 0/inf)."""
    sym, ref = matched_oi_totals({"binance": 1e9}, btc)
    assert ref is None
    assert scale_tier_thresholds(sym, ref or 0).extreme_usd == BTC_TIER_EXTREME_USD


def test_liq_price_formula():
    assert long_liq_price(100, 10, 0.005) == pytest.approx(100 * (1 - 0.1 + 0.005))
    assert short_liq_price(100, 10, 0.005) == pytest.approx(100 * (1 + 0.1 - 0.005))


def _flat_bars(n=24, start_px=100.0, start_ts=1_000_000):
    bars = []
    for i in range(n):
        px = start_px
        bars.append(Bar1h(start_ts + i * 3_600_000, px, px + 1, px - 1, px, quote_vol=1_000.0))
    return bars


def test_h2_longs_below_shorts_above_mark():
    bars = _flat_bars()
    mark = 100.0
    hits = h2_distribute(10_000_000, bars, mark)
    assert hits
    for h in hits:
        if h.side == "long":
            assert h.price < mark
        else:
            assert h.price > mark


def test_h2_drop_crossed_removes_swept_levels():
    # Heavy volume only on the first bar (entry). Second bar has zero volume so it
    # contributes no mass but its low=85 is still on the post-entry path.
    bars = [
        Bar1h(0, 100, 101, 99, 100, 1_000),
        Bar1h(3_600_000, 100, 101, 85, 100, 0),
    ]
    mark = 100.0
    kept = h2_distribute(1_000_000, bars, mark, drop_crossed=True)
    assert [h for h in kept if h.side == "long" and h.leverage == 10] == []
    no_drop = h2_distribute(1_000_000, bars, mark, drop_crossed=False)
    assert any(h.side == "long" and h.leverage == 10 and h.price < mark for h in no_drop)



def test_h2_volume_weight_shifts_mass_to_heavy_bars():
    bars = [
        Bar1h(0, 100, 101, 99, 100, quote_vol=1),
        Bar1h(3_600_000, 110, 111, 109, 110, quote_vol=99),
    ]
    mark = 110.0
    hits = h2_distribute(1_000_000, bars, mark, drop_crossed=False)
    # Most mass should come from the second entry (110).
    from_heavy = sum(h.notional_usd for h in hits if abs(h.entry - 110) < 1e-9)
    from_light = sum(h.notional_usd for h in hits if abs(h.entry - 100) < 1e-9)
    assert from_heavy > 10 * from_light


def test_aggregate_rejects_wrong_side_of_mark():
    from oi_liq.h2 import H2Hit

    hits = [
        H2Hit(95, 1e6, "long", 10, 100, 0),
        H2Hit(105, 1e6, "short", 10, 100, 0),
        H2Hit(106, 1e6, "long", 10, 100, 0),  # long above mark — must not appear
    ]
    rows = aggregate_h2_buckets(hits, mark=100.0, bucket_width_pct=0.01)
    assert all(r["side"] != "long" or r["hi"] <= 100 for r in rows)
    assert all(r["side"] != "short" or r["lo"] >= 100 for r in rows)


def _corr(a, b):
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    if sa == 0 or sb == 0:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)


def _pearson(a, b):
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    if sa == 0 or sb == 0:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)


def _iou_top(pred_usd, dy_extreme_idx, n=None):
    """IoU of top-|X| predicted bins vs Dongyi 极高 set (campaign definition)."""
    n = n if n is not None else max(1, len(dy_extreme_idx))
    order = sorted(range(len(pred_usd)), key=lambda i: -pred_usd[i])
    top = {i for i in order[:n] if pred_usd[i] > 0}
    union = top | dy_extreme_idx
    if not union:
        return 0.0
    return len(top & dy_extreme_idx) / len(union)


@pytest.mark.skipif(not GOLDEN.exists(), reason="OOS golden JSON not present")
def test_h2_golden_oos_tier_accuracy():
    """Fixed-dollar BTC tiers match Dongyi labels on the 5 OOS snapshots (≥85%)."""
    t = scale_tier_thresholds(1.0, 1.0)
    assert t.risk(183.4e6) == "极高"
    assert t.risk(75.1e6) == "高"
    assert t.risk(18.8e6) == "中"
    assert t.risk(0) == "低"
    ok = total = 0
    for path in sorted(GOLDEN.glob("s*.json")):
        if path.name.startswith("scores") or path.name.startswith("h2_"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for r in data["rows"]:
            pred = t.risk(r["m"] * 1e6)
            total += 1
            if pred == r["tier"]:
                ok += 1
    assert total >= 50
    assert ok / total >= 0.85, f"tier accuracy {ok}/{total}"


@pytest.mark.skipif(
    not (GOLDEN / "h2_preds.json").exists() or not (GOLDEN / "scores.json").exists(),
    reason="OOS h2_preds/scores not present",
)
def test_h2_golden_oos_corr_iou_thresholds():
    """Reproduce validated H2 OOS corr/IoU on the 5 Dongyi snapshots.

    Thresholds match the OOS campaign gate (corr ≥ 0.70; IoU pass flags in scores.json).
    Pred grids are frozen H2 outputs; this locks the campaign, not live network OI.
    """
    preds = json.loads((GOLDEN / "h2_preds.json").read_text(encoding="utf-8"))
    scores = json.loads((GOLDEN / "scores.json").read_text(encoding="utf-8"))["h2"]
    assert set(preds["snaps"]) == set(scores)
    for sid, snap in preds["snaps"].items():
        grid = snap["grid"]
        pred = [g["usd"] for g in grid]
        dy = [g["dy"] for g in grid]
        corr = _pearson(pred, dy)
        dy_x = {i for i, g in enumerate(grid) if g.get("dy_tier") == "极高"}
        iou = _iou_top(pred, dy_x)
        gate = scores[sid]
        assert corr >= 0.70, f"{sid} corr={corr}"
        assert abs(corr - gate["corr"]) < 0.02, f"{sid} corr drift {corr} vs {gate['corr']}"
        # IoU gate: campaign required pass_iou; allow 0.01 float noise vs frozen score
        assert abs(iou - gate["iou"]) < 0.02, f"{sid} iou drift {iou} vs {gate['iou']}"
        assert gate["PASS"] is True
        assert gate["pass_corr"] is True
        assert gate["pass_iou"] is True


# --- TH-FEAT-20: live/replay buckets at the Dongyi bin (~0.19%); same-tier boxes; 中+ shown ---
from oi_liq.h2 import LIVE_BUCKET_WIDTH_PCT  # noqa: E402
from oi_liq.zones import ZONE_RISKS, build_bands, build_sample_payload, merge_zones  # noqa: E402


def _row(lo, hi, side, usd, risk):
    return {"lo": lo, "hi": hi, "side": side, "liq_usd": usd, "liq_m": usd / 1e6, "risk": risk, "dist_pct": 0.0}


def test_live_bucket_is_dongyi_bin_and_cutoffs_are_btc_floors():
    assert LIVE_BUCKET_WIDTH_PCT == DONGYI_REF_BIN_WIDTH_PCT == pytest.approx(0.0019)
    t = scale_tier_thresholds(12e9, 12e9, bucket_width_pct=LIVE_BUCKET_WIDTH_PCT)
    assert (t.extreme_usd, t.high_usd, t.medium_usd) == (BTC_TIER_EXTREME_USD, BTC_TIER_HIGH_USD, BTC_TIER_MEDIUM_USD)
    # refresh_liq imports requests (not installed in CI): check its argparse default statically.
    src = (Path(__file__).resolve().parents[1] / "refresh_liq.py").read_text(encoding="utf-8")
    assert '"--bucket-width-pct", type=float, default=LIVE_BUCKET_WIDTH_PCT' in src
    assert "default=0.005" not in src


def test_bands_include_medium_but_never_low():
    rows = [_row(90, 91, "long", 20e6, "中"), _row(91, 92, "long", 5e6, "低"), _row(110, 111, "short", 80e6, "高")]
    assert ZONE_RISKS == frozenset({"中", "高", "极高"})
    risks = sorted(b["risk"] for b in build_bands(rows))
    assert risks == ["中", "高"]


def test_zones_merge_same_tier_only_and_singles_stay_bands():
    mid = 100.0
    rows = [
        _row(95.0, 96.0, "long", 120e6, "极高"),
        _row(96.0, 97.0, "long", 130e6, "极高"),
        _row(97.0, 98.0, "long", 80e6, "高"),  # adjacent but different tier → its own (single) band
        _row(98.0, 99.0, "long", 20e6, "中"),
        _row(101.0, 102.0, "short", 20e6, "中"),
        _row(102.0, 103.0, "short", 25e6, "中"),
        _row(104.0, 105.0, "short", 150e6, "极高"),  # isolated → band only
    ]
    zones = merge_zones(rows, mid, bucket_width_pct=0.01)
    got = [(z["lo"], z["hi"], z["risk_max"], z["bucket_count"]) for z in zones]
    assert got == [(95.0, 97.0, "极高", 2), (101.0, 103.0, "中", 2)]
    payload = build_sample_payload(symbol="BTCUSDT", mid=mid, buckets=rows, bucket_pct=1.0)
    assert len(payload["bands"]) == 7
    assert "SAME tier" in payload["zoneRule"]


def test_zones_never_merge_across_sides_or_gaps():
    rows = [_row(95.0, 96.0, "long", 120e6, "极高"), _row(96.5, 97.5, "long", 120e6, "极高"), _row(100.5, 101.5, "short", 120e6, "极高")]
    assert merge_zones(rows, 100.0, bucket_width_pct=0.01) == []


def test_s1020_btc_long_extreme_box_vs_dongyi():
    """Live BTC at Beijing 2026-10-20 02:47 (18:47Z), 0.19% buckets, BTC floors.

    东一 long 极高 = 79,462–79,619 (2 rows). H2's long-side peak sits lower: within ±5% of mark there is ONE
    merged long 极高 box, 78,508–79,598 (7 bins), which reaches into 东一's range at its top bin but is centred
    ~500 below it. Asserted as-is (honest gap, no tuning).
    """
    data = json.loads((Path(__file__).parent / "fixture_btc_s1020_0p19.json").read_text(encoding="utf-8"))
    mark, w = data["mark"], data["bucket_width_pct"]
    rows = apply_h2_tiers([dict(r) for r in data["buckets"]], scale_tier_thresholds(1.0, 1.0, bucket_width_pct=w))
    zones = merge_zones(rows, mark, bucket_width_pct=w)
    near = [z for z in zones if z["risk_max"] == "极高" and abs((z["lo"] + z["hi"]) / 2 / mark - 1) < 0.05]
    longs = [z for z in near if z["side"] == "long"]
    assert len(longs) == 1, longs
    box = longs[0]
    (dy_lo, dy_hi), = data["dongyi_extreme"]["long"]
    assert box["lo"] < dy_hi and box["hi"] > dy_lo, "long box must overlap 东一 79,462–79,619"
    assert round(box["lo"]) == 78508 and round(box["hi"]) == 79598 and box["bucket_count"] == 7
    assert (box["lo"] + box["hi"]) / 2 < (dy_lo + dy_hi) / 2 - 300  # model peak is below 东一's (documented gap)
    shorts = [z for z in near if z["side"] == "short"]
    assert any(z["lo"] < 84948 and z["hi"] > 84165 for z in shorts)
    # 东一's lower short pair (83,224–83,694) is two NON-adjacent single 极高 bins in H2 (83,178 / 83,490):
    # not a box, but still drawn as bands (the old ">=2 bins or nothing" rule hid them).
    bands = build_bands(rows)
    assert not any(z["lo"] < 83694 and z["hi"] > 83224 for z in shorts)
    assert sum(1 for b in bands if b["risk"] == "极高" and b["side"] == "short" and b["lo"] < 83694 and b["hi"] > 83224) == 2
    # 中+ singles still visible as bands; 低 never.
    assert all(b["risk"] in ("中", "高", "极高") for b in bands)
    assert sum(r["risk"] != "低" for r in rows) == len(bands)


# --- TH-FEAT-20b: small-OI alts never collapse to zero bands (relative tier floor) ---
from oi_liq.h2 import REL_FLOOR_HIGH, REL_FLOOR_MEDIUM, TierThresholds, apply_relative_tier_floor  # noqa: E402


def _tiered(rows, t):
    return apply_h2_tiers([dict(r) for r in rows], t)


def test_relative_floor_only_when_a_side_has_no_tiered_bin():
    t = TierThresholds(extreme_usd=1e9, high_usd=7e8, medium_usd=1.5e8)
    rows = _tiered([
        {"lo": 1, "hi": 2, "side": "long", "liq_usd": 100.0}, {"lo": 2, "hi": 3, "side": "long", "liq_usd": 85.0},
        {"lo": 3, "hi": 4, "side": "long", "liq_usd": 60.0}, {"lo": 4, "hi": 5, "side": "long", "liq_usd": 10.0},
        {"lo": 6, "hi": 7, "side": "short", "liq_usd": 2e8}, {"lo": 7, "hi": 8, "side": "short", "liq_usd": 1.0},
    ], t)
    assert [r["risk"] for r in rows] == ["低"] * 4 + ["中", "低"]
    used = apply_relative_tier_floor(rows)
    assert used == ["long"]
    assert [r["risk"] for r in rows] == ["高", "高", "中", "低", "中", "低"]  # short side untouched (has a 中)
    assert all(r.get("tier_basis") == "relative" for r in rows[:3]) and "tier_basis" not in rows[4]
    assert REL_FLOOR_HIGH == 0.8 and REL_FLOOR_MEDIUM == 0.5
    assert not any(r["risk"] == "极高" for r in rows[:4]), "the floor never invents 极高"


def test_relative_floor_deny_paths():
    assert apply_relative_tier_floor([]) == []
    zero = [{"lo": 1, "hi": 2, "side": "long", "liq_usd": 0.0, "risk": "低"}]
    assert apply_relative_tier_floor(zero) == [] and zero[0]["risk"] == "低"
    bad = [{"lo": 1, "hi": 2, "side": "long", "liq_usd": float("nan"), "risk": "低"},
           {"lo": 2, "hi": 3, "side": "bid", "liq_usd": 5.0, "risk": "低"}]
    assert apply_relative_tier_floor(bad) == [] and [r["risk"] for r in bad] == ["低", "低"]


def test_pyth_like_alt_gets_bands_and_a_box():
    # PYTHUSDT 0.5% live (10-20 03:47 BJ): max bucket 84k vs OI-scaled 中 cutoff 54k / 高 251k → only 中.
    t = scale_tier_thresholds(17.2e6, 12.6e9, bucket_width_pct=0.005)
    usd = [83_910, 79_798, 75_658, 51_243, 45_076]
    rows = _tiered([{"lo": 1.0 + i, "hi": 2.0 + i, "side": "long", "liq_usd": u, "liq_m": u / 1e6, "dist_pct": -1} for i, u in enumerate(usd)], t)
    apply_relative_tier_floor(rows)
    assert [r["risk"] for r in rows] == ["中", "中", "中", "低", "低"]
    # Same alt with 4× smaller OI: absolute → nothing; floor → its top bins still show + merge.
    tiny = _tiered([dict(r, liq_usd=r["liq_usd"] / 4) for r in rows], t)
    assert all(r["risk"] == "低" for r in tiny)
    assert apply_relative_tier_floor(tiny) == ["long"]
    assert [r["risk"] for r in tiny] == ["高", "高", "高", "中", "中"]  # ratios 1, .95, .90, .61, .54 of peak
    assert len(build_bands(tiny)) == 5
    zones = merge_zones(tiny, 10.0, bucket_width_pct=0.1)
    assert [(z["risk_max"], z["bucket_count"]) for z in zones] == [("高", 3), ("中", 2)]


def test_refresh_applies_relative_floor_after_absolute_tiers():
    src = (Path(__file__).resolve().parents[1] / "refresh_liq.py").read_text(encoding="utf-8")
    i, j = src.index("apply_h2_tiers(bucket_rows, thresholds)"), src.index("apply_relative_tier_floor(bucket_rows)")
    assert i < j < src.index("build_sample_payload(\n")
    assert '"relative_floor_sides": tier_fallback' in src
