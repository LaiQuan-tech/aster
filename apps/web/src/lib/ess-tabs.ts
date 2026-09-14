/**
 * ESS 分頁過濾（純函式，不碰 React）。
 *
 * `allowedKeys` 來自 GET /me 的 `essTabs`（由 tenants.features.essTabs[employment_type]
 * 決定；intern 沒設定時後端給預設清單）。null／undefined＝不限縮，全部分頁可見。
 *
 * 規則：
 *   - 順序永遠照 `tabs` 原本的順序，不照 allowedKeys 的順序（心智模型跟後台一致）。
 *   - "home"（今日打卡）永遠保留：它是 /ess 本身，藏掉會讓人進站看不到任何分頁，
 *     而且工讀生也要打卡。
 *   - allowedKeys 裡不認得的 key 直接忽略（後台打錯字不會炸畫面）。
 *
 * Tab key 是穩定的公開字串（後台 essTabs 設定用），改名要連 EssHeader 與後台一起改：
 *   home, schedule, punches, sheet, balances, requests, approvals, projects, bonus,
 *   payslips, expenses, kpi, jobs, ai, company, notifications, mydata
 */
export interface EssTabLike {
  key: string;
}

export function visibleTabs<T extends EssTabLike>(
  tabs: readonly T[],
  allowedKeys: readonly string[] | null | undefined,
): T[] {
  if (allowedKeys == null) return [...tabs];
  const allowed = new Set(allowedKeys);
  return tabs.filter((tab) => tab.key === "home" || allowed.has(tab.key));
}
