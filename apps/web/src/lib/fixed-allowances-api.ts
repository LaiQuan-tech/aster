/**
 * 員工固定津貼＋雇主勞退提撥（2026-11-08）——API 呼叫、表單驗證與薪資單顯示的純函式。
 *
 * 固定津貼：HR 在「員工薪資保險資料」逐人設定（名稱、月金額、是否計入投保、課稅方式、生效起迄日），
 * 薪資執行時自動帶入當月有效的津貼（月中起訖當月整月帶入）。應稅的進應發（扣繳基礎）；伙食費每月合計在免稅額內
 * （規則參數，預設 3,000）免稅、只加在實發，超過部分應稅。「計入投保」：勞健保級距不自動改（只提示合計）；
 * 勞退月提繳工資留空時，自動計算會含計入投保的津貼。
 *
 * 勞退：月提繳工資（員工薪資資料手填，留空＝本薪＋計入投保津貼依分級表自動取級距）× 雇主提撥率（規則參數，預設 6%）
 * ＝雇主提撥（公司負擔，不從實發扣除）；勞工自提同一個基數。不適用勞退新制 → 兩者都 0。
 *
 * 後端：apps/api/src/routes/fixed-allowances.ts、packages/rules/src/payroll-engine.ts。
 * 純函式不 import React／DOM（單元測試 __tests__/fixed-allowances.test.ts）。
 */
import { apiFetch } from "./api-client";

/* ── 型別 ──────────────────────────────────────────────────────────── */

export type AllowanceTaxType = "taxable" | "meal_exempt";

export const TAX_TYPE_LABEL: Record<AllowanceTaxType, string> = {
  taxable: "應稅",
  meal_exempt: "伙食費（每月合計免稅額內免稅，預設 3,000）",
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
  /** 計入加班費時薪基數（月薪制；舊版 API 沒有＝計入）。 */
  overtimeBase?: boolean;
  updatedAt: string;
}

export interface PensionSummary {
  /** 依本月分級表自動算的月提繳工資（本薪＋計入投保津貼）；算不出來＝null。 */
  autoWage: number | null;
  levelsEffectiveFrom: string;
  /** 本月適用分級表的全部級距（由小到大）；舊版 API 沒有。 */
  levels?: number[];
  /** 計薪方式（時薪／日薪制的自動值要到執行薪資才算得出來）。 */
  method?: string | null;
  /** 員工薪資資料手填的提繳工資；沒填＝null。 */
  manualWage: number | null;
  newSystem: boolean;
  nationality: string | null;
  /** 國籍看起來不是本國 → 建議確認是否適用新制（只建議，不自動判斷）。 */
  nationalityHint: string | null;
}

export interface FixedAllowanceSummary {
  /** 'YYYY-MM'（今天所屬月份） */
  period: string;
  activeTotal: number;
  activeInsurableTotal: number;
  pension?: PensionSummary | null;
  /** 本月規則的時薪除數（payroll.hourlyWageDivisor，預設 240）；舊版 API 沒有。 */
  hourlyWageDivisor?: number | null;
}

export interface FixedAllowanceWarning {
  code: "same_name_overlap";
  name: string;
  months: string[];
  message: string;
}

/** CRUD 回應附帶的提醒：同名同月重疊、需要重新執行的草稿期別。 */
export interface FixedAllowanceNotices {
  warnings?: FixedAllowanceWarning[];
  stalePeriods?: string[];
}

export interface FixedAllowanceBody {
  name: string;
  amount: number;
  insurable: boolean;
  taxType: AllowanceTaxType;
  overtimeBase: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

/* ── API ──────────────────────────────────────────────────────────── */

export function getFixedAllowances(employeeId: string) {
  return apiFetch<{ fixedAllowances: FixedAllowance[]; summary: FixedAllowanceSummary } & FixedAllowanceNotices>(
    `/salary/${encodeURIComponent(employeeId)}/fixed-allowances`,
  );
}

export function createFixedAllowance(employeeId: string, body: FixedAllowanceBody) {
  return apiFetch<{ fixedAllowance: FixedAllowance } & FixedAllowanceNotices>(`/salary/${encodeURIComponent(employeeId)}/fixed-allowances`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateFixedAllowance(id: string, body: Partial<FixedAllowanceBody>) {
  return apiFetch<{ fixedAllowance: FixedAllowance } & FixedAllowanceNotices>(`/fixed-allowances/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteFixedAllowance(id: string) {
  return apiFetch<{ ok: true } & FixedAllowanceNotices>(`/fixed-allowances/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 草稿過期提醒文字（stalePeriods 空 → null）。 */
export function staleNoticeText(stalePeriods: readonly string[] | undefined): string | null {
  if (!stalePeriods || stalePeriods.length === 0) return null;
  return `${stalePeriods.join("、")} 的草稿薪資單還沒跟上固定津貼的異動：請到「執行薪資/獎金作業」重新執行該月薪資，否則無法定案。`;
}

/**
 * 月中起訖提示：起日不是 1 號、或迄日不是月底 → 當月仍整月帶入（不按日計）。純函式。
 */
export function midMonthHint(form: Pick<FixedAllowanceForm, "effectiveFrom" | "effectiveTo">): string | null {
  const parts: string[] = [];
  if (DATE_RE.test(form.effectiveFrom) && !form.effectiveFrom.endsWith("-01")) parts.push(`起日 ${form.effectiveFrom}`);
  const to = form.effectiveTo.trim();
  if (DATE_RE.test(to)) {
    const [y, m, d] = to.split("-").map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    if (d !== last) parts.push(`迄日 ${to}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join("、")}落在月中：當月整月帶入，如需按日計請手動調整（例：改起迄日或以薪資加減項補扣）。`;
}

/* ── 表單驗證（純函式） ──────────────────────────────────────────────── */

export interface FixedAllowanceForm {
  name: string;
  amount: string;
  insurable: boolean;
  taxType: AllowanceTaxType;
  overtimeBase: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  note: string;
}

export const EMPTY_FIXED_ALLOWANCE_FORM: FixedAllowanceForm = {
  name: "",
  amount: "",
  insurable: true,
  taxType: "taxable",
  overtimeBase: true,
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
      overtimeBase: form.overtimeBase,
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
    overtimeBase: a.overtimeBase !== false,
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
    overtimeBase?: boolean;
  }>;
  /** 加班類給付的時薪基數（月薪制含計入加班基數的固定津貼）。 */
  overtimeHourlyBase?: number;
  hourlyWage?: number;
  fixedAllowancesTotal?: number;
  fixedAllowancesTaxable?: number;
  fixedAllowancesTaxFree?: number;
  employerPension?: number;
  employerPensionRate?: number;
  pensionWage?: number;
  pensionWageSource?: "manual" | "auto";
  pensionNewSystem?: false;
}

export interface FixedAllowanceDisplayLine {
  key: string;
  name: string;
  amount: number;
  taxableAmount: number;
  taxFreeAmount: number;
  /** 例「應稅」「免稅」「免稅 3,000＋應稅 600」 */
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

/** 時薪（基準時薪、加班時薪基數）一律 2 位小數：166.6667 → "166.67"（與 Email、Excel、月表 xlsx 同口徑）。 */
export function hourlyRateText(v: number | null | undefined): string {
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
}

/** 加班費基數勾選框的說明：除數取規則參數（payroll.hourlyWageDivisor）；拿不到寫「時薪除數」。 */
export function overtimeBaseHint(divisor: number | null | undefined): string {
  const d = typeof divisor === "number" && Number.isFinite(divisor) && divisor > 0 ? String(divisor) : "時薪除數";
  return `計入加班費基數（月薪制：加班時薪 ＝（本薪＋計入的津貼）÷ ${d}）`;
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

/** 表單「伙食費每月免稅額」字串 → 整數元；空白＝不設定（預設 3,000）。 */
export function parseMealTaxFree(input: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const raw = input.trim();
  if (raw === "") return { ok: true, value: null };
  if (!/^\d+$/.test(raw)) return { ok: false, error: "伙食費免稅額請填 0 以上的整數元" };
  const v = Number(raw);
  if (v > 100000) return { ok: false, error: "伙食費免稅額超出範圍" };
  return { ok: true, value: v };
}

/** 分級表文字（逗號／空白分隔）→ 由小到大的正整數陣列；有非數字回錯誤。 */
export function parsePensionLevels(input: string): { ok: true; levels: number[] } | { ok: false; error: string } {
  const tokens = input.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: "分級表至少要有一個級距" };
  const nums = tokens.map((t) => Number(t.replace(/元$/, "")));
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) return { ok: false, error: "分級表只能填正整數（元）" };
  return { ok: true, levels: [...new Set(nums)].sort((a, b) => a - b) };
}

/** 勞退月提繳工資欄位下方的說明（自動值、手填值、與分級表版本）。 */
export function pensionWageHintText(p: PensionSummary | null | undefined, manualInput: string): string | null {
  if (!p) return null;
  const fmt = (n: number) => n.toLocaleString("zh-TW");
  if (!p.newSystem) return "不適用勞退新制：雇主提撥與勞工自提都為 0。";
  const hourlyLike = p.method === "hourly" || p.method === "by_attendance_days";
  const auto =
    p.autoWage != null
      ? `依分級表（${p.levelsEffectiveFrom} 版）自動算：本薪＋計入投保的固定津貼 → ${fmt(p.autoWage)}`
      : hourlyLike
        ? `執行薪資時依當月本俸（時薪×正常工時／出勤天數×日薪）＋計入投保的固定津貼，按分級表（${p.levelsEffectiveFrom} 版）自動取級`
        : "無法自動計算（沒有本薪）：執行薪資時會列入「算不出勞退提繳工資」名單，請手填";
  return manualInput.trim() ? `目前以手填值計算；留空則${auto}。` : `留空＝${auto}。`;
}

/** 手填勞退月提繳工資上限＝分級表最高級。 */
export const PENSION_WAGE_MANUAL_MAX = 150_000;

/**
 * 手填提繳工資的提醒（不擋存檔，除非超過上限或不是正整數）：
 *   • 不是正整數／超過 150,000 → error（API 也會擋）
 *   • 不在本月分級表的級距上 → warning「不在分級表級距上」（勞保局只收級距值，請確認）
 */
export function pensionWageInputCheck(
  input: string,
  levels: readonly number[] | undefined,
): { error: string | null; warning: string | null } {
  const raw = input.trim();
  if (!raw) return { error: null, warning: null };
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return { error: "勞退月提繳工資請填正整數（元）", warning: null };
  const v = Number(raw);
  if (v > PENSION_WAGE_MANUAL_MAX) return { error: `勞退月提繳工資最高 ${PENSION_WAGE_MANUAL_MAX.toLocaleString("zh-TW")}（分級表最高級）`, warning: null };
  if (levels && levels.length > 0 && !levels.includes(v)) {
    const up = levels.find((l) => l >= v);
    return { error: null, warning: `${v.toLocaleString("zh-TW")} 不在分級表級距上${up ? `（對應級距 ${up.toLocaleString("zh-TW")}）` : ""}，請確認與勞保局申報一致。` };
  }
  return { error: null, warning: null };
}

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
