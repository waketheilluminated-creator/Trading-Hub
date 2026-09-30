"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  LineSeries,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { DeskHeader } from "@/components/desk-header.tsx";
import {
  CVD_OI_COLORS,
  CVD_OI_PANES,
  cvdOiLinePoints,
  formatCvdOiPrice,
  formatCvdOiTime,
  formatCvdOiUsd,
  readoutAt,
  type CvdOiReadout,
  type CvdOiSnapshot,
} from "@/lib/cvd-oi.ts";

const compactUsd = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

function seriesValue(param: MouseEventParams<Time>, series: ISeriesApi<"Line">): number | null {
  const row = param.seriesData.get(series) as LineData<Time> | undefined;
  if (!row || typeof row.value !== "number" || !Number.isFinite(row.value)) return null;
  return row.value;
}

export function CvdOiView({ snapshot, problem }: { snapshot: CvdOiSnapshot | null; problem: string | null }) {
  const points = useMemo(() => cvdOiLinePoints(snapshot?.series ?? []), [snapshot]);
  const [readout, setReadout] = useState<CvdOiReadout>(() => readoutAt(points, null));
  const chartHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = chartHost.current;
    if (!host || !snapshot || points.length === 0) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: CVD_OI_COLORS.chartBackground },
        textColor: "#3e4856",
        fontFamily: "var(--font-geist-mono)",
        fontSize: 10,
        panes: { separatorColor: "#d5dbe3", separatorHoverColor: "rgba(17, 17, 17, 0.16)", enableResize: true },
      },
      grid: { vertLines: { color: "#e6ebf1" }, horzLines: { color: "#e6ebf1" } },
      rightPriceScale: { borderColor: "#d5dbe3" },
      timeScale: { borderColor: "#d5dbe3", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: {
        vertLine: { color: "#5c6b80", width: 1, labelBackgroundColor: "#111111" },
        horzLine: { color: "#5c6b80", width: 1, labelBackgroundColor: "#111111" },
      },
    });
    const priceOptions = {
      color: CVD_OI_COLORS.price,
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
      title: snapshot.axes.price.label,
      priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
    };
    const oiOptions = {
      color: CVD_OI_COLORS.oiUsd,
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
      title: snapshot.axes.oiUsd.label,
      priceFormat: { type: "custom" as const, minMove: 1, formatter: (price: number) => compactUsd.format(price) },
    };
    const cvdOptions = {
      color: CVD_OI_COLORS.cvdUsd,
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
      title: snapshot.axes.cvdUsd.label,
      priceFormat: { type: "custom" as const, minMove: 1, formatter: (price: number) => compactUsd.format(price) },
    };
    const priceSeries = chart.addSeries(LineSeries, priceOptions, CVD_OI_PANES.price);
    const oiSeries = chart.addSeries(LineSeries, oiOptions, CVD_OI_PANES.oiUsd);
    const cvdSeries = chart.addSeries(LineSeries, cvdOptions, CVD_OI_PANES.cvdUsd);
    const line = (pick: (point: (typeof points)[number]) => number) => points.map((point) => ({ time: point.time as UTCTimestamp, value: pick(point) }));
    priceSeries.setData(line((point) => point.price));
    oiSeries.setData(line((point) => point.oiUsd));
    cvdSeries.setData(line((point) => point.cvdUsd));
    const panes = chart.panes();
    panes[CVD_OI_PANES.price]?.setStretchFactor(1.2);
    panes[CVD_OI_PANES.oiUsd]?.setStretchFactor(0.72);
    panes[CVD_OI_PANES.cvdUsd]?.setStretchFactor(0.72);
    chart.timeScale().fitContent();

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const time = typeof param.time === "number" ? param.time : null;
      if (time == null) {
        setReadout(readoutAt(points, null));
        return;
      }
      const price = seriesValue(param, priceSeries);
      const oiUsd = seriesValue(param, oiSeries);
      const cvdUsd = seriesValue(param, cvdSeries);
      const next = price == null && oiUsd == null && cvdUsd == null
        ? readoutAt(points, time)
        : { time, price, oiUsd, cvdUsd };
      setReadout((current) => (
        current.time === next.time && current.price === next.price && current.oiUsd === next.oiUsd && current.cvdUsd === next.cvdUsd
          ? current
          : next
      ));
    };
    chart.subscribeCrosshairMove(onCrosshair);
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
    };
  }, [points, snapshot]);

  return (
    <main className="desk-shell" data-page="cvd-oi">
      <DeskHeader section="CVD / OI" />
      <div className="desk-body">
        {snapshot ? (
          <>
            <div className="desk-title-row">
              <div>
                <p className="desk-kicker">{snapshot.symbol} · Binance</p>
                <h1>CVD / OI / Price</h1>
                <p className="desk-asof">{formatCvdOiTime(readout.time)}</p>
              </div>
            </div>
            {snapshot.note ? <p className="desk-note" role="note">{snapshot.note}</p> : null}
            <p className="desk-meta">Shared time axis · synced crosshair · {snapshot.series.length} hourly points</p>
            <ul className="cvd-oi-legend">
              <li>
                <i data-series="price" style={{ background: CVD_OI_COLORS.price }} />
                <span>{snapshot.axes.price.label}</span>
                <strong>{formatCvdOiPrice(readout.price)}</strong>
                <em>{snapshot.axes.price.unit}</em>
              </li>
              <li>
                <i data-series="oi" style={{ background: CVD_OI_COLORS.oiUsd }} />
                <span>{snapshot.axes.oiUsd.label}</span>
                <strong>{formatCvdOiUsd(readout.oiUsd)}</strong>
                <em>{snapshot.axes.oiUsd.unit}</em>
              </li>
              <li>
                <i data-series="cvd" style={{ background: CVD_OI_COLORS.cvdUsd }} />
                <span>{snapshot.axes.cvdUsd.label}</span>
                <strong className={readout.cvdUsd != null && readout.cvdUsd < 0 ? "flow-outflow" : "flow-inflow"}>{formatCvdOiUsd(readout.cvdUsd)}</strong>
                <em>{snapshot.axes.cvdUsd.unit}</em>
              </li>
            </ul>
            {points.length ? <div ref={chartHost} className="cvd-oi-chart" role="img" aria-label="BTC price, open interest, and cumulative net taker volume" /> : <p className="desk-empty">No CVD/OI points in the sample.</p>}
          </>
        ) : <p className="desk-error" role="alert">{problem ?? "CVD/OI sample is unavailable."}</p>}
      </div>
    </main>
  );
}
