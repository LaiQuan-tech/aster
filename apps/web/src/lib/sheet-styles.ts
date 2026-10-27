import type { CSSProperties } from "react";
import type { BorderStyle, GridCell } from "./statements-api";

/**
 * 後台「仿 Excel／Word」表格的共用視覺（2026-10-27 業主：表格配色字體要跟後台風格一致）。
 *
 * 結構（欄位、合併儲存格、順序）照原本的 Excel／Word 版面；只有視覺統一成後台樣式：
 *   - 字體繼承後台無襯線字（不指定 serif／標楷體／微軟正黑體），內容 13px、表頭 12px font-medium 灰字。
 *   - 表頭 bg-gray-50；框線 1px gray-200，外框 gray-300；不用粗黑雙線。
 *   - 強調格用品牌色淡底（var(--brand) 5%）；原本的灰底格改 bg-gray-50；紅字只用於警示（負數、超額）。
 *   - row hover bg-gray-50，不用斑馬紋；長文字換行、行高 1.4。
 *   - 列印跟網頁同一套（xlsx／PDF 下載檔不在這裡，格式不變）。
 *
 * 兩種用法：
 *   1. Tailwind class 常數（`sheet.*`）——手寫 <table> 的表格（專案列表、獎金批次、假勤月表…）。
 *   2. `gridCellWebStyle()`——照 API 格線（StatementGrid）畫的表（出勤統計表／薪資明細表；
 *      專案獎金分潤總表日後也可共用），把 Excel 的框線／底色／字級轉成後台樣式的 inline style。
 */

/* ------------------------------------------------------------ 顏色 token --- */

/** Tailwind gray 色票（inline style 用；與 class 版本一致）。 */
export const SHEET_COLORS = {
  text: "#111827", // gray-900
  muted: "#6b7280", // gray-500
  headText: "#4b5563", // gray-600
  headBg: "#f9fafb", // gray-50
  grid: "#e5e7eb", // gray-200
  frame: "#d1d5db", // gray-300
  danger: "#dc2626", // red-600
  /** 品牌色淡底（強調格）。 */
  accentBg: "color-mix(in srgb, var(--brand) 5%, white)",
} as const;

/* ------------------------------------------------------- Tailwind class --- */

export const sheet = {
  /** 表格外框容器（可水平捲動）。 */
  frame: "overflow-x-auto rounded-lg border border-gray-300 bg-white",
  /** <table> 本體。 */
  table: "w-full border-collapse text-[13px] leading-[1.4] text-gray-900",
  /** 表頭格。 */
  th: "border border-gray-200 bg-gray-50 px-2.5 py-2 text-center text-xs font-medium text-gray-600",
  /** 內容格。 */
  td: "border border-gray-200 px-2.5 py-1.5 align-middle",
  /** 數字格（靠右、等寬數字、不折行）。 */
  num: "text-right tabular-nums whitespace-nowrap",
  /** 一般內容列（hover 淡灰，不用斑馬紋）。 */
  row: "hover:bg-gray-50",
  /** 合計列。 */
  totalRow: "bg-gray-50 font-semibold",
  /** 強調格（原本藍／綠／黃底的格子）。 */
  accent: "bg-[color-mix(in_srgb,var(--brand)_5%,white)]",
  /** 原本 Excel 灰底的格子（標籤格、唯讀格）。 */
  shade: "bg-gray-50",
  /** 警示（負數、超額、未分配）。 */
  danger: "text-red-600",
  /** 抬頭：比照後台卡片標題（ess-ui Card 的 h2）。 */
  title: "text-base font-semibold text-gray-900",
  /** 抬頭下方的副標（公司名、地址、期別）。 */
  subtitle: "text-sm text-gray-500",
  /**
   * 表格內可輸入的格子：跟後台輸入框（ess-ui inputCls）同一套淡框＋品牌色聚焦，
   * 白底細框一眼看得出可填；唯讀格沒有框。
   */
  input:
    "w-full min-w-0 rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-[13px] text-gray-900 placeholder:text-gray-400 hover:border-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--brand)] disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500",
} as const;

/* ------------------------------------------------- StatementGrid → web --- */

export interface GridWebContext {
  /** 這格在表頭以上的抬頭區（公司名、地址、表名）。 */
  banner?: boolean;
  /** 抬頭區的第一列（主標題）。 */
  bannerTitle?: boolean;
}

/** 抬頭區：表格格線開始之前（第一個有左右框線的列以前）的列數。 */
export function gridBannerRows(cells: Pick<GridCell, "row" | "border">[]): number {
  let first = Infinity;
  for (const c of cells) if (c.border?.left || c.border?.right) first = Math.min(first, c.row);
  return Number.isFinite(first) ? first : 0;
}

/** Excel 框線 → 後台框線：細線 gray-200、中／粗／雙線（外框、區塊分隔）gray-300，一律 1px。 */
export function gridBorderCss(style: BorderStyle | undefined): string | undefined {
  if (!style) return undefined;
  return `1px solid ${style === "thin" ? SHEET_COLORS.grid : SHEET_COLORS.frame}`;
}

/** 表頭格判斷：粗體文字格（有底色或是較大字級的欄名）。數字格不算。 */
export function isGridHeaderCell(cell: Pick<GridCell, "bold" | "value" | "fill">): boolean {
  return !!cell.bold && typeof cell.value !== "number" && cell.value !== null && cell.value !== "";
}

/**
 * 一格 Excel 格線 → 後台樣式的 inline style。結構（合併、對齊、折行）照原檔；
 * 字型繼承頁面、字級統一（內容 13px／表頭 12px／抬頭 16px）、底色與框線換成後台色票。
 */
export function gridCellWebStyle(cell: GridCell, ctx: GridWebContext = {}): CSSProperties {
  const numeric = typeof cell.value === "number";
  const align = cell.align ?? (numeric ? "right" : "left");
  const base: CSSProperties = {
    textAlign: align,
    whiteSpace: cell.wrap ? "normal" : "nowrap",
    overflow: "visible",
    padding: "0 6px",
    verticalAlign: "middle",
    lineHeight: 1.4,
    fontVariantNumeric: "tabular-nums",
    color: cell.negative ? SHEET_COLORS.danger : SHEET_COLORS.text,
  };
  // 原檔 18pt 以上的大字（公司名、「薪資明細表」這種表名列）一律當抬頭主標，即使它在格線裡面。
  const bigTitle = (cell.size ?? 0) >= 18;
  if (ctx.banner || bigTitle) {
    // 抬頭：比照後台卡片標題（主標 16px 半粗；表名 14px 半粗；地址電話等 12px 灰字），不畫框線。
    const isTitle = ctx.bannerTitle || bigTitle;
    const isName = isTitle || /表/.test(cell.text);
    return {
      ...base,
      fontSize: isTitle ? 16 : isName ? 14 : 12,
      fontWeight: isName ? 600 : 400,
      color: isName ? SHEET_COLORS.text : SHEET_COLORS.muted,
    };
  }
  const b = cell.border ?? {};
  const header = isGridHeaderCell(cell);
  return {
    ...base,
    borderTop: gridBorderCss(b.top),
    borderBottom: gridBorderCss(b.bottom),
    borderLeft: gridBorderCss(b.left),
    borderRight: gridBorderCss(b.right),
    fontSize: header ? 12 : 13,
    fontWeight: header ? 500 : cell.bold ? 600 : 400,
    color: cell.negative ? SHEET_COLORS.danger : header ? SHEET_COLORS.headText : SHEET_COLORS.text,
    // 表頭（原本綠底／粗體欄名）→ gray-50；其他有底色的格（原本黃底強調）→ 品牌淡底。
    background: header ? SHEET_COLORS.headBg : cell.fill ? SHEET_COLORS.accentBg : undefined,
  };
}
