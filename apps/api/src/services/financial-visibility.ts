import type { SelfEmployee } from "../middleware/scope.js"
import { loadEmployeeFeatures, type EmployeeFeatures } from "./employee-features.js"
import { loadProjectBossEmpId } from "./project-scope.js"
import { isBossOrPlatformAdmin } from "../lib/boss.js"

/**
 * 集團財務可見性（業主 2026-10-26：老闆與一般 HR 分開）。
 *
 * 「集團財務」＝集團總覽（收入、支出、毛利、人事成本、各公司）、專案毛利（毛利／入帳／成本／累計獎金池、
 * 獎金比例）、後台首頁的本年收入／毛利率。誰看得到：
 *   • 老闆（tenants.features.approval.fallbackApproverEmpId，id 小寫比對；不一定是 hr_admin）
 *   • platform_admin（系統維護）
 *   • 被授權的 hr_admin（employees.features.seeGroupFinancials === true）
 * 其他 hr_admin 預設**看不到**；會計、一般員工一律看不到（即使旗標被誤設成 true 也不算——旗標只對 hr_admin 有效）。
 * HR 日常工作（薪資、薪資單、出勤、假單、人事、獎金批次的建立與送審）不受這條規則影響。
 *
 * 授權旗標只有老闆或 platform_admin 能改（PATCH /employees 帶 features.seeGroupFinancials，HR 改 → 403），
 * 見 canGrantGroupFinancials。
 */

type Caller = Pick<SelfEmployee, "id" | "role">

/** 純函式：給定老闆 id 與本人的個人功能開關，判斷看不看得到集團財務。 */
export function canSeeGroupFinancials(
  self: Caller,
  bossEmpId: string | null | undefined,
  features: Pick<EmployeeFeatures, "seeGroupFinancials"> | null | undefined,
): boolean {
  if (isBossOrPlatformAdmin(bossEmpId, self)) return true
  return self.role === "hr_admin" && features?.seeGroupFinancials === true
}

/** 純函式：能不能授權／取消別人的「可看集團財務」（只有老闆或 platform_admin）。 */
export function canGrantGroupFinancials(self: Caller, bossEmpId: string | null | undefined): boolean {
  return isBossOrPlatformAdmin(bossEmpId, self)
}

export type GroupFinancialsAccess = {
  /** 看得到集團財務。 */
  canSee: boolean
  /** 能改別人的 seeGroupFinancials 旗標（老闆／platform_admin）。 */
  canGrant: boolean
  /** 老闆的員工 id（小寫）；沒設定 null。 */
  bossEmpId: string | null
}

/**
 * 載入版：只在需要時才打 DB。先查老闆（呼叫端已查過可帶 `bossEmpId` 省一次），
 * 是老闆就定案；只有 hr_admin 才再讀自己的 features。
 */
export async function loadGroupFinancialsAccess(
  tenantId: string,
  self: Caller,
  bossEmpId?: string | null,
): Promise<GroupFinancialsAccess> {
  const boss = bossEmpId !== undefined ? bossEmpId : await loadProjectBossEmpId(tenantId)
  if (isBossOrPlatformAdmin(boss, self)) return { canSee: true, canGrant: true, bossEmpId: boss }
  if (self.role !== "hr_admin") return { canSee: false, canGrant: false, bossEmpId: boss }
  const features = await loadEmployeeFeatures(tenantId, self.id)
  return { canSee: canSeeGroupFinancials(self, boss, features), canGrant: false, bossEmpId: boss }
}
