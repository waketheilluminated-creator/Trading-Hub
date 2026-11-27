import type { DrawingTool } from "./types.ts";

export const DRAWING_CATEGORIES = [
  { id: "cursors", title: "光标" },
  { id: "lines", title: "趋势线" },
  { id: "channels", title: "通道" },
  { id: "fibonacci", title: "斐波那契" },
  { id: "patterns", title: "形态" },
  { id: "shapes", title: "形状" },
  { id: "annotation", title: "注释" },
  { id: "arrows", title: "箭头" },
] as const;

export type DrawingCategoryId = (typeof DRAWING_CATEGORIES)[number]["id"];

export type CatalogTool = {
  tool: DrawingTool;
  category: DrawingCategoryId;
  name: string;
  title: string;
};

export const DRAWING_TOOL_CATALOG: readonly CatalogTool[] = [
  { tool: "select", category: "cursors", name: "光标", title: "光标：选择并移动画线" },
  { tool: "crosshair", category: "cursors", name: "十字线", title: "十字线" },
  { tool: "trend-line", category: "lines", name: "趋势线", title: "趋势线" },
  { tool: "horizontal-line", category: "lines", name: "水平线", title: "水平线" },
  { tool: "text", category: "annotation", name: "文字", title: "文字标注" },
  { tool: "arrow", category: "arrows", name: "箭头", title: "箭头" },
];

export function groupedDrawingCatalog(): { id: DrawingCategoryId; title: string; tools: CatalogTool[] }[] {
  return DRAWING_CATEGORIES.flatMap((category) => {
    const tools = DRAWING_TOOL_CATALOG.filter((tool) => tool.category === category.id);
    return tools.length ? [{ id: category.id, title: category.title, tools }] : [];
  });
}

export function catalogTool(tool: DrawingTool): CatalogTool | undefined {
  return DRAWING_TOOL_CATALOG.find((item) => item.tool === tool);
}
