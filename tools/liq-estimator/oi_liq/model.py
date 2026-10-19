"""Path-based Model2-ish liquidation cluster estimator.

Core idea
---------
When open interest rises (ΔOI_usd > 0), attribute the increase to new positions
opened near that bar's mark price. Place long/short liquidation prices by a
configurable leverage mix; accumulate notional into price buckets.

When OI falls (ΔOI_usd < 0), proportionally decay all existing cluster notionals
so total attributed mass tracks current OI roughly.

This is NOT order-book intensity (janzm). Numbers will not match CoinGlass.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional

from .fetch import FetchResult, OIPoint


import math as _math


def price_decimals(mid: float) -> int:
    """Price decimals adapted to scale: ZEC ~1385 -> 2, PYTH ~0.079 -> 6, BTC -> 2."""
    if not mid or mid <= 0:
        return 2
    return int(min(10, max(2, 4 - _math.floor(_math.log10(mid)))))


def m_decimals(mid: float) -> int:
    return 2 if mid and mid >= 1 else 4


def min_detail_m(mid: float) -> float:
    return 0.05 if mid and mid >= 1 else 0.002


def min_bucket_m(mid: float) -> float:
    return 0.1 if mid and mid >= 1 else 0.005

# Default notional-weighted leverage mix (configurable).
# Note: OKX ZEC max listed leverage is 50x; 100x/125x are kept to approximate
# multi-exchange desks that allow higher leverage (Binance etc.).
DEFAULT_LEVERAGE_MIX: list[tuple[float, float]] = [
    (5.0, 0.10),
    (10.0, 0.25),
    (25.0, 0.30),
    (50.0, 0.20),
    (100.0, 0.10),
    (125.0, 0.05),
]

# Per-exchange max leverage caps (listed ZEC USDT perp as of 2026-09).
# Weights of dropped tiers are redistributed proportionally.
_OKX_MIX: list[tuple[float, float]] = [
    (5.0, 0.12),
    (10.0, 0.30),
    (25.0, 0.35),
    (50.0, 0.23),
]
_BINANCE_MIX: list[tuple[float, float]] = [
    (5.0, 0.10),
    (10.0, 0.22),
    (25.0, 0.28),
    (50.0, 0.20),
    (100.0, 0.12),
    (125.0, 0.08),
]
_BYBIT_MIX: list[tuple[float, float]] = [
    (5.0, 0.10),
    (10.0, 0.25),
    (25.0, 0.30),
    (50.0, 0.22),
    (100.0, 0.13),
]
_BITGET_MIX: list[tuple[float, float]] = [
    (5.0, 0.10),
    (10.0, 0.25),
    (25.0, 0.30),
    (50.0, 0.22),
    (75.0, 0.13),
]
_GATE_MIX: list[tuple[float, float]] = [
    (5.0, 0.12),
    (10.0, 0.28),
    (25.0, 0.35),
    (50.0, 0.25),
]
_HTX_MIX: list[tuple[float, float]] = [
    (5.0, 0.15),
    (10.0, 0.30),
    (25.0, 0.35),
    (50.0, 0.20),
]
_KUCOIN_MIX: list[tuple[float, float]] = [
    (5.0, 0.12),
    (10.0, 0.28),
    (25.0, 0.35),
    (50.0, 0.25),
]
_BINGX_MIX: list[tuple[float, float]] = [
    (5.0, 0.10),
    (10.0, 0.25),
    (25.0, 0.30),
    (50.0, 0.20),
    (100.0, 0.15),
]
_DYDX_MIX: list[tuple[float, float]] = [
    (5.0, 0.25),
    (10.0, 0.40),
    (20.0, 0.35),
]
_HYPERLIQUID_MIX: list[tuple[float, float]] = [
    (3.0, 0.15),
    (5.0, 0.35),
    (10.0, 0.50),  # HL ZEC maxLeverage=10
]
EXCHANGE_LEVERAGE_MIX: dict[str, list[tuple[float, float]]] = {
    "okx": _OKX_MIX,
    "binance": _BINANCE_MIX,
    "bybit": _BYBIT_MIX,
    "bitget": _BITGET_MIX,
    "gate": _GATE_MIX,
    "htx": _HTX_MIX,
    "kucoin": _KUCOIN_MIX,
    "bingx": _BINGX_MIX,
    "dydx": _DYDX_MIX,
    "hyperliquid": _HYPERLIQUID_MIX,
}


def mix_for_exchange(exchange: str) -> list[tuple[float, float]]:
    """Return leverage mix capped to exchange listing; fallback to default."""
    key = (exchange or "").split("+")[0].lower()
    return list(EXCHANGE_LEVERAGE_MIX.get(key, DEFAULT_LEVERAGE_MIX))


@dataclass
class ClusterHit:
    price: float
    notional_usd: float
    side: str  # "long" | "short"  — side of the *position* that gets liquidated
    leverage: float
    entry: float
    source_ts: int


@dataclass
class BucketRow:
    price: float  # bucket center or lower edge label
    lo: float
    hi: float
    long_usd: float = 0.0
    short_usd: float = 0.0

    @property
    def total_usd(self) -> float:
        return self.long_usd + self.short_usd

    @property
    def total_m(self) -> float:
        return self.total_usd / 1e6

    @property
    def dominant_side(self) -> str:
        if self.long_usd >= self.short_usd:
            return "long"
        return "short"

    @property
    def dominant_usd(self) -> float:
        return max(self.long_usd, self.short_usd)


@dataclass
class EstimateResult:
    mid: float
    exchange: str
    mode: str
    current_oi_usd: float
    total_attributed_usd: float
    long_attributed_usd: float
    short_attributed_usd: float
    detail_rows: list[dict] = field(default_factory=list)
    buckets: list[dict] = field(default_factory=list)

    hits: list[ClusterHit] = field(default_factory=list)
    assumptions: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


def _liq_price(entry: float, leverage: float, side: str) -> float:
    """Isolated-margin approx ignoring fees/maintenance margin.

    long  liq ≈ entry * (1 - 1/L)
    short liq ≈ entry * (1 + 1/L)
    """
    if leverage <= 1:
        raise ValueError("leverage must be > 1")
    if side == "long":
        return entry * (1.0 - 1.0 / leverage)
    if side == "short":
        return entry * (1.0 + 1.0 / leverage)
    raise ValueError(side)


# Detail-table risk is volume-only.  Distance is intentionally ignored.
# Exact cutoffs: after sorting positive-liq_m rows descending, ranks
# 1..ceil(0.10*N) are 极高, the next 10% are 高, the next 30% are 中,
# and the remaining 50% are 低 (rank 1 is the largest volume).
DETAIL_RISK_EXTREME_FRACTION = 0.10
DETAIL_RISK_HIGH_FRACTION = 0.20
DETAIL_RISK_MEDIUM_FRACTION = 0.50


def _risk_tier(
    distance_pct: float,
    notional_m: float,
    *,
    rank: int,
    population_size: int,
) -> str:
    """Return a volume-percentile tier; ``distance_pct`` is ignored."""
    del distance_pct
    if float(notional_m) <= 0 or population_size <= 0 or rank <= 0:
        return "低"
    import math

    extreme_cutoff = math.ceil(DETAIL_RISK_EXTREME_FRACTION * population_size)
    high_cutoff = math.ceil(DETAIL_RISK_HIGH_FRACTION * population_size)
    medium_cutoff = math.ceil(DETAIL_RISK_MEDIUM_FRACTION * population_size)
    if rank <= extreme_cutoff:
        return "极高"
    if rank <= high_cutoff:
        return "高"
    if rank <= medium_cutoff:
        return "中"
    return "低"


def _apply_detail_risk_tiers(rows: list[dict]) -> list[dict]:
    """Apply volume-only tiers to the rows in the displayed detail table."""
    ranked = sorted(
        (r for r in rows if float(r.get("liq_m", 0.0)) > 0),
        key=lambda r: (-float(r["liq_m"]), float(r.get("price", 0.0))),
    )
    n = len(ranked)
    rank_by_id = {id(row): rank for rank, row in enumerate(ranked, start=1)}
    for row in rows:
        rank = rank_by_id.get(id(row))
        row["risk"] = _risk_tier(
            float(row.get("dist_pct", 0.0)),
            float(row.get("liq_m", 0.0)),
            rank=rank or 0,
            population_size=n,
        )
    return rows


def _apply_volume_risk_tiers(rows: list[dict]) -> list[dict]:
    """Apply volume-only 10/10/30/50 percentile tiers."""
    ranked = sorted((r for r in rows if float(r.get("liq_m", 0.0)) > 0), key=lambda r: (-float(r["liq_m"]), float(r.get("price", 0.0))))
    n = len(ranked)
    rank_by_id = {id(row): rank for rank, row in enumerate(ranked, start=1)}
    for row in rows:
        row["risk"] = _risk_tier(float(row.get("dist_pct", 0.0)), float(row.get("liq_m", 0.0)), rank=rank_by_id.get(id(row), 0), population_size=n)
    return rows


def path_accumulate(
    points: list[OIPoint],
    leverage_mix: list[tuple[float, float]] = None,
    default_long_share: float = 0.5,
    decay_on_decrease: bool = True,
) -> list[ClusterHit]:
    """Walk OI path; emit liquidation hits for OI increases; decay on decreases.

    Seeds the first bar's full OI at that bar's mark (pre-window open interest
    still has liquidation levels). Without seeding, a flat OI path would leave
    near-zero attributed mass even though current OI is large.
    """
    mix = leverage_mix or DEFAULT_LEVERAGE_MIX
    wsum = sum(w for _, w in mix)
    mix = [(L, w / wsum) for L, w in mix]

    hits: list[ClusterHit] = []
    notionals: list[float] = []

    def _add(entry: float, oi_delta: float, long_share: float, ts: int) -> None:
        long_share = min(0.95, max(0.05, long_share))
        short_share = 1.0 - long_share
        if oi_delta <= 0 or entry is None or entry <= 0:
            return
        for L, w in mix:
            for side, share in (("long", long_share), ("short", short_share)):
                n = oi_delta * share * w
                if n <= 0:
                    continue
                lp = _liq_price(entry, L, side)
                hits.append(
                    ClusterHit(
                        price=lp,
                        notional_usd=n,
                        side=side,
                        leverage=L,
                        entry=entry,
                        source_ts=ts,
                    )
                )
                notionals.append(n)

    def _decay(remove_usd: float) -> None:
        if not decay_on_decrease or not notionals or remove_usd <= 0:
            return
        total = sum(notionals)
        if total <= 0:
            return
        factor = max(0.0, 1.0 - min(remove_usd, total) / total)
        for i in range(len(notionals)):
            notionals[i] *= factor
            hits[i].notional_usd = notionals[i]

    prev_oi: Optional[float] = None
    for p in points:
        if p.price is None or p.price <= 0 or p.oi_usd is None:
            continue
        ls = p.long_share if p.long_share is not None else default_long_share
        if prev_oi is None:
            # Seed: entire OI at first observed bar exists as open positions
            _add(p.price, p.oi_usd, ls, p.ts_ms)
            prev_oi = p.oi_usd
            continue
        delta = p.oi_usd - prev_oi
        prev_oi = p.oi_usd
        if delta > 0:
            _add(p.price, delta, ls, p.ts_ms)
        elif delta < 0:
            _decay(-delta)

    # TH-BUG-05: a position whose liquidation price the later price path already reached is gone.
    # Without this, longs opened higher keep a "long" liq level ABOVE the current price (and shorts below).
    import bisect as _bisect
    path = sorted((p.ts_ms, p.price) for p in points if p.price is not None and p.price > 0 and p.ts_ms is not None)
    if path:
        ts_list = [t for t, _ in path]
        suf_min = [0.0] * (len(path) + 1)
        suf_max = [0.0] * (len(path) + 1)
        suf_min[len(path)] = float("inf")
        suf_max[len(path)] = float("-inf")
        for i in range(len(path) - 1, -1, -1):
            suf_min[i] = min(path[i][1], suf_min[i + 1])
            suf_max[i] = max(path[i][1], suf_max[i + 1])
        last_px = path[-1][1]
        for h in hits:
            j = _bisect.bisect_right(ts_list, h.source_ts)
            lo_after = min(suf_min[j], last_px)
            hi_after = max(suf_max[j], last_px)
            if (h.side == "long" and lo_after <= h.price) or (h.side == "short" and hi_after >= h.price):
                h.notional_usd = 0.0

    return [h for h in hits if h.notional_usd >= 1.0]



def snapshot_distribute(
    oi_usd: float,
    mid: float,
    leverage_mix: list[tuple[float, float]] = None,
    long_share: float = 0.5,
) -> list[ClusterHit]:
    """Weaker mode: dump current OI across leverage mix at distances from mid."""
    mix = leverage_mix or DEFAULT_LEVERAGE_MIX
    wsum = sum(w for _, w in mix)
    mix = [(L, w / wsum) for L, w in mix]
    long_share = min(0.95, max(0.05, long_share))
    short_share = 1.0 - long_share
    hits: list[ClusterHit] = []
    for L, w in mix:
        for side, share in (("long", long_share), ("short", short_share)):
            n = oi_usd * share * w
            lp = _liq_price(mid, L, side)
            hits.append(
                ClusterHit(
                    price=lp,
                    notional_usd=n,
                    side=side,
                    leverage=L,
                    entry=mid,
                    source_ts=0,
                )
            )
    return hits


def _bucket_key(price: float, width: float, mid: float) -> tuple[float, float, float]:
    """Return a mid-anchored (lo, hi, center) bucket."""
    import math

    if width <= 0:
        raise ValueError("bucket width must be positive")
    lo = mid + math.floor((price - mid) / width) * width
    hi = lo + width
    return lo, hi, lo + width / 2.0


def aggregate_buckets(
    hits: Iterable[ClusterHit],
    width: float,
    mid: float,
    dead_zone_pct: float = 0.003,
) -> list[BucketRow]:
    """Accumulate hits into price buckets; optionally zero near-mid dead zone."""
    buckets: dict[float, BucketRow] = {}
    for h in hits:
        if h.notional_usd <= 0:
            continue
        # Dead zone: skip placement very near mid (UI parity choice)
        if mid > 0 and abs(h.price - mid) / mid < dead_zone_pct:
            continue
        lo, hi, center = _bucket_key(h.price, width, mid)
        if lo not in buckets:
            buckets[lo] = BucketRow(price=center, lo=lo, hi=hi)
        b = buckets[lo]
        if h.side == "long":
            b.long_usd += h.notional_usd
        else:
            b.short_usd += h.notional_usd
    return sorted(buckets.values(), key=lambda b: b.lo)


def rows_from_buckets(
    buckets: list[BucketRow],
    mid: float,
    min_m: float = 0.01,
    sort_by: str = "price",
) -> list[dict]:
    """Build display rows (one dominant-side row per bucket, screenshot-like)."""
    nonzero = [b for b in buckets if b.total_m >= min_m]
    if not nonzero:
        return []
    rows = []
    for b in nonzero:
        side = b.dominant_side
        usd = b.long_usd if side == "long" else b.short_usd
        # Also expose both sides if both significant
        dist = b.price - mid
        dist_pct = (dist / mid) * 100.0 if mid else 0.0
        m = usd / 1e6
        rows.append(
            {
                "price": round(b.price, price_decimals(mid)),
                "lo": b.lo,
                "hi": b.hi,
                "liq_usd": round(usd, 2),
                "liq_m": round(m, m_decimals(mid)),
                "long_m": round(b.long_usd / 1e6, m_decimals(mid)),
                "short_m": round(b.short_usd / 1e6, m_decimals(mid)),
                "side": side,
                "side_cn": "做多清算 ↓" if side == "long" else "做空清算 ↑",
                "dist": round(dist, price_decimals(mid)),
                "dist_pct": round(dist_pct, 2),
                "risk": "低",
                "trigger": "极高" if m >= 20 and abs(dist_pct) <= 15 else ("高" if m >= 5 else "中"),
            }
        )
    if sort_by == "notional":
        rows.sort(key=lambda r: r["liq_m"], reverse=True)
    else:
        rows.sort(key=lambda r: r["price"], reverse=True)
    _apply_volume_risk_tiers(rows)
    return rows


def estimate_from_fetch(
    fr: FetchResult,
    detail_width: float = 5.0,
    bucket_width: float | None = None,
    dead_zone_pct: float = 0.003,
    bucket_width_pct: float = 0.005,
    leverage_mix: list[tuple[float, float]] = None,
    force_snapshot: bool = False,
) -> EstimateResult:
    """Run model on a single exchange FetchResult."""
    if not fr.ok or fr.mid is None:
        raise ValueError(f"fetch not ok: {fr.exchange} {fr.error}")

    mid = fr.mid
    if bucket_width is None:
        if bucket_width_pct <= 0:
            raise ValueError("bucket_width_pct must be positive")
        bucket_width = mid * bucket_width_pct
    oi = fr.current_oi_usd or (fr.points[-1].oi_usd if fr.points else 0.0)
    notes = list(fr.notes)
    mix = leverage_mix or mix_for_exchange(fr.exchange)

    use_path = (not force_snapshot) and fr.mode == "path" and len(fr.points) >= 3
    if use_path:
        hits = path_accumulate(fr.points, leverage_mix=mix)
        mode = "path"
        notes.append(f"path-based on {len(fr.points)} OI bars")
    else:
        ls = 0.5
        if fr.points and fr.points[-1].long_share is not None:
            ls = fr.points[-1].long_share
        hits = snapshot_distribute(oi, mid, leverage_mix=mix, long_share=ls)
        mode = "snapshot"
        notes.append("snapshot mode: distributed current OI across leverage mix from mid")

    # TH-BUG-05 invariant: long liquidations sit below mid, short liquidations above.
    hits = [h for h in hits if (h.side == "long" and h.price < mid) or (h.side == "short" and h.price > mid)]
    long_usd = sum(h.notional_usd for h in hits if h.side == "long")
    short_usd = sum(h.notional_usd for h in hits if h.side == "short")
    total = long_usd + short_usd

    detail_b = aggregate_buckets(hits, detail_width, mid, dead_zone_pct=dead_zone_pct)
    buckets = aggregate_buckets(hits, bucket_width, mid, dead_zone_pct=dead_zone_pct)

    detail_rows = rows_from_buckets(detail_b, mid, min_m=min_detail_m(mid), sort_by="price")
    _apply_detail_risk_tiers(detail_rows)
    # Percentage bucket summary, anchored at mid and sorted by total notional.
    bucket_fixed = []
    bucket_pct_label = bucket_width_pct * 100.0
    for b in sorted([x for x in buckets if x.total_m >= min_bucket_m(mid)], key=lambda x: x.total_usd, reverse=True):
        side = b.dominant_side
        dist = (b.price - mid) / mid * 100.0 if mid else 0.0
        m = b.total_m
        bucket_fixed.append(
            {
                "range": f"${b.lo:.{max(0, price_decimals(mid) - 2)}f}-${b.hi:.{max(0, price_decimals(mid) - 2)}f} ({bucket_pct_label:g}%)",
                "lo": b.lo,
                "hi": b.hi,
                "price": round(b.price, price_decimals(mid)),
                "side": side,
                "side_cn": "做多清算" if side == "long" else "做空清算",
                "liq_m": round(m, m_decimals(mid)),
                "liq_usd": round(b.total_usd, 2),
                "long_m": round(b.long_usd / 1e6, m_decimals(mid)),
                "short_m": round(b.short_usd / 1e6, m_decimals(mid)),
                "dist_pct": round(dist, price_decimals(mid)),
                "trigger": "极高" if m >= 10 else ("高" if m >= 3 else "中"),
                "risk": "低",
            }
        )

    _apply_volume_risk_tiers(bucket_fixed)

    return EstimateResult(
        mid=mid,
        exchange=fr.exchange,
        mode=mode,
        current_oi_usd=oi,
        total_attributed_usd=total,
        long_attributed_usd=long_usd,
        short_attributed_usd=short_usd,
        detail_rows=detail_rows,
        buckets=bucket_fixed,
        hits=hits,
        assumptions={
            "leverage_mix": [{"leverage": L, "weight": w} for L, w in mix],
            "liq_formula_long": "entry * (1 - 1/L)",
            "liq_formula_short": "entry * (1 + 1/L)",
            "dead_zone_pct": dead_zone_pct,
            "detail_width": detail_width,
            "bucket_width": bucket_width,
            "bucket_width_usd": bucket_width,
            "bucket_width_pct": bucket_width_pct,
            "decay_on_oi_decrease": True if mode == "path" else False,
            "mmr_fees_ignored": True,
            "ls_source": fr.raw.get("ls_source", "unknown"),
            "risk_formula": "detail and percentage bucket rows: volume-only percentile; top ceil(10%N)=极高, next through ceil(20%N)=高, next through ceil(50%N)=中, remainder=低; distance ignored",
        },
        notes=notes,
    )


def merge_estimates(results: list[EstimateResult], mid: float, detail_width: float = 5.0, bucket_width_pct: float = 0.005) -> EstimateResult:
    """Sum hits across exchanges (simple multi-exchange aggregate)."""
    all_hits: list[ClusterHit] = []
    notes = ["merged exchanges: " + ",".join(r.exchange for r in results)]
    oi = 0.0
    for r in results:
        all_hits.extend(r.hits)
        oi += r.current_oi_usd
        notes.extend(f"[{r.exchange}] {n}" for n in r.notes)

    long_usd = sum(h.notional_usd for h in all_hits if h.side == "long")
    short_usd = sum(h.notional_usd for h in all_hits if h.side == "short")
    bucket_width = mid * bucket_width_pct
    detail_b = aggregate_buckets(all_hits, detail_width, mid)
    buckets = aggregate_buckets(all_hits, bucket_width, mid)
    detail_rows = rows_from_buckets(detail_b, mid, min_m=min_detail_m(mid), sort_by="price")
    _apply_detail_risk_tiers(detail_rows)
    bucket_fixed = []
    bucket_pct_label = bucket_width_pct * 100.0
    for b in sorted([x for x in buckets if x.total_m >= min_bucket_m(mid)], key=lambda x: x.total_usd, reverse=True):
        side = b.dominant_side
        dist = (b.price - mid) / mid * 100.0 if mid else 0.0
        m = b.total_m
        bucket_fixed.append(
            {
                "range": f"${b.lo:.{max(0, price_decimals(mid) - 2)}f}-${b.hi:.{max(0, price_decimals(mid) - 2)}f} ({bucket_pct_label:g}%)",
                "lo": b.lo,
                "hi": b.hi,
                "price": round(b.price, price_decimals(mid)),
                "side": side,
                "side_cn": "做多清算" if side == "long" else "做空清算",
                "liq_m": round(m, m_decimals(mid)),
                "liq_usd": round(b.total_usd, 2),
                "long_m": round(b.long_usd / 1e6, m_decimals(mid)),
                "short_m": round(b.short_usd / 1e6, m_decimals(mid)),
                "dist_pct": round(dist, price_decimals(mid)),
                "trigger": "极高" if m >= 10 else ("高" if m >= 3 else "中"),
                "risk": "低",
            }
        )
    _apply_volume_risk_tiers(bucket_fixed)
    return EstimateResult(
        mid=mid,
        exchange="+".join(r.exchange for r in results) if results else "none",
        mode="merged",
        current_oi_usd=oi,
        total_attributed_usd=long_usd + short_usd,
        long_attributed_usd=long_usd,
        short_attributed_usd=short_usd,
        detail_rows=detail_rows,
        buckets=bucket_fixed,
        hits=all_hits,
        assumptions={**(results[0].assumptions if results else {}), "detail_width": detail_width, "bucket_width": bucket_width, "bucket_width_usd": bucket_width, "bucket_width_pct": bucket_width_pct, "risk_formula": "detail and percentage bucket rows: volume-only percentile; top ceil(10%N)=极高, next through ceil(20%N)=高, next through ceil(50%N)=中, remainder=低; distance ignored"},
        notes=notes,
    )
