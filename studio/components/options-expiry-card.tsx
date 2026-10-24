"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_STRIKE_BAND,
  OPTIONS_OI_ERRORS,
  clipStrikes,
  formatDistancePct,
  formatExpiryChoice,
  formatOptionsFooter,
  formatOptionsHeadline,
  formatOptionsKicker,
  formatSpotUsd,
  formatStrike,
  isOptionsCurrency,
  layoutOptionsChart,
  parseOptionsOiSnapshot,
  type OptionsCurrency,
  type OptionsOiSnapshot,
} from "@/lib/options-oi.ts";

const CHART_HEIGHT = 168;
const POLL_MS = 60_000;

export function OptionsExpiryCard() {
  const [currency, setCurrency] = useState<OptionsCurrency>("BTC");
  const [expiry, setExpiry] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const [snapshot, setSnapshot] = useState<OptionsOiSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(260);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const next = Math.max(180, Math.floor(host.clientWidth));
      setChartWidth((current) => (current === next ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const load = () => {
      const params = new URLSearchParams({ currency });
      if (expiry) params.set("expiry", expiry);
      fetch(`/api/options-oi?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const body: unknown = await response.json().catch(() => null);
          if (!active) return;
          if (!response.ok) {
            setSnapshot(null);
            setError(readError(body));
            return;
          }
          const parsed = parseOptionsOiSnapshot(body);
          if (!parsed || parsed.currency !== currency || (expiry != null && parsed.expiry !== expiry)) {
            setSnapshot(null);
            setError(OPTIONS_OI_ERRORS.upstream);
            return;
          }
          setError(null);
          setSnapshot(parsed);
        })
        .catch(() => {
          if (!active || controller.signal.aborted) return;
          setSnapshot(null);
          setError(OPTIONS_OI_ERRORS.upstream);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [currency, expiry]);

  const visible = snapshot ? clipStrikes(snapshot.strikes, snapshot.spot, snapshot.maxPain, wide ? null : DEFAULT_STRIKE_BAND) : [];
  const layout = snapshot ? layoutOptionsChart(visible, snapshot.spot, snapshot.maxPain, snapshot.distancePct, chartWidth, CHART_HEIGHT) : null;
  const distance = snapshot ? formatDistancePct(snapshot.distancePct) : null;

  return (
    <div className="options-card" data-options-card={currency}>
      {snapshot ? (
        <>
          <p className="options-kicker">{formatOptionsKicker(snapshot.currency, snapshot.expiry)}</p>
          <p className="options-headline">{formatOptionsHeadline(snapshot.totalOiUsd, snapshot.putCallRatio)}</p>
        </>
      ) : (
        <p className="options-kicker">Options expiry</p>
      )}
      <div className="options-toolbar">
        <select
          className="currency"
          aria-label="Options currency"
          value={currency}
          onChange={(event) => {
            if (!isOptionsCurrency(event.target.value)) return;
            setCurrency(event.target.value);
            setExpiry(null);
            setWide(false);
          }}
        >
          <option value="BTC">BTC</option>
          <option value="ETH">ETH</option>
        </select>
        <select
          aria-label="Options expiry"
          value={expiry ?? snapshot?.expiry ?? ""}
          onChange={(event) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setExpiry(event.target.value);
          }}
        >
          {!snapshot ? <option value="">Expiry</option> : null}
          {snapshot?.expiries.map((row) => (
            <option key={row.expiry} value={row.expiry}>{formatExpiryChoice(row.expiry)}</option>
          ))}
        </select>
        <button type="button" className="options-icon-button" aria-label={wide ? "Clip strikes to within 40% of spot" : "Show all strikes"} aria-pressed={wide} title={wide ? "Clip strikes to within 40% of spot" : "Show all strikes"} onClick={() => setWide((value) => !value)}>
          <RangeIcon wide={wide} />
        </button>
      </div>
      {snapshot ? (
        <p className="options-legend">
          <span><i className="options-swatch-call" />Call OI</span>
          <span><i className="options-swatch-put" />Put OI, {snapshot.currency}</span>
        </p>
      ) : null}
      <div className="options-chart-host" ref={hostRef}>
        {error ? <p className="options-status error" role="alert">{error}</p> : null}
        {!error && !layout ? <p className="options-status">Loading options…</p> : null}
        {!error && layout && snapshot ? (
          <svg className="options-chart" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={chartLabel(snapshot, distance)}>
            {layout.band ? <rect className="options-band" x={layout.band.x} y={layout.plotTop} width={layout.band.width} height={layout.plotBottom - layout.plotTop} /> : null}
            {layout.bars.map((bar) => (
              <g key={bar.strike}>
                {bar.callH > 0 ? <rect className="options-bar-call" x={bar.x} y={bar.callY} width={bar.width} height={bar.callH} /> : null}
                {bar.putH > 0 ? <rect className="options-bar-put" x={bar.x} y={bar.putY} width={bar.width} height={bar.putH} /> : null}
              </g>
            ))}
            <line className="options-axis" x1={layout.plotLeft} x2={layout.plotRight} y1={layout.zeroY} y2={layout.zeroY} />
            {layout.maxPain ? <line className="options-marker" x1={layout.maxPain.x} x2={layout.maxPain.x} y1={layout.plotTop} y2={layout.plotBottom} strokeDasharray="3 3"><title>{`Max pain ${snapshot.maxPain == null ? "" : formatStrike(snapshot.maxPain)}`}</title></line> : null}
            {layout.spot ? <line className="options-marker options-marker-spot" x1={layout.spot.x} x2={layout.spot.x} y1={layout.plotTop} y2={layout.plotBottom} strokeDasharray="3 3"><title>{`Spot ${formatSpotUsd(snapshot.spot)}`}</title></line> : null}
            {layout.distance ? <text className="options-distance" x={layout.distance.x} y={layout.distance.y} textAnchor="middle">{layout.distance.text}</text> : null}
            {layout.ticks.map((tick) => (
              <text key={tick.text} className="options-tick" x={tick.x} y={layout.height - 6} textAnchor="middle">{tick.text}</text>
            ))}
          </svg>
        ) : null}
      </div>
      {snapshot ? (
        <p className="options-markers">
          <span>max pain {snapshot.maxPain == null ? "—" : formatStrike(snapshot.maxPain)}</span>
          <span>spot {formatSpotUsd(snapshot.spot)}</span>
        </p>
      ) : null}
      {snapshot ? <p className="options-footnote">{formatOptionsFooter(snapshot)}</p> : null}
    </div>
  );
}

function RangeIcon({ wide }: { wide: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      {wide
        ? <path d="M5 2.5V5H2.5M9 2.5V5h2.5M5 11.5V9H2.5M9 11.5V9h2.5" />
        : <path d="M2.5 5V2.5H5M11.5 5V2.5H9M2.5 9v2.5H5M11.5 9v2.5H9" />}
    </svg>
  );
}

function chartLabel(snapshot: OptionsOiSnapshot, distance: string | null): string {
  const pain = snapshot.maxPain == null ? "max pain unavailable" : `max pain ${formatStrike(snapshot.maxPain)}`;
  return `${formatOptionsKicker(snapshot.currency, snapshot.expiry)}. ${formatOptionsHeadline(snapshot.totalOiUsd, snapshot.putCallRatio)}. ${pain}, spot ${formatSpotUsd(snapshot.spot)}${distance ? `, ${distance}` : ""}.`;
}

function readError(body: unknown): string {
  if (!body || typeof body !== "object" || !("error" in body)) return OPTIONS_OI_ERRORS.upstream;
  const message = (body as { error?: unknown }).error;
  if (typeof message !== "string" || message.length > 160 || /[<>]/.test(message)) return OPTIONS_OI_ERRORS.upstream;
  return message;
}
