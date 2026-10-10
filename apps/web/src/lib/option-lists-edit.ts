/**
 * 「設定 → 選項清單」頁的編輯規則（純函式，無 React；有 vitest）。
 *
 * 頁面把一份清單攤成可編輯的列（`OptionRow`），使用者改名、上下移、勾停用、新增列之後按「儲存」，
 * 整批送 `PUT /option-lists/:key`：列的順序＝排序（sortOrder 依位置 10、20、30…），已存的列帶 code、
 * 新增的列不帶（code 由後端產生）。刪除不走這裡（獨立的 DELETE，只准刪沒被用過的）。
 */
import type { OptionItemInput, OptionListDetail } from "./option-lists-api";

/** 與後端 OPTION_LABEL_MAX 一致。 */
export const OPTION_LABEL_MAX = 40;
/** 排序值的間距：依位置 10、20、30…，之後後端新增的項目接在最大值＋10。 */
export const OPTION_SORT_STEP = 10;

export interface OptionRow {
  /** React key：已存的列用 code，新增的列用本地產生的 `new-…`。 */
  key: string;
  /** 已存的項目才有；新增的列沒有。 */
  code?: string;
  label: string;
  isActive: boolean;
  /** 載入時被資料引用的筆數（新增的列＝0）；刪除鈕看這個。 */
  usage: number;
}

/** 管理視圖 → 可編輯的列（順序照後端給的 sortOrder 排）。 */
export function rowsFromDetail(detail: Pick<OptionListDetail, "items" | "usage">): OptionRow[] {
  return detail.items.map((item) => ({
    key: item.code,
    code: item.code,
    label: item.label,
    isActive: item.isActive !== false,
    usage: detail.usage?.[item.code] ?? 0,
  }));
}

export function newOptionRow(key: string): OptionRow {
  return { key, label: "", isActive: true, usage: 0 };
}

/** 把第 `index` 列往上（-1）或往下（+1）挪一格；已在邊界就原樣回（回新陣列，不改原陣列）。 */
export function moveRow<T>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const next = [...rows];
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return next;
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}

/** 名稱比對用的正規化：與後端 optionLabelKey 同一套（trim、全形轉半形、轉小寫）——「ABC」「ａｂｃ」視為同名。 */
export function normalizeOptionLabel(label: string): string {
  return label.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

/**
 * 存檔前的檢查（後端仍是最後防線）：回第一個問題的說明，沒問題回 null。
 *   • 已存的項目名稱被清空 → 不能存（要拿掉請停用或刪除）；新增卻沒填名稱的空列直接略過。
 *   • 名稱超過 40 字、同清單名稱重複（正規化後比）。
 */
export function validateOptionRows(rows: readonly OptionRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const label = row.label.trim();
    if (!label) {
      if (row.code) return "已存的選項名稱不能空白；要拿掉請勾「停用」，或按「刪除」（沒用過才能刪）。";
      continue;
    }
    if (label.length > OPTION_LABEL_MAX) return `名稱「${label.slice(0, 10)}…」超過 ${OPTION_LABEL_MAX} 字。`;
    const key = normalizeOptionLabel(label);
    if (seen.has(key)) return `名稱重複：「${label}」，請改一下再存。`;
    seen.add(key);
  }
  return null;
}

/** 列 → PUT 的 items：略過空白的新增列；名稱 trim；排序依位置 10、20、30…；已存的列帶 code。 */
export function buildPutItems(rows: readonly OptionRow[]): OptionItemInput[] {
  const items: OptionItemInput[] = [];
  for (const row of rows) {
    const label = row.label.trim();
    if (!label) continue;
    items.push({
      ...(row.code ? { code: row.code } : {}),
      label,
      sortOrder: (items.length + 1) * OPTION_SORT_STEP,
      isActive: row.isActive,
    });
  }
  return items;
}
