/**
 * 角色常數的單一來源（原本硬編在 AdminGate / ess-api 各處，收斂於此避免不一致）。
 * ADMIN_ROLES = 可進後台 /admin 的角色。專案分潤的「主管可見」另由後端依
 * 專案負責人 / 部門主管動態判定，不靠這個清單。
 *
 * 2026-09-22 業主決策 3：新增會計（accountant）——可進後台，但只看得到
 * 「專案與財務／報銷／預支／出勤月表／人員基本資料」（lib/admin-nav.ts 的
 * roleNavOf／ACCOUNTANT_DEFAULT_NAV），薪資作業、薪資單、獎金批次、分潤趴數與
 * 獎金池看不到（API 端 requireFinance／canSeeBonus 是真正的守門，前端只是導覽）。
 */
export const HR_ROLES: readonly string[] = ["hr_admin", "platform_admin"]

export const ADMIN_ROLES: readonly string[] = [...HR_ROLES, "accountant"]

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(role)
}

/** HR／平台管理員（全後台）；會計不算。 */
export function isHrRole(role: string | null | undefined): boolean {
  return !!role && HR_ROLES.includes(role)
}

export function isAccountantRole(role: string | null | undefined): boolean {
  return role === "accountant"
}
