/**
 * 後台「員工端功能開放」（/admin/module-settings/ess-tabs）的純函式，不碰 React，全部有單元測試
 * （__tests__/ess-tabs-config.test.ts）：tenants.features.essTabs 的表單形狀（身分類別 → 可見 tab key
 * 清單）、預設值、由後端資料還原、勾選切換。tab key 與身分類別的定義在 ./ess-tabs
 * （ESS_TABS／EMPLOYMENT_TYPES／INTERN_DEFAULT_ESS_TABS），這裡不重複宣告。
 */
import {
  ALWAYS_VISIBLE_TAB_KEYS,
  EMPLOYMENT_TYPES,
  ESS_TABS,
  INTERN_DEFAULT_ESS_TABS,
  type EmploymentType,
  type EssTab,
} from "./ess-tabs";

/** 表單狀態：身分類別 → 目前勾選（可見）的 tab key 清單；切換時會照 ESS_TABS 順序重排。 */
export type EssTabsConfig = Record<EmploymentType, string[]>;

/** 某身分類別完全沒有設定時的預設勾選狀態：intern 只給後端預設的那幾個（含 home），其餘身分全勾。 */
export function defaultEssTabsFor(type: EmploymentType): string[] {
  return type === "intern" ? [...INTERN_DEFAULT_ESS_TABS] : ESS_TABS.map((t) => t.key);
}

export function defaultEssTabsConfig(): EssTabsConfig {
  const cfg = {} as EssTabsConfig;
  for (const type of EMPLOYMENT_TYPES) cfg[type] = defaultEssTabsFor(type);
  return cfg;
}

/**
 * 由 tenants.features.essTabs 還原表單狀態；整包不是物件、或某身分類別缺欄位／格式不對
 * （不是字串陣列），該身分類別退回預設值。有效清單原樣保留（含順序），但複製一份不共用參照。
 */
export function hydrateEssTabsConfig(raw: unknown): EssTabsConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const cfg = {} as EssTabsConfig;
  for (const type of EMPLOYMENT_TYPES) {
    const list = source[type];
    cfg[type] =
      Array.isArray(list) && list.every((v) => typeof v === "string") ? [...(list as string[])] : defaultEssTabsFor(type);
  }
  return cfg;
}

/** 照 ESS_TABS 原本順序重排；不在 ESS_TABS 的 key 丟掉、重複的只留一個。 */
export function sortedByEssTabs(keys: Iterable<string>): string[] {
  const wanted = new Set(keys);
  return ESS_TABS.map((t) => t.key).filter((key) => wanted.has(key));
}

/** 後台可勾選的 tab：排除永遠可見的 home／announcements（ALWAYS_VISIBLE_TAB_KEYS），順序照 ESS_TABS。 */
export function configurableEssTabs(): EssTab[] {
  return ESS_TABS.filter((t) => !ALWAYS_VISIBLE_TAB_KEYS.has(t.key));
}

/**
 * 切換某身分類別對某個 tab 的勾選：純函式，回傳新物件、不改輸入（其他身分類別沿用同一參照）；
 * 結果永遠照 ESS_TABS 順序排列。永遠可見的 tab（ALWAYS_VISIBLE_TAB_KEYS）不可切換，原物件原樣回傳。
 */
export function toggleEssTab(cfg: EssTabsConfig, type: EmploymentType, key: string): EssTabsConfig {
  if (ALWAYS_VISIBLE_TAB_KEYS.has(key)) return cfg;
  const current = new Set(cfg[type] ?? []);
  if (current.has(key)) current.delete(key);
  else current.add(key);
  return { ...cfg, [type]: sortedByEssTabs(current) };
}
