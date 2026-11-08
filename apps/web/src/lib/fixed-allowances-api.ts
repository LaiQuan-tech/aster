/**
 * 員工固定津貼＋雇主勞退提撥（2026-11-08）——API 呼叫、表單驗證與薪資單顯示的純函式。
 *
 * 固定津貼：HR 在「員工薪資保險資料」逐人設定（名稱、月金額、是否計入投保、課稅方式、生效起迄日），
 * 薪資執行時自動帶入當月有效的津貼。應稅的進應發（扣繳基礎）；伙食費每月合計 2,400 元以內免稅、只加在實發，超過部分應稅。
 * 「計入投保」只用於提示「底薪＋計入投保津貼」合計，系統不自動改投保級距。
 *
 * 雇主勞退提撥（公司負擔）：月提繳工資（＝勞保投保薪資）× 雇主提撥率（規則參數，預設 6%），不從實發扣除。
 *
 * 後端：apps/api/src/routes/fixed-allowances.ts、packages/rules/src/payroll-engine.ts。
 * 純函式不 import React／DOM（單元測試 __tests__/fixed-allowances.test.ts）。
 */
import { apiFetch } from "./api-client";

/* ── 型別 ──────────────────────────────────────────────────────────── */

export type AllowanceTaxType = "taxable" | "meal_exempt";

export const TAX_TYPE_LABEL: Record<AllowanceTaxType, string> = {
  taxable: "應稅",
  meal_exempt: "伙食費（每月 2,400 內免稅）",
};

export interface FixedAllowance {
  id: string;
  employeeId: string;
  name: string;
  amount: number;
  insurable: boolean;
  taxType: AllowanceTaxType;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  updatedAt: string;
}

export interface FixedAllowanceSummary {
  /** 'YYYY-MM'（今天所屬月份） */
  period: string;
  activeTotal: number;
  activeInsurableTotal: number;
}

export interface FixedAllowanceBody {
  name: string;
  amount: number;
  insurable: boolean;
  taxType: AllowanceTaxType;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

/* ── API ──────────────────────────────────────────────────────────── */

export function getFixedAllowances(employeeId: string) {
  return apiFetch<{ fixedAllowances: FixedAllowance[]; summary: FixedAllowanceSummary }>(
    `/salary/${encodeURIComponent(employeeId)}/fixed-allowances`,
  );
}

export function createFixedAllowance(employeeId: string, body: FixedAllowanceBody) {
  return apiFetch<{ fixedAllowance: FixedAllowance }>(`/salary/${encodeURIComponent(employeeId)}/fixed-allowances`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateFixedAllowance(id: string, body: Partial<FixedAllowanceBody>) {
  return apiFetch<{ fixedAllowance: FixedAllowance }>(`/fixed-allowances/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteFixedAllowance(id: string) {
  return apiFetch<{ ok: true }>(`/fixed-allowances/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ── 表單驗證（純函式） ──────────────────────────────────────────────── */

export interface FixedAllowanceForm {
  name: string;
  amount: string;
  insurable: boolean;
  taxType: AllowanceTaxType;
  effectiveFrom: string;
  effectiveTo: string;
  note: string;
}

export const EMPTY_FIXED_ALLOWANCE_FORM: FixedAllowanceForm = {
  name: "",
  amount: "",
  insurable: true,
  taxType: "taxable",
  effectiveFrom: "",
  effectiveTo: "",
  note: "",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildFixedAllowanceBody(
  form: FixedAllowanceForm,
): { ok: true; body: FixedAllowanceBody } | { ok: false; error: string } {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "請填津貼名稱" };
  if ([...name].length > 50) return { ok: false, error: "津貼名稱最多 50 字" };
  const raw = form.amount.trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: "月金額請填 0 以上的整數元" };
  const amount = Number(raw);
  if (amount > 9_999_999) return { ok: false, error: "月金額超出範圍" };
  if (!DATE_RE.test(form.effectiveFrom)) return { ok: false, error: "請選擇生效起日" };
  const to = form.effectiveTo.trim();
  if (to && !DATE_RE.test(to)) return { ok: false, error: "生效迄日格式不正確" };
  if (to && to < form.effectiveFrom) return { ok: false, error: "生效迄日不可早於生效起日" };
  return {
    ok: true,
    body: {
      name,
      amount,
      insurable: form.insurable,
      taxType: form.taxType,
      effectiveFrom: form.effectiveFrom,
      effectiveTo: to || null,
      note: form.note.trim() || null,
    },
  };
}

export function formFromAllowance(a: FixedAllowance): FixedAllowanceForm {
  return {
    name: a.name,
    amount: String(a.amount),
    insurable: a.insurable,
    taxType: a.taxType,
    effectiveFrom: a.effectiveFrom,
    effectiveTo: a.effectiveTo ?? "",
    note: a.note ?? "",
  };
}

/**
 * 投保提示：底薪 ＋ 本月有效且「計入投保」的固定津貼，與目前勞保投保級距比較。
 * 系統不自動改級距（投保薪資是 HR 申報的），只在合計高於級距時提醒。底薪或投保級距不是數字 → 只顯示合計。
 */
export function insuredHintText(baseSalary: string, laborGrade: string, insurableTotal: number): string | null {
  if (!(insurableTotal > 0)) return null;
  const base = Number(baseSalary);
  const baseNum = Number.isFinite(base) && base > 0 ? Math.round(base) : 0;
  const total = baseNum + insurableTotal;
  const fmt = (n: number) => n.toLocaleString("zh-TW");
  const head = `固定津貼 ＋ 底薪合計（供參考）：底薪 ${fmt(baseNum)} ＋ 計入投保的固定津貼 ${fmt(insurableTotal)} ＝ ${fmt(total)}`;
  const labor = Number(laborGrade);
  if (laborGrade.trim() === "" || !Number.isFinite(labor) || labor <= 0) {
    return `${head}。尚未設定勞保投保級距，請依合計選級距。`;
  }
  if (total > labor) {
    return `${head}，高於目前勞保投保級距 ${fmt(labor)}。系統不會自動調整級距，請確認是否需要調整投保薪資。`;
  }
  return `${head}，未超過目前勞保投保級距 ${fmt(labor)}。`;
}

/* ── 薪資單顯示（純函式） ──────────────────────────────────────────── */

/** 薪資單 breakdown 上固定津貼／公司負擔相關欄位（引擎輸出；舊薪資單沒有）。 */
export interface BreakdownAllowanceFields {
  gross?: number;
  fixedAllowances?: Array<{
    id?: string;
    name: string;
    amount: number;
    insurable?: boolean;
    taxType?: AllowanceTaxType;
    taxableAmount?: number;
    taxFreeAmount?: number;
  }>;
  fixedAllowancesTotal?: number;
  fixedAllowancesTaxable?: number;
  fixedAllowancesTaxFree?: number;
  employerPension?: number;
  employerPensionRate?: number;
  pensionWage?: number;
}

export interface FixedAllowanceDisplayLine {
  key: string;
  name: string;
  amount: number;
  taxableAmount: number;
  taxFreeAmount: number;
  /** 例「應稅」「免稅」「免稅 2,400＋應稅 600」 */
  taxNote: string;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("zh-TW");

export function fixedAllowanceDisplayOf(b: BreakdownAllowanceFields | null | undefined): FixedAllowanceDisplayLine[] {
  return (b?.fixedAllowances ?? []).map((f, i) => {
    const taxFree = Number(f.taxFreeAmount ?? 0) || 0;
    const taxable = f.taxableAmount !== undefined ? Number(f.taxableAmount) || 0 : (Number(f.amount) || 0) - taxFree;
    const taxNote = taxFree > 0 && taxable > 0 ? `免稅 ${fmtInt(taxFree)}＋應稅 ${fmtInt(taxable)}` : taxFree > 0 ? "免稅" : "應稅";
    return { key: f.id ?? `${i}`, name: f.name, amount: Number(f.amount) || 0, taxableAmount: taxable, taxFreeAmount: taxFree, taxNote };
  });
}

/** 雇主提撥率顯示：0.06 → "6%"。 */
export function pensionRatePct(rate: number | undefined): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 10000) / 100}%`;
}

/**
 * 人事成本 = 應發合計 ＋ 固定津貼免稅部分 ＋ 雇主勞退提撥（與後端工資清冊 CSV 的「人事成本合計」同一個定義）。
 * 雇主勞健保負擔系統沒有計算，不含。
 */
export function laborCostOf(gross: number, b: BreakdownAllowanceFields | null | undefined): number {
  const v = gross + (Number(b?.fixedAllowancesTaxFree ?? 0) || 0) + (Number(b?.employerPension ?? 0) || 0);
  return Math.round(v * 100) / 100;
}

/* ── 規則參數：雇主勞退提撥率（%） ─────────────────────────────────── */

/** 表單「%」字串 → 比例；6–100 以外或不是數字回錯誤訊息。空白＝不設定（預設 6%）。 */
export function parseEmployerRatePct(input: string): { ok: true; rate: number | null } | { ok: false; error: string } {
  const raw = input.trim();
  if (raw === "") return { ok: true, rate: null };
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return { ok: false, error: "雇主提撥率請填數字（%）" };
  if (pct < 6) return { ok: false, error: "雇主提撥率不得低於 6%（勞工退休金條例 §14）" };
  if (pct > 100) return { ok: false, error: "雇主提撥率不得超過 100%" };
  return { ok: true, rate: Math.round(pct * 100) / 10000 };
}
