/**
 * 員工所屬公司（2026-10-25，後端 migration 0072）的純函式：列表篩選、名稱顯示、批次指派的勾選、錯誤訊息。
 * 下拉選項沿用 lib/company-options.ts 的 companyOptions（停用公司只保留目前已選的那間）。
 * 無 React、無 IO，有 vitest（lib/__tests__/employee-company.test.ts）。
 * company_id null＝未指派：集團總覽把這些人另列、人事成本不分攤到任何公司。
 */

/** 篩選值：「」＝全部、UNASSIGNED_FILTER＝未指派、其他＝公司 id。 */
export const UNASSIGNED_FILTER = "__unassigned__";

export type CompanyOption = { id: string; name: string; isActive?: boolean };

/** 依公司篩選員工；舊版 API 沒有 company_id（undefined）一律當未指派。 */
export function filterByCompany<T extends { company_id?: string | null }>(rows: readonly T[], filter: string): T[] {
  if (!filter) return [...rows];
  if (filter === UNASSIGNED_FILTER) return rows.filter((row) => !row.company_id);
  return rows.filter((row) => row.company_id === filter);
}

/** 列表上的公司名稱：API 有給名稱就用；沒有就從名冊找；都沒有＝「未指派」。 */
export function companyLabel(
  row: { company_id?: string | null; company_name?: string | null },
  companies: readonly CompanyOption[],
): string {
  if (!row.company_id) return "未指派";
  return row.company_name ?? companies.find((c) => c.id === row.company_id)?.name ?? "（找不到公司）";
}

/** 勾選／取消一位員工（回新的 Set，不改原本的）。 */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 表頭「全選」：畫面上的員工全都已勾 → 全部取消（只取消畫面上的），否則全部勾上（保留畫面外已勾的）。 */
export function toggleAllVisible(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of visibleIds) {
    if (allOn) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** 後端錯誤碼 → 中文（員工所屬公司相關）。認不得回 null，交給呼叫端的通用翻譯。 */
export function companyErrorMessage(code: string | null): string | null {
  switch (code) {
    case "invalid_company":
      return "選的公司不屬於這個租戶（可能剛被刪除），請重新整理後再選";
    case "company_inactive":
      return "這家公司已停用，不能再指派員工；請先到「公司主體」重新啟用";
    case "employee_not_found":
      return "有員工已不存在（可能剛被刪除），請重新整理後再指派";
    default:
      return null;
  }
}
