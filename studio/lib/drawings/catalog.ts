import type { DrawingTool } from "./types.ts";

export const DRAWING_CATEGORIES = [
  { id: "cursors", title: "光标" },
  { id: "lines", title: "趋势线" },
  { id: "channels", title: "通道" },
  { id: "fibonacci", title: "斐波那契" },
  { id: "gann", title: "江恩" },
  { id: "patterns", title: "形态" },
  { id: "forecast", title: "预测" },
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
  icon: string;
};

const icon = (d: string) => d;

export const DRAWING_TOOL_CATALOG: readonly CatalogTool[] = [
  { tool: "select", category: "cursors", name: "光标", title: "光标 Cursor", icon: icon("M4 2 15 10l-5.4 1.1L7.8 17 4 2Z") },
  { tool: "crosshair", category: "cursors", name: "十字线", title: "十字线 Crosshair", icon: icon("M10 2v4M10 14v4M2 10h4M14 10h4M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z") },
  { tool: "trend-line", category: "lines", name: "趋势线", title: "趋势线 Trend line", icon: icon("M3 16 17 4") },
  { tool: "ray", category: "lines", name: "射线", title: "射线 Ray", icon: icon("M3 16 14 6M14 6l-4 .2M14 6l.2 4") },
  { tool: "info-line", category: "lines", name: "信息线", title: "信息线 Info line", icon: icon("M3 15 16 5M8 4h6v4") },
  { tool: "extended-line", category: "lines", name: "延长线", title: "延长线 Extended line", icon: icon("M2 16 18 4") },
  { tool: "trend-angle", category: "lines", name: "趋势角度", title: "趋势角度 Trend angle", icon: icon("M3 16h12M3 16 14 6") },
  { tool: "horizontal-line", category: "lines", name: "水平线", title: "水平线 Horizontal line", icon: icon("M3 10h14") },
  { tool: "horizontal-ray", category: "lines", name: "水平射线", title: "水平射线 Horizontal ray", icon: icon("M4 10h12M16 10l-3-2M16 10l-3 2") },
  { tool: "vertical-line", category: "lines", name: "垂直线", title: "垂直线 Vertical line", icon: icon("M10 3v14") },
  { tool: "cross-line", category: "lines", name: "十字线", title: "十字线 Cross line", icon: icon("M10 3v14M3 10h14") },
  { tool: "parallel-channel", category: "channels", name: "平行通道", title: "平行通道 Parallel channel", icon: icon("M3 14 15 6M5 17 17 9") },
  { tool: "regression-trend", category: "channels", name: "回归趋势", title: "回归趋势 Regression trend", icon: icon("M3 15c3-1 5-6 7-6s4 4 7 2") },
  { tool: "flat-channel", category: "channels", name: "平底/平顶", title: "平底/平顶 Flat top/bottom", icon: icon("M3 14 15 8M3 6h14") },
  { tool: "disjoint-channel", category: "channels", name: "不相交通道", title: "不相交通道 Disjoint channel", icon: icon("M3 15 10 8M10 14 17 6") },
  { tool: "fib-retracement", category: "fibonacci", name: "斐波那契回撤", title: "斐波那契回撤 Fib retracement", icon: icon("M3 5h14M3 9h14M3 12h14M3 16h14") },
  { tool: "fib-extension", category: "fibonacci", name: "斐波那契扩展", title: "斐波那契扩展 Trend-based fib extension", icon: icon("M3 16 8 8l4 3 5-7") },
  { tool: "fib-channel", category: "fibonacci", name: "斐波那契通道", title: "斐波那契通道 Fib channel", icon: icon("M3 15 16 7M3 12 16 4M3 17 16 9") },
  { tool: "fib-time-zone", category: "fibonacci", name: "斐波那契时间", title: "斐波那契时间区 Fib time zone", icon: icon("M5 3v14M9 3v14M14 3v14M17 3v14") },
  { tool: "pitchfork", category: "gann", name: "音叉", title: "安德鲁音叉 Pitchfork", icon: icon("M10 16 4 6M10 16 16 6M10 16V5") },
  { tool: "gann-fan", category: "gann", name: "江恩扇", title: "江恩扇 Gann fan", icon: icon("M4 16 16 4M4 16 16 8M4 16 16 12M4 16h12") },
  { tool: "abcd", category: "patterns", name: "ABCD", title: "ABCD 形态 ABCD", icon: icon("M3 14 8 6l4 5 5-6") },
  { tool: "xabcd", category: "patterns", name: "XABCD", title: "XABCD 形态 XABCD", icon: icon("M2 10 6 5l4 6 4-7 4 5") },
  { tool: "head-shoulders", category: "patterns", name: "头肩形态", title: "头肩形态 Head and shoulders", icon: icon("M2 14 5 10 8 13 10 5 12 13 15 10 18 14") },
  { tool: "elliott-impulse", category: "patterns", name: "艾略特推动", title: "艾略特推动浪 Elliott impulse 12345", icon: icon("M2 16 6 8 9 12 13 4 16 9") },
  { tool: "long-position", category: "forecast", name: "多头", title: "多头 Long position", icon: icon("M4 14h12v-4H4zM4 10h12V6H4z") },
  { tool: "short-position", category: "forecast", name: "空头", title: "空头 Short position", icon: icon("M4 6h12v4H4zM4 10h12v4H4z") },
  { tool: "price-range", category: "forecast", name: "价格范围", title: "价格范围 Price range", icon: icon("M4 6h12M4 14h12M10 6v8") },
  { tool: "date-range", category: "forecast", name: "日期范围", title: "日期范围 Date range", icon: icon("M6 4v12M14 4v12M6 10h8") },
  { tool: "date-price-range", category: "forecast", name: "日期和价格范围", title: "日期和价格范围 Date and price range", icon: icon("M5 5h10v10H5z") },
  { tool: "rectangle", category: "shapes", name: "矩形", title: "矩形 Rectangle", icon: icon("M4 5h12v10H4z") },
  { tool: "rotated-rectangle", category: "shapes", name: "旋转矩形", title: "旋转矩形 Rotated rectangle", icon: icon("M6 4h8l2 6-2 6H6l-2-6z") },
  { tool: "ellipse", category: "shapes", name: "椭圆", title: "椭圆 Ellipse", icon: icon("M10 5c4 0 6 2.2 6 5s-2 5-6 5-6-2.2-6-5 2-5 6-5Z") },
  { tool: "circle", category: "shapes", name: "圆形", title: "圆形 Circle", icon: icon("M10 4.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z") },
  { tool: "triangle", category: "shapes", name: "三角形", title: "三角形 Triangle", icon: icon("M10 4 17 16H3z") },
  { tool: "polyline", category: "shapes", name: "折线", title: "折线 Path", icon: icon("M3 14 8 6l4 5 5-7") },
  { tool: "arc", category: "shapes", name: "弧线", title: "弧线 Arc", icon: icon("M4 14c2-7 10-7 12 0") },
  { tool: "brush", category: "shapes", name: "画笔", title: "画笔 Brush", icon: icon("M4 15c2-1 3-3 4-3s2 2 4 1 3-4 5-5") },
  { tool: "text", category: "annotation", name: "文字", title: "文字 Text", icon: icon("M4 4h12M10 4v12M7 16h6") },
  { tool: "note", category: "annotation", name: "注释", title: "注释 Note", icon: icon("M5 4h7l3 3v9H5z") },
  { tool: "price-label", category: "annotation", name: "价格标签", title: "价格标签 Price label", icon: icon("M4 8h8l3 2-3 2H4z") },
  { tool: "callout", category: "annotation", name: "标注", title: "标注 Callout", icon: icon("M4 14 9 9h6v5H9z") },
  { tool: "arrow", category: "arrows", name: "箭头", title: "箭头 Arrow", icon: icon("M3 16 15 4M10 4h5v5") },
  { tool: "arrow-up", category: "arrows", name: "向上箭头", title: "向上箭头 Arrow up", icon: icon("M10 16V5M6 8l4-4 4 4") },
  { tool: "arrow-down", category: "arrows", name: "向下箭头", title: "向下箭头 Arrow down", icon: icon("M10 4v11M6 12l4 4 4-4") },
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
