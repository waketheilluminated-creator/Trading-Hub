"""Symbol-agnostic public exchange fetchers for USDT perp OI + price history.

OKX: direct. Binance fapi.binance.com is often 451 — use www.binance.com mirror.
Bybit CloudFront 403 from this egress — fall back to Tor SOCKS (socks5h://127.0.0.1:9050)
or OI_LIQ_PROXY / HTTPS_PROXY if set.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

import requests

log = logging.getLogger(__name__)

CST = timezone(timedelta(hours=8))
OKX = "https://www.okx.com"
# Official futures data + fapi routes are served on www without the CloudFront 451
# that fapi.binance.com returns from restricted egress IPs.
BINANCE = "https://www.binance.com"
BINANCE_HOSTS = ("https://fapi.binance.com", "https://www.binance.com")
BYBIT = "https://api.bybit.com"
BITGET = "https://api.bitget.com"
GATE = "https://api.gateio.ws"
HTX = "https://api.hbdm.com"
KUCOIN = "https://api-futures.kucoin.com"
BINGX = "https://open-api.bingx.com"
BITMEX = "https://www.bitmex.com"
DERIBIT = "https://www.deribit.com"
DYDX = "https://indexer.dydx.trade"
HYPERLIQUID = "https://api.hyperliquid.xyz"

DEFAULT_UA = "oi-liq-estimator/0.3"
DEFAULT_TOR_SOCKS = "socks5h://127.0.0.1:9050"


import threading

_CTX = threading.local()
REQ_TIMEOUT = float(os.environ.get("LIQ_REQ_TIMEOUT", "10"))


def _proxy_dict(venue: Optional[str] = None) -> Optional[dict[str, str]]:
    """SOCKS/HTTP proxy only if LIQ_SOCKS_PROXY is set (direct by default).

    LIQ_PROXY_VENUES=bybit,binance limits the proxy to those venues; unset = all.
    Legacy OI_LIQ_PROXY is honoured the same way.
    """
    proxy = os.environ.get("LIQ_SOCKS_PROXY") or os.environ.get("OI_LIQ_PROXY")
    if not proxy:
        return None
    venues = [v.strip().lower() for v in os.environ.get("LIQ_PROXY_VENUES", "").split(",") if v.strip()]
    venue = venue or getattr(_CTX, "venue", None)
    if venues and (venue or "").lower() not in venues:
        return None
    return {"http": proxy, "https": proxy}


@dataclass
class OIPoint:
    ts_ms: int
    oi_usd: float
    oi_contracts: float = 0.0
    oi_ccy: float = 0.0
    price: Optional[float] = None
    long_share: Optional[float] = None

    @property
    def ts_cst(self) -> str:
        return datetime.fromtimestamp(self.ts_ms / 1000, CST).strftime("%Y-%m-%d %H:%M CST")


@dataclass
class FetchResult:
    exchange: str
    symbol: str
    points: list[OIPoint] = field(default_factory=list)
    mid: Optional[float] = None
    current_oi_usd: Optional[float] = None
    mode: str = "path"
    notes: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)
    ok: bool = False
    error: Optional[str] = None
    unlisted: bool = False  # True = venue does not list this perp (not a failure)


class NotListed(RuntimeError):
    """Raised inside a fetcher when the venue simply does not list the symbol."""


# Venue-native base aliases (same underlying, same 1x unit). Multiplied contracts
# (1000PEPE, kPEPE, 1000000MOG...) are deliberately NOT mapped: exact name or unlisted.
BASE_ALIASES = {"kucoin": {"BTC": "XBT"}, "bitmex": {"BTC": "XBT"}}


def venue_base(venue: str, base: str) -> str:
    return BASE_ALIASES.get(venue, {}).get(base, base)


def _session(proxies: Optional[dict[str, str]] = None) -> requests.Session:
    s = requests.Session()
    s.trust_env = False
    if proxies is None:
        proxies = _proxy_dict()
    s.headers.update({"User-Agent": DEFAULT_UA})
    if proxies:
        s.proxies.update(proxies)
    return s


def _get(
    url: str,
    params: dict | None = None,
    timeout: Optional[float] = None,
    proxies: Optional[dict[str, str]] = None,
    session: Optional[requests.Session] = None,
) -> Any:
    s = session or _session(proxies)
    r = s.get(url, params=params, timeout=timeout or REQ_TIMEOUT)
    if r.status_code in (403, 451):
        raise RuntimeError(f"HTTP {r.status_code} geo/blocked: {r.text[:200]}")
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# OKX
# ---------------------------------------------------------------------------

def fetch_okx(
    base: str = "ZEC",
    days: float = 7.0,
    period: str = "1H",
    inst_id: str = None,
) -> FetchResult:
    """Fetch OKX <BASE>-USDT-SWAP OI history + mark candles + L/S share."""
    inst_id = inst_id or f"{base}-USDT-SWAP"
    out = FetchResult(exchange="okx", symbol=inst_id)
    s = _session()  # direct — OKX works from this host
    try:
        oi_now = _get(f"{OKX}/api/v5/public/open-interest", {"instId": inst_id}, session=s)
        ticker = _get(f"{OKX}/api/v5/market/ticker", {"instId": inst_id}, session=s)
        oi_row = (oi_now.get("data") or [None])[0]
        t_row = (ticker.get("data") or [None])[0]
        if str(oi_now.get("code")) == "51001" or str(ticker.get("code")) == "51001" or (not oi_row and not t_row):
            raise NotListed(f"OKX has no {inst_id}")
        if not oi_row or not t_row:
            raise RuntimeError(f"empty ticker/OI: oi={oi_now} ticker={ticker}")
        out.current_oi_usd = float(oi_row["oiUsd"])
        out.mid = float(t_row["last"])
        out.raw["oi_now"] = oi_row
        out.raw["ticker"] = t_row

        inst = _get(
            f"{OKX}/api/v5/public/instruments",
            {"instType": "SWAP", "instId": inst_id},
            session=s,
        )
        out.raw["instrument"] = (inst.get("data") or [None])[0]

        need_ms = int(days * 24 * 3600 * 1000)
        now_ms = int(time.time() * 1000)
        cutoff = now_ms - need_ms
        hist: list[list[str]] = []
        end: Optional[int] = None
        for _ in range(20):
            params: dict[str, Any] = {"instId": inst_id, "period": period}
            if end is not None:
                params["end"] = str(end)
            j = _get(
                f"{OKX}/api/v5/rubik/stat/contracts/open-interest-history",
                params,
                session=s,
            )
            if j.get("code") != "0":
                raise RuntimeError(f"OI history error: {j}")
            batch = j.get("data") or []
            if not batch:
                break
            hist.extend(batch)
            oldest = int(batch[-1][0])
            if oldest <= cutoff:
                break
            end = oldest
            time.sleep(0.15)
        by_ts: dict[int, list[str]] = {}
        for row in hist:
            by_ts[int(row[0])] = row
        rows = [by_ts[k] for k in sorted(by_ts) if k >= cutoff - 3600_000]
        out.notes.append(f"OI history points={len(rows)} period={period}")

        candles: list[list[str]] = []
        after: Optional[str] = None
        for _ in range(10):
            params = {
                "instId": inst_id,
                "bar": period if period != "1D" else "1D",
                "limit": "100",
            }
            if after:
                params["after"] = after
            j = _get(f"{OKX}/api/v5/market/mark-price-candles", params, session=s)
            if j.get("code") != "0":
                raise RuntimeError(f"mark candles error: {j}")
            batch = j.get("data") or []
            if not batch:
                break
            candles.extend(batch)
            oldest = batch[-1][0]
            if int(oldest) <= cutoff:
                break
            after = oldest
            time.sleep(0.1)
        px_by_ts = {int(c[0]): float(c[4]) for c in candles}
        out.raw["n_candles"] = len(candles)
        out.notes.append(f"mark candles={len(candles)}")

        ls_by_ts: dict[int, float] = {}
        try:
            j = _get(
                f"{OKX}/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader",
                {"instId": inst_id, "period": period},
                session=s,
            )
            if j.get("code") == "0":
                for row in j.get("data") or []:
                    ratio = float(row[1])
                    ls_by_ts[int(row[0])] = ratio / (1.0 + ratio)
                out.notes.append(f"top-trader position L/S points={len(ls_by_ts)}")
                out.raw["ls_source"] = "top_trader_position_ratio"
        except Exception as e:
            out.notes.append(f"top-trader L/S failed: {e}")

        if not ls_by_ts:
            try:
                j = _get(
                    f"{OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio",
                    {"ccy": base, "period": period},
                    session=s,
                )
                if j.get("code") == "0":
                    for row in j.get("data") or []:
                        ratio = float(row[1])
                        ls_by_ts[int(row[0])] = ratio / (1.0 + ratio)
                    out.notes.append(f"account L/S points={len(ls_by_ts)}")
                    out.raw["ls_source"] = "account_ratio"
            except Exception as e:
                out.notes.append(f"account L/S failed: {e}")

        if not ls_by_ts:
            out.notes.append("no L/S data; defaulting long_share=0.5")
            out.raw["ls_source"] = "default_50_50"

        def nearest_share(ts: int) -> float:
            if not ls_by_ts:
                return 0.5
            if ts in ls_by_ts:
                return ls_by_ts[ts]
            best = min(ls_by_ts.keys(), key=lambda k: abs(k - ts))
            return ls_by_ts[best]

        def nearest_px(ts: int) -> Optional[float]:
            if ts in px_by_ts:
                return px_by_ts[ts]
            if not px_by_ts:
                return out.mid
            best = min(px_by_ts.keys(), key=lambda k: abs(k - ts))
            if abs(best - ts) > 6 * 3600_000:
                return out.mid
            return px_by_ts[best]

        points: list[OIPoint] = []
        for row in rows:
            ts = int(row[0])
            points.append(
                OIPoint(
                    ts_ms=ts,
                    oi_contracts=float(row[1]),
                    oi_ccy=float(row[2]),
                    oi_usd=float(row[3]),
                    price=nearest_px(ts),
                    long_share=nearest_share(ts),
                )
            )
        out.points = points
        out.mode = "path" if len(points) >= 3 else "snapshot"
        out.ok = True
        if len(points) < 3:
            out.notes.append("too few OI points; caller should use snapshot mode")
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        log.exception("OKX fetch failed")
        return out


# ---------------------------------------------------------------------------
# Binance (www.binance.com bypasses fapi 451 on this host)
# ---------------------------------------------------------------------------

def fetch_binance(base: str = "ZEC", days: float = 7.0, period: str = "1h") -> FetchResult:
    """Try fapi.binance.com first, then the www.binance.com mirror."""
    errs = []
    for host in BINANCE_HOSTS:
        r = _fetch_binance_host(host, base=base, days=days, period=period)
        if r.ok:
            r.notes.append(f"host={host}")
            return r
        errs.append(f"{host}: {r.error}")
        if r.error and r.error.startswith("NOTLISTED:"):
            return r
    r.error = " | ".join(errs)
    return r


def _fetch_binance_host(host: str, base: str = "ZEC",
    days: float = 7.0, period: str = "1h") -> FetchResult:
    out = FetchResult(exchange="binance", symbol=f"{base}USDT")
    s = _session()  # direct via www.binance.com
    try:
        pr = s.get(f"{host}/fapi/v1/premiumIndex", params={"symbol": f"{base}USDT"}, timeout=REQ_TIMEOUT)
        if pr.status_code == 400 and "-1121" in pr.text:
            raise NotListed(f"Binance has no {base}USDT perp (-1121)")
        if pr.status_code in (403, 451):
            raise RuntimeError(f"HTTP {pr.status_code} geo/blocked")
        limit = min(500, max(5, int(days * 24) + 2))
        hist = _get(
            f"{host}/futures/data/openInterestHist",
            {"symbol": f"{base}USDT", "period": period, "limit": str(limit)},
            session=s,
        )
        if not isinstance(hist, list):
            raise RuntimeError(f"unexpected: {hist}")
        ticker = _get(
            f"{host}/fapi/v1/ticker/price",
            {"symbol": f"{base}USDT"},
            session=s,
        )
        out.mid = float(ticker["price"])
        out.notes.append("base=https://www.binance.com (fapi.binance.com 451 bypass)")
        points = []
        for row in hist:
            points.append(
                OIPoint(
                    ts_ms=int(row["timestamp"]),
                    oi_usd=float(row["sumOpenInterestValue"]),
                    oi_contracts=float(row.get("sumOpenInterest", 0)),
                    price=out.mid,
                    long_share=0.5,
                )
            )
        try:
            kl = _get(
                f"{host}/fapi/v1/markPriceKlines",
                {"symbol": f"{base}USDT", "interval": period, "limit": str(limit)},
                session=s,
            )
            px = {int(c[0]): float(c[4]) for c in kl}
            for p in points:
                if p.ts_ms in px:
                    p.price = px[p.ts_ms]
            out.notes.append(f"mark klines={len(px)}")
        except Exception as e:
            out.notes.append(f"mark klines skipped: {e}")
        try:
            lsr = _get(
                f"{host}/futures/data/topLongShortPositionRatio",
                {"symbol": f"{base}USDT", "period": period, "limit": str(min(limit, 500))},
                session=s,
            )
            by = {int(r["timestamp"]): float(r["longAccount"]) for r in lsr}
            for p in points:
                if p.ts_ms in by:
                    p.long_share = by[p.ts_ms]
            out.raw["ls_source"] = "topLongShortPositionRatio.longAccount"
            out.notes.append(f"top L/S points={len(by)}")
        except Exception as e:
            out.notes.append(f"L/S skipped: {e}")
            out.raw["ls_source"] = "default_50_50"
        points.sort(key=lambda x: x.ts_ms)
        # trim to lookback
        cutoff = int(time.time() * 1000) - int(days * 24 * 3600 * 1000)
        points = [p for p in points if p.ts_ms >= cutoff - 3600_000]
        out.points = points
        out.current_oi_usd = points[-1].oi_usd if points else None
        try:
            oi_now = _get(
                f"{host}/fapi/v1/openInterest",
                {"symbol": f"{base}USDT"},
                session=s,
            )
            # contracts * mid ≈ USD if value endpoint missing
            if out.mid and oi_now.get("openInterest"):
                # prefer last hist USD; keep note
                out.raw["oi_now"] = oi_now
        except Exception:
            pass
        out.mode = "path" if len(points) >= 3 else "snapshot"
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# Bybit (Tor SOCKS / OI_LIQ_PROXY when CloudFront 403)
# ---------------------------------------------------------------------------

def fetch_bybit(
    base: str = "ZEC",
    days: float = 7.0, interval: str = "1h") -> FetchResult:
    out = FetchResult(exchange="bybit", symbol=f"{base}USDT")
    # Probe direct; on geo-block fall back to Tor / OI_LIQ_PROXY
    proxies = None
    s = _session({})  # direct probe first
    try:
        probe = s.get(f"{BYBIT}/v5/market/time", timeout=min(REQ_TIMEOUT, 8))
        if probe.status_code in (403, 451):
            raise RuntimeError(f"probe HTTP {probe.status_code}")
    except Exception as e:
        proxies = _proxy_dict()
        if not proxies:
            out.ok = False
            out.error = f"Bybit blocked ({e}) and no LIQ_SOCKS_PROXY set"
            return out
        s = _session(proxies)
        out.notes.append(f"direct blocked; using proxies={proxies.get('https', '?')}")
    try:
        ii = _get(f"{BYBIT}/v5/market/instruments-info", {"category": "linear", "symbol": f"{base}USDT"}, session=s)
        if ii.get("retCode") == 10001 or not ((ii.get("result") or {}).get("list")):
            raise NotListed(f"Bybit has no linear {base}USDT")
        out.raw["instrument"] = ii["result"]["list"][0]
        limit = min(200, max(5, int(days * 24) + 2))
        # Paginate with cursor if needed
        lst: list[dict] = []
        cursor: Optional[str] = None
        for _ in range(8):
            params: dict[str, Any] = {
                "category": "linear",
                "symbol": f"{base}USDT",
                "intervalTime": interval,
                "limit": str(limit),
            }
            if cursor:
                params["cursor"] = cursor
            j = _get(f"{BYBIT}/v5/market/open-interest", params, session=s)
            if j.get("retCode") not in (0, "0"):
                raise RuntimeError(str(j))
            batch = (j.get("result") or {}).get("list") or []
            if not batch:
                break
            lst.extend(batch)
            cursor = (j.get("result") or {}).get("nextPageCursor") or None
            oldest = min(int(r["timestamp"]) for r in batch)
            cutoff = int(time.time() * 1000) - int(days * 24 * 3600 * 1000)
            if oldest <= cutoff or not cursor:
                break
            time.sleep(0.2)

        tick = _get(
            f"{BYBIT}/v5/market/tickers",
            {"category": "linear", "symbol": f"{base}USDT"},
            session=s,
        )
        t0 = ((tick.get("result") or {}).get("list") or [None])[0]
        if not t0:
            raise RuntimeError(f"no ticker: {tick}")
        out.mid = float(t0["lastPrice"])
        out.raw["ticker"] = t0
        # Prefer exchange-reported USD OI when present
        # Bybit openInterest* fields are two-sided (long+short); use single-side.
        if t0.get("singleOpenInterestValue"):
            out.current_oi_usd = float(t0["singleOpenInterestValue"])
            out.notes.append("current OI from ticker.singleOpenInterestValue")
        elif t0.get("openInterestValue"):
            out.current_oi_usd = float(t0["openInterestValue"]) / 2
            out.notes.append("current OI from ticker.openInterestValue/2 (two-sided)")

        # Mark price klines for bar alignment
        px_by_ts: dict[int, float] = {}
        try:
            # Bybit interval: 60 = 1h
            iv_map = {"5min": "5", "15min": "15", "1h": "60", "4h": "240", "1d": "D"}
            iv = iv_map.get(interval, "60")
            kl = _get(
                f"{BYBIT}/v5/market/mark-price-kline",
                {
                    "category": "linear",
                    "symbol": f"{base}USDT",
                    "interval": iv,
                    "limit": str(min(1000, max(limit, 200))),
                },
                session=s,
            )
            if kl.get("retCode") in (0, "0"):
                for c in (kl.get("result") or {}).get("list") or []:
                    # [start, open, high, low, close]
                    px_by_ts[int(c[0])] = float(c[4])
                out.notes.append(f"mark klines={len(px_by_ts)}")
        except Exception as e:
            out.notes.append(f"mark klines skipped: {e}")

        # Dedup by ts
        by_ts: dict[int, dict] = {}
        for row in lst:
            by_ts[int(row["timestamp"])] = row
        cutoff = int(time.time() * 1000) - int(days * 24 * 3600 * 1000)
        points = []
        for ts in sorted(by_ts):
            if ts < cutoff - 3600_000:
                continue
            row = by_ts[ts]
            if row.get("singleOpenInterest") not in (None, ""):
                oi_ccy = float(row["singleOpenInterest"])
            else:
                oi_ccy = float(row["openInterest"]) / 2  # two-sided -> single
            px = px_by_ts.get(ts) or out.mid
            points.append(
                OIPoint(
                    ts_ms=ts,
                    oi_ccy=oi_ccy,
                    oi_usd=oi_ccy * float(px),
                    price=float(px),
                    long_share=0.5,
                )
            )
        if not out.current_oi_usd and points:
            out.current_oi_usd = points[-1].oi_usd
        out.points = points
        out.mode = "path" if len(points) >= 3 else "snapshot"
        out.ok = True
        out.raw["ls_source"] = "default_50_50"
        out.notes.append(
            f"OI points={len(points)}; USD = singleOpenInterest(base)*mark (hist has no USD field)"
        )
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


VENUES = ["okx", "binance", "bybit", "bitget", "gate", "htx", "kucoin",
          "bingx", "bitmex", "deribit", "dydx", "hyperliquid"]


def _venue_fn(name: str):
    return globals()[f"fetch_{name}"]


def fetch_one(name: str, base: str, days: float = 7.0) -> FetchResult:
    _CTX.venue = name
    try:
        r = _venue_fn(name)(base=base, days=days)
        if not r.ok and r.error and r.error.startswith("NOTLISTED:"):
            r.unlisted = True
            r.error = r.error[len("NOTLISTED:"):].strip()
        return r
    except NotListed as e:
        return FetchResult(exchange=name, symbol=base, ok=False, error=str(e), unlisted=True)
    except Exception as e:  # never raise out of a venue
        return FetchResult(exchange=name, symbol=base, ok=False, error=str(e))


def fetch_all(days: float = 7.0, base: str = "ZEC", venues=None,
              venue_timeout: Optional[float] = None) -> list[FetchResult]:
    """Fetch all venues in parallel for <base>. Skip/record failures; never fake OI.

    Each venue gets a wall-clock budget (venue_timeout, default LIQ_VENUE_TIMEOUT or 25s);
    a slow venue is recorded as failed and abandoned (its thread is not awaited).
    """
    import concurrent.futures as cf
    venues = list(venues or VENUES)
    budget = venue_timeout or float(os.environ.get("LIQ_VENUE_TIMEOUT", "25"))
    ex = cf.ThreadPoolExecutor(max_workers=len(venues), thread_name_prefix="venue")
    futs = {name: ex.submit(fetch_one, name, base, days) for name in venues}
    start = time.time()
    results = []
    for name in venues:
        left = max(0.1, budget - (time.time() - start))
        try:
            r = futs[name].result(timeout=left)
        except cf.TimeoutError:
            r = FetchResult(exchange=name, symbol=base, ok=False, error=f"timeout after {budget:g}s")
        except Exception as e:
            r = FetchResult(exchange=name, symbol=base, ok=False, error=str(e))
        if r.ok:
            log.info("%s OK mid=%s oi_usd=%.0f points=%d mode=%s", name, r.mid,
                     r.current_oi_usd or 0, len(r.points), r.mode)
        else:
            log.warning("%s SKIPPED: %s", name, r.error)
        results.append(r)
    ex.shutdown(wait=False, cancel_futures=True) if hasattr(cf.ThreadPoolExecutor, "shutdown") else None
    return results


# ---------------------------------------------------------------------------
# Bitget (USDT-FUTURES ZECUSDT) — OI snapshot only (no public OI history)
# ---------------------------------------------------------------------------

def fetch_bitget(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    out = FetchResult(exchange="bitget", symbol=f"{base}USDT")
    s = _session()
    try:
        r0 = s.get(f"{BITGET}/api/v2/mix/market/ticker",
                   params={"productType": "USDT-FUTURES", "symbol": f"{base}USDT"}, timeout=REQ_TIMEOUT)
        if r0.status_code == 400 and ("40034" in r0.text or "not exist" in r0.text.lower()):
            raise NotListed(f"Bitget has no {base}USDT")
        t = _get(
            f"{BITGET}/api/v2/mix/market/ticker",
            {"productType": "USDT-FUTURES", "symbol": f"{base}USDT"},
            session=s,
        )
        if t.get("code") not in ("00000", 0, "0"):
            raise RuntimeError(str(t))
        row = (t.get("data") or [None])[0]
        if not row:
            raise RuntimeError(f"empty ticker: {t}")
        out.mid = float(row["lastPr"])
        holding = float(row.get("holdingAmount") or 0)
        out.current_oi_usd = holding * out.mid
        out.raw["ticker"] = row
        out.notes.append(
            f"OI USD = holdingAmount({holding:.3f} {base}) * last; no public OI history → snapshot"
        )
        # Mark candles for a thin path seed (optional); still snapshot without OI path
        try:
            kl = _get(
                f"{BITGET}/api/v2/mix/market/candles",
                {
                    "symbol": f"{base}USDT",
                    "productType": "USDT-FUTURES",
                    "granularity": "1H",
                    "limit": "100",
                },
                session=s,
            )
            out.raw["n_candles"] = len(kl.get("data") or [])
        except Exception as e:
            out.notes.append(f"candles skipped: {e}")
        out.points = [
            OIPoint(
                ts_ms=int(time.time() * 1000),
                oi_usd=out.current_oi_usd,
                oi_ccy=holding,
                price=out.mid,
                long_share=0.5,
            )
        ]
        out.mode = "snapshot"
        out.raw["ls_source"] = "default_50_50"
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# Gate.io (ZEC_USDT linear)
# ---------------------------------------------------------------------------

def fetch_gate(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    out = FetchResult(exchange="gate", symbol=f"{base}_USDT")
    s = _session()
    try:
        r0 = s.get(f"{GATE}/api/v4/futures/usdt/contracts/{base}_USDT", timeout=REQ_TIMEOUT)
        if r0.status_code in (400, 404) and ("NOT_FOUND" in r0.text.upper() or "INVALID" in r0.text.upper()):
            raise NotListed(f"Gate has no {base}_USDT")
        tickers = _get(
            f"{GATE}/api/v4/futures/usdt/tickers",
            {"contract": f"{base}_USDT"},
            session=s,
        )
        if not isinstance(tickers, list) or not tickers:
            raise RuntimeError(f"empty ticker: {tickers}")
        t0 = tickers[0]
        out.mid = float(t0["last"])
        # total_size = contracts; quanto_multiplier usually 0.01 ZEC
        try:
            info = _get(f"{GATE}/api/v4/futures/usdt/contracts/{base}_USDT", session=s)
            mult = float(info.get("quanto_multiplier") or 0.01)
            out.raw["instrument"] = info
        except Exception:
            mult = 0.01
        total_size = float(t0.get("total_size") or 0)
        mark = float(t0.get("mark_price") or out.mid)
        out.current_oi_usd = total_size * mult * mark
        out.raw["ticker"] = t0
        out.notes.append(
            f"current OI = total_size({total_size:.0f})*{mult}*mark({mark:.2f})"
        )

        now_s = int(time.time())
        from_s = now_s - int(days * 86400)
        limit = min(1000, max(24, int(days * 24) + 2))
        stats = _get(
            f"{GATE}/api/v4/futures/usdt/contract_stats",
            {
                "contract": f"{base}_USDT",
                "interval": "1h",
                "from": str(from_s),
                "limit": str(limit),
            },
            session=s,
        )
        if not isinstance(stats, list):
            raise RuntimeError(f"stats unexpected: {stats}")
        points: list[OIPoint] = []
        for row in stats:
            ts = int(row["time"]) * 1000
            oi_usd = float(row.get("open_interest_usd") or 0)
            px = float(row.get("mark_price") or out.mid)
            lsr = row.get("top_lsr_account")
            if lsr is None:
                lsr = row.get("lsr_account")
            if lsr is not None:
                ratio = float(lsr)
                long_share = ratio / (1.0 + ratio) if ratio >= 0 else 0.5
            else:
                long_share = 0.5
            points.append(
                OIPoint(
                    ts_ms=ts,
                    oi_usd=oi_usd,
                    oi_contracts=float(row.get("open_interest") or 0),
                    price=px,
                    long_share=long_share,
                )
            )
        points.sort(key=lambda p: p.ts_ms)
        out.points = points
        out.mode = "path" if len(points) >= 3 else "snapshot"
        out.raw["ls_source"] = "gate_top_lsr_account"
        out.notes.append(f"contract_stats points={len(points)} interval=1h")
        if not out.current_oi_usd and points:
            out.current_oi_usd = points[-1].oi_usd
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# HTX / Huobi linear swap ZEC-USDT
# ---------------------------------------------------------------------------

def fetch_htx(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    out = FetchResult(exchange="htx", symbol=f"{base}-USDT")
    s = _session()
    try:
        oi = _get(
            f"{HTX}/linear-swap-api/v1/swap_open_interest",
            {"contract_code": f"{base}-USDT"},
            session=s,
        )
        if oi.get("status") != "ok":
            if str(oi.get("err_code")) == "1014" or "exist" in str(oi.get("err_msg", "")).lower():
                raise NotListed(f"HTX has no {base}-USDT")
            raise RuntimeError(str(oi))
        row = (oi.get("data") or [None])[0]
        if not row:
            raise NotListed(f"HTX has no {base}-USDT (empty OI)")
        if False:
            raise RuntimeError(f"empty OI: {oi}")
        out.current_oi_usd = float(row["value"])
        out.raw["oi_now"] = row
        htx_ct = 0.01
        try:
            ci = _get(f"{HTX}/linear-swap-api/v1/swap_contract_info",
                      {"contract_code": f"{base}-USDT"}, session=s)
            htx_ct = float((ci.get("data") or [{}])[0].get("contract_size") or 0.01)
        except Exception:
            pass

        tick = _get(
            f"{HTX}/linear-swap-ex/market/detail/merged",
            {"contract_code": f"{base}-USDT"},
            session=s,
        )
        if tick.get("status") != "ok":
            raise RuntimeError(str(tick))
        out.mid = float(tick["tick"]["close"])
        out.raw["ticker"] = tick["tick"]

        size = min(200, max(24, int(days * 24) + 2))
        hist = _get(
            f"{HTX}/linear-swap-api/v1/swap_his_open_interest",
            {
                "contract_code": f"{base}-USDT",
                "period": "60min",
                "amount_type": "1",
                "size": str(size),
            },
            session=s,
        )
        if hist.get("status") != "ok":
            raise RuntimeError(str(hist))
        ticks = (hist.get("data") or {}).get("tick") or []

        kl = _get(
            f"{HTX}/linear-swap-ex/market/history/kline",
            {"contract_code": f"{base}-USDT", "period": "60min", "size": str(size)},
            session=s,
        )
        px_by_ts: dict[int, float] = {}
        if kl.get("status") == "ok":
            for c in kl.get("data") or []:
                # id is seconds
                px_by_ts[int(c["id"]) * 1000] = float(c["close"])
            out.notes.append(f"klines={len(px_by_ts)}")

        points: list[OIPoint] = []
        cutoff = int(time.time() * 1000) - int(days * 24 * 3600 * 1000)
        for t in ticks:
            ts = int(t["ts"])
            if ts < cutoff - 3600_000:
                continue
            px = px_by_ts.get(ts) or out.mid
            points.append(
                OIPoint(
                    ts_ms=ts,
                    oi_usd=float(t["value"]),
                    oi_contracts=float(t.get("volume") or 0),
                    oi_ccy=float(t.get("volume") or 0) * htx_ct,
                    price=float(px),
                    long_share=0.5,
                )
            )
        points.sort(key=lambda p: p.ts_ms)
        out.points = points
        out.mode = "path" if len(points) >= 3 else "snapshot"
        out.raw["ls_source"] = "default_50_50"
        out.notes.append(f"OI hist points={len(points)} period=60min")
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# KuCoin futures ZECUSDTM — snapshot (public OI history empty/404)
# ---------------------------------------------------------------------------

def fetch_kucoin(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    vb = venue_base("kucoin", base)
    out = FetchResult(exchange="kucoin", symbol=f"{vb}USDTM")
    s = _session()
    try:
        j = _get(f"{KUCOIN}/api/v1/contracts/{vb}USDTM", session=s)
        if not j.get("data") or str(j.get("code")) in ("40010", "300000", "404"):
            raise NotListed(f"KuCoin has no {vb}USDTM")
        if j.get("code") not in ("200000", 200000, "0", 0):
            raise RuntimeError(str(j))
        row = j["data"]
        out.mid = float(row["markPrice"])
        mult = float(row.get("multiplier") or 0.01)
        oi_contracts = float(row.get("openInterest") or 0)
        out.current_oi_usd = oi_contracts * mult * out.mid
        out.raw["instrument"] = {
            k: row[k]
            for k in (
                "symbol",
                "multiplier",
                "openInterest",
                "markPrice",
                "maxLeverage",
                "initialMargin",
            )
            if k in row
        }
        out.notes.append(
            f"OI USD = openInterest({oi_contracts:.0f})*{mult}*mark; no usable OI hist → snapshot"
        )
        out.points = [
            OIPoint(
                ts_ms=int(time.time() * 1000),
                oi_usd=out.current_oi_usd,
                oi_contracts=oi_contracts,
                price=out.mid,
                long_share=0.5,
            )
        ]
        out.mode = "snapshot"
        out.raw["ls_source"] = "default_50_50"
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# BingX ZEC-USDT — snapshot (no public OI history)
# ---------------------------------------------------------------------------

def fetch_bingx(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    out = FetchResult(exchange="bingx", symbol=f"{base}-USDT")
    s = _session()
    try:
        oi = _get(
            f"{BINGX}/openApi/swap/v2/quote/openInterest",
            {"symbol": f"{base}-USDT"},
            session=s,
        )
        if oi.get("code") not in (0, "0"):
            if any(k in str(oi.get("msg", "")).lower() for k in ("not exist", "offline")) or str(oi.get("code")) in ("109400", "80014", "109418"):
                raise NotListed(f"BingX has no {base}-USDT: {oi.get('msg')}")
            raise RuntimeError(str(oi))
        oi_row = oi["data"]
        # BingX returns USDT notional for openInterest on USDT-M swaps
        out.current_oi_usd = float(oi_row["openInterest"])
        out.raw["oi_now"] = oi_row

        tick = _get(
            f"{BINGX}/openApi/swap/v2/quote/ticker",
            {"symbol": f"{base}-USDT"},
            session=s,
        )
        if tick.get("code") not in (0, "0"):
            raise RuntimeError(str(tick))
        out.mid = float(tick["data"]["lastPrice"])
        out.raw["ticker"] = tick["data"]
        out.notes.append("OI from quote/openInterest (USDT notional); no OI hist → snapshot")
        out.points = [
            OIPoint(
                ts_ms=int(oi_row.get("time") or time.time() * 1000),
                oi_usd=out.current_oi_usd,
                price=out.mid,
                long_share=0.5,
            )
        ]
        out.mode = "snapshot"
        out.raw["ls_source"] = "default_50_50"
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# BitMEX — probe only (no ZEC linear as of 2026-09)
# ---------------------------------------------------------------------------

def _snapshot(out: FetchResult, base_qty: float = 0.0) -> FetchResult:
    out.points = [OIPoint(ts_ms=int(time.time() * 1000), oi_usd=out.current_oi_usd or 0,
                          oi_ccy=base_qty, price=out.mid, long_share=0.5)]
    out.mode = "snapshot"
    out.raw["ls_source"] = "default_50_50"
    out.ok = True
    return out


def fetch_bitmex(base: str = "ZEC", days: float = 7.0) -> FetchResult:
    """BitMEX: linear <X>USDT perp if open with OI; BTC also XBTUSD inverse (1 contract = 1 USD).

    Quanto contracts (e.g. ETHUSD, SOLUSD settled in XBT) are skipped: USD notional per
    contract depends on a quanto multiplier we don't want to mix in.
    """
    vb = venue_base("bitmex", base)
    out = FetchResult(exchange="bitmex", symbol=f"{vb}USDT")
    s = _session()
    cols = "symbol,typ,state,quoteCurrency,settlCurrency,openInterest,openValue,markPrice,lastPrice,underlyingToPositionMultiplier"
    try:
        cands = [f"{vb}USDT"] + (["XBTUSD"] if vb == "XBT" else [])
        oi_usd = 0.0
        used = []
        mid = None
        for sym in cands:
            rows = _get(f"{BITMEX}/api/v1/instrument", {"symbol": sym, "columns": cols}, session=s)
            row = rows[0] if isinstance(rows, list) and rows else None
            if not row or row.get("typ") != "FFWCSX" or row.get("state") != "Open" or not row.get("openInterest"):
                continue
            mark = float(row.get("markPrice") or row.get("lastPrice") or 0)
            if sym == "XBTUSD":
                usd = float(row["openInterest"])  # inverse: contracts are USD
            else:
                u2p = float(row.get("underlyingToPositionMultiplier") or 0)
                if not u2p:
                    continue
                usd = float(row["openInterest"]) / u2p * mark
            oi_usd += usd
            used.append(sym)
            mid = mid or mark
        if not used:
            raise NotListed(f"no open linear/inverse {vb} perp with OI on BitMEX")
        out.symbol = "+".join(used)
        out.mid = mid
        out.current_oi_usd = oi_usd
        out.notes.append(f"BitMEX {used} OI≈${oi_usd:,.0f} snapshot")
        return _snapshot(out)
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


def fetch_deribit(base: str = "ZEC", days: float = 7.0) -> FetchResult:
    """Deribit: <B>-PERPETUAL inverse (OI in USD; BTC/ETH) + <B>_USDC-PERPETUAL linear (OI in base)."""
    out = FetchResult(exchange="deribit", symbol=base)
    s = _session()
    try:
        oi_usd, used, mid = 0.0, [], None
        for inst, inverse in ((f"{base}-PERPETUAL", True), (f"{base}_USDC-PERPETUAL", False)):
            r = s.get(f"{DERIBIT}/api/v2/public/get_book_summary_by_instrument",
                      params={"instrument_name": inst}, timeout=REQ_TIMEOUT)
            if r.status_code in (403, 451):
                raise RuntimeError(f"HTTP {r.status_code} geo/blocked")
            res = (r.json() or {}).get("result") if r.status_code == 200 else None
            if not res:
                continue
            row = res[0]
            mark = float(row.get("mark_price") or 0)
            oi = float(row.get("open_interest") or 0)
            if not mark or not oi:
                continue
            oi_usd += oi if inverse else oi * mark
            used.append(inst)
            mid = mid or mark
        if not used:
            raise NotListed(f"no {base} perpetual on Deribit")
        out.symbol = "+".join(used)
        out.mid = mid
        out.current_oi_usd = oi_usd
        out.notes.append(f"Deribit {used} OI≈${oi_usd:,.0f} snapshot (USD-quoted mark)")
        return _snapshot(out)
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# dYdX v4 ZEC-USD (USD linear perpetual)
# ---------------------------------------------------------------------------

def fetch_dydx(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    out = FetchResult(exchange="dydx", symbol=f"{base}-USD")
    s = _session()
    try:
        markets = _get(f"{DYDX}/v4/perpetualMarkets", session=s)
        m = (markets.get("markets") or {}).get(f"{base}-USD")
        if not m or str(m.get("status", "ACTIVE")).upper() != "ACTIVE":
            raise NotListed(f"no active {base}-USD market on dYdX")
        out.mid = float(m.get("oraclePrice") or m.get("price") or 0)
        oi_base = float(m.get("openInterest") or 0)
        out.current_oi_usd = oi_base * out.mid
        out.raw["market"] = {
            k: m[k]
            for k in (
                "ticker",
                "status",
                "oraclePrice",
                "openInterest",
                "volume24H",
                "initialMarginFraction",
            )
            if k in m
        }
        limit = min(200, max(24, int(days * 24) + 2))
        candles = _get(
            f"{DYDX}/v4/candles/perpetualMarkets/{base}-USD",
            {"resolution": "1HOUR", "limit": str(limit)},
            session=s,
        )
        pts: list[OIPoint] = []
        for c in candles.get("candles") or []:
            # startedAt e.g. 2026-09-26T15:00:00.000Z
            from datetime import datetime as _dt

            started = c["startedAt"].replace("Z", "+00:00")
            ts = int(_dt.fromisoformat(started).timestamp() * 1000)
            px = float(c.get("close") or out.mid)
            oi_b = float(c.get("startingOpenInterest") or 0)
            pts.append(
                OIPoint(
                    ts_ms=ts,
                    oi_usd=oi_b * px,
                    oi_ccy=oi_b,
                    price=px,
                    long_share=0.5,
                )
            )
        pts.sort(key=lambda p: p.ts_ms)
        cutoff = int(time.time() * 1000) - int(days * 24 * 3600 * 1000)
        pts = [p for p in pts if p.ts_ms >= cutoff - 3600_000]
        out.points = pts
        out.mode = "path" if len(pts) >= 3 else "snapshot"
        out.raw["ls_source"] = "default_50_50"
        out.notes.append(
            f"OI base={oi_base:.2f} {base} → USD={out.current_oi_usd:.0f}; candles={len(pts)}"
        )
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


# ---------------------------------------------------------------------------
# Hyperliquid ZEC (USDC-margined perp) — snapshot (no public OI history)
# ---------------------------------------------------------------------------

def fetch_hyperliquid(
    base: str = "ZEC",
    days: float = 7.0) -> FetchResult:
    out = FetchResult(exchange="hyperliquid", symbol=base)
    s = _session()
    try:
        # POST metaAndAssetCtxs
        r = s.post(
            f"{HYPERLIQUID}/info",
            json={"type": "metaAndAssetCtxs"},
            timeout=REQ_TIMEOUT,
        )
        if r.status_code in (403, 451):
            raise RuntimeError(f"HTTP {r.status_code} geo/blocked")
        r.raise_for_status()
        meta, ctxs = r.json()
        names = [u["name"] for u in meta.get("universe") or []]
        if base not in names or (meta["universe"][names.index(base)] or {}).get("isDelisted"):
            raise NotListed(f"no {base} on Hyperliquid universe (multiplied names like k{base} not mapped)")
        i = names.index(base)
        ctx = ctxs[i]
        out.mid = float(ctx.get("markPx") or ctx.get("midPx") or 0)
        oi_coins = float(ctx.get("openInterest") or 0)
        out.current_oi_usd = oi_coins * out.mid
        out.raw["ctx"] = ctx
        out.raw["max_leverage"] = (meta["universe"][i] or {}).get("maxLeverage")
        out.notes.append(
            f"OI coins={oi_coins:.2f} * mark={out.mid:.2f}; maxLeverage={out.raw['max_leverage']}; no OI hist → snapshot"
        )
        # Optional candles for notes only
        try:
            now_ms = int(time.time() * 1000)
            start = now_ms - int(days * 86400 * 1000)
            cr = s.post(
                f"{HYPERLIQUID}/info",
                json={
                    "type": "candleSnapshot",
                    "req": {
                        "coin": base,
                        "interval": "1h",
                        "startTime": start,
                        "endTime": now_ms,
                    },
                },
                timeout=REQ_TIMEOUT,
            )
            if cr.ok:
                out.notes.append(f"candles={len(cr.json() or [])}")
        except Exception as e:
            out.notes.append(f"candles skipped: {e}")
        out.points = [
            OIPoint(
                ts_ms=int(time.time() * 1000),
                oi_usd=out.current_oi_usd,
                oi_ccy=oi_coins,
                price=out.mid,
                long_share=0.5,
            )
        ]
        out.mode = "snapshot"
        out.raw["ls_source"] = "default_50_50"
        out.ok = True
        return out
    except Exception as e:
        out.ok = False
        out.error = ("NOTLISTED: " if isinstance(e, NotListed) else "") + str(e)
        return out


def _decimals_of(tick: float) -> int:
    t = ("%.12f" % tick).rstrip("0")
    return len(t.split(".")[1]) if "." in t else 0


def fetch_tick_size(base: str, timeout: float = 6.0) -> tuple[Optional[float], str]:
    """Price tick for <base>USDT perp: OKX → Bybit → Binance instrument info. (None, '') if none."""
    s = _session()
    try:
        j = _get(f"{OKX}/api/v5/public/instruments", {"instType": "SWAP", "instId": f"{base}-USDT-SWAP"},
                 timeout=timeout, session=s)
        row = (j.get("data") or [None])[0]
        if row and float(row.get("tickSz") or 0) > 0:
            return float(row["tickSz"]), "okx"
    except Exception as e:
        log.info("okx tick failed: %s", e)
    try:
        _CTX.venue = "bybit"
        j = _get(f"{BYBIT}/v5/market/instruments-info", {"category": "linear", "symbol": f"{base}USDT"},
                 timeout=timeout, session=_session())
        lst = (j.get("result") or {}).get("list") or []
        if lst and float(lst[0]["priceFilter"]["tickSize"]) > 0:
            return float(lst[0]["priceFilter"]["tickSize"]), "bybit"
    except Exception as e:
        log.info("bybit tick failed: %s", e)
    for host in BINANCE_HOSTS:
        try:
            j = _get(f"{host}/fapi/v1/exchangeInfo", timeout=timeout, session=s)
            for sym in j.get("symbols") or []:
                if sym.get("symbol") == f"{base}USDT":
                    for f in sym.get("filters") or []:
                        if f.get("filterType") == "PRICE_FILTER" and float(f.get("tickSize") or 0) > 0:
                            return float(f["tickSize"]), "binance"
            break
        except Exception as e:
            log.info("binance tick failed: %s", e)
    return None, ""


# Legacy ZEC-named aliases (estimate_zec.py and older callers).
for _n in VENUES:
    globals()[f"fetch_{_n}_zec"] = (lambda f: (lambda days=7.0, **kw: f(base="ZEC", days=days, **kw)))(_venue_fn(_n))


# --- TH-FEAT-19 H2 helpers -------------------------------------------------

def fetch_binance_klines_1h(base: str, days: float = 7.0) -> list[dict]:
    """Return 1h OHLCV bars with quote volume for H2 entry weighting.

    Each item: {ts_ms, open, high, low, close, quote_vol}. Uses Binance USDT-M
    ``/fapi/v1/klines`` (index 7 = quote asset volume). Tries primary then www mirror.
    """
    import time as _time

    limit = min(1000, max(10, int(days * 24) + 2))
    end = int(_time.time() * 1000)
    start = end - int(days * 24 * 3600 * 1000)
    last_err: Exception | None = None
    for host in BINANCE_HOSTS:
        try:
            s = _session()
            data = _get(
                f"{host}/fapi/v1/klines",
                {
                    "symbol": f"{base}USDT",
                    "interval": "1h",
                    "startTime": str(start),
                    "endTime": str(end),
                    "limit": str(limit),
                },
                session=s,
            )
            if not isinstance(data, list):
                raise RuntimeError(f"unexpected klines: {data!r}")
            out = []
            for c in data:
                out.append(
                    {
                        "ts_ms": int(c[0]),
                        "open": float(c[1]),
                        "high": float(c[2]),
                        "low": float(c[3]),
                        "close": float(c[4]),
                        "quote_vol": float(c[7]),
                    }
                )
            return out
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
    raise RuntimeError(f"binance 1h klines failed: {last_err}")


def fetch_btc_oi_usd() -> float | None:
    """Best-effort Binance BTCUSDT one-sided OI in USD for alt tier scaling."""
    try:
        r = fetch_binance("BTC", days=1.0)
        if r.ok and r.current_oi_usd:
            return float(r.current_oi_usd)
        if r.ok and r.points:
            return float(r.points[-1].oi_usd)
    except Exception:
        return None
    return None
