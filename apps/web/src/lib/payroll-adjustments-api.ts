/**
 * 薪資一次性加減項（前期更正；2026-10-11 業主拍板）——API 呼叫、表單驗證與薪資單顯示的純函式。
 *
 * 已匯款的月份不改原薪資單，改在下個月薪資補發或扣回：HR 對某位員工、某一期（`period`＝放進哪一期的薪資單）加一行有說明的
 * 加減項（名稱、帶正負號的金額、是否課稅、更正的是哪個月）。薪資執行時併進該期薪資單，三種歸屬：
 *   • 課稅的補發（earning）→ 列在應發、併入扣繳基礎   • 扣回（deduction）→ 列在應扣、只減實發（不減應發，保守）
 *   • 不課稅的補發（non_taxable）→ 只加在實發（標「不計薪資所得」）
 * 薪資單（後台列印、員工端、Email）每一筆都逐項列出，標題帶「(更正 YYYY-MM)」。規則與稅務處理見後端
 * packages/rules/src/payroll-engine.ts 檔頭；API 見 apps/api/src/routes/payroll-adjustments.ts。
 *
 * 純函式部分不 import React、DOM（單元測試在 __tests__/payroll-adjustments.test.ts）；
 * 型別與 API 函式放這個新檔，不擠 admin-api.ts／ess-api.ts（§3.4 檔案互斥原則）。
 */
import { apiErrorMessage, apiFetch } from "./api-client";

/* ── 型別 ──────────────────────────────────────────────────────────── */

/** 加減項在薪資單上的歸屬。 */
export type AdjustmentTreatment = "earning" | "deduction" | "non_taxable";

/** 該員工該期的薪資單狀態（草稿的加減項跟不上時 stale=true）。 */
export interface PayslipAdjustState {
  status: "draft" | "finalized" | null;
  stale: boolean;
}

export interface PayrollAdjustment {
  id: string;
  employeeId: string;
  period: string;
  label: string;
  /** 帶正負號：正＝補發、負＝扣回。 */
  amount: number;
  taxable: boolean;
  /** 更正的月份 'YYYY-MM'；沒有＝null。 */
  relatedPeriod: string | null;
  note: string | null;
  createdByEmpId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PayrollAdjustmentWithState = PayrollAdjustment & { payslip: PayslipAdjustState };

export type PeriodLockState = "open" | "closed" | "reopened";

export interface PayrollAdjustmentBody {
  employeeId: string;
  period: string;
  label: string;
  amount: number;
  taxable: boolean;
  relatedPeriod: string | null;
  note: string | null;
}

export type PayrollAdjustmentPatch = Partial<Pick<PayrollAdjustmentBody, "label" | "amount" | "taxable" | "relatedPeriod" | "note">>;

/** 薪資單 breakdown 上加減項相關欄位（引擎輸出；舊薪資單沒有）。 */
export interface BreakdownAdjustmentLine {
  id?: string;
  label: string;
  amount: number;
  taxable?: boolean;
  relatedPeriod?: string | null;
  treatment?: AdjustmentTreatment;
}

/* ── API ───────────────────────────────────────────────────────────── */

export function listPayrollAdjustments(query: { period?: string; employeeId?: string }) {
  const qs = new URLSearchParams();
  if (query.period) qs.set("period", query.period);
  if (query.employeeId) qs.set("employeeId", query.employeeId);
  return apiFetch<{ adjustments: PayrollAdjustmentWithState[]; periodState?: PeriodLockState }>(`/payroll-adjustments?${qs.toString()}`);
}

export function createPayrollAdjustment(body: PayrollAdjustmentBody) {
  return apiFetch<{ adjustment: PayrollAdjustment; payslip: PayslipAdjustState }>("/payroll-adjustments", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updatePayrollAdjustment(id: string, patch: PayrollAdjustmentPatch) {
  return apiFetch<{ adjustment: PayrollAdjustment; payslip: PayslipAdjustState }>(`/payroll-adjustments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deletePayrollAdjustment(id: string) {
  return apiFetch<{ id: string; deleted: true; payslip: PayslipAdjustState }>(`/payroll-adjustments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* ── 顯示名稱、歸屬、合計 ──────────────────────────────────────────── */

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const LABEL_MAX = 100;
export const NOTE_MAX = 500;
/** 與後端同一個上限（多打幾個 0 的筆誤在這裡先擋）。 */
export const AMOUNT_MAX = 99_999_999.99;

/** 薪資單上的顯示名稱：有更正月份標「(更正 YYYY-MM)」，名稱已寫同樣標示不重複。與引擎 adjustmentDisplayLabel 同一個規則。 */
export function adjustmentDisplayLabel(label: string, relatedPeriod?: string | null): string {
  const name = label.trim();
  if (!relatedPeriod) return name;
  const tag = `更正 ${relatedPeriod}`;
  return name.includes(tag) ? name : `${name}(${tag})`;
}

export function adjustmentTreatment(a: { amount: number; taxable?: boolean | null; treatment?: AdjustmentTreatment | null }): AdjustmentTreatment {
  if (a.treatment === "earning" || a.treatment === "deduction" || a.treatment === "non_taxable") return a.treatment;
  if (a.amount < 0) return "deduction";
  return a.taxable === false ? "non_taxable" : "earning";
}

export const TREATMENT_LABEL: Record<AdjustmentTreatment, string> = {
  earning: "計入應發",
  deduction: "計入應扣",
  non_taxable: "加在實發（不計薪資所得）",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AdjustmentTotals {
  count: number;
  /** 課稅補發合計（進應發）。 */
  earnings: number;
  /** 扣回合計（正值，進應扣）。 */
  deductions: number;
  /** 不課稅補發合計（只加實發）。 */
  nonTaxable: number;
  /** 對實發的淨影響 = earnings − deductions + nonTaxable。 */
  netEffect: number;
}

export function summarizeAdjustments(list: ReadonlyArray<{ amount: number; taxable?: boolean | null; treatment?: AdjustmentTreatment | null }>): AdjustmentTotals {
  let earnings = 0;
  let deductions = 0;
  let nonTaxable = 0;
  for (const a of list) {
    const treatment = adjustmentTreatment(a);
    if (treatment === "earning") earnings += a.amount;
    else if (treatment === "deduction") deductions += -a.amount;
    else nonTaxable += a.amount;
  }
  return {
    count: list.length,
    earnings: round2(earnings),
    deductions: round2(deductions),
    nonTaxable: round2(nonTaxable),
    netEffect: round2(earnings - deductions + nonTaxable),
  };
}

/** 帶正負號、千分位的金額，例「+3,000」「-2,000」。 */
export function signedMoney(amount: number): string {
  const text = Math.abs(amount).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
  return `${amount < 0 ? "-" : "+"}${text}`;
}

/* ── 薪資單顯示（後台列印、員工端共用）──────────────────────────────── */

export interface AdjustmentDisplayRow {
  id?: string;
  /** 顯示名稱，已帶「(更正 YYYY-MM)」；不課稅的補發另加「（不計薪資所得）」。 */
  label: string;
  /** 顯示用金額（正值）：補發、扣回都用絕對值，歸屬已經說明方向。 */
  amount: number;
  /** 帶正負號的原金額。 */
  signed: number;
  treatment: AdjustmentTreatment;
  relatedPeriod: string | null;
}

export interface AdjustmentDisplay {
  earning: AdjustmentDisplayRow[];
  deduction: AdjustmentDisplayRow[];
  nonTaxable: AdjustmentDisplayRow[];
  all: AdjustmentDisplayRow[];
}

/** 薪資單 breakdown（任何形狀；舊資料沒有 adjustments）→ 依歸屬分好的顯示列。 */
export function adjustmentDisplayOf(breakdown: unknown): AdjustmentDisplay {
  const raw = (breakdown as { adjustments?: unknown } | null | undefined)?.adjustments;
  const list = Array.isArray(raw) ? (raw as BreakdownAdjustmentLine[]) : [];
  const out: AdjustmentDisplay = { earning: [], deduction: [], nonTaxable: [], all: [] };
  for (const a of list) {
    const amount = Number(a?.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const treatment = adjustmentTreatment({ amount, taxable: a.taxable, treatment: a.treatment });
    const base = adjustmentDisplayLabel(String(a.label ?? ""), a.relatedPeriod ?? null);
    const row: AdjustmentDisplayRow = {
      id: a.id,
      label: treatment === "non_taxable" ? `${base}（不計薪資所得）` : base,
      amount: Math.abs(amount),
      signed: amount,
      treatment,
      relatedPeriod: a.relatedPeriod ?? null,
    };
    (treatment === "earning" ? out.earning : treatment === "deduction" ? out.deduction : out.nonTaxable).push(row);
    out.all.push(row);
  }
  return out;
}

/**
 * 後台「列印」薪資單用的 `<tr>` HTML：某一種歸屬的加減項，一筆一列（名稱已 escape、金額千分位）。
 * 版面與 Email（apps/api/src/services/payslip-html.ts）一致：課稅補發列在應發合計前、扣回列在應扣合計前、
 * 不課稅補發列在實發金額前。`money`／`esc` 由呼叫端傳入，與列印版其他列同一份格式化。
 */
export function adjustmentPrintRows(
  breakdown: unknown,
  treatment: AdjustmentTreatment,
  format: { money: (n: number) => string; esc: (s: string) => string },
): string {
  const display = adjustmentDisplayOf(breakdown);
  const rows = treatment === "earning" ? display.earning : treatment === "deduction" ? display.deduction : display.nonTaxable;
  return rows
    .map((row) => `<tr><td>${format.esc(row.label)}</td><td style="text-align:right">${format.money(row.amount)}</td></tr>`)
    .join("\n");
}

/* ── 表單 ──────────────────────────────────────────────────────────── */

export type AdjustmentKind = "add" | "deduct";

export interface AdjustmentDraft {
  label: string;
  /** 使用者輸入的金額（正數）；方向由 kind 決定。 */
  amount: string;
  kind: AdjustmentKind;
  taxable: boolean;
  /** 更正的月份 'YYYY-MM'（month input）；空白＝沒有。 */
  relatedPeriod: string;
  note: string;
}

export function emptyAdjustmentDraft(period: string): AdjustmentDraft {
  return { label: "", amount: "", kind: "add", taxable: true, relatedPeriod: previousPeriod(period), note: "" };
}

/** 'YYYY-MM' 的前一個月；格式不對回空字串。 */
export function previousPeriod(period: string): string {
  if (!PERIOD_RE.test(period)) return "";
  const [y, m] = period.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/** 已存的加減項 → 編輯表單。 */
export function draftFromAdjustment(a: Pick<PayrollAdjustment, "label" | "amount" | "taxable" | "relatedPeriod" | "note">): AdjustmentDraft {
  return {
    label: a.label,
    amount: String(Math.abs(a.amount)),
    kind: a.amount < 0 ? "deduct" : "add",
    taxable: a.taxable,
    relatedPeriod: a.relatedPeriod ?? "",
    note: a.note ?? "",
  };
}

/** 金額輸入 → 正數（最多兩位小數、允許千分位逗號）；不合法回 null。 */
export function parseAmountInput(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  return value > 0 && value <= AMOUNT_MAX ? value : null;
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fieldErrors(draft: AdjustmentDraft, period: string): string | null {
  const label = draft.label.trim();
  if (!label) return "請輸入名稱（例：補發 9 月加班費）";
  if ([...label].length > LABEL_MAX) return `名稱最多 ${LABEL_MAX} 字`;
  if (parseAmountInput(draft.amount) === null) return "金額請輸入大於 0 的數字（最多兩位小數）；補發或扣回用下拉選擇";
  const related = draft.relatedPeriod.trim();
  if (related && !PERIOD_RE.test(related)) return "更正月份格式不正確";
  if (related && related > period) return "更正月份不能晚於薪資單所屬月份";
  if ([...draft.note.trim()].length > NOTE_MAX) return `備註最多 ${NOTE_MAX} 字`;
  return null;
}

/** 表單 → 新增用的 body（含驗證，錯誤訊息直接給人看）。 */
export function buildCreateBody(draft: AdjustmentDraft, ctx: { employeeId: string; period: string }): DraftResult<PayrollAdjustmentBody> {
  const error = fieldErrors(draft, ctx.period);
  if (error) return { ok: false, error };
  const amount = parseAmountInput(draft.amount) as number;
  return {
    ok: true,
    value: {
      employeeId: ctx.employeeId,
      period: ctx.period,
      label: draft.label.trim(),
      amount: draft.kind === "deduct" ? -amount : amount,
      taxable: draft.taxable,
      relatedPeriod: draft.relatedPeriod.trim() || null,
      note: draft.note.trim() || null,
    },
  };
}

/** 表單 → 修改用的 patch（員工與期別不能改；整份欄位都送，後端冪等）。 */
export function buildPatch(draft: AdjustmentDraft, period: string): DraftResult<PayrollAdjustmentPatch> {
  const error = fieldErrors(draft, period);
  if (error) return { ok: false, error };
  const amount = parseAmountInput(draft.amount) as number;
  return {
    ok: true,
    value: {
      label: draft.label.trim(),
      amount: draft.kind === "deduct" ? -amount : amount,
      taxable: draft.taxable,
      relatedPeriod: draft.relatedPeriod.trim() || null,
      note: draft.note.trim() || null,
    },
  };
}

/* ── 錯誤、提示 ────────────────────────────────────────────────────── */

/** 新增／修改／刪除失敗的中文訊息：已結算月份、薪資單已定稿等後端有給訊息的直接用，其餘補上白話。 */
export function adjustmentErrorMessage(err: unknown, fallback = "儲存失敗"): string {
  const code = err instanceof Error ? (err as { code?: string }).code : undefined;
  if (code === "invalid_employee") return "找不到這位員工，請重新整理後再試";
  if (code === "invalid_body") return "欄位格式不正確：名稱 1–100 字、金額大於 0 且最多兩位小數、更正月份不能晚於薪資月份";
  if (code === "forbidden") return "目前的帳號沒有權限（需要 HR 管理員）";
  if (code === "not_found") return "這筆加減項已不存在（可能剛被刪除），請重新整理";
  return apiErrorMessage(err, fallback);
}

/** 該員工該期薪資單狀態對應的提醒；沒事回 null。 */
export function payslipStateNote(state: PayslipAdjustState | null | undefined, period: string): { tone: "warn" | "locked"; text: string } | null {
  if (!state) return null;
  if (state.status === "finalized") return { tone: "locked", text: `${period} 的薪資單已定稿，不能再改加減項；如需更正請加在下個月的薪資` };
  if (state.stale) return { tone: "warn", text: "草稿薪資單還沒跟上這些加減項：請到下方「執行薪資/獎金作業」重新執行這個月的薪資，否則無法定稿" };
  return null;
}
