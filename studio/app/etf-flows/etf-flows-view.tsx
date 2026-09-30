"use client";

import { useState } from "react";
import { DeskHeader } from "@/components/desk-header.tsx";
import {
  etfCardAmount,
  etfCardTone,
  formatEtfCardAmount,
  formatFlowCell,
  flowTone,
  type EtfFlowsSnapshot,
  type EtfUnit,
} from "@/lib/etf-flows.ts";

export function EtfFlowsView({ snapshot, problem }: { snapshot: EtfFlowsSnapshot | null; problem: string | null }) {
  const [unit, setUnit] = useState<EtfUnit>(snapshot?.unitDefault ?? "USD");
  const activeUnit = snapshot?.units.includes(unit) ? unit : snapshot?.unitDefault ?? "USD";

  return (
    <main className="desk-shell" data-page="etf-flows">
      <DeskHeader section="ETF Flows" />
      <div className="desk-body">
        {snapshot ? <EtfFlowsBody snapshot={snapshot} unit={activeUnit} onUnit={setUnit} /> : <p className="desk-error" role="alert">{problem ?? "ETF flow sample is unavailable."}</p>}
      </div>
    </main>
  );
}

function EtfFlowsBody({
  snapshot,
  unit,
  onUnit,
}: {
  snapshot: EtfFlowsSnapshot;
  unit: EtfUnit;
  onUnit: (unit: EtfUnit) => void;
}) {
  const columns = [...snapshot.tickers, "Total"];
  return (
    <>
      <div className="desk-title-row">
        <div>
          <p className="desk-kicker">US spot Bitcoin</p>
          <h1>ETF Flows</h1>
          <p className="desk-asof">{`As of ${snapshot.asOfDate}`}</p>
        </div>
        <div className="unit-toggle" role="group" aria-label="Flow unit">
          {snapshot.units.map((option) => (
            <button key={option} type="button" aria-pressed={unit === option} onClick={() => onUnit(option)}>{option}</button>
          ))}
        </div>
      </div>
      {snapshot.lagNote ? <p className="desk-note">{snapshot.lagNote}</p> : null}
      <section className="etf-cards" aria-label="ETF flow summary">
        {snapshot.cards.map((card) => {
          const amount = etfCardAmount(card, unit);
          return (
            <article key={card.id} className="etf-card" data-card={card.id}>
              <span>{card.label}</span>
              <strong className={`flow-${etfCardTone(card.id, amount)}`}>{formatEtfCardAmount(amount, unit)}</strong>
              <small>{unit === "BTC" && amount == null ? "BTC unavailable" : unit}</small>
            </article>
          );
        })}
      </section>
      {snapshot.rows.length ? (
        <div className="etf-table-wrap">
          <table className="etf-table">
            <caption>{unit === "USD" ? "Daily net flow in USD millions, newest first." : "Daily net flow in BTC, newest first."}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {columns.map((ticker) => <th key={ticker} scope="col" className={ticker === "Total" ? "total" : undefined}>{ticker}</th>)}
              </tr>
            </thead>
            <tbody>
              {snapshot.rows.map((row) => {
                const flows = unit === "USD" ? row.flowsUsdM : row.flowsBtc;
                return (
                  <tr key={row.date}>
                    <th scope="row">{row.date}</th>
                    {columns.map((ticker) => {
                      const value = flows[ticker] ?? null;
                      return <td key={ticker} className={`flow-${flowTone(value)}${ticker === "Total" ? " total" : ""}`}>{formatFlowCell(value, unit)}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="desk-empty">No flow rows in the sample.</p>}
      {snapshot.source ? <p className="desk-source">Farside daily matrix · SoSoValue summary cards · sample fixture</p> : null}
    </>
  );
}
