/**
 * 健保眷屬人數「直接輸入」（2026-11-17）——員工資料頁「健保眷屬投保資料」區的人數欄：API 呼叫＋純函式
 * （不 import React／DOM，單元測試 __tests__/nhi-dependents-count.test.ts）。
 *
 * 規則（後端 apps/api services/nhi-dependents-count.ts）：有填直接輸入值（0–10）就以它為準；
 * 留空＝沿用下方明細中「投保中」的筆數。健保自付額的眷口數法定上限 3 口（第 4 口起免繳）。
 */
import { apiFetch, type ApiError } from "./api-client";

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
  /** 只有 PUT 回應帶：本月與上月的薪資單／月表狀態（存檔後提示用）。 */
  impacts?: NhiPeriodImpact[];
}

export interface NhiPeriodImpact {
  period: string;
  payslipStatus: string | null;
  sheetStatus: string | null;
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

const fmtPeriod = (p: string) => {
  const [y, m] = p.split("-");
  return `${y} 年 ${Number(m)} 月`;
};

/**
 * 存檔後提示（每個受影響月份一行）：
 *   • 已有薪資單草稿 →「此月已產生薪資單，請重跑薪資才會套用」
 *   • 薪資單已定案 →「已定案，不追溯」
 *   • 沒有薪資單、月表已核准／鎖定 →「金額為核准當下快照，跑薪資時會套用新人數」
 */
export function nhiSaveNotices(impacts: NhiPeriodImpact[] | undefined): string[] {
  const out: string[] = [];
  for (const i of impacts ?? []) {
    const label = fmtPeriod(i.period);
    if (i.payslipStatus === "finalized") out.push(`${label}薪資單已定案，新人數不追溯`);
    else if (i.payslipStatus) out.push(`${label}已產生薪資單，請重跑薪資才會套用`);
    else if (i.sheetStatus === "approved" || i.sheetStatus === "locked")
      out.push(`${label}月表已核准，金額為核准當下快照，跑薪資時會套用新人數`);
  }
  return out;
}

/** API 錯誤 → 中文（403／404／503／400／其他）。 */
export function nhiCountErrorMessage(err: unknown, action: "讀取" | "儲存"): string {
  const status = (err as ApiError | null)?.status;
  if (status === 403) return `沒有權限${action}眷屬人數（限 HR）`;
  if (status === 404) return "找不到這位員工";
  if (status === 400) return `眷屬人數請輸入 ${NHI_COUNT_MIN}–${NHI_COUNT_MAX} 的整數`;
  if (status === 503) return "資料庫尚未支援直接輸入人數，目前依明細計算";
  return `${action}眷屬人數失敗，請稍後再試`;
}

/** 出勤統計表：表上健保（薪資單／核准快照）≠ 目前即時試算時的一行提示。 */
export function healthMismatchNote(hm: { shown: number; live: number }, payslipStatus: string | null): string {
  const nums = `表上健保 ${hm.shown.toLocaleString("zh-TW")}，依目前投保金額與眷屬人數試算為 ${hm.live.toLocaleString("zh-TW")}`;
  if (payslipStatus === "finalized") return `${nums}（薪資單已定案，不追溯）`;
  if (payslipStatus) return `${nums}，重跑薪資後才會套用`;
  return `${nums}，月表核准快照不變，跑薪資時會套用`;
}
