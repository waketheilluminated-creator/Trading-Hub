import type { ReactNode } from "react";

export type ChartLegendRow = {
  id: string;
  title: string;
  params?: string;
  color: string;
  visible: boolean;
  configurable?: boolean;
};

type ChartStudyLegendProps = {
  rows: readonly ChartLegendRow[];
  onToggleVisible(id: string): void;
  onRemove(id: string): void;
  onConfigure?(id: string): void;
  settingsFor?: string | null;
  settings?: ReactNode;
};

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" data-icon={open ? "eye" : "eye-off"}>
      <path d="M1.5 9S4.2 4 9 4s7.5 5 7.5 5-2.7 5-7.5 5S1.5 9 1.5 9Z" />
      <circle cx="9" cy="9" r="2.2" />
      {!open && <path d="M3 15 15 3" />}
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="7" cy="7" r="1.7" />
      <path d="M7 1.8v1.3M7 10.9v1.3M1.8 7h1.3M10.9 7h1.3M3.2 3.2l.9.9M9.9 9.9l.9.9M10.8 3.2l-.9.9M4.1 9.9l-.9.9" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5" />
    </svg>
  );
}

/**
 * TradingView-style study legend at the chart's top-left: one row per added
 * indicator (name + inputs). Hovering a row reveals the eye (show/hide plots)
 * and remove actions; hidden studies stay listed but dimmed with the eye kept
 * visible so they can be shown again.
 */
export function ChartStudyLegend({ rows, onToggleVisible, onRemove, onConfigure, settingsFor, settings }: ChartStudyLegendProps) {
  if (!rows.length) return null;
  return (
    <ul className="study-legend" aria-label="Chart indicators">
      {rows.map((row) => {
        const label = row.params ? `${row.title} ${row.params}` : row.title;
        return (
          <li key={row.id} className={`study-legend-row${row.visible ? "" : " hidden-study"}`} data-study={row.id} data-visible={row.visible ? "on" : "off"}>
            <i className="study-legend-swatch" style={{ background: row.color }} aria-hidden="true" />
            <span className="study-legend-title">{row.title}</span>
            {row.params ? <span className="study-legend-params">{row.params}</span> : null}
            <span className="study-legend-actions">
              <button
                type="button"
                className="study-legend-button study-legend-eye"
                aria-label={row.visible ? `Hide ${label}` : `Show ${label}`}
                aria-pressed={!row.visible}
                title={row.visible ? "Hide" : "Show"}
                onClick={() => onToggleVisible(row.id)}
              >
                <EyeIcon open={row.visible} />
              </button>
              {row.configurable && onConfigure ? (
                <button
                  type="button"
                  className="study-legend-button"
                  aria-label={`Settings ${label}`}
                  aria-expanded={settingsFor === row.id}
                  title="Lengths"
                  onClick={() => onConfigure(row.id)}
                >
                  <GearIcon />
                </button>
              ) : null}
              <button type="button" className="study-legend-button" aria-label={`Remove ${label}`} title="Remove" onClick={() => onRemove(row.id)}>
                <RemoveIcon />
              </button>
            </span>
            {settingsFor === row.id ? settings : null}
          </li>
        );
      })}
    </ul>
  );
}
