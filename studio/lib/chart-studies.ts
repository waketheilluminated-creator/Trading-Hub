export type StudyId = "ema9" | "ema21" | "cvd" | "oi";
export type StudyPlacement = "overlay" | "pane";

export type StudyDefinition = {
  id: StudyId;
  name: string;
  params: string;
  description: string;
  placement: StudyPlacement;
  color: string;
  /** localStorage flag: study is on the chart. */
  addedKey: string;
  /** localStorage flag: study is on the chart but its plots are hidden (eye off). */
  hiddenKey: string;
};

export type StudyFlags = Partial<Record<StudyId, { added: boolean; hidden: boolean }>>;

export type LegendEntry = {
  id: StudyId;
  title: string;
  params: string;
  color: string;
  visible: boolean;
  placement: StudyPlacement;
};

// CVD / OI keep their original pane keys so existing saved layouts survive.
export const STUDY_CATALOG: readonly StudyDefinition[] = [
  { id: "ema9", name: "EMA", params: "9 close", description: "Exponential moving average · overlay", placement: "overlay", color: "#62d6e8", addedKey: "th-study-ema9", hiddenKey: "th-study-ema9-hidden" },
  { id: "ema21", name: "EMA", params: "21 close", description: "Exponential moving average · overlay", placement: "overlay", color: "#f2c66d", addedKey: "th-study-ema21", hiddenKey: "th-study-ema21-hidden" },
  { id: "cvd", name: "CVD", params: "perp · public trades", description: "Cumulative volume delta · separate pane", placement: "pane", color: "#53c990", addedKey: "th-pane-cvd", hiddenKey: "th-pane-cvd-hidden" },
  { id: "oi", name: "Open interest", params: "USD", description: "Derivatives open interest · separate pane", placement: "pane", color: "#62d6e8", addedKey: "th-pane-oi", hiddenKey: "th-pane-oi-hidden" },
];

export function studyDefinition(id: StudyId): StudyDefinition {
  const found = STUDY_CATALOG.find((study) => study.id === id);
  if (!found) throw new Error(`Unknown study: ${id}`);
  return found;
}

export function isStudyId(value: unknown): value is StudyId {
  return typeof value === "string" && STUDY_CATALOG.some((study) => study.id === value);
}

/** TradingView-style legend rows: only added studies, in catalog order, hidden ones kept but marked. */
export function legendEntries(flags: StudyFlags, labels: Partial<Record<StudyId, string>> = {}): LegendEntry[] {
  return STUDY_CATALOG.flatMap((study) => {
    const state = flags[study.id];
    if (!state?.added) return [];
    return [{
      id: study.id,
      title: labels[study.id] || study.name,
      params: study.params,
      color: study.color,
      visible: !state.hidden,
      placement: study.placement,
    }];
  });
}

export function filterStudyCatalog(query: string): StudyDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...STUDY_CATALOG];
  return STUDY_CATALOG.filter((study) =>
    `${study.name} ${study.params} ${study.description}`.toLowerCase().includes(needle));
}

export function studyLegendLabel(entry: Pick<LegendEntry, "title" | "params">): string {
  return entry.params ? `${entry.title} ${entry.params}` : entry.title;
}
