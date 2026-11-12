/**
 * 專案申請單「設計內容（科別／服務項目）」科別欄的下拉建議（2026-11-12）。
 *
 * 選項存在後端「選項清單」的 `design_discipline`（每個租戶可自訂；設定 → 選項清單 → 設計內容科別選項）。
 * 專案上存的是科別**文字**（不是 code），所以清單怎麼改都不影響既有專案。純函式，有 vitest。
 */
import { normalizeOptionLabel } from "./option-lists-edit";
import type { OptionItem } from "./option-lists-api";

export const DESIGN_DISCIPLINE_LIST_KEY = "design_discipline";
/** 與後端登記表的預設值一致；清單還沒載入或載入失敗時當建議用。 */
export const DEFAULT_DESIGN_DISCIPLINES: readonly string[] = ["電機", "空調", "消防", "汙水", "規費"];
/** 與後端 labelMax 一致。 */
export const DESIGN_DISCIPLINE_LABEL_MAX = 20;

/** 下拉建議：啟用的項目名稱（依排序）；清單還沒有任何項目（載入中／失敗）時用預設值。 */
export function designDisciplineSuggestions(items: readonly OptionItem[]): string[] {
  if (items.length === 0) return [...DEFAULT_DESIGN_DISCIPLINES];
  return items.filter((item) => item.isActive !== false).map((item) => item.label);
}

/**
 * 要不要在輸入框旁顯示「加入常用選項」：有填值、不超過字數上限，而且清單（含停用的）裡沒有同名
 * （去空白、大小寫／全半形不分）。清單還沒載入完（items 空）時不顯示，免得閃一下。
 */
export function canOfferAddDiscipline(value: string, items: readonly OptionItem[]): boolean {
  const label = value.trim();
  if (!label || label.length > DESIGN_DISCIPLINE_LABEL_MAX || items.length === 0) return false;
  const key = normalizeOptionLabel(label);
  return !items.some((item) => normalizeOptionLabel(item.label) === key);
}
