import { supabaseAdmin } from "../lib/supabase.js"
import { canEditUnlockList, loadPeriodUnlockPolicy, type PeriodUnlockPolicy } from "./period-lock.js"

/**
 * 特權帳號的權限邊界（2026-10-11，業主拍板：堵住 HR 繞過發薪解鎖）。
 *
 * 發薪鎖定的「誰能重新開放」是 老闆（tenants.features.approval.fallbackApproverEmpId）＋老闆指定的人
 * （features.payroll.periodUnlockEmpIds）。HR（hr_admin）預設不在其中，但 HR 原本有三條路能「變成」老闆或
 * 接管他的帳號——這支檔案把那三條路收成**只有老闆或 platform_admin 能走**：
 *
 *   ① 更換老闆設定（PUT /api/tenant/settings 的 approval.fallbackApproverEmpId）
 *        → 目前有老闆時，只有老闆本人（可以交棒給別人）或 platform_admin 能換／清除；
 *          **還沒有老闆**（null）時，任何 HR 可以做第一次設定（否則沒人能設定，是鎖死的初始狀態）。
 *   ② 指派 platform_admin 角色（建立員工、改角色、批次建立帳號的 CSV 角色欄）
 *        → 只有 platform_admin。HR 不能指派，也不能把自己升上去。**只擋「變成」**：目標本來就是
 *          platform_admin 時，帶著原值存檔（員工管理頁每次儲存都會帶 role）照常通過。
 *   ③ 重設／接管受保護帳號的密碼（後台重設密碼、寄重設密碼信、寄邀請信、批次建立時綁到既有列）
 *        → 受保護帳號＝ 老闆、老闆指定的解鎖人、hr_admin、platform_admin；
 *          只有老闆或 platform_admin 能動（對本人自己例外——不是接管）。HR 重設一般員工照舊。
 *
 * 為什麼連「寄信」也算：`sendEmployeeAccountLink`／`bulkInviteFromCsv` 在 dryRun 或沒設信件服務時會把
 * 重設連結直接回給呼叫者，拿到連結等於可以替對方設新密碼——跟直接重設密碼一樣是接管。
 * 為什麼連「老闆指定的解鎖人」也算：他們本來就能重新開放月份，HR 接管他們的帳號等於把這個權限偷走。
 *
 * 本檔的判斷全是純函式（有單元測試）；只有 `assertCanManageCredentials`／`loadActor` 會讀 DB。
 * 守門的呼叫點：routes/tenant.ts、routes/employees.ts、routes/auth-accounts.ts、
 * services/auth-invite.ts（bulkInviteFromCsv）。
 */

export const PLATFORM_ADMIN_ROLE = "platform_admin"
export const HR_ADMIN_ROLE = "hr_admin"

/** 角色字串比對一律小寫、去頭尾空白（DB 值與 zod trim 後的輸入對得起來）。 */
export function normalizeRole(role: string | null | undefined): string {
  return (role ?? "").trim().toLowerCase()
}

/** 系統認得的角色（employees.role 是自由文字，這五個以外的字串不帶任何權限）。 */
const KNOWN_ROLES: ReadonlySet<string> = new Set(["employee", "manager", "accountant", HR_ADMIN_ROLE, PLATFORM_ADMIN_ROLE])

/**
 * 寫進資料庫的角色字串：已知角色一律存小寫標準寫法，其他字串只去頭尾空白。
 * 為什麼要統一：權限判斷（requireRole、RLS 的 is_hr_admin）是**精確比對**，`Platform_Admin` 這種大小寫變體既不帶權限、
 * 又會讓原本的 platform_admin 默默失去權限；而本檔的檢查是正規化後比對，兩邊寫法必須一致。
 */
export function canonicalRole(role: string): string {
  const normalized = normalizeRole(role)
  return KNOWN_ROLES.has(normalized) ? normalized : role.trim()
}

export interface PrivilegeCaller {
  id: string
  role: string
}

export interface AccountTarget {
  id: string
  role: string
}

export type PrivilegeCode = "not_boss" | "platform_admin_required"

export const BOSS_SETTING_MESSAGE = "只有老闆或平台管理員可以更換老闆設定"
export const CREDENTIALS_MESSAGE = "只有老闆或平台管理員可以重設老闆、HR 管理員或平台管理員的密碼"
export const ROLE_CHANGE_MESSAGE = "只有老闆或平台管理員可以變更老闆、HR 管理員或平台管理員的角色"
export const PLATFORM_ADMIN_ASSIGN_MESSAGE = "只有平台管理員可以指派「平台管理員」角色"

/** 權限不足：一律 403 `{ error: code, message }`（middleware/privilege-error.ts 轉成回應）。 */
export class PrivilegeError extends Error {
  readonly code: PrivilegeCode
  readonly httpStatus = 403
  constructor(code: PrivilegeCode, message: string) {
    super(message)
    this.name = "PrivilegeError"
    this.code = code
  }
  toBody(): { error: PrivilegeCode; message: string } {
    return { error: this.code, message: this.message }
  }
}

export function isPrivilegeError(err: unknown): err is PrivilegeError {
  return err instanceof PrivilegeError
}

/** 老闆（目前設定的那位）或 platform_admin。純函式。與「誰能改解鎖名單」同一個判準。 */
export function isBossOrPlatformAdmin(policy: PeriodUnlockPolicy, caller: PrivilegeCaller): boolean {
  return canEditUnlockList(policy, { id: caller.id, role: normalizeRole(caller.role) })
}

/**
 * 能不能把老闆設定從 `before` 換成別的值（含清除）。純函式。
 * 目前沒有老闆（bossEmpId＝null）→ 任何 HR 可做第一次設定；有老闆 → 只有老闆本人或 platform_admin。
 * 呼叫端只在 before／after 的老闆不同時才問這個。
 */
export function canChangeBoss(before: PeriodUnlockPolicy, caller: PrivilegeCaller): boolean {
  return before.bossEmpId === null || isBossOrPlatformAdmin(before, caller)
}

/** 老闆設定有沒有變（兩邊都是小寫 id 或 null）。純函式。 */
export function bossChanged(before: PeriodUnlockPolicy, after: PeriodUnlockPolicy): boolean {
  return before.bossEmpId !== after.bossEmpId
}

/** 指派 `role` 給人：platform_admin 只有 platform_admin 能指派，其餘角色不受這條限制。純函式。 */
export function canAssignRole(caller: PrivilegeCaller, role: string): boolean {
  return normalizeRole(role) !== PLATFORM_ADMIN_ROLE || normalizeRole(caller.role) === PLATFORM_ADMIN_ROLE
}

/**
 * 角色變更是否為「變成 platform_admin」：寫進去的角色（標準寫法）是 platform_admin，而資料庫現在存的**不是剛好**
 * `platform_admin`。純函式。（`currentRole` 為 null＝新建的列，視為不是。）
 * 為什麼目前的角色要精確比對：權限判斷（requireRole）是精確比對，既有的非標準列（例如 `Platform_Admin`）其實沒有權限；
 * 它帶著原值存檔時，canonicalRole 會把它寫成真的 platform_admin——那就是升級，必須算進來。
 */
export function isPlatformAdminPromotion(newRole: string | null | undefined, currentRole: string | null | undefined): boolean {
  return canonicalRole(newRole ?? "") === PLATFORM_ADMIN_ROLE && (currentRole ?? "") !== PLATFORM_ADMIN_ROLE
}

/**
 * 受保護帳號：老闆、老闆指定的解鎖人、hr_admin、platform_admin。純函式。
 * 動它們的登入憑證（重設密碼／寄連結／綁帳號）要老闆或 platform_admin。
 */
export function isProtectedAccount(target: AccountTarget, policy: PeriodUnlockPolicy): boolean {
  const role = normalizeRole(target.role)
  if (role === HR_ADMIN_ROLE || role === PLATFORM_ADMIN_ROLE) return true
  const id = target.id.toLowerCase()
  return policy.bossEmpId === id || policy.designatedEmpIds.includes(id)
}

/**
 * 呼叫者能不能動 `target` 的登入憑證。純函式。
 * 一般員工 → 任何有權限進到該端點的人（HR）；受保護帳號 → 老闆或 platform_admin，或是本人自己
 * （HR 對自己的帳號操作不是接管；改自己的密碼本來走員工自助的 /me/password）。
 */
export function canManageCredentialsOf(caller: PrivilegeCaller, target: AccountTarget, policy: PeriodUnlockPolicy): boolean {
  if (!isProtectedAccount(target, policy)) return true
  if (caller.id.toLowerCase() === target.id.toLowerCase()) return true
  return isBossOrPlatformAdmin(policy, caller)
}

/**
 * 能不能變更 `target` 的角色：受保護帳號（老闆、老闆指定的解鎖人、hr_admin、platform_admin）的角色異動——**含降級**——
 * 只有老闆或 platform_admin 能做（本人除外）。純函式。
 * 為什麼降級也要擋：不擋的話，HR 先把另一位 HR 降成一般員工（不再受保護）、重設他的密碼、再升回 hr_admin，
 * 受保護帳號的密碼保護就形同虛設；對老闆／platform_admin 則是直接剝奪他們的權限。判準與 canManageCredentialsOf 相同。
 */
export function canChangeRoleOf(caller: PrivilegeCaller, target: AccountTarget, policy: PeriodUnlockPolicy): boolean {
  return canManageCredentialsOf(caller, target, policy)
}

/** 載入某位員工的 {id, role}（actorEmpId → 角色）；查無或沒帶 id 回 null。 */
export async function loadActor(tenantId: string, actorEmpId: string | null | undefined): Promise<PrivilegeCaller | null> {
  if (!actorEmpId) return null
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("id", actorEmpId)
    .maybeSingle()
  if (error) throw new Error(`privileged-accounts (actor): ${error.message}`)
  if (!data) return null
  return { id: data.id as string, role: data.role as string }
}

/**
 * 呼叫者不能動 `target` 的登入憑證就丟 PrivilegeError（403 `not_boss`）。會讀一次租戶的解鎖政策。
 * `caller` 為 null（查不到呼叫者）一律視為沒有權限。
 */
export async function assertCanManageCredentials(
  tenantId: string,
  caller: PrivilegeCaller | null,
  target: AccountTarget,
  policyOverride?: PeriodUnlockPolicy,
): Promise<void> {
  const policy = policyOverride ?? (await loadPeriodUnlockPolicy(tenantId))
  if (!isProtectedAccount(target, policy)) return
  if (!caller || !canManageCredentialsOf(caller, target, policy)) {
    throw new PrivilegeError("not_boss", CREDENTIALS_MESSAGE)
  }
}

/**
 * 呼叫者不能把 `target` 的角色改成 `newRole` 就丟 PrivilegeError（403 `not_boss`）。角色沒變（正規化後相同）一律放行——
 * 員工管理頁每次儲存都會帶 role，只改姓名不能被擋。會讀一次租戶的解鎖政策。
 */
export async function assertCanChangeRole(
  tenantId: string,
  caller: PrivilegeCaller | null,
  target: AccountTarget,
  newRole: string,
  policyOverride?: PeriodUnlockPolicy,
): Promise<void> {
  if (normalizeRole(newRole) === normalizeRole(target.role)) return
  const policy = policyOverride ?? (await loadPeriodUnlockPolicy(tenantId))
  if (!isProtectedAccount(target, policy)) return
  if (!caller || !canChangeRoleOf(caller, target, policy)) {
    throw new PrivilegeError("not_boss", ROLE_CHANGE_MESSAGE)
  }
}

/**
 * 呼叫者不能指派 `role` 就丟 PrivilegeError（403 `platform_admin_required`）。
 * 只有 platform_admin 這個角色受限；其他角色不看呼叫者（`caller` 為 null 也放行——那是呼叫端自己的授權問題）。
 */
export function assertCanAssignRole(caller: PrivilegeCaller | null, role: string): void {
  if (normalizeRole(role) !== PLATFORM_ADMIN_ROLE) return
  if (!caller || !canAssignRole(caller, role)) {
    throw new PrivilegeError("platform_admin_required", PLATFORM_ADMIN_ASSIGN_MESSAGE)
  }
}
