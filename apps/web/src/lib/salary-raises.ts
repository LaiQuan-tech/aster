/**
 * 員工薪資「調薪中」（2026-11-17）——API 呼叫與純函式（不 import React／DOM，單元測試 __tests__/salary-raises.test.ts）。
 *
 * 調薪中：薪資照新本薪發（請假／加班／加給用新時薪＝新本薪 ÷ 240），勞保／健保（與勞退）照舊級距扣，
 * 出勤統計表「薪資」欄顯示原本薪＋差額行、薪資單列「調薪差額」。政府端投保調整完成後按「調薪完成」→
 * 薪資資料改成新本薪／新投保；按「取消調薪中」→ 回到舊薪資。後端：apps/api/src/routes/salary-raises.ts。
 */
import { apiFetch } from "./api-client";
import { formatMoney } from "@/lib/money";

export type SalaryRaiseStatus = "pending" | "completed" | "cancelled";

export interface SalaryRaiseView {
  id: string;
  status: SalaryRaiseStatus;
  effectiveOn: string;
  startPeriod: string;
  newBaseSalary: number;
  newLaborInsuredSalary: number | null;
  newHealthInsuredSalary: number | null;
  newPensionWage: number | null;
  prevBaseSalary: number | null;
  prevLaborInsuredSalary: number | null;
  prevHealthInsuredSalary: number | null;
  prevPensionWage: number | null;
  note: string | null;
  createdAt: string;
  completedPeriod: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface SalaryRaisesResponse {
  raises: SalaryRaiseView[];
  pending: SalaryRaiseView | null;
  /** false：資料表未套用（migration 0112）。 */
  available: boolean;
}

export function getSalaryRaises(employeeId: string) {
  return apiFetch<SalaryRaisesResponse>(`/salary/${employeeId}/raises`);
}

export interface CreateRaiseBody {
  effectiveDate: string;
  newBaseSalary: number;
  newLaborInsuredSalary?: number | null;
  newHealthInsuredSalary?: number | null;
  newPensionWage?: number | null;
  note?: string | null;
}

export function createSalaryRaise(employeeId: string, body: CreateRaiseBody) {
  return apiFetch<{ raise: SalaryRaiseView }>(`/salary/${employeeId}/raises`, { method: "POST", body: JSON.stringify(body) });
}

export interface CompleteRaiseBody {
  completedPeriod?: string;
  laborInsuredSalary?: number;
  healthInsuredSalary?: number;
  pensionWage?: number | null;
}

export function completeSalaryRaise(employeeId: string, id: string, body: CompleteRaiseBody) {
  return apiFetch<{ raise: SalaryRaiseView }>(`/salary/${employeeId}/raises/${id}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelSalaryRaise(employeeId: string, id: string) {
  return apiFetch<{ raise: SalaryRaiseView }>(`/salary/${employeeId}/raises/${id}/cancel`, { method: "POST", body: "{}" });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function money(v: string): number | null {
  const t = v.replace(/,/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** 「調薪中」表單 → API body；不合法回錯誤訊息（純函式）。 */
export function buildRaiseBody(
  form: { effectiveDate: string; newBase: string; labor: string; health: string; pension: string; note: string },
  currentBase: number | null,
): { ok: true; body: CreateRaiseBody } | { ok: false; error: string } {
  if (!DATE_RE.test(form.effectiveDate)) return { ok: false, error: "請填調薪生效日" };
  const base = money(form.newBase);
  if (base === null || Number.isNaN(base) || base <= 0) return { ok: false, error: "請填新本薪（大於 0）" };
  if (currentBase !== null && Math.round(base) === Math.round(currentBase)) return { ok: false, error: "新本薪與目前本薪相同" };
  const labor = money(form.labor);
  const health = money(form.health);
  const pension = money(form.pension);
  for (const [v, name] of [
    [labor, "新勞保投保薪資"],
    [health, "新健保投保金額"],
    [pension, "新勞退月提繳工資"],
  ] as const) {
    if (v !== null && (Number.isNaN(v) || v < 0 || !Number.isInteger(v))) return { ok: false, error: `${name}須為整數元` };
  }
  if (pension !== null && (pension <= 0 || pension > 150_000)) return { ok: false, error: "新勞退月提繳工資須介於 1–150,000" };
  return {
    ok: true,
    body: {
      effectiveDate: form.effectiveDate,
      newBaseSalary: base,
      newLaborInsuredSalary: labor,
      newHealthInsuredSalary: health,
      newPensionWage: pension,
      note: form.note.trim() || null,
    },
  };
}

/** 「調薪完成」表單 → API body（純函式）。勞保／健保必填。 */
export function buildCompleteBody(
  form: { completedPeriod: string; labor: string; health: string; pension: string },
): { ok: true; body: CompleteRaiseBody } | { ok: false; error: string } {
  if (!PERIOD_RE.test(form.completedPeriod)) return { ok: false, error: "請填調薪完成月份（YYYY-MM）" };
  const labor = money(form.labor);
  const health = money(form.health);
  const pension = money(form.pension);
  if (labor === null || Number.isNaN(labor) || !Number.isInteger(labor) || labor <= 0) return { ok: false, error: "請填新勞保投保薪資（整數元）" };
  if (health === null || Number.isNaN(health) || !Number.isInteger(health) || health <= 0) return { ok: false, error: "請填新健保投保金額（整數元）" };
  if (pension !== null && (Number.isNaN(pension) || !Number.isInteger(pension) || pension <= 0 || pension > 150_000))
    return { ok: false, error: "新勞退月提繳工資須為 1–150,000 的整數元" };
  return {
    ok: true,
    body: { completedPeriod: form.completedPeriod, laborInsuredSalary: labor, healthInsuredSalary: health, ...(pension !== null ? { pensionWage: pension } : {}) },
  };
}

export const RAISE_STATUS_LABEL: Record<SalaryRaiseStatus, string> = {
  pending: "調薪中",
  completed: "調薪完成",
  cancelled: "已取消",
};

/** 「2026-11」→「2026 年 11 月」。 */
export function periodText(p: string | null | undefined): string {
  if (!p || !PERIOD_RE.test(p)) return "—";
  return `${p.slice(0, 4)} 年 ${Number(p.slice(5, 7))} 月`;
}

/** 調薪中摘要：「原本薪 38,000 → 新本薪 40,000（＋2,000）」。 */
export function raiseSummary(r: Pick<SalaryRaiseView, "prevBaseSalary" | "newBaseSalary">): string {
  const prev = r.prevBaseSalary;
  const diff = prev != null ? r.newBaseSalary - prev : null;
  const diffText = diff == null ? "" : `（${diff >= 0 ? "＋" : "−"}${formatMoney(Math.abs(diff))}）`;
  return `原本薪 ${formatMoney(prev)} → 新本薪 ${formatMoney(r.newBaseSalary)}${diffText}`;
}

/** 一筆調薪中的期間文字（列表用）。 */
export function raisePeriodText(r: Pick<SalaryRaiseView, "status" | "startPeriod" | "completedPeriod">): string {
  if (r.status === "completed") return `${periodText(r.startPeriod)}起調薪中，${periodText(r.completedPeriod)}起全部新`;
  if (r.status === "cancelled") return `${periodText(r.startPeriod)}起（已取消，回到舊薪資）`;
  return `${periodText(r.startPeriod)}起`;
}
