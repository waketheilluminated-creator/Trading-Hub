import type { ComponentType, ReactNode } from "react";
import type { DrawingTool } from "@/lib/drawings/types.ts";

type DrawingToolbarProps = {
  activeTool: DrawingTool;
  onToolChange(tool: DrawingTool): void;
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

function LiqRefreshIcon() {
  return <IconFrame><path d="M15.5 8.5A5.6 5.6 0 0 0 5 6.6M4.5 11.5A5.6 5.6 0 0 0 15 13.4" /><path d="M5 3.4v3.3h3.3M15 16.6v-3.3h-3.3" /></IconFrame>;
}

const IconFrame = ({ children }: { children: ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">{children}</svg>
);

function SelectIcon() {
  return <IconFrame><path d="m4 2 11 8-5.4 1.1L7.8 17 4 2Z" /></IconFrame>;
}

function TrendLineIcon() {
  return <IconFrame><line x1="3" y1="16" x2="17" y2="4" /><circle cx="3" cy="16" r="1" /><circle cx="17" cy="4" r="1" /></IconFrame>;
}

function HorizontalLineIcon() {
  return <IconFrame><line x1="3" y1="10" x2="17" y2="10" /><circle cx="3" cy="10" r="1" /><circle cx="17" cy="10" r="1" /></IconFrame>;
}

function ArrowIcon() {
  return <IconFrame><path d="M3 16 15 4M10 4h5v5" /></IconFrame>;
}

function TextIcon() {
  return <IconFrame><path d="M4 4h12M10 4v12M7 16h6" /></IconFrame>;
}

function PriceChangeIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-icon="ruler">
    <g transform="rotate(-45 10 10)">
      <rect x="3" y="7" width="14" height="6" rx="1.5" />
      <line x1="6" y1="7" x2="6" y2="10" />
      <line x1="9" y1="7" x2="9" y2="9" />
      <line x1="12" y1="7" x2="12" y2="10" />
      <line x1="15" y1="7" x2="15" y2="9" />
    </g>
  </svg>;
}

function CrosshairIcon() {
  return <IconFrame><circle cx="10" cy="10" r="4" /><line x1="10" y1="2" x2="10" y2="6" /><line x1="10" y1="14" x2="10" y2="18" /><line x1="2" y1="10" x2="6" y2="10" /><line x1="14" y1="10" x2="18" y2="10" /></IconFrame>;
}

function SettingsIcon() {
  return <IconFrame><circle cx="10" cy="10" r="2.5" /><path d="M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4" /></IconFrame>;
}

function LargeOrderSrIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-icon="large-order-sr">
      {/* Order-book ladder: resting size per price level, one fat "wall" level. */}
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
      {/* Trade prints: bubbles sized by fill, sitting on a time axis. */}
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

export function DrawingToolbar({
  activeTool,
  onToolChange,
  unfilledLargeOrdersVisible,
  onUnfilledLargeOrdersToggle,
  executedLargeTradesVisible,
  onExecutedLargeTradesToggle,
  liqHeatmapVisible,
  onLiqHeatmapToggle,
  liqRefreshState = "unsupported",
  liqRefreshCooldownSec = 0,
  onLiqRefresh,
}: DrawingToolbarProps) {
  const tools: { tool: DrawingTool; label: string; Icon: ComponentType }[] = [
    { tool: "select", label: "Select drawing tool", Icon: SelectIcon },
    { tool: "trend-line", label: "Trend line drawing tool", Icon: TrendLineIcon },
    { tool: "horizontal-line", label: "Horizontal line drawing tool", Icon: HorizontalLineIcon },
    { tool: "arrow", label: "Arrow drawing tool", Icon: ArrowIcon },
    { tool: "text", label: "Text drawing tool", Icon: TextIcon },
    { tool: "price-change", label: "Measure price change drawing tool", Icon: PriceChangeIcon },
    { tool: "crosshair", label: "Crosshair drawing tool", Icon: CrosshairIcon },
  ];

  const unfilledLabel = unfilledLargeOrdersVisible ? "Hide unfilled large orders" : "Show unfilled large orders";
  const executedLabel = executedLargeTradesVisible ? "Hide executed large trades" : "Show executed large trades";
  const liqLabel = liqHeatmapVisible ? "Hide liquidation heatmap" : "Show liquidation heatmap";

  return <nav className="left-rail" aria-label="Chart drawing tools">
    {tools.map(({ tool, label, Icon }) => <button key={tool} type="button" className={`tool-button ${activeTool === tool ? "active" : ""}`} aria-label={label} aria-pressed={activeTool === tool} title={label.replace(" drawing tool", "")} onClick={() => onToolChange(tool)}><Icon /></button>)}
    <span className="rail-spacer" />
    <div className="rail-group" role="group" aria-label="订单流" data-rail-group="orderflow">
      <span className="rail-group-label" aria-hidden="true">订单流</span>
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
      <span className="rail-group-label" aria-hidden="true">清算</span>
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
          title={liqRefreshState === "loading" ? "刷新清算中…（约 10–60 秒）" : liqRefreshState === "cooldown" ? `刷新清算：冷却中，${liqRefreshCooldownSec} 秒后可再次刷新` : liqRefreshState === "unsupported" ? "刷新清算：当前币种暂不支持" : "刷新清算：立即重新计算当前币种的清算区域（约 10–60 秒）"}
          onClick={onLiqRefresh}
        >
          <LiqRefreshIcon />
          {liqRefreshState === "cooldown" && <span className="liq-refresh-countdown">{liqRefreshCooldownSec}</span>}
        </button>}
      </div>
    </div>
    <button type="button" className="tool-button" aria-label="Chart settings" title="Settings"><SettingsIcon /></button>
  </nav>;
}
