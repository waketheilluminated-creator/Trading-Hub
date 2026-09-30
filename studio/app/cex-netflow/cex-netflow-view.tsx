"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  LineSeries,
  LineStyle,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { DeskHeader } from "@/components/desk-header.tsx";
import { RegimeBandPrimitive } from "@/lib/cex-netflow-bands.ts";
import {
  CEX_NETFLOW_COLORS,
  CEX_NETFLOW_EN_LABEL,
  CEX_NETFLOW_WATERMARK,
  CEX_NETFLOW_ZH_LABEL,
  cexNetflowChartPoints,
  flowLineData,
  formatBtcPrice,
  formatReserveBtc,
  formatSignal,
  formatUpdatedAt,
  maLineData,
  priceLineData,
  readoutAt,
  regimeBands,
  showProxyWatermark,
  type CexNetflowReadout,
  type CexNetflowSnapshot,
} from "@/lib/cex-netflow.ts";

function seriesValue(param: MouseEventParams<Time>, series: ISeriesApi<"Line">): number | null {
  const row = param.seriesData.get(series) as LineData<Time> | undefined;
  if (!row || typeof row.value !== "number" || !Number.isFinite(row.value)) return null;
  return row.value;
}

function toLine(points: readonly { time: number; value: number }[]) {
  return points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
}

export function CexNetflowView({ snapshot, problem }: { snapshot: CexNetflowSnapshot | null; problem: string | null }) {
  const points = useMemo(() => cexNetflowChartPoints(snapshot?.series ?? []), [snapshot]);
  const [readout, setReadout] = useState<CexNetflowReadout>(() => readoutAt(points, null));
  const chartHost = useRef<HTMLDivElement>(null);
  const watermark = snapshot ? showProxyWatermark(snapshot) : false;

  useEffect(() => {
    const host = chartHost.current;
    if (!host || !snapshot || points.length === 0) return;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: CEX_NETFLOW_COLORS.chartBackground },
        textColor: "#3e4856",
        fontFamily: "var(--font-geist-mono)",
        fontSize: 10,
      },
      grid: { vertLines: { color: "rgba(214, 220, 228, 0.85)" }, horzLines: { color: "rgba(214, 220, 228, 0.85)" } },
      leftPriceScale: { visible: true, borderColor: "#d5dbe3" },
      rightPriceScale: { visible: true, borderColor: "#d5dbe3" },
      timeScale: { borderColor: "#d5dbe3", timeVisible: false, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        vertLine: { color: "#5c6b80", width: 1, labelBackgroundColor: "#111111" },
        horzLine: { color: "#5c6b80", width: 1, labelBackgroundColor: "#111111" },
      },
    });
    const flowSeries = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: CEX_NETFLOW_COLORS.flow,
      lineWidth: 2 as const,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
      title: snapshot.axes.flowBtc.label,
      priceFormat: { type: "custom" as const, minMove: 1, formatter: (price: number) => `${(price / 1e6).toFixed(3)}M` },
    });
    const maSeries = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: CEX_NETFLOW_COLORS.ma,
      lineWidth: 2 as const,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      title: `${snapshot.maWindowDays}d MA`,
      priceFormat: { type: "custom" as const, minMove: 1, formatter: (price: number) => `${(price / 1e6).toFixed(3)}M` },
    });
    const priceSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: CEX_NETFLOW_COLORS.price,
      lineWidth: 2 as const,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
      title: snapshot.axes.priceUsd.label,
      priceFormat: { type: "custom" as const, minMove: 1, formatter: (price: number) => `$${Math.round(price).toLocaleString("en-US")}` },
    });
    flowSeries.setData(toLine(flowLineData(points)));
    maSeries.setData(toLine(maLineData(points)));
    priceSeries.setData(toLine(priceLineData(points)));
    flowSeries.attachPrimitive(new RegimeBandPrimitive(regimeBands(points)));
    chart.timeScale().fitContent();

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const time = typeof param.time === "number" ? param.time : null;
      if (time == null) {
        setReadout(readoutAt(points, null));
        return;
      }
      const flowBtc = seriesValue(param, flowSeries);
      const priceUsd = seriesValue(param, priceSeries);
      const base = readoutAt(points, time);
      const next = flowBtc == null && priceUsd == null
        ? base
        : { ...base, time, flowBtc: flowBtc ?? base.flowBtc, priceUsd: priceUsd ?? base.priceUsd };
      setReadout((current) => (
        current.time === next.time && current.flowBtc === next.flowBtc && current.flowMa90 === next.flowMa90 && current.priceUsd === next.priceUsd && current.signal === next.signal
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
    <main className="desk-shell" data-page="cex-netflow">
      <DeskHeader section="Net Flow" />
      <div className="desk-body">
        {snapshot ? (
          <>
            <div className="desk-title-row">
              <div>
                <p className="desk-kicker">{CEX_NETFLOW_ZH_LABEL}</p>
                <h1>{snapshot.title}</h1>
                <p className="desk-asof" data-signal={readout.signal ?? "none"}>
                  {CEX_NETFLOW_EN_LABEL} · {readout.date ?? "—"} · {formatSignal(readout.signal)}
                </p>
              </div>
            </div>
            <p className="desk-note" role="note">{snapshot.disclaimer}</p>
            <p className="desk-meta">
              {snapshot.axes.flowBtc.label} ({snapshot.axes.flowBtc.unit}) · {snapshot.axes.priceUsd.label} ({snapshot.axes.priceUsd.unit}) · {snapshot.signalRule}
            </p>
            <p className="desk-source">Updated {formatUpdatedAt(snapshot.updatedAt)} · {snapshot.source} · {snapshot.series.length} daily points</p>
            <ul className="cex-netflow-legend">
              <li>
                <i data-series="flow" style={{ background: CEX_NETFLOW_COLORS.flow }} />
                <span>{snapshot.axes.flowBtc.label}</span>
                <strong>{formatReserveBtc(readout.flowBtc)}</strong>
                <em>{snapshot.axes.flowBtc.unit}</em>
              </li>
              <li>
                <i data-series="ma" style={{ borderBottom: `2px dashed ${CEX_NETFLOW_COLORS.ma}` }} />
                <span>{snapshot.maWindowDays}d MA</span>
                <strong>{formatReserveBtc(readout.flowMa90)}</strong>
                <em>{snapshot.axes.flowBtc.unit}</em>
              </li>
              <li>
                <i data-series="price" style={{ background: CEX_NETFLOW_COLORS.price }} />
                <span>{snapshot.axes.priceUsd.label}</span>
                <strong>{formatBtcPrice(readout.priceUsd)}</strong>
                <em>{snapshot.axes.priceUsd.unit}</em>
              </li>
              <li>
                <i data-series={readout.signal ?? "none"} style={{ background: readout.signal === "bull" ? CEX_NETFLOW_COLORS.bull : CEX_NETFLOW_COLORS.bear }} />
                <span>Regime vs {snapshot.maWindowDays}d MA</span>
                <strong className={readout.signal === "bear" ? "flow-outflow" : "flow-inflow"}>{formatSignal(readout.signal)}</strong>
              </li>
            </ul>
            {points.length ? (
              <div className="cex-netflow-chart-wrap">
                {watermark ? <p className="cex-netflow-watermark">{CEX_NETFLOW_WATERMARK}</p> : null}
                <div ref={chartHost} className="cex-netflow-chart" role="img" aria-label="Exchange reserve proxy, 90-day average, and BTC price" />
              </div>
            ) : <p className="desk-empty">No exchange reserve points in the sample.</p>}
          </>
        ) : <p className="desk-error" role="alert">{problem ?? "Exchange net flow sample is unavailable."}</p>}
      </div>
    </main>
  );
}
