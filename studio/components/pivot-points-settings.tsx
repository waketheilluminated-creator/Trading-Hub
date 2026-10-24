"use client";

import { useState } from "react";
import {
  PIVOT_HIGH_COLOR,
  PIVOT_LOW_COLOR,
  normalizePivotPointsSettings,
  type PivotPointsHighLowSettings,
} from "@/lib/pivot-points-high-low.ts";

type PivotPointsSettingsProps = {
  value: PivotPointsHighLowSettings;
  onChange(next: PivotPointsHighLowSettings): void;
};

function LengthInput({ label, value, onCommit }: { label: string; value: number; onCommit(next: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const commit = () => {
    const next = Number(shown);
    setDraft(null);
    if (!Number.isFinite(next)) return;
    onCommit(next);
  };
  return (
    <input
      aria-label={label}
      title={label}
      inputMode="numeric"
      value={shown}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function SideMark({ side }: { side: "high" | "low" }) {
  const high = side === "high";
  return (
    <span title={high ? "Pivot high" : "Pivot low"}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" data-icon={high ? "pivot-high" : "pivot-low"}>
        <path d={high ? "M7 11.2 2.8 4.2h8.4L7 11.2Z" : "M7 2.8 11.2 9.8H2.8L7 2.8Z"} fill={high ? PIVOT_HIGH_COLOR : PIVOT_LOW_COLOR} />
      </svg>
    </span>
  );
}

export function PivotPointsSettings({ value, onChange }: PivotPointsSettingsProps) {
  const commit = (patch: Partial<PivotPointsHighLowSettings>) => onChange(normalizePivotPointsSettings({ ...value, ...patch }));
  return (
    <div className="pivot-settings" role="group" aria-label="Pivot lengths" data-pivot-settings="on">
      <SideMark side="high" />
      <LengthInput label="Pivot high left bars" value={value.highLeft} onCommit={(highLeft) => commit({ highLeft })} />
      <LengthInput label="Pivot high right bars" value={value.highRight} onCommit={(highRight) => commit({ highRight })} />
      <SideMark side="low" />
      <LengthInput label="Pivot low left bars" value={value.lowLeft} onCommit={(lowLeft) => commit({ lowLeft })} />
      <LengthInput label="Pivot low right bars" value={value.lowRight} onCommit={(lowRight) => commit({ lowRight })} />
    </div>
  );
}
