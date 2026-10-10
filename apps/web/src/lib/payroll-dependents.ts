/**
 * 薪資作業頁（admin/payroll）「新增健保眷屬／新增扶養親屬」兩個行內子表單的送出判斷
 * （不碰 DOM，可直接單元測試）。
 *
 * 從頁面抽出來，組 body 的規則與抽出前內聯的寫法逐字相同：姓名去頭尾空白後必填；關係、證號去頭尾空白後
 * 留空就不帶；出生年留空就不帶、有填就轉成數字。API 收到的 JSON（含鍵順序）一個字都沒變。
 * 唯一的差別是姓名空白時：以前靜默不動作，現在回傳提示給頁面顯示。其餘驗證（姓名至少 1 字、出生年須為
 * 整數）仍由 API 的 zod 負責，前端不重複。
 */
import type { addNhiDependent, addTaxDependent } from "./admin-api";

export type NhiDependentBody = Parameters<typeof addNhiDependent>[0];
export type TaxDependentBody = Parameters<typeof addTaxDependent>[0];

/** ok＝帶著可以直接送 API 的 body；沒過＝給使用者看的提示（不送 API）。 */
export type DependentSubmit<Body> = { ok: true; body: Body } | { ok: false; error: string };

export interface NhiDependentDraft {
  name: string;
  relationship: string;
  idNumber: string;
  insured: boolean;
}

export interface TaxDependentDraft {
  name: string;
  relationship: string;
  idNumber: string;
  /** `<input type="number">` 的字串值；空字串＝沒填。 */
  birthYear: string;
}

export function buildNhiDependentBody(employeeId: string, draft: NhiDependentDraft): DependentSubmit<NhiDependentBody> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "請輸入眷屬姓名" };
  return {
    ok: true,
    body: {
      employeeId,
      name,
      relationship: draft.relationship.trim() || undefined,
      idNumber: draft.idNumber.trim() || undefined,
      insured: draft.insured,
    },
  };
}

export function buildTaxDependentBody(employeeId: string, draft: TaxDependentDraft): DependentSubmit<TaxDependentBody> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "請輸入親屬姓名" };
  return {
    ok: true,
    body: {
      employeeId,
      name,
      relationship: draft.relationship.trim() || undefined,
      idNumber: draft.idNumber.trim() || undefined,
      birthYear: draft.birthYear ? Number(draft.birthYear) : undefined,
    },
  };
}

/**
 * API 失敗時顯示在面板裡的字：「新增健保眷屬失敗：[400] invalid_body」。
 * 後半沿用 apiFetch 丟出的 `[status] code`（跟頁面上其他錯誤一樣）；拿不到 Error 訊息就只有前半。
 */
export function dependentErrorMessage(err: unknown, action: string): string {
  return err instanceof Error && err.message ? `${action}失敗：${err.message}` : `${action}失敗`;
}
