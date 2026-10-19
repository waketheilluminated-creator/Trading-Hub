"""Merge adjacent 高/极高 liquidation buckets into TradingHub box zones."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/Toronto")

RISK_RANK = {"低": 0, "中": 1, "高": 2, "极高": 3}
ZONE_RISKS = frozenset({"高", "极高"})

ZONE_RULE = (
    "H2 (TH-FEAT-19): merge runs of >=2 price-adjacent 0.5%-of-mid buckets with "
    "risk 高 or 极高, same side of markPrice, same liquidation side (long|short). "
    "Isolated 高/极高 buckets are not zones. "
    "Strictly below markPrice = support (green); strictly above = resistance (red). "
    "Boxes drawn from the latest candle rightward only (boxStart=latest_candle)."
)


def _risk_max(risks: Iterable[str]) -> str:
    best = "低"
    best_r = -1
    for r in risks:
        rank = RISK_RANK.get(r, -1)
        if rank > best_r:
            best_r = rank
            best = r
    return best


def _same_mid_side(a: dict, b: dict, mid: float) -> bool:
    a_hi, b_hi = float(a["hi"]), float(b["hi"])
    a_lo, b_lo = float(a["lo"]), float(b["lo"])
    both_below = a_hi <= mid and b_hi <= mid
    both_above = a_lo >= mid and b_lo >= mid
    return both_below or both_above


def _adjacent(prev: dict, nxt: dict, bucket_width: float) -> bool:
    """True when prev.hi ≈ nxt.lo (no gap bucket between)."""
    gap = abs(float(prev["hi"]) - float(nxt["lo"]))
    tol = max(1e-9, bucket_width * 1e-4)
    return gap <= tol


def build_bands(buckets: list[dict]) -> list[dict]:
    """Volume-ranked 高 + 极高 bands for the TradingHub sample."""
    rows = [b for b in buckets if b.get("risk") in ZONE_RISKS and float(b.get("liq_m", 0)) > 0]
    rows = sorted(rows, key=lambda r: (-float(r["liq_m"]), float(r["lo"])))
    bands = []
    for row in rows:
        bands.append(
            {
                "lo": float(row["lo"]),
                "hi": float(row["hi"]),
                "side": row["side"],
                "liq_m": float(row["liq_m"]),
                "risk": row["risk"],
                "dist_pct": float(row["dist_pct"]),
            }
        )
    return bands


def merge_zones(
    buckets: list[dict],
    mid: float,
    bucket_width_pct: float = 0.005,
    bands: list[dict] | None = None,
) -> list[dict]:
    """Return non-overlapping zones sorted by lo ascending (within each side)."""
    if mid <= 0:
        return []
    bucket_width = mid * bucket_width_pct
    if bands is None:
        bands = build_bands(buckets)

    # Index bands by (lo, hi, side) for band_idx lookup.
    band_index: dict[tuple[float, float, str], int] = {}
    for i, b in enumerate(bands):
        key = (round(float(b["lo"]), 10), round(float(b["hi"]), 10), b["side"])
        band_index[key] = i

    candidates = [
        b for b in buckets if b.get("risk") in ZONE_RISKS and float(b.get("liq_m", 0)) > 0
    ]
    candidates = sorted(candidates, key=lambda r: float(r["lo"]))

    runs: list[list[dict]] = []
    cur: list[dict] = []
    for row in candidates:
        if not cur:
            cur = [row]
            continue
        prev = cur[-1]
        if (
            _adjacent(prev, row, bucket_width)
            and _same_mid_side(prev, row, mid)
            and prev.get("side") == row.get("side")
        ):
            cur.append(row)
        else:
            runs.append(cur)
            cur = [row]
    if cur:
        runs.append(cur)

    zones: list[dict] = []
    for run in runs:
        if len(run) < 2:
            continue
        lo = float(run[0]["lo"])
        hi = float(run[-1]["hi"])
        if lo >= hi:
            continue
        side = run[0]["side"]
        # Role by position vs mark: below = support, above = resistance.
        if hi < mid:
            role, color = "support", "green"
        elif lo > mid:
            role, color = "resistance", "red"
        else:
            # Touches or crosses mark — reject (TH-BUG-05 / H2 invariant).
            continue
        liq_m = round(sum(float(r["liq_m"]) for r in run), 4)
        # Nearest edge to mid, signed (+ above, - below).
        if role == "support":
            nearest = hi
        else:
            nearest = lo
        dist_pct = round((nearest - mid) / mid * 100.0, 4)
        idxs = []
        for r in run:
            key = (round(float(r["lo"]), 10), round(float(r["hi"]), 10), r["side"])
            if key in band_index:
                idxs.append(band_index[key])
        zones.append(
            {
                "lo": lo,
                "hi": hi,
                "side": side,
                "role": role,
                "color": color,
                "liq_m": liq_m,
                "risk_max": _risk_max(r["risk"] for r in run),
                "dist_pct": dist_pct,
                "bucket_count": len(run),
                "band_idx": sorted(idxs),
            }
        )

    # Within a side, no overlap; sort by lo ascending overall (contract: within side by lo).
    zones.sort(key=lambda z: (z["side"], z["lo"]))
    # Re-sort globally by lo for chart consumers while keeping per-side non-overlap.
    zones.sort(key=lambda z: z["lo"])
    return zones


def build_sample_payload(
    *,
    symbol: str,
    mid: float,
    buckets: list[dict],
    venue: str = "multi",
    bucket_pct: float = 0.5,
    source: str = "oi_liq_estimator",
) -> dict[str, Any]:
    """Full TradingHub liq_heatmap_bands sample including zones."""
    bands = build_bands(buckets)
    zones = merge_zones(buckets, mid, bucket_width_pct=bucket_pct / 100.0, bands=bands)
    as_of = datetime.now(ET).isoformat(timespec="seconds")
    return {
        "kind": "liq_heatmap_bands",
        "schemaVersion": 1,
        "venue": venue,
        "symbol": symbol,
        "asOf": as_of,
        "markPrice": mid,
        "mid": mid,
        "bucket_pct": bucket_pct,
        "updatedAt": int(datetime.now(ET).timestamp() * 1000),
        "source": source,
        "unit": "usd_millions",
        "zoneRule": ZONE_RULE,
        "boxStart": "latest_candle",
        "bands": bands,
        "zones": zones,
    }
