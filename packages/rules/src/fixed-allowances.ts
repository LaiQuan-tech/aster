/**
 * fixed-allowances — 員工固定津貼的純函式 (2026-11-08)。無 IO。
 *
 *   • activeFixedAllowancesForPeriod(rows, 'YYYY-MM') — 資料表列 → 當月有效的引擎輸入
 *     有效 = 生效起日 ≤ 該月最後一天,且 (沒有迄日 或 迄日 ≥ 該月第一天)。
 *     月中生效／月中終止的津貼**當月照全額帶入** (不按日比例);要按比例請 HR 調整迄日或另加一次性加減項。
 *   • insurableFixedAllowanceTotal(inputs) — 標記「計入投保薪資」的合計 (提示 HR 核對投保級距用)。
 *
 * 計算 (應稅／伙食費免稅額切分) 在 payroll-engine.ts splitFixedAllowances。
 */

import type { FixedAllowanceInput, FixedAllowanceTaxType } from "./types.js";

/** 伙食費免稅額:每人每月合計 2,400 元以內免稅,超過部分應稅。 */
export const MEAL_ALLOWANCE_TAX_FREE_MONTHLY = 2400;

export const FIXED_ALLOWANCE_TAX_TYPES = ["taxable", "meal_exempt"] as const satisfies readonly FixedAllowanceTaxType[];

/** employee_fixed_allowances 的資料表列 (PostgREST 的 integer 也可能是字串,一律寬鬆接)。 */
export interface FixedAllowanceRowLike {
  id?: string;
  name: string;
  amount: number | string;
  insurable: boolean;
  tax_type: string;
  /** 'YYYY-MM-DD' */
  effective_from: string;
  /** 'YYYY-MM-DD' 或 null (= 無迄日) */
  effective_to?: string | null;
}

function monthBounds(period: string): { first: string; last: string } {
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * 當月有效的固定津貼 (依輸入順序)。金額非有限數字、<= 0、或課稅方式不認得的列略過 (不猜)。
 * 'YYYY-MM-DD' 是定寬字串,字典序 = 時間序。
 */
export function activeFixedAllowancesForPeriod(
  rows: readonly FixedAllowanceRowLike[],
  period: string,
): FixedAllowanceInput[] {
  const { first, last } = monthBounds(period);
  const out: FixedAllowanceInput[] = [];
  for (const row of rows) {
    const from = String(row.effective_from ?? "").slice(0, 10);
    const to = row.effective_to ? String(row.effective_to).slice(0, 10) : null;
    if (!from || from > last) continue;
    if (to !== null && to < first) continue;
    const amount = Math.round(Number(row.amount));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!(FIXED_ALLOWANCE_TAX_TYPES as readonly string[]).includes(row.tax_type)) continue;
    out.push({
      ...(row.id ? { id: row.id } : {}),
      name: String(row.name ?? "").trim() || "固定津貼",
      amount,
      insurable: row.insurable === true,
      taxType: row.tax_type as FixedAllowanceTaxType,
    });
  }
  return out;
}

/** 標記「計入投保薪資」的固定津貼合計 (整數元)。 */
export function insurableFixedAllowanceTotal(inputs: readonly FixedAllowanceInput[]): number {
  return inputs.reduce((acc, a) => acc + (a.insurable ? Math.max(0, Math.round(a.amount)) : 0), 0);
}
