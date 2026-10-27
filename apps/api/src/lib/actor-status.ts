import { getRequestContext, markActorInactive } from "./request-context.js"

/**
 * 停用／離職帳號的「有效角色」（2026-10-27 業主追加 A）。
 *
 * employees.status ≠ 'active'（停用、離職…）的帳號一律不得行使任何管理／簽核／老闆／HR／財務權限：
 *   • 有效角色降成 `employee`——所有以角色判斷的守門（middleware/role.ts requireRole／requireHrAdmin／
 *     requireFinance、middleware/scope.ts resolveSelf、各 route 私有的 resolveSelf、/me 回給前端的 role）
 *     都走 `effectiveRole`，仍可登入看自己的 ESS 資料（薪資單等）。
 *   • 不得作為任何簽核關的簽核人（主管關、HR 關、老闆關、HR 代簽）：services/approval-steps.ts
 *     stepActorStanding 認 `actor.active === false`，以及本請求內被標記為非在職的呼叫者（見下）。
 *   • 不得行使老闆身分（設定的老闆本人若已非在職）：lib/boss.ts isBossOrPlatformAdmin 同樣認。
 *   • **不停用 auth 帳號**（登入不受影響）。
 *
 * 為什麼還要「請求內標記」：老闆判斷、簽核人判斷的呼叫端很多是用 `{ id, role }` 自己組 actor（不帶 status），
 * 逐一補欄位容易漏。所以解出呼叫者的地方（resolveSelf／requireRole／各 route 私有 resolveSelf）若發現非在職，
 * 就在本請求的 AsyncLocalStorage 記下該員工 id（`markActorInactive`），純函式判斷時再查一次——漏帶 status 也擋得住。
 * 沒有請求情境（cron、單元測試直接呼叫）時沒有標記，只看呼叫端明確帶的 `active`。
 */

export const INACTIVE_EFFECTIVE_ROLE = "employee"

/** status 是不是在職。缺值（舊資料／測試假資料沒帶欄位）視為在職——DB 欄位 NOT NULL DEFAULT 'active'。 */
export function isActiveStatus(status: string | null | undefined): boolean {
  return (status ?? "active") === "active"
}

/** 有效角色：在職＝原角色；非在職＝employee。 */
export function effectiveRole(role: string | null | undefined, status: string | null | undefined): string {
  return isActiveStatus(status) ? ((role as string) ?? "") : INACTIVE_EFFECTIVE_ROLE
}

/**
 * 解出呼叫者後呼叫：非在職就在本請求記下（之後的老闆／簽核人判斷會擋）。回傳有效角色。
 */
export function actorRoleOf(empId: string | null | undefined, role: string | null | undefined, status: string | null | undefined): string {
  if (!isActiveStatus(status) && empId) markActorInactive(empId)
  return effectiveRole(role, status)
}

/** 這個員工 id 在本請求是不是被標記為非在職的呼叫者。 */
export function isInactiveActor(empId: string | null | undefined): boolean {
  if (!empId) return false
  const ids = getRequestContext()?.inactiveActorEmpIds
  return !!ids && ids.includes(empId.toLowerCase())
}

/** actor 明確帶 active=false，或本請求標記為非在職 → true。 */
export function actorIsInactive(actor: { id?: string | null; active?: boolean | null } | null | undefined): boolean {
  if (!actor) return false
  return actor.active === false || isInactiveActor(actor.id)
}
