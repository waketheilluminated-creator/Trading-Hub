import type { ComponentType, ReactNode } from "react";
import type { DrawingTool } from "@/lib/drawings/types.ts";

type DrawingToolbarProps = {
  activeTool: DrawingTool;
  onToolChange(tool: DrawingTool): void;
  unfilledLargeOrdersVisible: boolean;
  onUnfilledLargeOrdersToggle(): void;
  executedLargeTradesVisible: boolean;
  onExecutedLargeTradesToggle(): void;
};

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
      <rect x="2.5" y="4.5" width="15" height="3.2" rx="1" fill="currentColor" stroke="none" opacity="0.5" />
      <rect x="2.5" y="12.3" width="15" height="3.2" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LargeTradesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" data-icon="large-trades">
      <circle cx="6.5" cy="13.5" r="2.1" fill="currentColor" stroke="none" />
      <circle cx="13.2" cy="6.6" r="2.6" fill="currentColor" stroke="none" />
      <circle cx="14.2" cy="13.8" r="1.5" fill="currentColor" stroke="none" opacity="0.72" />
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

  return <nav className="left-rail" aria-label="Chart drawing tools">
    {tools.map(({ tool, label, Icon }) => <button key={tool} type="button" className={`tool-button ${activeTool === tool ? "active" : ""}`} aria-label={label} aria-pressed={activeTool === tool} title={label.replace(" drawing tool", "")} onClick={() => onToolChange(tool)}><Icon /></button>)}
    <span className="rail-spacer" />
    <button
      type="button"
      className={`tool-button ${unfilledLargeOrdersVisible ? "active" : ""}`}
      aria-label={unfilledLabel}
      aria-pressed={unfilledLargeOrdersVisible}
      title={unfilledLargeOrdersVisible ? "Hide unfilled large orders (大额挂单)" : "Show unfilled large orders (大额挂单)"}
      onClick={onUnfilledLargeOrdersToggle}
    >
      <LargeOrderSrIcon />
    </button>
    <button
      type="button"
      className={`tool-button ${executedLargeTradesVisible ? "active" : ""}`}
      aria-label={executedLabel}
      aria-pressed={executedLargeTradesVisible}
      title={executedLargeTradesVisible ? "Hide executed large trades (大额成交)" : "Show executed large trades (大额成交)"}
      onClick={onExecutedLargeTradesToggle}
    >
      <LargeTradesIcon />
    </button>
    <button type="button" className="tool-button" aria-label="Chart settings" title="Settings"><SettingsIcon /></button>
  </nav>;
}
