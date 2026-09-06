"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatMarketId } from "@/lib/market-symbols.js";
import { venueLabel, type MarketVenue } from "@/lib/market-venues.ts";
import {
  EXCHANGE_TYPES,
  SYMBOL_ASSET_TYPES,
  SYMBOL_KINDS,
  assetTypeHasLiveCatalog,
  assetTypeLabel,
  exchangeTypeTriggerLabel,
  filterSources,
  filterWorkspaceSymbols,
  groupSourcesByCategory,
  isExchangeTypeFilter,
  isSymbolKindFilter,
  kindTriggerLabel,
  resolveSourceFilter,
  sourceTriggerLabel,
  sourcesEmptyCopy,
  sourcesForAssetType,
  symbolSearchEmptyCopy,
  type ExchangeTypeFilter,
  type SymbolAssetType,
  type SymbolKindFilter,
} from "@/lib/symbol-search-nav.ts";

export type SymbolSearchMarket = {
  symbol: string;
  base: string;
  quote: string;
  venue: MarketVenue;
  kind?: string;
};

type SymbolSearchDialogProps = {
  open: boolean;
  sourcesOpen: boolean;
  catalog: SymbolSearchMarket[];
  recentMarkets: SymbolSearchMarket[];
  onSourcesOpenChange(open: boolean): void;
  onClose(): void;
  onSelectMarket(market: SymbolSearchMarket): void;
};

type FilterMenu = "kind" | "exchangeType" | null;

function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
      <ellipse cx="10" cy="10" rx="3.2" ry="7.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.8 10h14.4M4.4 6.4h11.2M4.4 13.6h11.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M12.5 4.5 6.5 10l6 5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SourceLogo({ venue, size = "md" }: { venue: MarketVenue; size?: "sm" | "md" }) {
  const mark = venue === "binance" ? "BN" : venue === "bybit" ? "BY" : venue === "okx" ? "OK" : "BG";
  return <span className={`source-logo venue-${venue} size-${size}`} aria-hidden="true">{mark}</span>;
}

function FilterSelect({
  label,
  value,
  valueLabel,
  options,
  open,
  onToggle,
  onChange,
}: {
  label: string;
  value: string;
  valueLabel: string;
  options: readonly { id: string; label: string }[];
  open: boolean;
  onToggle(): void;
  onChange(id: string): void;
}) {
  return (
    <div className="symbol-filter-select-wrap">
      <button type="button" className={`symbol-filter-select ${open ? "open" : ""}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={onToggle}>
        <span>{valueLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && <div className="symbol-filter-menu" role="listbox" aria-label={label}>
        {options.map((option) => <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={option.id === value ? "active" : ""} onClick={() => onChange(option.id)}>
          <span>{option.label}</span>
          {(option.id === "spot" || option.id === "dex") && <small>Coming soon</small>}
        </button>)}
      </div>}
    </div>
  );
}

export function SymbolSearchDialog({
  open,
  sourcesOpen,
  catalog,
  recentMarkets,
  onSourcesOpenChange,
  onClose,
  onSelectMarket,
}: SymbolSearchDialogProps) {
  const symbolSearchRef = useRef<HTMLInputElement>(null);
  const sourcesSearchRef = useRef<HTMLInputElement>(null);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [assetType, setAssetType] = useState<SymbolAssetType>("crypto");
  const [sourceFilter, setSourceFilter] = useState<"all" | MarketVenue>("all");
  const [kind, setKind] = useState<SymbolKindFilter>("all");
  const [exchangeType, setExchangeType] = useState<ExchangeTypeFilter>("all");
  const [activeSymbolIndex, setActiveSymbolIndex] = useState(0);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [openMenu, setOpenMenu] = useState<FilterMenu>(null);

  const resolvedSource = resolveSourceFilter(assetType, sourceFilter);
  const availableSources = useMemo(() => sourcesForAssetType(assetType), [assetType]);
  const visibleSources = useMemo(() => filterSources(availableSources, sourceQuery), [availableSources, sourceQuery]);
  const sourceGroups = useMemo(() => groupSourcesByCategory(visibleSources), [visibleSources]);
  const symbolResults = useMemo(
    () => filterWorkspaceSymbols(catalog, { query: symbolQuery, type: assetType, source: resolvedSource, kind, exchangeType }).slice(0, 100),
    [assetType, catalog, exchangeType, kind, resolvedSource, symbolQuery],
  );
  const visibleRecent = useMemo(() => {
    if (symbolQuery || !assetTypeHasLiveCatalog(assetType) || kind === "spot" || exchangeType === "dex") return [];
    return recentMarkets.filter((market) => resolvedSource === "all" || market.venue === resolvedSource);
  }, [assetType, exchangeType, kind, recentMarkets, resolvedSource, symbolQuery]);
  const emptyCopy = symbolSearchEmptyCopy({ type: assetType, kind, exchangeType, query: symbolQuery, source: resolvedSource });
  const sourcesEmpty = sourcesEmptyCopy(assetType);

  useEffect(() => {
    if (!open) {
      setSourceQuery("");
      setOpenMenu(null);
      return;
    }
    const timer = window.setTimeout(() => {
      if (sourcesOpen) sourcesSearchRef.current?.focus();
      else symbolSearchRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, sourcesOpen]);

  useEffect(() => {
    if (!openMenu) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".symbol-filter-selects")) return;
      setOpenMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openMenu]);

  if (!open) return null;

  const applyAssetType = (next: SymbolAssetType) => {
    setAssetType(next);
    setSourceFilter((current) => resolveSourceFilter(next, current));
    setActiveSymbolIndex(0);
    setOpenMenu(null);
  };

  const applySource = (next: "all" | MarketVenue) => {
    setSourceFilter(resolveSourceFilter(assetType, next));
    setActiveSymbolIndex(0);
    setSourceQuery("");
    setActiveSourceIndex(0);
    onSourcesOpenChange(false);
  };

  const openSources = () => {
    setOpenMenu(null);
    setSourceQuery("");
    setActiveSourceIndex(0);
    onSourcesOpenChange(true);
  };

  const closeSources = () => {
    setSourceQuery("");
    setActiveSourceIndex(0);
    onSourcesOpenChange(false);
  };

  const handleSymbolKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveSymbolIndex((index) => Math.min(Math.max(symbolResults.length - 1, 0), index + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveSymbolIndex((index) => Math.max(0, index - 1)); }
    if (event.key === "Enter" && symbolResults[activeSymbolIndex]) { event.preventDefault(); onSelectMarket(symbolResults[activeSymbolIndex]); }
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };

  const handleSourceKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveSourceIndex((index) => Math.min(Math.max(visibleSources.length - 1, 0), index + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveSourceIndex((index) => Math.max(0, index - 1)); }
    if (event.key === "Enter") {
      event.preventDefault();
      const source = visibleSources[activeSourceIndex];
      if (source) applySource(source.id);
      else if (!sourceQuery) applySource("all");
    }
    if (event.key === "Escape") { event.preventDefault(); closeSources(); }
  };

  return (
    <>
      <button className="symbol-search-backdrop" aria-label="Close symbol search" onClick={onClose} />
      <section className={`symbol-search-dialog ${sourcesOpen ? "sources-view" : ""}`} role="dialog" aria-modal="true" aria-labelledby={sourcesOpen ? "sources-sheet-title" : "symbol-search-title"}>
        {sourcesOpen ? <>
          <header className="symbol-search-header sources-header">
            <button type="button" aria-label="Back to symbol search" onClick={closeSources}><BackIcon /></button>
            <h2 id="sources-sheet-title">Sources</h2>
            <button type="button" aria-label="Close symbol search" onClick={onClose}>×</button>
          </header>
          <div className="symbol-search-input-wrap sources-search">
            <span aria-hidden="true">⌕</span>
            <input ref={sourcesSearchRef} aria-label="Search sources" placeholder="Search" value={sourceQuery} onChange={(event) => { setSourceQuery(event.target.value); setActiveSourceIndex(0); }} onKeyDown={handleSourceKeyDown} />
            {sourceQuery ? <button type="button" className="symbol-search-clear" aria-label="Clear source search" onClick={() => { setSourceQuery(""); setActiveSourceIndex(0); sourcesSearchRef.current?.focus(); }}>×</button> : null}
          </div>
          <button type="button" className={`sources-all-button ${resolvedSource === "all" ? "active" : ""}`} aria-pressed={resolvedSource === "all"} onClick={() => applySource("all")}>
            <span className="sources-all-icon"><GlobeIcon /></span>
            <span>All sources</span>
          </button>
          <div className="sources-body">
            {sourceGroups.map((group) => <section key={group.category} className="sources-group">
              <h3 className="sources-category">{group.category}</h3>
              <div className="sources-grid" role="listbox" aria-label={`${group.category} sources`}>
                {group.sources.map((source) => {
                  const index = visibleSources.findIndex((item) => item.id === source.id);
                  const selected = resolvedSource === source.id;
                  return <button key={source.id} type="button" role="option" aria-selected={selected || index === activeSourceIndex} className={`sources-item ${selected ? "selected" : ""} ${index === activeSourceIndex ? "active" : ""}`} onMouseEnter={() => setActiveSourceIndex(index)} onClick={() => applySource(source.id)}>
                    <SourceLogo venue={source.id} />
                    <span className="sources-item-copy"><strong>{source.label}</strong><small>{source.subtitle}</small></span>
                  </button>;
                })}
              </div>
            </section>)}
            {visibleSources.length === 0 && <div className="symbol-empty"><strong>{availableSources.length ? "No sources found" : sourcesEmpty.title}</strong><span>{availableSources.length ? "Try another exchange name." : sourcesEmpty.detail}</span></div>}
          </div>
          <footer className="symbol-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Back</span></footer>
        </> : <>
          <header className="symbol-search-header">
            <div>
              <h2 id="symbol-search-title">Symbol search</h2>
              <span>{assetTypeLabel(assetType)} · {sourceTriggerLabel(resolvedSource)}</span>
            </div>
            <button type="button" aria-label="Close symbol search" onClick={onClose}>×</button>
          </header>
          <div className="symbol-search-input-wrap">
            <span aria-hidden="true">⌕</span>
            <input ref={symbolSearchRef} aria-label="Search symbols" placeholder="Search symbol, e.g. BTCUSDT" value={symbolQuery} onChange={(event) => { setSymbolQuery(event.target.value.toUpperCase()); setActiveSymbolIndex(0); }} onKeyDown={handleSymbolKeyDown} />
            {symbolQuery ? <button type="button" className="symbol-search-clear" aria-label="Clear symbol search" onClick={() => { setSymbolQuery(""); setActiveSymbolIndex(0); symbolSearchRef.current?.focus(); }}>×</button> : null}
            <kbd>⌘ K</kbd>
          </div>
          <div className="symbol-type-chips" role="radiogroup" aria-label="Asset type">
            {SYMBOL_ASSET_TYPES.map((item) => <button key={item.id} type="button" role="radio" aria-checked={assetType === item.id} className={`symbol-type-chip ${assetType === item.id ? "active" : ""}`} onClick={() => applyAssetType(item.id)}>{item.label}</button>)}
          </div>
          <div className="symbol-filter-selects">
            <button type="button" className="symbol-filter-select sources-trigger" aria-label="Open sources" onClick={openSources}>
              <span>{sourceTriggerLabel(resolvedSource)}</span>
              <span aria-hidden="true">▾</span>
            </button>
            <FilterSelect label="All types" value={kind} valueLabel={kindTriggerLabel(kind)} options={SYMBOL_KINDS} open={openMenu === "kind"} onToggle={() => setOpenMenu((current) => current === "kind" ? null : "kind")} onChange={(id) => { if (!isSymbolKindFilter(id)) return; setKind(id); setActiveSymbolIndex(0); setOpenMenu(null); }} />
            <FilterSelect label="All exchange types" value={exchangeType} valueLabel={exchangeTypeTriggerLabel(exchangeType)} options={EXCHANGE_TYPES} open={openMenu === "exchangeType"} onToggle={() => setOpenMenu((current) => current === "exchangeType" ? null : "exchangeType")} onChange={(id) => { if (!isExchangeTypeFilter(id)) return; setExchangeType(id); setActiveSymbolIndex(0); setOpenMenu(null); }} />
          </div>
          {visibleRecent.length > 0 && <div className="recent-symbols"><span>Recent</span><div>{visibleRecent.map((market) => <button key={formatMarketId(market.venue, market.symbol)} type="button" onClick={() => onSelectMarket(market)}>{market.base}<small>/{market.quote} · {venueLabel(market.venue)}</small></button>)}</div></div>}
          <div className="symbol-results-head"><span>Symbol</span><span>{symbolResults.length} markets</span></div>
          <div className="symbol-results" role="listbox" aria-label="Symbols under the selected source">
            {symbolResults.map((market, index) => <button key={formatMarketId(market.venue, market.symbol)} type="button" role="option" aria-selected={index === activeSymbolIndex} className={`symbol-result ${index === activeSymbolIndex ? "active" : ""}`} onMouseEnter={() => setActiveSymbolIndex(index)} onClick={() => onSelectMarket(market)}>
              <span className={`symbol-avatar venue-${market.venue}`}>{market.symbol === "BTCUSDT" ? "₿" : market.base.slice(0, 2)}</span>
              <span className="symbol-result-copy">
                <strong>{market.symbol}</strong>
                <small>{market.base} / TetherUS Perpetual</small>
                <em>swap crypto</em>
              </span>
              <span className={`symbol-source venue-${market.venue}`}>
                <span>{venueLabel(market.venue)}</span>
                <SourceLogo venue={market.venue} size="sm" />
              </span>
            </button>)}
            {symbolResults.length === 0 && <div className="symbol-empty"><strong>{emptyCopy.title}</strong><span>{emptyCopy.detail}</span></div>}
          </div>
          <footer className="symbol-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Select</span><span><kbd>Esc</kbd> Close</span></footer>
        </>}
      </section>
    </>
  );
}
