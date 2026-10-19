"""H2 Dongyi-replica liquidation estimator (TH-FEAT-19).

Algorithm (validated OOS against Youtube东一 Model2 | 7d screenshots):
  - Take each venue's *current one-sided* open interest (Bybit: singleOpenInterest
    or openInterest/2). Sum across Binance + OKX + Bybit when available.
  - Distribute that total OI over the last ``lookback_days`` of 1h entries,
    weighted by each bar's quote volume.
  - Apply leverage mix 10/25/50/100x @ 0.30/0.30/0.25/0.15, 50/50 long/short,
    with 0.5% maintenance margin:
        long  liq = entry * (1 - 1/L + mm)
        short liq = entry * (1 + 1/L - mm)
  - Drop a level once the post-entry high/low path (through mark) has crossed it
    (TH-BUG-05). Longs only below mark (support/green); shorts only above
    (resistance/red).
  - Risk tiers: fixed-dollar on BTC (极高 ≥ $100M, 高 ≥ $70M, 中 ≥ $15M, else 低).
    For other symbols, scale those cutoffs by symbol_OI / btc_OI at the same time.
    The dollar floors are per *Dongyi BTC bin* (~0.19% of price); a wider bucket
    (live chart: 0.5%) sums more bins, so the floors scale by bucket / 0.19%
    (TH-BUG-06; see ``scale_tier_thresholds``).

OKX OI history is only ~2.5–6 days of 5m samples; H2 uses *current* OI only, so
OKX is included whenever its ticker OI is available. Replay uses the last OI
sample at or before the cutoff.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

# --- frozen H2 constants (do not retune without a new OOS campaign) ---
H2_LEVERAGE_MIX: tuple[tuple[float, float], ...] = (
    (10.0, 0.30),
    (25.0, 0.30),
    (50.0, 0.25),
    (100.0, 0.15),
)
H2_MAINT_MARGIN = 0.005
H2_LOOKBACK_DAYS = 7.0
H2_LONG_SHARE = 0.5

# BTC fixed-dollar tier floors (USD notional per bin).
BTC_TIER_EXTREME_USD = 100_000_000.0
BTC_TIER_HIGH_USD = 70_000_000.0
BTC_TIER_MEDIUM_USD = 15_000_000.0
# Bin width (fraction of price) the floors were calibrated on: Dongyi BTC rows are
# ~$157 apart at ~$82k (OOS s1020) ≈ 0.19%. TH-BUG-06.
DONGYI_REF_BIN_WIDTH_PCT = 0.0019
# TH-FEAT-20: live + replay buckets use the Dongyi bin, so cutoffs are the BTC floors as-is.
LIVE_BUCKET_WIDTH_PCT = DONGYI_REF_BIN_WIDTH_PCT
_BUCKET_FACTOR_MIN = 0.05
_BUCKET_FACTOR_MAX = 50.0


@dataclass(frozen=True)
class Bar1h:
    """One 1h OHLCV bar. ``quote_vol`` is quote-asset volume (USDT)."""

    ts_ms: int  # open time
    open: float
    high: float
    low: float
    close: float
    quote_vol: float


@dataclass(frozen=True)
class TierThresholds:
    extreme_usd: float
    high_usd: float
    medium_usd: float

    def risk(self, notional_usd: float) -> str:
        if notional_usd >= self.extreme_usd:
            return "极高"
        if notional_usd >= self.high_usd:
            return "高"
        if notional_usd >= self.medium_usd:
            return "中"
        return "低"


def _bucket_factor(bucket_width_pct: float | None) -> float:
    """bucket / Dongyi reference bin, clamped. Missing or non-finite/non-positive → 1 (reference)."""
    if bucket_width_pct is None:
        return 1.0
    try:
        w = float(bucket_width_pct)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(w) or w <= 0:
        return 1.0
    return max(_BUCKET_FACTOR_MIN, min(_BUCKET_FACTOR_MAX, w / DONGYI_REF_BIN_WIDTH_PCT))


def scale_tier_thresholds(
    symbol_oi_usd: float,
    btc_oi_usd: float,
    *,
    bucket_width_pct: float | None = None,
    extreme: float = BTC_TIER_EXTREME_USD,
    high: float = BTC_TIER_HIGH_USD,
    medium: float = BTC_TIER_MEDIUM_USD,
) -> TierThresholds:
    """Scale BTC fixed-dollar tiers by symbol_OI / btc_OI and by bucket width.

    OI share: when ``btc_oi_usd`` is missing or non-positive, or the symbol is
    BTC-scale (ratio ≈ 1), the OI factor is 1. It is clamped to [1e-4, 1e2] so a
    tiny alt cannot drive thresholds to zero and a mis-read BTC OI cannot explode
    them.

    Bucket width (fraction of price, e.g. 0.005 for the live 0.5% bucket): the
    floors are per Dongyi ~0.19% bin, so they scale by
    ``bucket_width_pct / DONGYI_REF_BIN_WIDTH_PCT`` (clamped to [0.05, 50]).
    ``None`` or an invalid width means the reference bin (factor 1), which keeps
    the golden OOS tier contract. The 高/极高 ratio is unchanged.
    """
    f = _bucket_factor(bucket_width_pct)
    ratio = 1.0
    if btc_oi_usd and btc_oi_usd > 0 and symbol_oi_usd and symbol_oi_usd > 0:
        r = symbol_oi_usd / btc_oi_usd
        if abs(r - 1.0) >= 0.05:  # else treat as BTC
            ratio = max(1e-4, min(1e2, r))
    k = ratio * f
    return TierThresholds(extreme * k, high * k, medium * k)


def matched_oi_totals(
    symbol_oi_by_venue: dict | None,
    btc_oi_by_venue: dict | None,
) -> tuple[float, float | None]:
    """Symbol and BTC current OI summed over the venues that report a positive finite OI for *both*.

    The OI share in ``scale_tier_thresholds`` must compare like with like (TH-BUG-06b): a 3-venue alt
    total against a Binance-only BTC OI can land near 1.0 and snap the alt to BTC floors. Returns
    ``(symbol_total_all_venues, None)`` when there is no overlap, which keeps the BTC floors.
    """
    def ok(v) -> bool:
        try:
            return v is not None and math.isfinite(float(v)) and float(v) > 0
        except (TypeError, ValueError):
            return False

    sym = {k: float(v) for k, v in (symbol_oi_by_venue or {}).items() if ok(v)}
    btc = {k: float(v) for k, v in (btc_oi_by_venue or {}).items() if ok(v)}
    shared = sorted(set(sym) & set(btc))
    if not shared:
        return sum(sym.values()), None
    return sum(sym[k] for k in shared), sum(btc[k] for k in shared)


def long_liq_price(entry: float, lev: float, mm: float = H2_MAINT_MARGIN) -> float:
    return entry * (1.0 - 1.0 / lev + mm)


def short_liq_price(entry: float, lev: float, mm: float = H2_MAINT_MARGIN) -> float:
    return entry * (1.0 + 1.0 / lev - mm)


@dataclass
class H2Hit:
    price: float
    notional_usd: float
    side: str  # "long" | "short"
    leverage: float
    entry: float
    source_ts: int


def h2_distribute(
    total_oi_usd: float,
    bars: Sequence[Bar1h],
    mark: float,
    *,
    leverage_mix: Sequence[tuple[float, float]] = H2_LEVERAGE_MIX,
    mm: float = H2_MAINT_MARGIN,
    long_share: float = H2_LONG_SHARE,
    drop_crossed: bool = True,
) -> list[H2Hit]:
    """Distribute ``total_oi_usd`` over volume-weighted 1h entries; emit surviving hits.

    ``bars`` must be the lookback window ending at (or just before) the as-of
    time, sorted ascending. Path high/low for drop-crossed is the running
    max/min of bar highs/lows from the entry bar through the last bar, also
    including ``mark``.
    """
    if total_oi_usd <= 0 or mark <= 0 or not bars:
        return []
    mix = [(L, w) for L, w in leverage_mix if L > 1 and w > 0]
    wsum = sum(w for _, w in mix) or 1.0
    mix = [(L, w / wsum) for L, w in mix]
    long_share = min(0.95, max(0.05, long_share))
    short_share = 1.0 - long_share

    vols = [max(0.0, float(b.quote_vol)) for b in bars]
    vsum = sum(vols)
    if vsum <= 0:
        # Flat volume: fall back to uniform weights.
        vols = [1.0] * len(bars)
        vsum = float(len(bars))

    # Suffix min/max of path after bar i (inclusive of later bars).
    n = len(bars)
    suf_min = [float("inf")] * (n + 1)
    suf_max = [float("-inf")] * (n + 1)
    for i in range(n - 1, -1, -1):
        suf_min[i] = min(suf_min[i + 1], bars[i].low)
        suf_max[i] = max(suf_max[i + 1], bars[i].high)

    hits: list[H2Hit] = []
    for i, b in enumerate(bars):
        weight = vols[i] / vsum
        entry_oi = total_oi_usd * weight
        if entry_oi <= 0 or b.close <= 0:
            continue
        path_min = min(suf_min[i + 1], mark)  # path strictly after this bar
        path_max = max(suf_max[i + 1], mark)
        entry = b.close
        for L, w in mix:
            for side, share in (("long", long_share), ("short", short_share)):
                ntl = entry_oi * share * w
                if ntl <= 0:
                    continue
                if side == "long":
                    lp = long_liq_price(entry, L, mm)
                    if drop_crossed and path_min <= lp:
                        continue
                    if lp >= mark:
                        continue  # long support must sit strictly below mark
                    hits.append(H2Hit(lp, ntl, "long", L, entry, b.ts_ms))
                else:
                    sp = short_liq_price(entry, L, mm)
                    if drop_crossed and path_max >= sp:
                        continue
                    if sp <= mark:
                        continue  # short resistance must sit strictly above mark
                    hits.append(H2Hit(sp, ntl, "short", L, entry, b.ts_ms))
    return hits


def aggregate_h2_buckets(
    hits: Iterable[H2Hit],
    mark: float,
    bucket_width_pct: float = LIVE_BUCKET_WIDTH_PCT,
    *,
    range_pct: float = 12.0,
) -> list[dict]:
    """Bucket H2 hits into mid-relative bins (dominant side per bin)."""
    if mark <= 0 or bucket_width_pct <= 0:
        return []
    width = mark * bucket_width_pct
    buckets: dict[int, dict] = {}
    for h in hits:
        if h.notional_usd <= 0:
            continue
        if abs(h.price / mark - 1.0) * 100.0 > range_pct:
            continue
        idx = int((h.price - mark) // width)  # floor toward -inf
        # Enforce side-of-mark: long bins fully below, short fully above.
        lo = mark + idx * width
        hi = lo + width
        # Strict side-of-mark (TH-BUG-05): long fully below, short fully above.
        if h.side == "long" and hi >= mark:
            continue
        if h.side == "short" and lo <= mark:
            continue
        b = buckets.get(idx)
        if b is None:
            b = {"idx": idx, "lo": lo, "hi": hi, "long_usd": 0.0, "short_usd": 0.0}
            buckets[idx] = b
        if h.side == "long":
            b["long_usd"] += h.notional_usd
        else:
            b["short_usd"] += h.notional_usd

    rows: list[dict] = []
    for b in sorted(buckets.values(), key=lambda x: x["lo"]):
        if b["long_usd"] >= b["short_usd"]:
            side, usd = "long", b["long_usd"]
        else:
            side, usd = "short", b["short_usd"]
        if usd <= 0:
            continue
        # Re-check side vs mark after dominant-side pick.
        if side == "long" and b["hi"] >= mark:
            continue
        if side == "short" and b["lo"] <= mark:
            continue
        dist_pct = ((b["lo"] + b["hi"]) / 2.0 - mark) / mark * 100.0
        rows.append(
            {
                "lo": b["lo"],
                "hi": b["hi"],
                "price": (b["lo"] + b["hi"]) / 2.0,
                "side": side,
                "side_cn": "做多清算 ↓" if side == "long" else "做空清算 ↑",
                "liq_usd": usd,
                "liq_m": usd / 1e6,
                "long_m": b["long_usd"] / 1e6,
                "short_m": b["short_usd"] / 1e6,
                "dist_pct": dist_pct,
                "risk": "低",
            }
        )
    return rows


def apply_h2_tiers(
    rows: list[dict],
    thresholds: TierThresholds,
) -> list[dict]:
    """Stamp fixed-dollar (possibly scaled) risk tiers onto bucket rows."""
    for r in rows:
        r["risk"] = thresholds.risk(float(r.get("liq_usd") or float(r.get("liq_m", 0)) * 1e6))
    return rows


# TH-FEAT-20b: relative tier floor. Absolute (OI-scaled) cutoffs can leave a small-OI alt with zero
# tiered bins, so the chart shows nothing ("no reaction"). Only on a side where NO bin reached 中,
# re-tier that side relative to its own max bin: >= 0.8×max → 高, >= 0.5×max → 中. The floor never
# produces 极高 and never touches a side that already has a 中+ bin. Marked tier_basis="relative".
REL_FLOOR_HIGH = 0.8
REL_FLOOR_MEDIUM = 0.5
_TIERED = frozenset({"中", "高", "极高"})


def apply_relative_tier_floor(rows: list[dict]) -> list[str]:
    """Apply the relative floor in place; return the sides it was applied to (sorted)."""
    used: list[str] = []
    for side in ("long", "short"):
        side_rows = []
        for r in rows:
            if r.get("side") != side:
                continue
            try:
                usd = float(r.get("liq_usd") or 0.0)
            except (TypeError, ValueError):
                continue
            if math.isfinite(usd) and usd > 0:
                side_rows.append((r, usd))
        if not side_rows or any(r.get("risk") in _TIERED for r, _ in side_rows):
            continue
        peak = max(usd for _, usd in side_rows)
        for r, usd in side_rows:
            if usd >= REL_FLOOR_HIGH * peak:
                r["risk"], r["tier_basis"] = "高", "relative"
            elif usd >= REL_FLOOR_MEDIUM * peak:
                r["risk"], r["tier_basis"] = "中", "relative"
        used.append(side)
    return used
