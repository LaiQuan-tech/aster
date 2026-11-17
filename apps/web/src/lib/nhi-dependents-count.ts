/**
 * 健保眷屬人數「直接輸入」（2026-11-17）——員工資料頁「健保眷屬投保資料」區的人數欄：API 呼叫＋純函式
 * （不 import React／DOM，單元測試 __tests__/nhi-dependents-count.test.ts）。
 *
 * 規則（後端 apps/api services/nhi-dependents-count.ts）：有填直接輸入值（0–10）就以它為準；
 * 留空＝沿用下方明細中「投保中」的筆數。健保自付額的眷口數法定上限 3 口（第 4 口起免繳）。
 */
import { apiFetch } from "./api-client";

export const NHI_COUNT_MIN = 0;
export const NHI_COUNT_MAX = 10;
export const NHI_BILLABLE_MAX = 3;

export interface NhiDependentsCount {
  /** 直接輸入值；null＝沒填。 */
  override: number | null;
  /** 明細中投保中的筆數。 */
  detailCount: number;
  /** 計算採用人數。 */
  effective: number;
  /** 健保費實際計費眷口（上限 3）。 */
  billable: number;
  /** false＝資料庫欄位尚未套用（只能看明細、不能存）。 */
  available: boolean;
}

export function getNhiDependentsCount(employeeId: string) {
  return apiFetch<NhiDependentsCount>(`/nhi-dependents-count/${encodeURIComponent(employeeId)}`);
}

export function saveNhiDependentsCount(employeeId: string, count: number | null) {
  return apiFetch<NhiDependentsCount>(`/nhi-dependents-count/${encodeURIComponent(employeeId)}`, {
    method: "PUT",
    body: JSON.stringify({ count }),
  });
}

/** 輸入框字串 → 要送的值：空白＝null（清除，回到明細）；0–10 整數；其他回錯誤字。 */
export function parseNhiCountInput(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: `眷屬人數請輸入 ${NHI_COUNT_MIN}–${NHI_COUNT_MAX} 的整數` };
  const n = Number(s);
  if (n < NHI_COUNT_MIN || n > NHI_COUNT_MAX) return { ok: false, error: `眷屬人數請輸入 ${NHI_COUNT_MIN}–${NHI_COUNT_MAX} 的整數` };
  return { ok: true, value: n };
}

/** 「明細筆數 N／計算採用 M 人」＋上限說明。 */
export function nhiCountSummary(c: Pick<NhiDependentsCount, "override" | "detailCount" | "effective">): string {
  const source = c.override != null ? "以直接輸入為準" : "依明細";
  const cap = c.effective > NHI_BILLABLE_MAX ? `（健保費計費上限 ${NHI_BILLABLE_MAX} 口）` : "";
  return `明細筆數 ${c.detailCount}／計算採用 ${c.effective} 人（${source}）${cap}`;
}
