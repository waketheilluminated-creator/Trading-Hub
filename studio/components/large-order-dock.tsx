import { useState } from "react";
import { SrWallControls } from "@/components/sr-wall-controls";
import { wallListEntries, type TrackedWall, type WallRangeSettings } from "@/lib/market-depth.ts";
import { topTradeEntries, type VenueTrade } from "@/lib/market-trades.ts";
import { venueLabel } from "@/lib/market-venues.ts";

type LargeOrderSection = "unfilled" | "executed";

type LargeOrderDockProps = {
  showUnfilled: boolean;
  showExecuted: boolean;
  walls: readonly TrackedWall[];
  /** TH-FEAT-14: already ranked Top 10 (by USD notional) within the visible chart range. */
  trades: readonly VenueTrade[];
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
  const tradeRows = topTradeEntries(trades);
  const both = showUnfilled && showExecuted;
  const section: LargeOrderSection = both ? preferredSection : showUnfilled ? "unfilled" : "executed";

  return <div className="large-order-dock" data-large-order-dock={collapsed ? "collapsed" : "open"}>
    {section === "unfilled" && <SrWallControls minNotional={minNotional} onMinNotional={onMinNotional} range={range} onRange={onRange} showRange={showUnfilled} />}
    <section className="large-order-list" aria-label="Large order lists">
      <header>
        {both ? <div className="large-order-tabs" role="tablist" aria-label="Large order sections">
          <button type="button" role="tab" aria-selected={section === "unfilled"} onClick={() => setPreferredSection("unfilled")}>Unfilled · {wallRows.length}</button>
          <button type="button" role="tab" aria-selected={section === "executed"} onClick={() => setPreferredSection("executed")}>Top {tradeRows.length} 大额成交</button>
        </div> : <strong>{section === "unfilled" ? `Unfilled · ${wallRows.length}` : `Top ${tradeRows.length} 大额成交`}</strong>}
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
      {!collapsed && section === "executed" && <ul aria-label="Top executed trades in view" data-top-trades={tradeRows.length}>
        <li className="top-trade-row top-trade-head" aria-hidden="true"><span>USD</span><span>Qty</span><span>Price</span><span>Time</span><span>Venue</span></li>
        {tradeRows.length === 0 ? <li className="large-order-empty">No large prints in the visible range.</li> : tradeRows.map((row) => <li key={row.key} className={`top-trade-row ${row.side}`} data-side={row.side}>
          <span className="top-trade-notional">{row.notionalLabel}<span className="large-order-bar" aria-hidden="true"><span style={{ width: `${row.barPct}%` }} /></span></span>
          <span className="top-trade-qty">{row.qtyLabel}</span>
          <span className="top-trade-price">{row.priceLabel}</span>
          <span className="top-trade-time">{row.timeLabel.replace(" UTC", "")}</span>
          <span className="top-trade-venue">{venueLabel(row.venue)}</span>
        </li>)}
      </ul>}
      {notice && <p className="large-order-error" role="status">{notice}</p>}
    </section>
  </div>;
}
