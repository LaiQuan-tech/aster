import type { GridCell, StatementGrid } from "./statements-api";

/**
 * 獎金分潤總表「公司格式」的畫面／列印風格（2026-10-27 業主：配色字體跟後台一致；同一套規格會套到其他 Excel 版面）。
 * Excel 下載維持原檔格式（API 產生），這裡只改畫面：
 *   • 字體繼承後台無襯線字；內容 13px、表頭 12px font-medium text-gray-600；數字 tabular-nums 靠右。
 *   • 表頭 bg-gray-50；框線一律 1px gray-200（外框 gray-300 在容器上），不用粗黑雙線。
 *   • 原「本輪」綠／藍底 → 品牌色淡底（--brand 5%），該欄表頭品牌色字；灰底格 → gray-50。
 *   • 紅字只用在警示（負數、尚未分配不為 0）；百分比與一般金額 text-gray-900，備註 gray-700。
 *   • 抬頭（ASTER 標誌、公司名、表名、本期）從格線拿出來，改畫成後台卡片標題（webThemeGrid().title）。
 * 純函式。
 */

export const THEME = {
  border: "#E5E7EB", // gray-200
  headerBg: "#F9FAFB", // gray-50
  headerText: "#4B5563", // gray-600
  text: "#111827", // gray-900
  noteText: "#374151", // gray-700
  warn: "#DC2626", // red-600
  brandTint: "color-mix(in srgb, var(--brand, #1f4e79) 5%, #fff)",
  brand: "var(--brand, #1f4e79)",
} as const;

/** API 版面用的強調底色（lib/statements/bonus-sheet.ts）：本次欄淡綠、本次列已收款淡藍、成員姓名灰底。 */
const ACCENT_FILLS = new Set(["#E2EFDA", "#DDEBF7"]);
const GRAY_FILLS = new Set(["#E7E6E6"]);

export type ThemedTitle = { logo: boolean; texts: string[] };
export type ThemedGrid = {
  grid: StatementGrid;
  title: ThemedTitle | null;
  /** 原格線列號 → 新列號（被拿掉的抬頭／間隔列不在裡面）。 */
  rowMap: Map<number, number>;
  /** 「尚未分配」欄（新欄號）：不為 0 才紅字。 */
  warnColumns: Set<number>;
};

/** 欄寬縮放與工程名稱欄最小字寬（StatementGrid 欄寬單位）。 */
export const COLUMN_SCALE = 0.6;
export const NAME_MIN_WIDTH = 16;
export const AMOUNT_MIN_WIDTH = 9.5;
export const MAX_AUTO_WIDTH = 14;

/** 一行文字在 13px 無襯線下約佔幾個欄寬單位（1 單位≈8px）：半形 ≈0.95、全形 ≈1.65；多行取最長。 */
export function textWidthUnits(text: string): number {
  return Math.max(0, ...text.split("\n").map((line) => [...line].reduce((w, ch) => w + (/[\u0000-\u00ff]/.test(ch) ? 0.95 : 1.65), 0)));
}

function freezeRowsOf(rows: number, rowMap: Map<number, number>): number {
  return [...rowMap.keys()].filter((old) => old < rows).length;
}

const isEmpty = (c: GridCell) => c.value === null || c.value === "";

/**
 * 拿掉抬頭列（有標誌格的那幾列）與空白間隔列（整列沒有值、高度 ≤ 12pt），工程名稱欄給足寬度（行高 1.4 不擠成五行）。
 */
export function webThemeGrid(src: StatementGrid): ThemedGrid {
  const logo = src.cells.find((c) => c.logo);
  const titleRows = logo ? logo.row + (logo.rowSpan ?? 1) : 0;
  const title: ThemedTitle | null = logo
    ? {
        logo: true,
        texts: src.cells
          .filter((c) => c.row < titleRows && !c.logo && !isEmpty(c))
          .sort((a, b) => a.row - b.row || a.col - b.col)
          .map((c) => String(c.text || c.value)),
      }
    : null;
  const rowCount = Math.max(src.rowHeights.length, src.cells.reduce((m, c) => Math.max(m, c.row + (c.rowSpan ?? 1)), 0));
  const drop = new Set<number>();
  for (let r = 0; r < titleRows; r += 1) drop.add(r);
  for (let r = titleRows; r < rowCount; r += 1) {
    const inRow = src.cells.filter((c) => c.row === r);
    const spanned = src.cells.some((c) => c.row < r && c.row + (c.rowSpan ?? 1) > r);
    if (!spanned && (src.rowHeights[r] ?? 20) <= 12 && inRow.every(isEmpty)) drop.add(r);
  }
  const rowMap = new Map<number, number>();
  let next = 0;
  for (let r = 0; r < rowCount; r += 1) if (!drop.has(r)) rowMap.set(r, next++);
  const cells = src.cells.filter((c) => rowMap.has(c.row)).map((c) => ({ ...c, row: rowMap.get(c.row)! }));
  const rowHeights = Array.from({ length: rowCount }, (_, r) => r)
    .filter((r) => rowMap.has(r))
    .map((r) => src.rowHeights[r] ?? 20.9);
  // 原檔欄寬是 12pt 明體量的；13px 無襯線字較窄，整體收 COLUMN_SCALE，1280 寬配合「符合寬度」看得完。
  // 工程名稱欄至少 NAME_MIN_WIDTH 字寬（約 150px），名稱換行也只有兩三行。
  const columns = src.columns.map((w) => (w < 1 ? w : Math.max(5, Math.round(w * COLUMN_SCALE * 100) / 100)))
  const nameCol = cells.find((c) => c.value === "工程名稱")?.col;
  if (nameCol !== undefined) columns[nameCol] = Math.max(columns[nameCol] ?? 0, NAME_MIN_WIDTH);
  // 成員「%＋金額」兩行格與尚未分配：要放得下「累 1,234,567」。
  for (const c of cells) if (c.value === "%\n金額" || c.value === "尚未分配") columns[c.col] = Math.max(columns[c.col] ?? 0, AMOUNT_MIN_WIDTH);
  // 不換行的內容格（數字、姓名）至少放得下最長的一行，不被截斷（上限 MAX_AUTO_WIDTH）。
  const headerRowsEnd = src.freeze ? freezeRowsOf(src.freeze.rows, rowMap) : 0;
  for (const c of cells) {
    if (c.row < headerRowsEnd || (c.colSpan ?? 1) > 1 || c.wrap && !isNumericCell(c)) continue;
    const need = Math.min(MAX_AUTO_WIDTH, textWidthUnits(c.text || String(c.value ?? "")) + 1.5);
    if (need > (columns[c.col] ?? 0)) columns[c.col] = need;
  }
  const warnColumns = new Set(cells.filter((c) => c.value === "尚未分配").map((c) => c.col));
  const freezeRows = src.freeze ? freezeRowsOf(src.freeze.rows, rowMap) : 0;
  return {
    grid: { ...src, columns, rowHeights, cells, ...(src.freeze ? { freeze: { rows: freezeRows, cols: src.freeze.cols } } : {}) },
    title,
    rowMap,
    warnColumns,
  };
}

const NUMERIC_TEXT = /^[\d,.\-−\s%()累—]+$/;

/** 看起來是數字（含「40.0 %\n6,000」「累 8,000」兩行格）→ 靠右、tabular-nums。 */
export function isNumericCell(c: Pick<GridCell, "value" | "text">): boolean {
  if (typeof c.value === "number") return true;
  const t = (c.text || String(c.value ?? "")).trim();
  return t !== "" && NUMERIC_TEXT.test(t);
}

/** 尚未分配不為 0：上行百分比不是 0。 */
export function isNonZeroUnallocated(c: Pick<GridCell, "value" | "text">): boolean {
  const t = (c.text || String(c.value ?? "")).trim();
  if (!t) return false;
  const first = t.split("\n")[0]!.replace(/[%\s]/g, "");
  const n = Number(first);
  return Number.isFinite(n) ? n !== 0 : false;
}

export type CellTheme = {
  background: string;
  color: string;
  fontSize: string;
  fontWeight: number;
  textAlign: "left" | "center" | "right";
  numeric: boolean;
};

/** 單格的畫面風格。header＝表頭列；warn＝這格在「尚未分配」欄。 */
export function cellTheme(cell: GridCell, opts: { header: boolean; warn: boolean }): CellTheme {
  const accent = !!cell.fill && ACCENT_FILLS.has(cell.fill.toUpperCase());
  const gray = !!cell.fill && GRAY_FILLS.has(cell.fill.toUpperCase());
  if (opts.header) {
    return {
      background: accent ? THEME.brandTint : THEME.headerBg,
      color: accent ? THEME.brand : THEME.headerText,
      fontSize: "12px",
      fontWeight: 500,
      textAlign: "center",
      numeric: false,
    };
  }
  const numeric = isNumericCell(cell);
  const warn = cell.negative || (typeof cell.value === "number" && cell.value < 0) || (opts.warn && isNonZeroUnallocated(cell));
  const note = !numeric && cell.wrap && cell.align === "left" && typeof cell.value === "string" && cell.value.length > 12;
  return {
    background: accent ? THEME.brandTint : gray ? THEME.headerBg : "#fff",
    color: warn ? THEME.warn : note ? THEME.noteText : THEME.text,
    fontSize: note ? "12px" : "13px",
    fontWeight: cell.bold ? 600 : 400,
    textAlign: numeric ? "right" : cell.align === "center" ? "center" : (cell.align ?? "left"),
    numeric,
  };
}
