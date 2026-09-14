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

/**
 * 身分類別（employees.employment_type）：目前系統只有這四種可指派值（來源：
 * app/admin/employees/page.tsx 新增員工表單的下拉選單），後台「員工端功能
 * 開放」（module-settings 頁）只針對這四類各給一排 checkbox。
 */
export const EMPLOYMENT_TYPES = ["regular", "parttime", "contract", "intern"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  regular: "正職",
  parttime: "兼職",
  contract: "約聘",
  intern: "實習",
};

/**
 * intern 在 tenants.features.essTabs 沒有設定時的後端預設值，鏡射
 * apps/api/src/routes/me.ts 的 INTERN_DEFAULT_ESS_TABS——後台用它當 intern
 * 排的預設勾選狀態。兩邊是各自檔案裡的常數（web 不能 import api），改一邊
 * 要記得改另一邊。
 */
export const INTERN_DEFAULT_ESS_TABS: readonly string[] = [
  "home",
  "schedule",
  "punches",
  "requests",
  "notifications",
  "mydata",
];
