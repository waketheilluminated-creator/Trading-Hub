"""Write CSV/TXT/JSON tables for the estimator."""

from __future__ import annotations

import csv
import json
import time
from pathlib import Path
from typing import Any

from .fetch import FetchResult, OIPoint
from .model import EstimateResult
from .zones import build_sample_payload



from .model import price_decimals  # noqa: E402


def _base(est) -> str:
    sym = est.assumptions.get("symbol") or "ZECUSDT"
    return sym[:-4] if sym.endswith("USDT") else sym


def _write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def detail_txt(est: EstimateResult) -> str:
    lines = [
        f"{_base(est)} 清算热力图数据 — Model2-ish | path/snapshot | oi-liq-estimator",
        f"交易所: {est.exchange}  模式: {est.mode}",
        f"当前中价 mid: ${est.mid:,.{price_decimals(est.mid)}f}",
        f"当前 OI: ${est.current_oi_usd:,.0f} ({est.current_oi_usd/1e6:.2f}M)",
        f"归因总量: ${est.total_attributed_usd:,.0f}  "
        f"多={est.long_attributed_usd/1e6:.2f}M  空={est.short_attributed_usd/1e6:.2f}M",
        "",
        f"{'价格':>10} {'清算量USD':>14} {'清算量M':>8} {'方向':^14} {'距当前价':>10} {'距离%':>8} {'危险':>4}",
        "-" * 78,
    ]
    for r in est.detail_rows:
        lines.append(
            f"{r['price']:10.{max(2, price_decimals(est.mid) - 2)}f} {r['liq_usd']:14,.2f} {r['liq_m']:7.2f}M "
            f"{r['side_cn']:^12} {r['dist']:10.{max(2, price_decimals(est.mid) - 2)}f} {r['dist_pct']:7.2f}% {r['risk']:>4}"
        )
    return "\n".join(lines) + "\n"


def buckets_txt(est: EstimateResult) -> str:
    lines = [
        f"{_base(est)} 关键清算价位汇总 ({est.assumptions.get('bucket_width_pct', 0.005) * 100:g}%分组) — {est.exchange} / {est.mode}",
        f"{_base(est)}当前价格: ${est.mid:,.{price_decimals(est.mid)}f}   OI: {est.current_oi_usd/1e6:.2f}M",
        "",
        f"{'价位区间':^16} {'方向':^10} {'合计M':>8} {'多M':>7} {'空M':>7} {'距离%':>8} {'触发':>6}",
        "-" * 72,
    ]
    for r in est.buckets:
        lines.append(
            f"{r['range']:^16} {r['side_cn']:^10} {r['liq_m']:8.2f} "
            f"{r['long_m']:7.2f} {r['short_m']:7.2f} {r['dist_pct']:7.2f}% {r['trigger']:>6}"
        )
    return "\n".join(lines) + "\n"


def write_estimate(out_dir: Path, est: EstimateResult, prefix: str = "") -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = prefix + ("_" if prefix else "")
    paths = {}

    detail_fields = [
        "price", "liq_usd", "liq_m", "long_m", "short_m", "side", "side_cn",
        "dist", "dist_pct", "risk",
    ]
    _write_csv(out_dir / f"{p}detail_table.csv", est.detail_rows, detail_fields)
    paths["detail_csv"] = str(out_dir / f"{p}detail_table.csv")

    txt = detail_txt(est)
    (out_dir / f"{p}detail_table.txt").write_text(txt, encoding="utf-8")
    paths["detail_txt"] = str(out_dir / f"{p}detail_table.txt")

    b_fields = [
        "range", "lo", "hi", "price", "side", "side_cn", "liq_m", "liq_usd",
        "long_m", "short_m", "dist_pct", "trigger", "risk",
    ]
    bucket_stem = "buckets_pct05"
    _write_csv(out_dir / f"{p}{bucket_stem}.csv", est.buckets, b_fields)
    paths["buckets_csv"] = str(out_dir / f"{p}{bucket_stem}.csv")
    (out_dir / f"{p}{bucket_stem}.txt").write_text(buckets_txt(est), encoding="utf-8")
    paths["buckets_txt"] = str(out_dir / f"{p}{bucket_stem}.txt")

    summary = {
        "exchange": est.exchange,
        "mode": est.mode,
        "mid": est.mid,
        "current_oi_usd": est.current_oi_usd,
        "current_oi_m": round(est.current_oi_usd / 1e6, 4),
        "total_attributed_usd": est.total_attributed_usd,
        "total_attributed_m": round(est.total_attributed_usd / 1e6, 4),
        "long_attributed_m": round(est.long_attributed_usd / 1e6, 4),
        "short_attributed_m": round(est.short_attributed_usd / 1e6, 4),
        "n_detail_rows": len(est.detail_rows),
        "n_bucket_rows": len(est.buckets),
        "bucket_width_usd": est.assumptions.get("bucket_width_usd"),
        "bucket_width_pct": est.assumptions.get("bucket_width_pct", 0.005),
        "n_hits": len(est.hits),
        "assumptions": est.assumptions,
        "notes": est.notes,
        "top5_long": [r for r in sorted(
            [x for x in est.detail_rows if x["side"] == "long"],
            key=lambda x: x["liq_m"], reverse=True,
        )[:5]],
        "top5_short": [r for r in sorted(
            [x for x in est.detail_rows if x["side"] == "short"],
            key=lambda x: x["liq_m"], reverse=True,
        )[:5]],
        "top10_buckets": est.buckets[:10],
    }
    # Keep a color-aware extreme-range artifact for chart consumers.
    # Long liquidation is forced selling (red); short liquidation is forced buying (green).
    extreme = []
    for row in est.buckets:
        if row.get("risk") != "极高":
            continue
        extreme.append({
            "range": row["range"], "lo": row["lo"], "hi": row["hi"],
            "side": row["side"], "liq_m": row["liq_m"],
            "risk": row["risk"], "dist_pct": row["dist_pct"],
            "color": "red" if row["side"] == "long" else "green",
        })
    (out_dir / f"{p}extreme_ranges.json").write_text(
        json.dumps(extreme, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    paths["extreme_ranges"] = str(out_dir / f"{p}extreme_ranges.json")
    if not prefix:
        # TradingHub sample: 高+极高 bands + merged support/resistance zones.
        sample = build_sample_payload(
            symbol=est.assumptions.get("symbol") or "ZECUSDT",
            mid=est.mid,
            buckets=est.buckets,
            venue="multi" if "+" in est.exchange else est.exchange,
            bucket_pct=round(est.assumptions.get("bucket_width_pct", 0.005) * 100, 6),
        )
        (out_dir / "liq_heatmap_bands.sample.json").write_text(
            json.dumps(sample, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        paths["liq_heatmap_bands_sample"] = str(out_dir / "liq_heatmap_bands.sample.json")
        # zones.csv + TradingHub contract note
        zfields = [
            "lo", "hi", "side", "role", "color", "liq_m", "risk_max",
            "dist_pct", "bucket_count", "band_idx",
        ]
        zrows = []
        for z in sample.get("zones", []):
            zrows.append({**z, "band_idx": ",".join(str(i) for i in z.get("band_idx", []))})
        _write_csv(out_dir / "zones.csv", zrows, zfields)
        paths["zones_csv"] = str(out_dir / "zones.csv")
        th_md = _tradinghub_md(sample)
        (out_dir / "TRADINGHUB.md").write_text(th_md, encoding="utf-8")
        paths["tradinghub_md"] = str(out_dir / "TRADINGHUB.md")

    (out_dir / f"{p}summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    paths["summary"] = str(out_dir / f"{p}summary.json")
    return paths


def write_raw_points(out_dir: Path, fr: FetchResult, prefix: str = "") -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = prefix + ("_" if prefix else "")
    path = out_dir / f"{p}raw_oi_price.csv"
    fields = ["ts_ms", "ts_cst", "oi_usd", "oi_ccy", "oi_contracts", "price", "long_share"]
    rows = [
        {
            "ts_ms": pt.ts_ms,
            "ts_cst": pt.ts_cst,
            "oi_usd": pt.oi_usd,
            "oi_ccy": pt.oi_ccy,
            "oi_contracts": pt.oi_contracts,
            "price": pt.price,
            "long_share": pt.long_share,
        }
        for pt in fr.points
    ]
    _write_csv(path, rows, fields)
    meta = {
        "exchange": fr.exchange,
        "symbol": fr.symbol,
        "ok": fr.ok,
        "error": fr.error,
        "mid": fr.mid,
        "current_oi_usd": fr.current_oi_usd,
        "mode": fr.mode,
        "notes": fr.notes,
        "ls_source": fr.raw.get("ls_source"),
        "n_points": len(fr.points),
    }
    (out_dir / f"{p}raw_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return str(path)


def _tradinghub_md(sample: dict) -> str:
    """Short contract note for TradingHub box overlays."""
    zones = sample.get("zones", [])
    lines = [
        f"# TradingHub — {sample.get('symbol')} liquidation zones",
        "",
        f"- schemaVersion: `{sample.get('schemaVersion')}`",
        f"- kind: `{sample.get('kind')}`",
        f"- markPrice / mid: `{sample.get('markPrice')}` (USDT)",
        f"- asOf: `{sample.get('asOf')}`",
        f"- boxStart: `{sample.get('boxStart')}` — draw boxes from the latest candle rightward only",
        f"- zoneRule: {sample.get('zoneRule')}",
        "",
        "## Units",
        "",
        "- `liq_m`: millions USD notional (estimated liquidation cluster mass).",
        "- `lo` / `hi`: USDT prices with `lo < hi`.",
        "- `dist_pct`: signed percent distance of the zone edge nearest to markPrice; "
        "`+` above mark, `-` below mark. `(nearest_edge - markPrice) / markPrice * 100`.",
        "",
        "## risk / risk_max enum",
        "",
        "Same volume-only percentile tiers as `bands[].risk`:",
        "",
        "| value | meaning |",
        "|-------|---------|",
        "| `极高` | top ceil(10% N) by `liq_m` |",
        "| `高` | next through ceil(20% N) |",
        "| `中` | next through ceil(50% N) |",
        "| `低` | remainder |",
        "",
        "`risk_max` on a zone is the max tier among merged buckets (极高 > 高).",
        "",
        "## bands vs zones",
        "",
        "- `bands[]` lists every `高` and `极高` bucket (volume-ranked).",
        "- `zones[]` merges runs of >=2 price-adjacent same-side (of mark) same-`side` "
        "(long|short) high/extreme buckets.",
        "- `band_idx[]` indexes into `bands[]` for buckets consumed by that zone "
        "(shell may hide those singles).",
        "- role/color: below mark → `support`/`green`; above mark → `resistance`/`red`.",
        "- Within a liquidation `side`, zones do not overlap; sorted by `lo` ascending.",
        "",
        f"## zones ({len(zones)})",
        "",
    ]
    for z in zones:
        lines.append(
            f"- `{z['lo']}`–`{z['hi']}` {z['role']}/{z['color']} "
            f"side={z['side']} liq_m={z['liq_m']} risk_max={z['risk_max']} "
            f"buckets={z['bucket_count']} band_idx={z.get('band_idx')}"
        )
    lines.append("")
    return "\n".join(lines)

