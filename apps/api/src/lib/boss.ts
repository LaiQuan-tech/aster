import { supabaseAdmin } from "./supabase.js"

/**
 * 「老闆」身分的共用判準（2026-10-27 業主：以後平台管理員就是老闆）。
 *
 * 老闆＝租戶 tenants.features.approval.fallbackApproverEmpId（id 不分大小寫比對）。凡是「呼叫者是不是老闆」的檢查，
 * role = platform_admin 一律視同老闆——包括沒設定老闆的租戶。**只放寬 platform_admin**，hr_admin 與其他角色照舊。
 *
 * 套用點（改這裡要一併看）：services/bonus-run-store.ts（獎金核准／退回）、services/late-reports.ts（遲到說明決定）、
 * services/period-lock.ts（重新開放月份、改解鎖名單）、services/privileged-accounts.ts（換老闆、受保護帳號）、
 * services/boss-summary.ts（首頁老闆視角）、services/financial-visibility.ts（集團財務）、services/project-scope.ts（改分潤）。
 *
 * 寄給老闆的通知也同時寄給租戶所有在職 platform_admin（bossNotificationRecipients）。
 * 刻意不套用：簽核鏈的「老闆關」（services/approval-chain.ts）——那是把單子派給誰簽的路由，不是「呼叫者是不是老闆」；
 * platform_admin 屬 HR 角色，本來就能代簽（requests allowHrOverride）。
 */

export const PLATFORM_ADMIN_ROLE = "platform_admin"

/**
 * 角色是不是 platform_admin。**精確比對**（同 requireRole／isHrRole：DB 存的是 canonicalRole 標準寫法，大小寫變體不帶權限）；
 * 需要正規化的呼叫端（privileged-accounts）自己先 normalizeRole。純函式。
 */
export function isPlatformAdminRole(role: string | null | undefined): boolean {
  return role === PLATFORM_ADMIN_ROLE
}

/** 員工 id 是不是設定的老闆（不分大小寫）。純函式。 */
export function isConfiguredBoss(bossEmpId: string | null | undefined, empId: string | null | undefined): boolean {
  return !!bossEmpId && !!empId && bossEmpId.toLowerCase() === empId.toLowerCase()
}

/**
 * 呼叫者算不算老闆：設定的老闆本人，或 platform_admin（不需要老闆已設定）。沒有員工 id → false。純函式。
 */
export function isBossOrPlatformAdmin(
  bossEmpId: string | null | undefined,
  caller: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!caller?.id) return false
  return isPlatformAdminRole(caller.role) || isConfiguredBoss(bossEmpId, caller.id)
}

/** 租戶所有在職 platform_admin 的員工 id（小寫）。 */
export async function loadPlatformAdminEmpIds(tenantId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", PLATFORM_ADMIN_ROLE)
    .eq("status", "active")
  if (error) throw new Error(`boss (platform admins): ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id.toLowerCase())
}

/**
 * 「寄給老闆」的收件人：老闆（可為 null）＋所有在職 platform_admin，去重（不分大小寫）；`exclude` 裡的人不寄
 * （呼叫端原本就有的排除，例如不通知本人／已另外通知的送審人）。查 platform_admin 失敗 → 只寄老闆（通知是盡力而為）。
 */
export async function bossNotificationRecipients(
  tenantId: string,
  bossEmpId: string | null | undefined,
  exclude: ReadonlyArray<string | null | undefined> = [],
): Promise<string[]> {
  const admins = await loadPlatformAdminEmpIds(tenantId).catch(() => [] as string[])
  const skip = new Set(exclude.filter((id): id is string => !!id).map((id) => id.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [bossEmpId, ...admins]) {
    if (!id) continue
    const key = id.toLowerCase()
    if (seen.has(key) || skip.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}
