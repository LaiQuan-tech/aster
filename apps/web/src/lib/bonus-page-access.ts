import { canSeeGroupFinancialsOf, roleNavOf } from "./admin-nav";

/**
 * 「獎金分潤」分頁（app/admin/bonus-sheet/page.tsx）各區塊誰看得到（2026-10-27 獎金季發放併入獎金分潤）。
 * 合併前兩頁權限不同，合併後每個區塊沿用各自原本的條件，不放寬：
 *   runs   季發放儀表板＋發放批次（原 /admin/bonus-runs）：HR／平台管理員——API 是 requireHrAdmin
 *          （會計即使被租戶開了這個分頁，API 也是 403，所以這裡直接不畫）。核准另由 API 判斷（老闆／platform_admin）。
 *   sheet  專案獎金總表（原「獎金分潤」分頁：hrOnly＋groupFinancials）：不是受限角色（roleNav 為 null）
 *          且看得到集團財務（/me.canSeeGroupFinancials，舊 API 缺欄位時退回 HR 角色）——API 是 requireGroupFinancials。
 */
export function bonusSheetAccess(me: { role: string; canSeeGroupFinancials?: boolean } | null | undefined): { runs: boolean; sheet: boolean } {
  if (!me) return { runs: false, sheet: false };
  const runs = me.role === "hr_admin" || me.role === "platform_admin";
  const sheet = roleNavOf(me.role, null) === null && canSeeGroupFinancialsOf(me);
  return { runs, sheet };
}
