/**
 * 後台首頁（老闆看板，app/admin/page.tsx）新版三區的純函式：數字格式、集團 KPI、各公司列、下鑽連結、
 * 下游頁面讀網址篩選。全部無 React、無 IO，有 vitest（lib/__tests__/boss-dashboard.test.ts）。
 *
 * 資料來源：
 *   • 集團總覽區 → GET /group-overview（整年一次；本月數字取 monthly[本月]，不另打一支）；
 *     各公司逾期應收 → GET /dashboard/boss-summary 的 overdueReceivablesByCompany。
 *   • 待處理／人事區 → GET /dashboard/boss-summary（後端 services/boss-summary.ts）。
 * `/group-overview` 回應若有 `companies[].headcount`／`payrollCost`（員工所屬公司上線後才有）就顯示，沒有就不顯示。
 */

/* ------------------------------------------------------------- 格式 --- */

/**
 * 首頁統一的金額格式：絕對值滿一萬改用「萬」（最多一位小數，千分位），未滿一萬顯示到元（千分位）；
 * null／undefined／非有限數 →「—」。四捨五入成 0 的負數不顯示「-0」。
 */
export function fmtWan(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) {
    const wan = Math.round(n / 1_000) / 10;
    return `${wan.toLocaleString("zh-TW", { maximumFractionDigits: 1 })} 萬`;
  }
  const rounded = Math.round(n);
  return (rounded === 0 ? 0 : rounded).toLocaleString("zh-TW");
}

/** 件數／人數：千分位；null →「—」。 */
export function fmtCount(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("zh-TW");
}

/** 百分比一位小數；null →「—」。 */
export function fmtPct1(p: number | null | undefined): string {
  return p == null || !Number.isFinite(p) ? "—" : `${p.toFixed(1)}%`;
}

/** 毛利率（%，一位小數）：收入 0 → null（與後端 project-money pct1 同口徑）。 */
export function marginPct(grossProfit: number, revenue: number): number | null {
  if (!revenue) return null;
  return Math.round((grossProfit / revenue) * 1000) / 10;
}

/** 數字要不要標成「需要處理」的顏色：> 0 才標。 */
export function needsAttention(n: number | null | undefined): boolean {
  return n != null && n > 0;
}

/* -------------------------------------------------- 型別（最小子集） --- */

export interface MonthPointLite {
  month: number;
  revenue: number;
  expense: number;
  grossProfit: number;
}

export interface GroupCompanyLite {
  id: string;
  name: string;
  isActive: boolean;
  excluded?: boolean;
  revenue: number;
  expense: number;
  grossProfit: number;
  grossMarginPct: number | null;
  monthly: MonthPointLite[];
  /** 員工所屬公司上線後才有（另一批工作）：沒有就不顯示。 */
  headcount?: number | null;
  payrollCost?: number | null;
}

export interface GroupOverviewLite {
  period: { year: number };
  companies: GroupCompanyLite[];
  group: { revenue: number; expense: number; grossProfit: number; grossMarginPct: number | null; monthly: MonthPointLite[] };
}

export interface CompanyOverdueLite {
  companyId: string;
  companyName: string;
  overdueAmount: number;
  overdueCount: number;
}

/* ---------------------------------------------------------- 集團 KPI --- */

export interface Kpi {
  revenue: number;
  expense: number;
  grossProfit: number;
  grossMarginPct: number | null;
}

/** 本月與本年集團收入／毛利／毛利率。本月取 group.monthly[month-1]（已剔除關係企業往來）。 */
export function groupKpis(overview: GroupOverviewLite, month: number): { month: Kpi; year: Kpi } {
  const p = overview.group.monthly.find((m) => m.month === month);
  const monthKpi: Kpi = p
    ? { revenue: p.revenue, expense: p.expense, grossProfit: p.grossProfit, grossMarginPct: marginPct(p.grossProfit, p.revenue) }
    : { revenue: 0, expense: 0, grossProfit: 0, grossMarginPct: null };
  const g = overview.group;
  return {
    month: monthKpi,
    year: { revenue: g.revenue, expense: g.expense, grossProfit: g.grossProfit, grossMarginPct: g.grossMarginPct },
  };
}

/* ---------------------------------------------------------- 各公司列 --- */

export type CompanyView = "month" | "year";

export interface CompanyRow {
  id: string;
  name: string;
  revenue: number;
  expense: number;
  grossProfit: number;
  grossMarginPct: number | null;
  /** 逾期應收（不分月／年，是「現在」的狀態）；boss-summary 沒回（查詢失敗）→ null。 */
  overdue: number | null;
  overdueCount: number | null;
  headcount: number | null | undefined;
  payrollCost: number | null | undefined;
}

/**
 * 各公司一列：收入／放款支出／毛利依 view 取本月（monthly[month-1]）或整年；逾期應收以公司 id 對上
 * boss-summary 的 overdueReceivablesByCompany。停用且整年沒數字、也沒有逾期的公司不列；
 * 只出現在逾期清單（例如「（未歸屬公司）」）且有金額的列補在最後。
 */
export function companyRows(
  overview: GroupOverviewLite,
  overdue: readonly CompanyOverdueLite[] | null,
  view: CompanyView,
  month: number,
): CompanyRow[] {
  const overdueBy = new Map((overdue ?? []).map((o) => [o.companyId, o]));
  const rows: CompanyRow[] = [];
  for (const c of overview.companies) {
    const o = overdueBy.get(c.id);
    const idle = c.revenue === 0 && c.expense === 0 && !(o && o.overdueAmount !== 0);
    if (!c.isActive && idle) continue;
    let revenue = c.revenue;
    let expense = c.expense;
    let grossProfit = c.grossProfit;
    let pct = c.grossMarginPct;
    if (view === "month") {
      const p = c.monthly.find((m) => m.month === month);
      revenue = p?.revenue ?? 0;
      expense = p?.expense ?? 0;
      grossProfit = p?.grossProfit ?? 0;
      pct = marginPct(grossProfit, revenue);
    }
    rows.push({
      id: c.id,
      name: c.name,
      revenue,
      expense,
      grossProfit,
      grossMarginPct: pct,
      overdue: overdue ? (o?.overdueAmount ?? 0) : null,
      overdueCount: overdue ? (o?.overdueCount ?? 0) : null,
      headcount: c.headcount,
      payrollCost: c.payrollCost,
    });
  }
  const known = new Set(overview.companies.map((c) => c.id));
  for (const o of overdue ?? []) {
    if (known.has(o.companyId) || o.overdueAmount === 0) continue;
    rows.push({
      id: o.companyId,
      name: o.companyName,
      revenue: 0,
      expense: 0,
      grossProfit: 0,
      grossMarginPct: null,
      overdue: o.overdueAmount,
      overdueCount: o.overdueCount,
      headcount: undefined,
      payrollCost: undefined,
    });
  }
  return rows;
}

/** 回應裡有沒有人數／薪資成本欄位（任何一列帶了該鍵就顯示那一欄）。 */
export function optionalColumns(overview: GroupOverviewLite): { headcount: boolean; payrollCost: boolean } {
  return {
    headcount: overview.companies.some((c) => "headcount" in c && c.headcount !== undefined),
    payrollCost: overview.companies.some((c) => "payrollCost" in c && c.payrollCost !== undefined),
  };
}

/** 只有一家公司（列數 ≤ 1）→ 首頁改顯示單一公司摘要、不畫列表。 */
export function isSingleCompany(rows: readonly CompanyRow[]): boolean {
  return rows.length <= 1;
}

/* ---------------------------------------------------------- 下鑽連結 --- */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const bossLinks = {
  groupOverview: "/admin/group-overview",
  leaveApprovals: "/admin/approvals?status=pending",
  disbursementApprovals: "/admin/disbursements/approvals?scope=all",
  attendanceAnomalies: (period: string) => `/admin/attendance-sheets?period=${encodeURIComponent(period)}&anomaly=1`,
  overtimeDrafts: (period: string | null) =>
    period ? `/admin/overtime-settlements?status=draft&period=${encodeURIComponent(period)}` : "/admin/overtime-settlements?status=draft",
  employees: "/admin/employees",
} as const;

/* -------------------------------------------- 下游頁面讀網址篩選（首頁帶過去的） --- */

/** `?period=YYYY-MM`；格式不對或沒帶 → null。 */
export function readPeriodParam(search: string): string | null {
  const v = new URLSearchParams(search).get("period");
  return v && PERIOD_RE.test(v) ? v : null;
}

/** `?name=1`／`true` → true。 */
export function readFlagParam(search: string, name: string): boolean {
  const v = new URLSearchParams(search).get(name);
  return v === "1" || v === "true";
}

/** `?name=` 屬於 allowed 之一才回傳，否則 null。 */
export function readEnumParam<T extends string>(search: string, name: string, allowed: readonly T[]): T | null {
  const v = new URLSearchParams(search).get(name);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/* ------------------------------------------------------- 合規警示文案 --- */

export interface ComplianceCounts {
  total: number;
  sevenDayRule: number;
  regularLeaveWork: number;
  dailyOver12h: number;
  monthlyOtOver46h: number;
}

/** 合規警示的細項（固定順序；0 件也列，讓老闆知道有在檢查哪四項）。 */
export function complianceItems(c: ComplianceCounts): Array<{ key: keyof Omit<ComplianceCounts, "total">; label: string; count: number }> {
  return [
    { key: "sevenDayRule", label: "七休一", count: c.sevenDayRule },
    { key: "regularLeaveWork", label: "例假出勤", count: c.regularLeaveWork },
    { key: "dailyOver12h", label: "單日>12h", count: c.dailyOver12h },
    { key: "monthlyOtOver46h", label: "月>46h", count: c.monthlyOtOver46h },
  ];
}
