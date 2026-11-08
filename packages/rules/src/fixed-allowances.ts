/**
 * fixed-allowances — 員工固定津貼的純函式 (2026-11-08)。無 IO。
 *
 *   • activeFixedAllowancesForPeriod(rows, 'YYYY-MM') — 資料表列 → 當月有效的引擎輸入
 *     有效 = 生效起日 ≤ 該月最後一天,且 (沒有迄日 或 迄日 ≥ 該月第一天)。
 *     月中生效／月中終止的津貼**當月照全額帶入** (不按日比例);要按比例請 HR 調整迄日或另加一次性加減項。
 *   • insurableFixedAllowanceTotal(inputs) — 標記「計入投保薪資」的合計 (提示 HR 核對投保級距與勞退提繳工資)。
 *   • sameNameOverlaps(rows) — 同一員工「同名」津貼的有效期間落在同一個月 (月中換約時兩筆都整月帶入 → 重複給付) 的提醒。
 *
 * 計算 (應稅／伙食費免稅額切分) 在 payroll-engine.ts splitFixedAllowances。
 */

import type { FixedAllowanceInput, FixedAllowanceTaxType } from "./types.js";

/**
 * 伙食費免稅額的**預設值**:每人每月合計 3,000 元以內免稅,超過部分應稅
 * (營利事業所得稅查核準則第 88 條,溯自 112-01-01;實際值取規則參數 allowance.mealTaxFreeMonthly,見 resolveMealTaxFreeMonthly)。
 */
export const MEAL_ALLOWANCE_TAX_FREE_MONTHLY = 3000;

export const FIXED_ALLOWANCE_TAX_TYPES = ["taxable", "meal_exempt"] as const satisfies readonly FixedAllowanceTaxType[];

/** employee_fixed_allowances 的資料表列 (PostgREST 的 integer 也可能是字串,一律寬鬆接)。 */
export interface FixedAllowanceRowLike {
  id?: string;
  name: string;
  amount: number | string;
  insurable: boolean;
  tax_type: string;
  /** migration 0087:計入加班費基數;欄位不存在 (未套用) 或 NULL → 視為 true。 */
  overtime_base?: boolean | null;
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
      overtimeBase: row.overtime_base !== false,
    });
  }
  return out;
}

/** 標記「計入投保薪資」的固定津貼合計 (整數元)。 */
export function insurableFixedAllowanceTotal(inputs: readonly FixedAllowanceInput[]): number {
  return inputs.reduce((acc, a) => acc + (a.insurable ? Math.max(0, Math.round(a.amount)) : 0), 0);
}

/** 同名津貼在同一個月都有效的一組 (月份 'YYYY-MM' 由小到大,最多列 12 個)。 */
export interface SameNameOverlap {
  name: string;
  ids: [string, string];
  months: string[];
}

const monthOf = (d: string) => d.slice(0, 7);

/**
 * 同一員工的津貼裡,名稱相同 (去空白、不分大小寫) 且有效期間落在同一個月的成對組合。
 * 薪資執行是「當月有效就整月帶入」,所以舊約 3/15 止、新約 3/16 起,3 月會兩筆都帶 → 這裡提醒 HR 調整。
 * 只看未刪除的列 (呼叫端負責篩)。純函式。
 */
export function sameNameOverlaps(rows: readonly FixedAllowanceRowLike[]): SameNameOverlap[] {
  const out: SameNameOverlap[] = [];
  const key = (r: FixedAllowanceRowLike) => String(r.name ?? "").trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (key(a) !== key(b)) continue;
      const startA = monthOf(String(a.effective_from));
      const startB = monthOf(String(b.effective_from));
      const endA = a.effective_to ? monthOf(String(a.effective_to)) : "9999-12";
      const endB = b.effective_to ? monthOf(String(b.effective_to)) : "9999-12";
      const lo = startA > startB ? startA : startB;
      const hi = endA < endB ? endA : endB;
      if (lo > hi) continue;
      const months: string[] = [];
      let cur = lo;
      while (cur <= hi && months.length < 12) {
        months.push(cur);
        const [y, m] = cur.split("-").map(Number);
        cur = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
      }
      out.push({ name: String(a.name).trim(), ids: [String(a.id ?? ""), String(b.id ?? "")], months });
    }
  }
  return out;
}
