import type { SelfEmployee } from "../middleware/scope.js"
import { loadEmployeeFeatures, type EmployeeFeatures } from "./employee-features.js"
import { loadProjectBossEmpId } from "./project-scope.js"
import { isBossOrPlatformAdmin, isPlatformAdminRole } from "../lib/boss.js"
import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 集團財務可見性（業主 2026-10-26：老闆與一般 HR 分開）。
 *
 * 「集團財務」＝專案毛利（毛利／入帳／成本／累計獎金池、獎金比例；routes/projects.ts）、獎金批次的毛利欄位
 * （routes/bonus-runs.ts canSeeProfit）、獎金分潤總表（routes/bonus-sheet.ts）。誰看得到：
 *   • 老闆（tenants.features.approval.fallbackApproverEmpId，id 小寫比對；不一定是 hr_admin）
 *   • platform_admin（系統維護）
 *   • 被授權的 hr_admin（employees.features.seeGroupFinancials === true）
 * 其他 hr_admin 預設**看不到**；會計、一般員工一律看不到（即使旗標被誤設成 true 也不算——旗標只對 hr_admin 有效）。
 * HR 日常工作（薪資、薪資單、出勤、假單、人事、獎金批次的建立與送審）不受這條規則影響。
 *
 * 授權旗標只有老闆或 platform_admin 能改（PATCH /employees 帶 features.seeGroupFinancials，HR 改 → 403），
 * 見 canGrantGroupFinancials。
 *
 * ⚠️ 集團總覽（各公司收入、開票、支出、毛利、人事成本、月趨勢）與後台首頁的本年收入／毛利率**不走這條規則**：
 * 2026-10-27 業主：「集團總覽的內容直接放到首頁，並且只有平台管理員才看得到。」→ 只開給在職的 platform_admin
 * （canSeeGroupOverview／loadGroupOverviewAccess）。老闆若不是 platform_admin、被授權的 hr_admin 都看不到集團總覽，
 * 但上面三項（專案毛利、獎金批次毛利、獎金分潤）照舊。
 */

type Caller = Pick<SelfEmployee, "id" | "role" | "active">

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

/* ── 集團總覽（2026-10-27：只有在職的平台管理員） ───────────────────────── */

/**
 * 純函式：看不看得到集團總覽（首頁集團總覽區塊、首頁本年收入／毛利率、GET /group-overview*）。
 * 業主 2026-10-27 原話「只有平台管理員才看得到」→ **照字面**：role = platform_admin（精確比對）且 status = 'active'。
 * 刻意不用 isBossOrPlatformAdmin（不含「老闆」）、也不看 features.seeGroupFinancials。
 */
export function canSeeGroupOverview(self: { role?: string | null; status?: string | null } | null | undefined): boolean {
  return !!self && isPlatformAdminRole(self.role) && self.status === "active"
}

/** 載入版：用登入者 user id 讀自己的 role／status（resolveSelf 不帶 status）。查不到員工列 → false；查詢錯誤往上丟。 */
export async function loadGroupOverviewAccess(tenantId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`group overview access: ${error.message}`)
  return canSeeGroupOverview(data as { role?: string | null; status?: string | null } | null)
}
