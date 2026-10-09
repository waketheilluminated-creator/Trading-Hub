import { useEffect, useId, useRef, useState } from "react";
import { filterStudyCatalog, type StudyId } from "@/lib/chart-studies.ts";

type IndicatorsMenuProps = {
  added: Partial<Record<StudyId, boolean>>;
  pineApplied: boolean;
  onToggleStudy(id: StudyId): void;
  onAddPine(): void;
  open: boolean;
  onOpenChange(open: boolean): void;
};

/** TradingView-like "ƒx Indicators" toolbar button with a searchable add/remove list. */
// Open state is owned by the workspace so its global Escape handler (which stops
// propagation) can close this menu before cancelling drawings.
export function IndicatorsMenu({ added, pineApplied, onToggleStudy, onAddPine, open, onOpenChange }: IndicatorsMenuProps) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [onOpenChange, open]);

  const studies = filterStudyCatalog(query);
  const showPine = !query.trim() || "pine script custom editor".includes(query.trim().toLowerCase());

  return (
    <div className="indicators-menu" ref={rootRef}>
      <button
        type="button"
        className={`time-button indicators-button${open ? " active" : ""}`}
        aria-label="Indicators"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title="Indicators"
        onClick={() => { onOpenChange(!open); setQuery(""); }}
      >
        <span className="indicators-fx" aria-hidden="true">ƒx</span> Indicators
      </button>
      {open && (
        <div className="indicators-popover" role="dialog" aria-label="Add indicators" id={listId}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- Opening the indicator search should accept typing immediately, like TradingView. */}
          <input className="indicators-search" aria-label="Search indicators" placeholder="Search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
          <ul className="indicators-list">
            {studies.map((study) => {
              const isAdded = !!added[study.id];
              return (
                <li key={study.id}>
                  <button type="button" className={`indicators-item${isAdded ? " added" : ""}`} aria-pressed={isAdded} onClick={() => onToggleStudy(study.id)}>
                    <span className="indicators-item-copy"><strong>{study.name} {study.params}</strong><small>{study.description}</small></span>
                    <span className="indicators-item-state">{isAdded ? "✓ Added" : "Add"}</span>
                  </button>
                </li>
              );
            })}
            {showPine && (
              <li>
                <button type="button" className={`indicators-item${pineApplied ? " added" : ""}`} onClick={() => { onAddPine(); onOpenChange(false); }}>
                  <span className="indicators-item-copy"><strong>Pine script</strong><small>Pine Editor output · runs the editor script</small></span>
                  <span className="indicators-item-state">{pineApplied ? "↻ Update" : "Add"}</span>
                </button>
              </li>
            )}
            {!studies.length && !showPine && <li className="indicators-empty">No indicators match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
