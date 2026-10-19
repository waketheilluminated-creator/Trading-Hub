# oi_liq estimator (TH-FEAT-19 H2)

Live liquidation heatmap for TradingHub. Deployed on the Windows host as
`D:\liq-estimator` and invoked via `LIQ_ESTIMATOR_CMD` (30s cooldown / 90s
timeout enforced by the studio refresh route).

## Algorithm (H2 — Dongyi replica)

- **OI:** current one-sided open interest, summed across Binance + OKX + Bybit
  when available. Bybit uses `singleOpenInterest` (or `openInterest / 2`).
- **Entries:** last 7 days of 1h bars, weighted by quote volume.
- **Leverage mix:** 10 / 25 / 50 / 100× at 0.30 / 0.30 / 0.25 / 0.15; 50/50 long/short.
- **MM:** 0.5%. Long liq = `entry*(1-1/L+mm)`; short = `entry*(1+1/L-mm)`.
- **Drop crossed:** levels the post-entry path already swept are removed (TH-BUG-05).
- **Sides:** longs only below mark (green support); shorts only above (red resistance).
- **Tiers (BTC):** 极高 ≥ $100M, 高 ≥ $70M, 中 ≥ $15M, else 低 — per **Dongyi BTC bin
  (~0.19% of price)**.
- **Bucket width (TH-BUG-06):** a wider bucket sums several Dongyi bins, so the floors
  scale by `bucket_width_pct / 0.0019` (clamped `[0.05, 50]`). Live 0.5% buckets →
  ×2.63 (BTC 极高 ≥ $263M / 高 ≥ $184M / 中 ≥ $39M). Missing/invalid width = reference bin.
- **Tiers (alts):** same floors also scaled by `symbol_OI / btc_OI` via
  `oi_liq.h2.scale_tier_thresholds` (clamped `[1e-4, 1e2]`). Both OI sums are taken over the
  **same venues** (`matched_oi_totals`, TH-BUG-06b). Comparing a 3-venue alt total against a
  Binance-only BTC OI snapped ETH to the BTC floors. The 高/极高 ratio is the
  same for every symbol (no ETH-specific ratio until more Model 1 snapshots).
- **Zones:** merge ≥2 adjacent 高/极高 same-side bins into one box.

### OKX coverage

OKX open-interest *history* is only ~2.5–6 days. H2 uses **current** OI only, so
OKX is included whenever its ticker OI is available; short history does not
exclude it from the live sum. Replay uses the last OI sample at or before the
cutoff per venue.

## Layout

```
refresh_liq.py          CLI entry (stdout: one JSON status line)
oi_liq/h2.py            H2 core + tier scaling
oi_liq/fetch.py         venue OI + 1h klines + BTC OI helper
oi_liq/zones.py         band/zone merge + sample payload
oi_liq/model.py         legacy path_accumulate (unused by refresh after H2)
tests/test_h2.py        unit + golden OOS (corr/IoU on 5 snapshots)
golden/                 Dongyi tables + frozen H2 preds + scores.json
```

Replay (on-the-fly, no snapshots) lives in `studio/lib/replay/liq-replay.ts`
and must stay in lockstep with `oi_liq/h2.py`.
