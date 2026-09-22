/**
 * 特休週年制（W1，2026-09-23）— 餘額桶期間與年度給假的 client＋型別。
 *
 * 對應後端 `apps/api/src/routes/leave-balances.ts`：
 *   PUT  /leave-balances               （body 多了 periodStart／periodEnd／note）
 *   POST /leave-balances/annual-grant  （dryRun 先預覽、migrate 搬遷曆年列）
 * 型別手抄自 `apps/api/src/services/annual-leave.ts`（web 與 api 是各自的 build 邊界，
 * 同 lib/backup-api.ts 的慣例）。
 *
 * 讀取用的 `getLeaveBalancesAdmin`／`LeaveBalance` 仍在 lib/admin-api.ts（欄位已含期間四欄）。
 */
import { apiFetch } from "./api-client";

export type AnnualGrantAction = "granted" | "migrated" | "skipped";

export interface AnnualGrantEntry {
  employeeId: string;
  empNo: string | null;
  name: string;
  hireDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** 期間起日當時的年資月數。 */
  seniorityMonths: number;
  days: number;
  entitledHours: number;
  action: AnnualGrantAction;
  /** calendar_basis｜not_hired_yet｜under_six_months｜already_granted */
  reason?: string;
  balanceId: string | null;
  /** 搬遷專用：原曆年列的年份與已用時數。 */
  fromYear?: number;
  usedHours?: number;
}

export interface AnnualGrantResult {
  tenantId: string;
  asOf: string;
  dryRun: boolean;
  migrate: boolean;
  basis: "anniversary" | "calendar";
  leaveTypeId: string;
  leaveTypeCode: string;
  dailyRegularHours: number;
  granted: AnnualGrantEntry[];
  migrated: AnnualGrantEntry[];
  skipped: AnnualGrantEntry[];
}

export interface AnnualGrantBody {
  /** 基準日 'YYYY-MM-DD'（省略＝今天）。 */
  asOf?: string;
  /** true ＝ 只預覽不寫入。 */
  dryRun?: boolean;
  /** true ＝ 同時把該員的曆年列搬成週年期（上線一次性）。 */
  migrate?: boolean;
}

export function runAnnualGrant(body: AnnualGrantBody = {}) {
  return apiFetch<AnnualGrantResult>("/leave-balances/annual-grant", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface PutLeaveBalanceBody {
  employeeId: string;
  leaveTypeId: string;
  /** periodStart 省略時用它推曆年期間；有 periodStart 時只是相容欄位。 */
  year: number;
  entitled: number;
  deferred?: number;
  /** 期間起日；省略＝該年 1/1。 */
  periodStart?: string;
  /** 期間迄日；省略＝起日 + 1 年 − 1 天（沒給起日時＝該年 12/31）。 */
  periodEnd?: string;
  note?: string | null;
}

/** PUT /leave-balances（支援期間欄；lib/admin-api.ts 的 setLeaveBalance 是舊的曆年版）。 */
export function putLeaveBalance(body: PutLeaveBalanceBody) {
  return apiFetch<{ id: string }>("/leave-balances", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------ 顯示用小工具 */

export const BALANCE_SOURCE_LABELS: Record<string, string> = {
  manual: "手動",
  auto: "自動給假",
  migrated: "曆年搬遷",
};

export function balanceSourceLabel(source?: string | null): string {
  if (!source) return "手動";
  return BALANCE_SOURCE_LABELS[source] ?? source;
}

/** 來源 pill 的顏色（手動灰、自動綠、搬遷琥珀）。 */
export function balanceSourceClass(source?: string | null): string {
  if (source === "auto") return "bg-green-50 text-green-700";
  if (source === "migrated") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

/**
 * 餘額桶期間文字：有期間欄就顯示「2026-05-10 ～ 2027-05-09」，
 * 舊資料（API 還沒回期間）退回顯示年度。
 */
export function balancePeriodLabel(balance: {
  year: number;
  period_start?: string | null;
  period_end?: string | null;
}): string {
  if (balance.period_start && balance.period_end) {
    return `${balance.period_start} ～ ${balance.period_end}`;
  }
  return `${balance.year} 年`;
}

/** 小時 → 天（顯示用；dailyRegularHours 省略＝8）。 */
export function hoursToDays(hours: number, dailyRegularHours = 8): number {
  if (!Number.isFinite(hours) || dailyRegularHours <= 0) return 0;
  return Math.round((hours / dailyRegularHours) * 100) / 100;
}
