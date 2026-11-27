import type { ReactNode } from "react";

type OverlayTogglesProps = {
  unfilledLargeOrdersVisible: boolean;
  onUnfilledLargeOrdersToggle(): void;
  executedLargeTradesVisible: boolean;
  onExecutedLargeTradesToggle(): void;
  liqHeatmapVisible: boolean;
  onLiqHeatmapToggle(): void;
  liqRefreshState?: "idle" | "loading" | "cooldown" | "unsupported";
  liqRefreshCooldownSec?: number;
  onLiqRefresh?(): void;
};

const IconFrame = ({ children }: { children: ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">{children}</svg>
);

function LiqRefreshIcon() {
  return <IconFrame><path d="M15.5 8.5A5.6 5.6 0 0 0 5 6.6M4.5 11.5A5.6 5.6 0 0 0 15 13.4" /><path d="M5 3.4v3.3h3.3M15 16.6v-3.3h-3.3" /></IconFrame>;
}

function LargeOrderSrIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-icon="large-order-sr">
      <rect x="9.2" y="2.5" width="1.6" height="15" rx=".5" fill="currentColor" stroke="none" opacity="0.55" />
      <rect x="4.5" y="3.6" width="4" height="2.2" rx=".6" fill="currentColor" stroke="none" opacity="0.6" />
      <rect x="1.8" y="7.2" width="6.7" height="2.6" rx=".6" fill="currentColor" stroke="none" />
      <rect x="11.5" y="10.6" width="3.2" height="2.2" rx=".6" fill="currentColor" stroke="none" opacity="0.6" />
      <rect x="11.5" y="14" width="6.7" height="2.6" rx=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LargeTradesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-icon="large-trades">
      <circle cx="5" cy="11.5" r="2.2" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="11.2" cy="7.2" r="3.4" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12.2" r="1.6" fill="currentColor" stroke="none" opacity="0.7" />
      <rect x="2" y="16.2" width="16" height="1.3" rx=".6" fill="currentColor" stroke="none" opacity="0.55" />
    </svg>
  );
}

function LiqHeatmapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-icon="liq-heatmap">
      <path fill="currentColor" stroke="none" d="M10.2 1.7c.2 2.2-1.1 3.4-2.1 4.9-1.2 1.6-2.4 3.2-2.4 5.3 0 2.8 2.1 5 4.6 5s4.5-2.1 4.5-4.9c0-1.7-.8-2.9-1.6-4-.3 1.2-1 1.9-1.8 1.9.8-1.8.5-3.6-.2-5-.7-1.3-1.1-2.4-1-3.2Z" />
    </svg>
  );
}

/** Order-flow and liquidation toggles. They live on the chart toolbar so the left rail can stay a drawing rail. */
export function OverlayToggles({
  unfilledLargeOrdersVisible,
  onUnfilledLargeOrdersToggle,
  executedLargeTradesVisible,
  onExecutedLargeTradesToggle,
  liqHeatmapVisible,
  onLiqHeatmapToggle,
  liqRefreshState = "unsupported",
  liqRefreshCooldownSec = 0,
  onLiqRefresh,
}: OverlayTogglesProps) {
  const unfilledLabel = unfilledLargeOrdersVisible ? "Hide unfilled large orders" : "Show unfilled large orders";
  const executedLabel = executedLargeTradesVisible ? "Hide executed large trades" : "Show executed large trades";
  const liqLabel = liqHeatmapVisible ? "Hide liquidation heatmap" : "Show liquidation heatmap";

  return (
    <div className="overlay-toggles" aria-label="Chart overlays">
      <div className="rail-group" role="group" aria-label="订单流" data-rail-group="orderflow">
        <button
          type="button"
          className={`tool-button ${unfilledLargeOrdersVisible ? "active" : ""}`}
          aria-label={unfilledLabel}
          aria-pressed={unfilledLargeOrdersVisible}
          data-rail-tool="large-orders"
          title={`大额挂单（盘口墙）：标出订单簿里尚未成交的大额买/卖挂单价位 · 点击${unfilledLargeOrdersVisible ? "隐藏" : "显示"}`}
          onClick={onUnfilledLargeOrdersToggle}
        >
          <LargeOrderSrIcon />
        </button>
        <button
          type="button"
          className={`tool-button ${executedLargeTradesVisible ? "active" : ""}`}
          aria-label={executedLabel}
          aria-pressed={executedLargeTradesVisible}
          data-rail-tool="large-trades"
          title={`大额成交：在 K 线上标出已经成交的大额主动买/卖单 · 点击${executedLargeTradesVisible ? "隐藏" : "显示"}`}
          onClick={onExecutedLargeTradesToggle}
        >
          <LargeTradesIcon />
        </button>
      </div>
      <div className="rail-group" role="group" aria-label="清算" data-rail-group="liquidation">
        <div className="rail-pair">
          <button
            type="button"
            className={`tool-button ${liqHeatmapVisible ? "active" : ""}`}
            aria-label={liqLabel}
            aria-pressed={liqHeatmapVisible}
            data-rail-tool="liq-heatmap"
            title={`清算热力：高/极高清算价带 + 合并的支撑(绿)/阻力(红)区域 · 点击${liqHeatmapVisible ? "隐藏" : "显示"}`}
            onClick={onLiqHeatmapToggle}
          >
            <LiqHeatmapIcon />
          </button>
          {onLiqRefresh && <button
            type="button"
            className={`tool-button liq-refresh-button ${liqRefreshState === "loading" ? "loading" : ""}`}
            aria-label="刷新清算"
            aria-busy={liqRefreshState === "loading"}
            disabled={liqRefreshState !== "idle"}
            data-liq-refresh={liqRefreshState}
            data-rail-tool="liq-refresh"
            title={liqRefreshState === "loading" ? "刷新清算中…（约 10–60 秒）" : liqRefreshState === "cooldown" ? `刷新清算：冷却中，${liqRefreshCooldownSec} 秒后可再次刷新` : liqRefreshState === "unsupported" ? "刷新清算：仅支持 USDT 永续合约" : "刷新清算：立即重新计算当前币种的清算区域（约 10–60 秒）"}
            onClick={onLiqRefresh}
          >
            <LiqRefreshIcon />
            {liqRefreshState === "cooldown" && <span className="liq-refresh-countdown">{liqRefreshCooldownSec}</span>}
          </button>}
        </div>
      </div>
    </div>
  );
}
