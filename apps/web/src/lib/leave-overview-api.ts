/**
 * 假別剩餘總覽／員工假別內頁／手動調整（2026-10-27 業主：「一個頁面看到大家的假別剩餘，
 * 點進內頁可以手動增減假的時數」）。
 *
 * 對應後端 `apps/api/src/routes/leave-balances.ts`：
 *   GET  /leave-balances/overview?year=&deptId=&q=         一人一列總覽（HR 全租戶；其他角色只回自己）
 *   GET  /leave-balances/overview/export.xlsx              同篩選匯出 Excel
 *   GET  /leave-balances/employees/:id?year=               員工內頁（卡片、餘額桶、調整歷程）
 *   POST /leave-balances/adjustments                       手動增減（只有 HR／平台管理員）
 * 型別手抄自 `apps/api/src/services/leave-overview.ts`／`leave-adjustments.ts`（web 與 api 各自 build）。
 * 數字一律是**小時**；顯示用 lib/leave-duration.ts 換成「天＋時」。
 */
import { apiDownload, apiFetch } from "./api-client";
import type { LeaveBalance } from "./admin-api";

export interface OverviewLeaveType {
  id: string;
  code: string;
  name: string;
}

export interface OverviewCell {
  total: number;
  used: number;
  remaining: number;
  balanceIds: string[];
  periodStart: string | null;
  periodEnd: string | null;
  expiring: { date: string; hours: number; daysLeft: number } | null;
  /** 有桶但沒有任何桶的期間包含參考日（格子顯示 0＋「無有效期間」）。 */
  noActivePeriod?: boolean;
  /** 另有幾個期間也包含參考日（沒算進來；與扣假挑同一桶）。 */
  overlapCount?: number;
}

export interface OverviewRow {
  employeeId: string;
  empNo: string | null;
  name: string;
  deptId: string | null;
  deptName: string | null;
  cells: Record<string, OverviewCell>;
}

export interface LeaveOverview {
  year: number;
  asOf: string;
  columns: OverviewLeaveType[];
  rows: OverviewRow[];
  totals: { total: number; used: number; remaining: number };
  dailyRegularHours: number;
  canAdjust: boolean;
}

export interface OverviewQuery {
  year: number;
  deptId?: string;
  q?: string;
}

function overviewQs(params: OverviewQuery): string {
  const qs = new URLSearchParams({ year: String(params.year) });
  if (params.deptId) qs.set("deptId", params.deptId);
  if (params.q?.trim()) qs.set("q", params.q.trim());
  return qs.toString();
}

export function getLeaveOverview(params: OverviewQuery) {
  return apiFetch<LeaveOverview>(`/leave-balances/overview?${overviewQs(params)}`);
}

export function downloadLeaveOverview(params: OverviewQuery) {
  return apiDownload(
    `/leave-balances/overview/export.xlsx?${overviewQs(params)}`,
    `${params.year - 1911}年假別剩餘總覽.xlsx`,
  );
}

export interface LeaveAdjustment {
  id: string;
  employee_id: string;
  leave_type_id: string;
  balance_id: string | null;
  delta_hours: number | string;
  entitled_before: number | string;
  entitled_after: number | string;
  reason: string;
  created_by_emp_id: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface EmployeeLeaveDetail {
  year: number;
  asOf: string;
  employee: {
    id: string;
    name: string;
    emp_no: string | null;
    dept_id: string | null;
    dept_name: string | null;
    hire_date?: string | null;
    status?: string | null;
  };
  leaveTypes: OverviewLeaveType[];
  cards: Array<OverviewCell & { leaveType: OverviewLeaveType }>;
  balances: LeaveBalance[];
  adjustments: LeaveAdjustment[];
  adjustmentsAvailable: boolean;
  dailyRegularHours: number;
  canAdjust: boolean;
}

export function getEmployeeLeaveDetail(employeeId: string, year: number) {
  return apiFetch<EmployeeLeaveDetail>(
    `/leave-balances/employees/${encodeURIComponent(employeeId)}?year=${year}`,
  );
}

export interface AdjustLeaveBody {
  employeeId: string;
  leaveTypeId: string;
  balanceId?: string;
  deltaHours: number;
  reason: string;
  allowNegative?: boolean;
}

export interface AdjustLeaveResult {
  balance: { id: string; entitled: number; deferred: number; used: number; remaining: number };
  createdBalance: boolean;
  negative: boolean;
}

export function adjustLeaveBalance(body: AdjustLeaveBody) {
  return apiFetch<AdjustLeaveResult>("/leave-balances/adjustments", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------ 純函式（有測試） */

/** 員工內頁網址。 */
export function leaveDetailHref(employeeId: string, year?: number): string {
  const base = `/admin/leave-balances/${encodeURIComponent(employeeId)}`;
  return year ? `${base}?year=${year}` : base;
}

/**
 * 「天＋時」→ 小時（依 1 天＝hoursPerDay 小時）。空字串當 0；負數或非數字回 null（表單顯示錯誤）。
 * 結果留 2 位小數。
 */
export function daysHoursToHours(days: string, hours: string, hoursPerDay = 8): number | null {
  const d = days.trim() === "" ? 0 : Number(days);
  const h = hours.trim() === "" ? 0 : Number(hours);
  if (!Number.isFinite(d) || !Number.isFinite(h) || d < 0 || h < 0) return null;
  const perDay = Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : 8;
  return Math.round((d * perDay + h) * 100) / 100;
}

export type AdjustDirection = "add" | "subtract";

/** 單次調整上限（小時），與 API zod 上限一致。 */
export const MAX_ADJUST_HOURS = 9999.99;

/**
 * 調整表單預設要選哪個餘額桶：期間包含 `today` 的桶，多個時取起日最新者（與扣假同規則）；
 * 沒有 → ""（呼叫端在多桶時強制使用者選）。只有一個桶 → 那一個。
 */
export function defaultBucketId(
  buckets: Array<{ id: string; period_start?: string | null; period_end?: string | null }>,
  today: string,
): string {
  if (buckets.length === 1) return buckets[0]!.id;
  const active = buckets
    .filter((b) => b.period_start && b.period_end && b.period_start <= today && today <= b.period_end)
    .sort((a, b) => ((a.period_start as string) < (b.period_start as string) ? 1 : -1));
  return active[0]?.id ?? "";
}

export interface AdjustFormInput {
  direction: AdjustDirection;
  days: string;
  hours: string;
  reason: string;
  leaveTypeId: string;
}

/** 表單驗證：回 `{ deltaHours }` 或 `{ error }`（給人看的訊息）。 */
export function validateAdjustForm(
  form: AdjustFormInput,
  hoursPerDay = 8,
): { deltaHours: number; error?: undefined } | { error: string; deltaHours?: undefined } {
  if (!form.leaveTypeId) return { error: "請選擇假別" };
  const hours = daysHoursToHours(form.days, form.hours, hoursPerDay);
  if (hours === null) return { error: "天數與時數須為不小於 0 的數字" };
  if (hours === 0) return { error: "請輸入要調整的天數或時數" };
  if (hours > MAX_ADJUST_HOURS) return { error: `單次調整不可超過 ${MAX_ADJUST_HOURS} 小時` };
  if (!form.reason.trim()) return { error: "請填寫調整原因" };
  return { deltaHours: form.direction === "subtract" ? -hours : hours };
}

/** 依「本次調整後剩餘」判斷會不會變負數（前端先提示，送出時再帶 allowNegative）。 */
export function remainingAfter(currentRemaining: number, deltaHours: number): number {
  return Math.round((currentRemaining + deltaHours) * 100) / 100;
}

/** 快到期標籤文字：「11/10 到期 · 剩 1天4小時」由呼叫端組時數；這裡只組日期與天數。 */
export function expiringLabel(expiring: OverviewCell["expiring"]): string | null {
  if (!expiring) return null;
  const [, m, d] = expiring.date.split("-");
  const when = expiring.daysLeft === 0 ? "今天到期" : `${Number(m)}/${Number(d)} 到期`;
  return expiring.daysLeft === 0 ? when : `${when}（${expiring.daysLeft} 天）`;
}

/** 格子色調：用完（剩 0）灰、負數紅、其餘一般。 */
export function cellTone(cell: OverviewCell | undefined): "empty" | "zero" | "negative" | "normal" {
  if (!cell) return "empty";
  if (cell.remaining < 0) return "negative";
  if (cell.remaining === 0) return "zero";
  return "normal";
}

/** 調整歷程的增減文字：+8 小時 → 「+1天」（8 小時制）。 */
export function signedDelta(delta: number | string, format: (hours: number) => string): string {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return "0";
  return `${n > 0 ? "+" : "−"}${format(Math.abs(n))}`;
}
