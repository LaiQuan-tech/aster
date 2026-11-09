/**
 * 員工薪資分頁「調薪歷程」＋「勞健保調整歷程」（2026-11-10）——API 呼叫與純函式（不 import React／DOM，
 * 單元測試 __tests__/salary-history.test.ts）。只是紀錄：不改任何薪資計算。
 *
 * 後端：apps/api/src/routes/salary-history.ts（列表、補登、軟刪）、routes/salary.ts（存薪資資料時自動寫一筆）。
 */
import { apiFetch } from "./api-client";

export interface SalaryAdjustmentView {
  id: string;
  effectiveDate: string;
  prevSalary: number | null;
  newSalary: number;
  diff: number | null;
  reason: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface InsuredPair {
  prev: number | null;
  next: number | null;
}

export interface InsuredChangeView {
  id: string;
  effectiveOn: string;
  labor: InsuredPair;
  health: InsuredPair;
  pension: InsuredPair;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface SalaryHistory {
  salaryAdjustments: SalaryAdjustmentView[];
  insuredChanges: InsuredChangeView[];
  /** insured=false：投保調整歷程資料表未套用（migration 0088）；prevSalary=false：調薪紀錄還沒有「原本薪」欄。 */
  available: { insured: boolean; prevSalary: boolean };
}

export function getSalaryHistory(employeeId: string) {
  return apiFetch<SalaryHistory>(`/salary/${employeeId}/history`);
}

export function addSalaryAdjustment(
  employeeId: string,
  body: { effectiveDate: string; prevSalary?: number | null; newSalary: number; reason?: string | null },
) {
  return apiFetch<{ id: string }>(`/salary/${employeeId}/salary-adjustments`, { method: "POST", body: JSON.stringify(body) });
}

export interface InsuredChangeBody {
  effectiveOn: string;
  laborInsuredSalary?: number | null;
  healthInsuredSalary?: number | null;
  pensionWage?: number | null;
  prevLaborInsuredSalary?: number | null;
  prevHealthInsuredSalary?: number | null;
  prevPensionWage?: number | null;
  note?: string | null;
}

export function addInsuredChange(employeeId: string, body: InsuredChangeBody) {
  return apiFetch<{ id: string }>(`/salary/${employeeId}/insured-changes`, { method: "POST", body: JSON.stringify(body) });
}

export function deleteInsuredChange(employeeId: string, id: string) {
  return apiFetch<{ id: string }>(`/salary/${employeeId}/insured-changes/${id}`, { method: "DELETE" });
}

/* ── 純函式 ─────────────────────────────────────────────────────────── */

/** 本地今天 'YYYY-MM-DD'（生效日預設值）。 */
export function todayDateKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 表單字串 → 數字（空白＝null）。 */
export function numOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface SalaryFormValues {
  baseSalary: string;
  laborGrade: string;
  healthGrade: string;
  pensionWage: string;
}

/**
 * 「儲存薪資資料」前：本薪、投保三項（勞保／健保投保薪資、勞退月提繳工資）有沒有變（跟讀進來的值比）。
 * 本薪空白與 0 視為相同。投保欄位清空也算變動（API 會依級距表重選）。
 */
export function salaryFormChanges(loaded: SalaryFormValues, current: SalaryFormValues): { base: boolean; insured: boolean } {
  const same = (a: string, b: string) => numOrNull(a) === numOrNull(b);
  return {
    base: (numOrNull(loaded.baseSalary) ?? 0) !== (numOrNull(current.baseSalary) ?? 0),
    insured:
      !same(loaded.laborGrade, current.laborGrade) ||
      !same(loaded.healthGrade, current.healthGrade) ||
      !same(loaded.pensionWage, current.pensionWage),
  };
}

/** 金額顯示：33000 → 「33,000」；null → emptyLabel。 */
export function fmtAmount(n: number | null | undefined, emptyLabel = "—"): string {
  return n === null || n === undefined ? emptyLabel : Math.round(n).toLocaleString("zh-TW");
}

/** 「33,000 → 38,200」；前後相同只顯示一個值；兩者皆空＝「—」。 */
export function pairText(pair: InsuredPair, emptyLabel = "—"): string {
  if (pair.prev === null && pair.next === null) return "—";
  if (pair.prev === pair.next) return fmtAmount(pair.next, emptyLabel);
  return `${fmtAmount(pair.prev, emptyLabel)} → ${fmtAmount(pair.next, emptyLabel)}`;
}

/** 差額「+5,000」／「-1,000」；沒有原本薪＝「—」。 */
export function diffText(diff: number | null): string {
  if (diff === null) return "—";
  const s = Math.abs(Math.round(diff)).toLocaleString("zh-TW");
  return diff > 0 ? `+${s}` : diff < 0 ? `-${s}` : "0";
}

/** 登錄時間 ISO → 「2026-11-10 14:05」（本地時區）。 */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 補登調薪表單 → API body；不合法回錯誤訊息。 */
export function buildSalaryBackfill(form: {
  effectiveDate: string;
  prevSalary: string;
  newSalary: string;
  reason: string;
}): { ok: true; body: Parameters<typeof addSalaryAdjustment>[1] } | { ok: false; error: string } {
  if (!DATE_RE.test(form.effectiveDate)) return { ok: false, error: "請填生效日" };
  const next = numOrNull(form.newSalary);
  if (next === null || next < 0) return { ok: false, error: "請填新本薪" };
  const prev = numOrNull(form.prevSalary);
  if (prev !== null && prev < 0) return { ok: false, error: "原本薪不可為負數" };
  return {
    ok: true,
    body: { effectiveDate: form.effectiveDate, prevSalary: prev, newSalary: next, reason: form.reason.trim() || null },
  };
}

/** 補登投保調整表單 → API body；三項調整後金額至少填一項。 */
export function buildInsuredBackfill(form: {
  effectiveOn: string;
  labor: string;
  health: string;
  pension: string;
  prevLabor: string;
  prevHealth: string;
  prevPension: string;
  note: string;
}): { ok: true; body: InsuredChangeBody } | { ok: false; error: string } {
  if (!DATE_RE.test(form.effectiveOn)) return { ok: false, error: "請填生效日" };
  const vals = [form.labor, form.health, form.pension, form.prevLabor, form.prevHealth, form.prevPension].map(numOrNull);
  if (vals.some((v) => v !== null && (v < 0 || !Number.isInteger(v)))) return { ok: false, error: "金額必須是 0 以上的整數" };
  const [labor, health, pension, prevLabor, prevHealth, prevPension] = vals;
  if (labor === null && health === null && pension === null)
    return { ok: false, error: "至少填一項調整後金額（勞保／健保投保薪資或勞退月提繳工資）" };
  return {
    ok: true,
    body: {
      effectiveOn: form.effectiveOn,
      laborInsuredSalary: labor,
      healthInsuredSalary: health,
      pensionWage: pension,
      prevLaborInsuredSalary: prevLabor,
      prevHealthInsuredSalary: prevHealth,
      prevPensionWage: prevPension,
      note: form.note.trim() || null,
    },
  };
}
