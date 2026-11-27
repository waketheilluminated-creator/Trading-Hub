export type RemovalKind = "drawings" | "indicators" | "both";

export const REMOVAL_MENU: readonly { kind: RemovalKind; label: string }[] = [
  { kind: "drawings", label: "删除所有画线" },
  { kind: "indicators", label: "删除所有指标" },
  { kind: "both", label: "删除画线和指标" },
];

export type IndicatorPresence = {
  ema9: boolean;
  ema21: boolean;
  cvd: boolean;
  oi: boolean;
  pine: boolean;
};

export function removableIndicatorIds(flags: IndicatorPresence): string[] {
  const ids: string[] = [];
  if (flags.ema9) ids.push("ema9");
  if (flags.ema21) ids.push("ema21");
  if (flags.cvd) ids.push("cvd");
  if (flags.oi) ids.push("oi");
  if (flags.pine) ids.push("pine");
  return ids;
}

export function removalPrompt(kind: RemovalKind, drawings: number, indicators: number): string {
  switch (kind) {
    case "drawings":
      return `删除 ${drawings} 条画线？`;
    case "indicators":
      return `删除 ${indicators} 个指标？`;
    case "both":
      return `删除 ${drawings} 条画线和 ${indicators} 个指标？`;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
