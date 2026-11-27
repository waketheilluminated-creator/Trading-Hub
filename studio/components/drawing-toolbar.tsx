import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { catalogTool, groupedDrawingCatalog } from "@/lib/drawings/catalog.ts";
import { MAX_DRAWING_FAVORITES } from "@/lib/drawings/favorites.ts";
import type { DrawingModeKey, DrawingModes } from "@/lib/drawings/modes.ts";
import { REMOVAL_MENU, removalPrompt, type RemovalKind } from "@/lib/drawings/removal.ts";
import type { DrawingTool } from "@/lib/drawings/types.ts";

type DrawingToolbarProps = {
  activeTool: DrawingTool;
  favorites: readonly DrawingTool[];
  modes: DrawingModes;
  drawingsCount: number;
  indicatorCount: number;
  onToolChange(tool: DrawingTool): void;
  /** Returns true when the star was blocked because the rail is full. */
  onToggleFavorite(tool: DrawingTool): boolean;
  onToggleMode(mode: DrawingModeKey): void;
  onZoom(direction: "in" | "out"): void;
  onRemove(kind: RemovalKind): void;
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
function CrosshairIcon() {
  return <IconFrame><circle cx="10" cy="10" r="4" /><line x1="10" y1="2" x2="10" y2="6" /><line x1="10" y1="14" x2="10" y2="18" /><line x1="2" y1="10" x2="6" y2="10" /><line x1="14" y1="10" x2="18" y2="10" /></IconFrame>;
}
function LibraryIcon() {
  return <IconFrame><path d="M4 15.5 15.5 4" /><path d="M12.5 4H16v3.5" /><circle cx="4" cy="15.5" r="1" /></IconFrame>;
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
function ZoomInIcon() {
  return <IconFrame><circle cx="9" cy="9" r="4.5" /><line x1="12.2" y1="12.2" x2="16.5" y2="16.5" /><line x1="9" y1="7" x2="9" y2="11" /><line x1="7" y1="9" x2="11" y2="9" /></IconFrame>;
}
function ZoomOutIcon() {
  return <IconFrame><circle cx="9" cy="9" r="4.5" /><line x1="12.2" y1="12.2" x2="16.5" y2="16.5" /><line x1="7" y1="9" x2="11" y2="9" /></IconFrame>;
}
function MagnetIcon() {
  return <IconFrame><path d="M6 4v6a4 4 0 0 0 8 0V4" /><path d="M6 4v3M14 4v3" /></IconFrame>;
}
function ContinuousIcon() {
  return <IconFrame><path d="M4 14.5 13 5.5" /><path d="M11 5h2.5V7.5" /><rect x="12.2" y="11.2" width="4.2" height="5" rx="1" /><path d="M13.4 13.2h1.8v1.4a.9.9 0 0 1-1.8 0Z" /></IconFrame>;
}
function LockIcon() {
  return <IconFrame><rect x="5" y="9" width="10" height="7" rx="1.4" /><path d="M7.2 9V7.2a2.8 2.8 0 0 1 5.6 0V9" /></IconFrame>;
}
function EyeIcon({ hidden }: { hidden: boolean }) {
  return hidden
    ? <IconFrame><path d="M3.5 10s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m4.5 4.5 11 11" /></IconFrame>
    : <IconFrame><path d="M3.5 10s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><circle cx="10" cy="10" r="1.7" /></IconFrame>;
}
function TrashIcon() {
  return <IconFrame><path d="M5 7h10M8 7V5h4v2M7 7l.6 9h4.8l.6-9" /></IconFrame>;
}
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true" data-icon="star">
      <path d="m10 2.8 2.1 4.4 4.8.7-3.5 3.4.8 4.8L10 13.8 5.8 16.1l.8-4.8L3.1 7.9l4.8-.7L10 2.8Z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

const TOOL_ICONS: Record<DrawingTool, () => ReactNode> = {
  select: SelectIcon,
  "trend-line": TrendLineIcon,
  "horizontal-line": HorizontalLineIcon,
  arrow: ArrowIcon,
  text: TextIcon,
  "price-change": PriceChangeIcon,
  crosshair: CrosshairIcon,
};

type TrashState = "closed" | "menu" | RemovalKind;

export function DrawingToolbar({
  activeTool,
  favorites,
  modes,
  drawingsCount,
  indicatorCount,
  onToolChange,
  onToggleFavorite,
  onToggleMode,
  onZoom,
  onRemove,
}: DrawingToolbarProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [trash, setTrash] = useState<TrashState>("closed");
  const [capHint, setCapHint] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const openRef = useRef({ libraryOpen, trash });
  const libraryId = useId();
  const firstToolRef = useRef<HTMLButtonElement>(null);
  const groups = groupedDrawingCatalog();
  const armedOffRail = activeTool !== "select" && activeTool !== "price-change" && !favorites.includes(activeTool);

  useEffect(() => {
    openRef.current = { libraryOpen, trash };
  }, [libraryOpen, trash]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = openRef.current;
      if (event.key === "Escape") {
        if (!state.libraryOpen && state.trash === "closed") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        setLibraryOpen(false);
        setTrash("closed");
        return;
      }
      if (!state.libraryOpen || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const tools = [...(navRef.current?.querySelectorAll<HTMLButtonElement>(".drawing-library-tool") ?? [])];
      const index = tools.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(tools.length - 1, index + 1) : Math.max(0, index - 1);
      tools[next]?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!libraryOpen && trash === "closed") return;
    const onPointer = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) {
        setLibraryOpen(false);
        setTrash("closed");
      }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [libraryOpen, trash]);

  useEffect(() => {
    if (libraryOpen) firstToolRef.current?.focus();
  }, [libraryOpen]);

  useEffect(() => {
    if (!capHint) return;
    const timer = window.setTimeout(() => setCapHint(false), 1600);
    return () => window.clearTimeout(timer);
  }, [capHint]);

  const star = (tool: DrawingTool) => {
    const blocked = onToggleFavorite(tool);
    if (blocked) setCapHint(true);
  };

  return (
    <nav className="left-rail" aria-label="Chart drawing tools" ref={navRef}>
      <div className="rail-top">
        <button
          type="button"
          className={`tool-button ${libraryOpen || armedOffRail ? "active" : ""}`}
          aria-label="Drawing tools"
          aria-haspopup="dialog"
          aria-expanded={libraryOpen}
          aria-controls={libraryOpen ? libraryId : undefined}
          title="画线工具"
          onClick={() => { setLibraryOpen((open) => !open); setTrash("closed"); }}
        >
          <LibraryIcon />
        </button>
        <div className="rail-favorites">
          {favorites.map((tool) => {
            const entry = catalogTool(tool);
            if (!entry) return null;
            const Icon = TOOL_ICONS[entry.tool];
            return (
              <button
                key={entry.tool}
                type="button"
                className={`tool-button ${activeTool === entry.tool ? "active" : ""}`}
                aria-label={entry.name}
                aria-pressed={activeTool === entry.tool}
                title={entry.title}
                data-favorite-tool={entry.tool}
                onClick={() => onToolChange(entry.tool)}
              >
                <Icon />
              </button>
            );
          })}
        </div>
      </div>
      {libraryOpen && (
        <div className="drawing-library" id={libraryId} role="dialog" aria-label="画线工具库" tabIndex={-1}>
          {groups.map((group) => (
            <section key={group.id} className="drawing-library-section" aria-label={group.title}>
              <h2 className="drawing-library-title">{group.title}</h2>
              {group.tools.map((entry, index) => {
                const Icon = TOOL_ICONS[entry.tool];
                const starred = favorites.includes(entry.tool);
                const blocked = !starred && favorites.length >= MAX_DRAWING_FAVORITES;
                return (
                  <div key={entry.tool} className="drawing-library-row">
                    <button
                      type="button"
                      className={`drawing-library-tool ${activeTool === entry.tool ? "active" : ""}`}
                      ref={index === 0 && group.id === groups[0]?.id ? firstToolRef : undefined}
                      aria-pressed={activeTool === entry.tool}
                      onClick={() => { onToolChange(entry.tool); setLibraryOpen(false); }}
                    >
                      <Icon />
                      <span>{entry.name}</span>
                    </button>
                    <button
                      type="button"
                      className="drawing-library-star"
                      aria-pressed={starred}
                      aria-disabled={blocked}
                      aria-label={starred ? `取消收藏${entry.name}` : `收藏${entry.name}`}
                      title={blocked ? `最多收藏 ${MAX_DRAWING_FAVORITES} 个` : starred ? `取消收藏${entry.name}` : `收藏${entry.name}`}
                      onClick={() => star(entry.tool)}
                    >
                      <StarIcon filled={starred} />
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {capHint && <p className="rail-cap-hint" role="status">最多收藏 {MAX_DRAWING_FAVORITES} 个</p>}
      <div className="rail-bottom">
        <button type="button" className={`tool-button ${activeTool === "price-change" ? "active" : ""}`} aria-label="Measure price change drawing tool" aria-pressed={activeTool === "price-change"} title="测量" data-icon="ruler" onClick={() => onToolChange(activeTool === "price-change" ? "select" : "price-change")}><PriceChangeIcon /></button>
        <button type="button" className="tool-button" aria-label="Zoom in" title="放大" onClick={() => onZoom("in")}><ZoomInIcon /></button>
        <button type="button" className="tool-button" aria-label="Zoom out" title="缩小" onClick={() => onZoom("out")}><ZoomOutIcon /></button>
        <button type="button" className={`tool-button ${modes.magnet ? "active" : ""}`} aria-label="Magnet" aria-pressed={modes.magnet} title="磁铁：吸附到开高低收" onClick={() => onToggleMode("magnet")}><MagnetIcon /></button>
        <button type="button" className={`tool-button ${modes.continuous ? "active" : ""}`} aria-label="Continuous drawing" aria-pressed={modes.continuous} title="连续画线" onClick={() => onToggleMode("continuous")}><ContinuousIcon /></button>
        <button type="button" className={`tool-button ${modes.locked ? "active" : ""}`} aria-label="Lock all drawings" aria-pressed={modes.locked} title={modes.locked ? "解锁全部画线" : "锁定全部画线"} onClick={() => onToggleMode("locked")}><LockIcon /></button>
        <button type="button" className={`tool-button ${modes.hidden ? "active" : ""}`} aria-label={modes.hidden ? "Show all drawings" : "Hide all drawings"} aria-pressed={modes.hidden} title={modes.hidden ? "显示全部画线" : "隐藏全部画线"} onClick={() => onToggleMode("hidden")}><EyeIcon hidden={modes.hidden} /></button>
        <button type="button" className={`tool-button ${trash !== "closed" ? "active" : ""}`} aria-label="Remove drawings and indicators" aria-expanded={trash !== "closed"} aria-haspopup="dialog" title="删除画线和指标" onClick={() => { setTrash((current) => current === "closed" ? "menu" : "closed"); setLibraryOpen(false); }}><TrashIcon /></button>
      </div>
      {trash !== "closed" && (
        <div className="rail-menu" role="dialog" aria-label="删除画线和指标">
          {trash === "menu" ? REMOVAL_MENU.map((item) => (
            <button key={item.kind} type="button" className="rail-menu-item" onClick={() => setTrash(item.kind)}>{item.label}</button>
          )) : (
            <div className="rail-menu-confirm">
              <p>{removalPrompt(trash, drawingsCount, indicatorCount)}</p>
              <button type="button" className="rail-menu-item" onClick={() => { onRemove(trash); setTrash("closed"); }}>删除</button>
              <button type="button" className="rail-menu-item" onClick={() => setTrash("menu")}>取消</button>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
