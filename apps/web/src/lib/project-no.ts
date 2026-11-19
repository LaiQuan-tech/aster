/**
 * 合約編號（projects.project_no，2026-11-18 migration 0117）：專案序號（code，如 AT-115-004）之外，
 * 可自由輸入的另一套編號（業主／客戶或內部）。選填、不唯一、去頭尾空白後最多 100 字（與 API zod、
 * DB CHECK projects_project_no_len_chk 相同）。純函式、不依賴 `@/` 別名，前端各處與測試都可直接載入。
 */
export const PROJECT_NO_MAX = 100;

/** 合約編號輸入整理：去頭尾空白、空字串＝null；超過上限回 "too_long"（前端先擋，後端仍會驗）。 */
export function normalizeProjectNo(raw: string | null | undefined): string | null | "too_long" {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return [...v].length > PROJECT_NO_MAX ? "too_long" : v;
}
