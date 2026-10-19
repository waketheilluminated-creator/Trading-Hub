#!/usr/bin/env python3
"""TradingHub liquidation refresher — TH-FEAT-19 H2 Dongyi replica.

CLI contract (unchanged for studio/lib/liq-refresh.ts):
  refresh_liq.py --symbol BTCUSDT --out /path/to.json
  exit 0 on success; exit 2 bad args; exit 3 symbol unlisted; exit 1 other failure.

Algorithm: see oi_liq/h2.py. 30s cooldown / 90s timeout are enforced by the
Node refresher, not here.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

NOT_LISTED_HINTS = (
    "not listed", "does not exist", "invalid symbol", "symbol not support",
    "instid", "-1121", "not support symbol", "unknown instrument",
)

from oi_liq.fetch import (
    VENUES,
    fetch_all,
    fetch_binance_klines_1h,
    fetch_btc_oi_usd,
    fetch_tick_size,
)
from oi_liq.h2 import (
    H2_LOOKBACK_DAYS,
    Bar1h,
    aggregate_h2_buckets,
    apply_h2_tiers,
    h2_distribute,
    scale_tier_thresholds,
)
from oi_liq.model import price_decimals
from oi_liq.zones import build_sample_payload


def _decimals_of(tick: float | None) -> int:
    if tick is None or tick <= 0:
        return 2
    s = f"{tick:.10f}".rstrip("0")
    if "." not in s:
        return 0
    return len(s.split(".")[1])


def _round_payload(payload: dict, dec: int, tick: float | None) -> None:
    """Snap zone/band edges to the tick grid (bucket width itself stays %-of-mid)."""
    def snap(v: float, side: str) -> float:
        if tick and tick > 0:
            import math
            n = v / tick
            n = math.floor(n) if side == "long" else math.ceil(n)
            return round(n * tick, dec)
        return round(v, dec)

    for row in payload.get("bands", []):
        side = row.get("side", "long")
        row["lo"] = snap(float(row["lo"]), side)
        row["hi"] = snap(float(row["hi"]), side)
        if row["hi"] <= row["lo"] and tick and tick > 0:
            row["hi"] = snap(row["lo"] + tick, side)
    for z in payload.get("zones", []):
        side = z.get("side", "long")
        z["lo"] = snap(float(z["lo"]), side)
        z["hi"] = snap(float(z["hi"]), side)


def _validate(p: dict) -> None:
    assert p["schemaVersion"] == 1
    assert p["kind"] == "liq_heatmap_bands"
    for z in p["zones"]:
        assert z["lo"] < z["hi"], z
        assert z["side"] in ("long", "short")
        if z["side"] == "long":
            assert z["hi"] < p["markPrice"] + 1e-9
        else:
            assert z["lo"] > p["markPrice"] - 1e-9


def main() -> int:
    t0 = time.time()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", required=True, help="USDT perp, e.g. BTCUSDT")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--days", type=float, default=H2_LOOKBACK_DAYS)
    ap.add_argument("--bucket-width-pct", type=float, default=0.005)
    ap.add_argument("--venue-timeout", type=float, default=float(os.environ.get("LIQ_VENUE_TIMEOUT", "25")))
    ap.add_argument("--venues", default="binance,okx,bybit", help="comma list (H2 default: binance,okx,bybit)")
    ap.add_argument("--png", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if a.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    symbol = a.symbol.upper().strip()
    status: dict = {
        "ok": False,
        "symbol": symbol,
        "venues_used": [],
        "venues_failed": {},
        "venues_unlisted": [],
        "elapsed_s": None,
        "out": str(a.out),
        "algo": "h2",
    }

    def finish(code: int, err: str | None = None) -> int:
        status["elapsed_s"] = round(time.time() - t0, 2)
        if err:
            status["error"] = err
            print(f"refresh_liq: {err}", file=sys.stderr)
        print(json.dumps(status, ensure_ascii=False), flush=True)
        sys.stderr.flush()
        os._exit(code)

    if not symbol.endswith("USDT") or len(symbol) <= 4:
        return finish(2, "symbol must be a USDT perp like BTCUSDT")
    base = symbol[:-4]
    venues = [v.strip() for v in a.venues.split(",") if v.strip()]

    try:
        import concurrent.futures as cf

        tex = cf.ThreadPoolExecutor(max_workers=2)
        tick_fut = tex.submit(fetch_tick_size, base)
        klines_fut = tex.submit(fetch_binance_klines_1h, base, a.days)
        btc_oi_fut = tex.submit(fetch_btc_oi_usd) if base != "BTC" else None

        results = fetch_all(days=a.days, base=base, venues=venues, venue_timeout=a.venue_timeout)
        ok = [r for r in results if r.ok and r.mid]
        if len(ok) >= 3:
            mids = sorted(r.mid for r in ok)
            med = mids[len(mids) // 2]
            for r in list(ok):
                if abs(r.mid / med - 1) > 0.05:
                    ok.remove(r)
                    r.ok, r.unlisted = False, True
                    r.error = f"price {r.mid} vs median {med}: different contract/multiplier"
                    status.setdefault("venues_notes", {})[r.exchange] = r.error
        for r in results:
            if r.ok and r.mid:
                continue
            err = r.error or "no data"
            if getattr(r, "unlisted", False) or (
                any(h in err.lower() for h in NOT_LISTED_HINTS) and "timeout" not in err.lower()
            ):
                status["venues_unlisted"].append(r.exchange)
            else:
                status["venues_failed"][r.exchange] = err[:300]
        status["venues_used"] = [r.exchange for r in ok]
        if not ok:
            if len(status["venues_unlisted"]) == len(results):
                return finish(3, f"no venue lists {symbol}")
            return finish(1, "zero venues returned data")

        # One-sided current OI sum (FetchResult.current_oi_usd already prefers single-side on Bybit).
        total_oi = 0.0
        mid = next((e.mid for e in ok if e.exchange == "okx"), None) or next(
            (e.mid for e in ok if e.exchange == "binance"), ok[0].mid
        )
        for fr in ok:
            oi = fr.current_oi_usd or (fr.points[-1].oi_usd if fr.points else 0.0)
            if oi and oi > 0:
                total_oi += float(oi)
            if fr.mid:
                mid = fr.mid if fr.exchange == "binance" else mid

        try:
            raw_kl = klines_fut.result(timeout=20)
        except Exception as ex:  # noqa: BLE001
            return finish(1, f"1h klines: {ex}")
        if len(raw_kl) < 12:
            return finish(1, "not enough 1h klines for H2 lookback")
        bars = [
            Bar1h(
                ts_ms=int(b["ts_ms"]),
                open=float(b["open"]),
                high=float(b["high"]),
                low=float(b["low"]),
                close=float(b["close"]),
                quote_vol=float(b["quote_vol"]),
            )
            for b in raw_kl
        ]
        # Prefer mark from last kline close if venues disagree slightly.
        if bars:
            mid = float(bars[-1].close)

        hits = h2_distribute(total_oi, bars, mid)
        bucket_rows = aggregate_h2_buckets(hits, mid, bucket_width_pct=a.bucket_width_pct)
        btc_oi = total_oi if base == "BTC" else None
        if btc_oi_fut is not None:
            try:
                btc_oi = btc_oi_fut.result(timeout=15)
            except Exception:
                btc_oi = None
        thresholds = scale_tier_thresholds(total_oi, btc_oi or total_oi)
        apply_h2_tiers(bucket_rows, thresholds)

        # Round for display
        dec = price_decimals(mid)
        for r in bucket_rows:
            r["liq_m"] = round(float(r["liq_m"]), 2 if mid >= 1 else 4)
            r["liq_usd"] = round(float(r["liq_usd"]), 2)
            r["long_m"] = round(float(r["long_m"]), 2 if mid >= 1 else 4)
            r["short_m"] = round(float(r["short_m"]), 2 if mid >= 1 else 4)
            r["dist_pct"] = round(float(r["dist_pct"]), 2)
            r["lo"] = round(float(r["lo"]), dec)
            r["hi"] = round(float(r["hi"]), dec)
            r["price"] = round(float(r["price"]), dec)
            r["range"] = f"${r['lo']}-${r['hi']} ({a.bucket_width_pct * 100:g}%)"
            r["trigger"] = r["risk"]

        payload = build_sample_payload(
            symbol=symbol,
            mid=mid,
            buckets=bucket_rows,
            venue="multi" if len(ok) > 1 else ok[0].exchange,
            bucket_pct=round(a.bucket_width_pct * 100, 6),
            source="oi_liq_estimator",
        )
        payload["algo"] = "h2"
        payload["tierThresholds"] = {
            "extreme_usd": thresholds.extreme_usd,
            "high_usd": thresholds.high_usd,
            "medium_usd": thresholds.medium_usd,
            "btc_oi_usd": btc_oi,
            "symbol_oi_usd": total_oi,
        }
        payload["assumptions"] = {
            "lookback_days": a.days,
            "leverage_mix": [{"leverage": L, "weight": w} for L, w in ((10, 0.3), (25, 0.3), (50, 0.25), (100, 0.15))],
            "mm": 0.005,
            "entry": "1h quote-volume weighted",
            "oi": "current one-sided sum (binance+okx+bybit)",
            "drop_crossed": True,
        }

        try:
            tick, tick_src = tick_fut.result(timeout=3)
        except Exception:
            tick, tick_src = None, ""
        dec2 = _decimals_of(tick) if tick else dec
        _round_payload(payload, dec2, tick)
        payload["tickSource"] = tick_src or "heuristic"
        payload["tickSize"] = tick
        payload["priceDecimals"] = dec2
        payload["venues"] = status["venues_used"]
        payload["oi_usd"] = round(total_oi, 2)
        _validate(payload)

        a.out.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(a.out.parent), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, a.out)
        status["zones"] = len(payload["zones"])
        status["bands"] = len(payload["bands"])
        status["markPrice"] = payload["markPrice"]
        status["oi_usd"] = payload["oi_usd"]

        if a.png:
            try:
                from render_zones_png import render

                status["png"] = render(payload, a.out.with_suffix(".png"))
            except Exception as ex:  # noqa: BLE001
                status["png_error"] = str(ex)
    except Exception as ex:  # noqa: BLE001
        return finish(1, f"{type(ex).__name__}: {ex}")
    status["ok"] = True
    return finish(0)


if __name__ == "__main__":
    main()
