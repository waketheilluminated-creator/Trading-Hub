import { useState } from "react";
import {
  WALL_NOTIONAL_PRESETS_USD,
  clampMinNotional,
  type WallRangeMode,
  type WallRangeSettings,
} from "@/lib/market-depth.ts";

const PRESET_LABELS: Record<(typeof WALL_NOTIONAL_PRESETS_USD)[number], string> = {
  50_000: "$50k",
  100_000: "$100k",
  250_000: "$250k",
  1_000_000: "$1M",
};

type SrWallControlsProps = {
  minNotional: number;
  onMinNotional(value: number): void;
  range: WallRangeSettings;
  onRange(next: WallRangeSettings): void;
  showRange?: boolean;
};

export function SrWallControls({ minNotional, onMinNotional, range, onRange, showRange = true }: SrWallControlsProps) {
  const [notionalDraft, setNotionalDraft] = useState<string | null>(null);
  const [lowDraft, setLowDraft] = useState<string | null>(null);
  const [highDraft, setHighDraft] = useState<string | null>(null);
  const notionalValue = notionalDraft ?? String(minNotional);
  const lowValue = lowDraft ?? (range.low == null ? "" : String(range.low));
  const highValue = highDraft ?? (range.high == null ? "" : String(range.high));

  const commitNotional = () => {
    const numeric = Number(notionalValue);
    setNotionalDraft(null);
    if (!Number.isFinite(numeric)) return;
    onMinNotional(clampMinNotional(numeric));
  };

  const commitBound = (side: "low" | "high", raw: string) => {
    const trimmed = raw.trim();
    if (side === "low") setLowDraft(null);
    else setHighDraft(null);
    if (!trimmed) {
      onRange({ ...range, [side]: null });
      return;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    onRange({ ...range, [side]: numeric });
  };

  const setMode = (mode: WallRangeMode) => onRange({ ...range, mode });

  return <div className="sr-wall-controls" data-sr-wall-controls="on">
    <div className="sr-wall-row">
      <span className="sr-wall-label">Min $</span>
      {WALL_NOTIONAL_PRESETS_USD.map((preset) => <button key={preset} type="button" className="sr-mini-button" aria-pressed={minNotional === preset} onClick={() => onMinNotional(preset)}>{PRESET_LABELS[preset]}</button>)}
      <input className="sr-mini-input" aria-label="Custom minimum wall notional" inputMode="decimal" value={notionalValue} onChange={(event) => setNotionalDraft(event.target.value)} onBlur={commitNotional} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitNotional(); } }} />
    </div>
    {showRange && <div className="sr-wall-row" role="radiogroup" aria-label="Wall price range">
      <span className="sr-wall-label">Range</span>
      <button type="button" className="sr-mini-button" aria-pressed={range.mode === "book"} onClick={() => setMode("book")}>Book</button>
      <button type="button" className="sr-mini-button" aria-pressed={range.mode === "visible"} onClick={() => setMode("visible")}>Visible</button>
      <button type="button" className="sr-mini-button" aria-pressed={range.mode === "custom"} onClick={() => setMode("custom")}>Custom</button>
      {range.mode === "custom" && <>
        <input className="sr-mini-input" aria-label="Custom range low" inputMode="decimal" placeholder="Low" value={lowValue} onChange={(event) => setLowDraft(event.target.value)} onBlur={() => commitBound("low", lowValue)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitBound("low", lowValue); } }} />
        <input className="sr-mini-input" aria-label="Custom range high" inputMode="decimal" placeholder="High" value={highValue} onChange={(event) => setHighDraft(event.target.value)} onBlur={() => commitBound("high", highValue)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitBound("high", highValue); } }} />
      </>}
    </div>}
  </div>;
}
