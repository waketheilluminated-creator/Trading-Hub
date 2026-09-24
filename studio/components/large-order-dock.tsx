import { useState } from "react";
import { SrWallControls } from "@/components/sr-wall-controls";
import { wallListEntries, type TrackedWall, type WallRangeSettings } from "@/lib/market-depth.ts";
import { tradeListEntries, type LargeTrade } from "@/lib/market-trades.ts";

type LargeOrderSection = "unfilled" | "executed";

type LargeOrderDockProps = {
  showUnfilled: boolean;
  showExecuted: boolean;
  walls: readonly TrackedWall[];
  trades: readonly LargeTrade[];
  now: number;
  minNotional: number;
  onMinNotional(value: number): void;
  range: WallRangeSettings;
  onRange(next: WallRangeSettings): void;
  notice: string | null;
};

export function LargeOrderDock({
  showUnfilled,
  showExecuted,
  walls,
  trades,
  now,
  minNotional,
  onMinNotional,
  range,
  onRange,
  notice,
}: LargeOrderDockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [preferredSection, setPreferredSection] = useState<LargeOrderSection>("unfilled");
  const wallRows = wallListEntries(walls, now);
  const tradeRows = tradeListEntries(trades);
  const both = showUnfilled && showExecuted;
  const section: LargeOrderSection = both ? preferredSection : showUnfilled ? "unfilled" : "executed";

  return <div className="large-order-dock" data-large-order-dock={collapsed ? "collapsed" : "open"}>
    <SrWallControls minNotional={minNotional} onMinNotional={onMinNotional} range={range} onRange={onRange} showRange={showUnfilled} />
    <section className="large-order-list" aria-label="Large order lists">
      <header>
        {both ? <div className="large-order-tabs" role="tablist" aria-label="Large order sections">
          <button type="button" role="tab" aria-selected={section === "unfilled"} onClick={() => setPreferredSection("unfilled")}>Unfilled · {wallRows.length}</button>
          <button type="button" role="tab" aria-selected={section === "executed"} onClick={() => setPreferredSection("executed")}>Executed · {tradeRows.length}</button>
        </div> : <strong>{section === "unfilled" ? `Unfilled · ${wallRows.length}` : `Executed · ${tradeRows.length}`}</strong>}
        <button
          type="button"
          className="large-order-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand large order list" : "Collapse large order list"}
          title={collapsed ? "Expand large order list" : "Collapse large order list"}
          onClick={() => setCollapsed((value) => !value)}
        >{collapsed ? "⌃" : "⌄"}</button>
      </header>
      {!collapsed && section === "unfilled" && <ul aria-label="Unfilled large orders">
        {wallRows.length === 0 ? <li className="large-order-empty">No resting walls above the minimum.</li> : wallRows.map((row) => <li key={`${row.side}-${row.price}`} className={`large-order-row ${row.side}`}>
          <span className={`large-order-price ${row.side}`}>{row.priceLabel}</span>
          <span className="large-order-amount">
            <span className="large-order-notional">{row.notionalLabel}</span>
            <span className="large-order-bar" aria-hidden="true"><span style={{ width: `${row.barPct}%` }} /></span>
          </span>
          <span className="large-order-meta">{row.ageLabel}</span>
        </li>)}
      </ul>}
      {!collapsed && section === "executed" && <ul aria-label="Executed large trades">
        {tradeRows.length === 0 ? <li className="large-order-empty">No large prints in the latest trades.</li> : tradeRows.map((row) => <li key={`${row.side}-${row.time}-${row.price}`} className={`large-order-row ${row.side}`}>
          <span className={`large-order-price ${row.side}`}>{row.priceLabel}</span>
          <span className="large-order-amount">
            <span className="large-order-notional">{row.notionalLabel}</span>
            <span className="large-order-bar" aria-hidden="true"><span style={{ width: `${row.barPct}%` }} /></span>
          </span>
          <span className="large-order-meta">{row.clockLabel}</span>
        </li>)}
      </ul>}
      {notice && <p className="large-order-error" role="status">{notice}</p>}
    </section>
  </div>;
}
