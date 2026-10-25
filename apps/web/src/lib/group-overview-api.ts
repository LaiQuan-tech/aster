/**
 * 集團總覽的 typed API 呼叫與回應型別。後端見 apps/api/src/routes/group-overview.ts；
 * 口徑（入帳收入未稅依入帳日、放款已匯款毛額依匯款日、關係企業剔除、人事依員工所屬公司）見 apps/api/src/services/group-overview.ts。
 * 只有 hr_admin／platform_admin 打得通（其他角色 403）。
 */
import { apiFetch } from "./api-client";
import { buildOverviewQuery } from "./group-overview";

export interface GroupMonthPoint {
  /** 1–12。 */
  month: number;
  revenue: number;
  invoiced: number;
  expense: number;
  grossProfit: number;
}

export interface GroupAffiliateAmounts {
  revenue: number;
  invoiced: number;
  expense: number;
}

export interface GroupCompanyRow {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  /** 使用者勾掉的公司：不計入集團合計，列仍照常回傳（畫面灰色顯示）。 */
  excluded: boolean;
  /** 入帳收入（未稅、依入帳日）。 */
  revenue: number;
  /** 已開票（未稅、依開票日；參考）。 */
  invoiced: number;
  /** 放款支出（已匯款、代扣前毛額、依匯款日）。 */
  expense: number;
  grossProfit: number;
  /** 毛利÷入帳收入（%，一位小數）；收入 0 → null。 */
  grossMarginPct: number | null;
  /** 其中關係企業往來（已包含在上面三個數字裡）。 */
  affiliate: GroupAffiliateAmounts;
  /** 該年 12 個月（不受月份篩選影響）。 */
  monthly: GroupMonthPoint[];
  /** 目前在職人數（依員工所屬公司）。 */
  headcount: number;
  /** 期間內薪資單應發合計（依員工所屬公司）；期間內沒有任何薪資單 → null（尚無薪資資料）。 */
  payrollCost: number | null;
  /** 毛利 − 薪資成本；payrollCost 為 null 時也是 null。 */
  grossProfitAfterPayroll: number | null;
}

export interface GroupTotals {
  includedCompanyIds: string[];
  revenue: number;
  invoiced: number;
  expense: number;
  grossProfit: number;
  grossMarginPct: number | null;
  /** 集團合計已剔除的關係企業往來（只計納入合計的公司）。 */
  eliminated: GroupAffiliateAmounts & { total: number };
  monthly: GroupMonthPoint[];
  /** 在職人數：納入合計的公司＋未指派。 */
  headcount: number;
  /** 薪資成本：納入合計的公司＋未指派；沒有薪資資料 → null。 */
  payrollCost: number | null;
  /** 未指派公司的在職人數（不分攤到任何公司）。 */
  unassignedHeadcount: number;
  /** 未指派公司員工的薪資成本；沒有薪資資料 → null。 */
  unassignedPayrollCost: number | null;
  /** 集團毛利 − 集團薪資成本；沒有薪資資料 → null。 */
  grossProfitAfterPayroll: number | null;
}

/** 人事資料的狀態。 */
export interface GroupPayrollSummary {
  /** 期間內有任何薪資單；false＝畫面標示「尚無薪資資料」。 */
  hasData: boolean;
  slipCount: number;
  /** 其中還是草稿（未定稿）的張數。 */
  draftSlipCount: number;
  /** 員工所屬公司欄位（migration 0072）已套；false＝全部人列在未指派。 */
  companyAssignmentReady: boolean;
  /** 薪資成本是否含雇主負擔（勞健保、勞退雇主提繳）；目前固定 false（只有應發）。 */
  employerCostIncluded: boolean;
}

export interface GroupPeriod {
  year: number;
  month: number | null;
  from: string;
  to: string;
}

/** 資料品質提醒的一列（專案期別）。 */
export interface GroupQualityRow {
  projectId: string;
  code: string | null;
  name: string;
  installmentNo: number | null;
  /** 入帳日；「沒有入帳日」那一類是 null。 */
  receivedOn: string | null;
  receivedAmount: number;
  /** 該期有效金額（未稅）；算不出來是 null。 */
  effectiveAmount: number | null;
}

/** 不改任何數字，只攤出可疑的列讓人核對（見後端 services/group-overview.ts 檔頭「資料品質提醒」）。 */
export interface GroupDataQuality {
  /** 有入帳金額但沒有入帳日：無法歸月，不在任何一個月的收入裡（租戶全部期別）。 */
  undatedReceived: { count: number; amount: number; sample: GroupQualityRow[] };
  /** 該年入帳的期別中，實收比該期有效金額（未稅）多超過 1 元：可能把含稅金額當成未稅填了。 */
  receivedOverEffective: { count: number; excess: number; sample: GroupQualityRow[] };
}

export interface GroupOverviewResult {
  period: GroupPeriod;
  companies: GroupCompanyRow[];
  group: GroupTotals;
  dataQuality: GroupDataQuality;
  /** 舊版 API 沒有這個欄位（部署順序差）時是 undefined。 */
  payroll?: GroupPayrollSummary;
}

export type GroupDetailKind = "revenue" | "expense";

export interface GroupRevenueRow {
  projectId: string;
  code: string | null;
  name: string;
  clientName: string | null;
  clientShortName: string | null;
  isAffiliate: boolean;
  /** 入帳金額（未稅）。 */
  amount: number;
}

export interface GroupExpenseRow {
  key: string;
  vendorId: string | null;
  name: string;
  shortName: string | null;
  isAffiliate: boolean;
  /** 放款金額（已匯款、代扣前毛額）。 */
  amount: number;
  /** 匯款筆數。 */
  count: number;
}

interface GroupDetailBase {
  companyId: string;
  companyName: string;
  period: GroupPeriod;
  /** 全部的合計（不受 50 筆上限影響）。 */
  total: number;
  /** 全部的專案數／廠商數。 */
  count: number;
  /** count 超過 50：只列金額前 50 名。 */
  truncated: boolean;
}

export type GroupRevenueDetail = GroupDetailBase & { kind: "revenue"; rows: GroupRevenueRow[] };
export type GroupExpenseDetail = GroupDetailBase & { kind: "expense"; rows: GroupExpenseRow[] };
export type GroupDetailResult = GroupRevenueDetail | GroupExpenseDetail;

export type GroupOverviewParams = {
  year?: number;
  /** null／省略＝全年。 */
  month?: number | null;
  /** 不納入集團合計的公司 id。 */
  exclude?: readonly string[];
};

/** GET /group-overview?year=&month=&exclude= */
export function getGroupOverview(params: GroupOverviewParams = {}) {
  return apiFetch<GroupOverviewResult>(`/group-overview${buildOverviewQuery(params)}`);
}

/** GET /group-overview/detail?companyId=&year=&month=&kind=revenue|expense */
export function getGroupOverviewDetail(params: { companyId: string; kind: "revenue"; year?: number; month?: number | null }): Promise<GroupRevenueDetail>;
export function getGroupOverviewDetail(params: { companyId: string; kind: "expense"; year?: number; month?: number | null }): Promise<GroupExpenseDetail>;
export function getGroupOverviewDetail(params: { companyId: string; kind: GroupDetailKind; year?: number; month?: number | null }): Promise<GroupDetailResult> {
  return apiFetch<GroupDetailResult>(`/group-overview/detail${buildOverviewQuery(params)}`);
}
