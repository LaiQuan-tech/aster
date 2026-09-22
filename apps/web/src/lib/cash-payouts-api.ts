/**
 * 現金給付（不進薪資單的兩筆帳）的 API client：
 *   • 三節／節慶獎金 `festival_bonuses`（M6，API 由 WP7 實作）
 *   • 加班超額另計 `overtime_settlements`（M1，**API 由 WP1 實作**，這裡照 §3.2 的
 *     端點契約寫；WP1 若調整回應形狀，只要改這個檔的型別即可，頁面不動）
 * 另外補上薪資條寄送（M3）的兩支端點。`payslips.sent_at/sent_to` 現在已經在
 * `lib/admin-api.ts` 的 `Payslip`／`lib/ess-api.ts` 的 `MyPayslip` 上（WP10 補齊），
 * 這裡的 `PayslipSendFields` 只留成對它的引用，供既有呼叫端沿用。
 *
 * 新 feature 一律另開 `lib/<feature>-api.ts`（§3.4 檔案互斥原則），不擠 admin-api.ts。
 */
import { apiFetch } from "./api-client";
import type { Payslip } from "./admin-api";

/* ── 薪資條寄送（M3）────────────────────────────────────────────────── */

/**
 * `payslips` 在 migration 0050 之後多出來的兩欄（遷移前 API 不回，故全 optional）。
 * 型別本體已在 `Payslip` 上，這裡只做引用，不再各自維護一份。
 */
export type PayslipSendFields = Pick<Payslip, "sent_at" | "sent_to">;

export interface SendPayslipResult {
  id: string;
  sentAt: string;
  sentTo: string;
}

export interface SendBatchSkipped {
  id: string;
  employeeId: string;
  /** `not_finalized`｜`no_recipient`｜`send_failed`。 */
  reason: string;
  message?: string;
}

export interface SendBatchResult {
  period: string;
  sent: number;
  sentIds: string[];
  skipped: SendBatchSkipped[];
}

/** 單張寄送。409：`not_finalized`／`mail_not_configured`／`no_recipient`。 */
export function sendPayslip(id: string) {
  return apiFetch<SendPayslipResult>(`/payslips/${id}/send`, { method: "POST" });
}

/** 整個期別批次寄送（只寄已定案的；其餘列在 skipped）。 */
export function sendPayslipsBatch(period: string) {
  return apiFetch<SendBatchResult>(`/payslips/send-batch`, {
    method: "POST",
    body: JSON.stringify({ period }),
  });
}

/* ── 三節／節慶獎金（M6）────────────────────────────────────────────── */

export const FESTIVALS = ["lunar_new_year", "dragon_boat", "mid_autumn", "other"] as const;
export type Festival = (typeof FESTIVALS)[number];

export const FESTIVAL_LABEL: Record<Festival, string> = {
  lunar_new_year: "春節",
  dragon_boat: "端午",
  mid_autumn: "中秋",
  other: "其他",
};

export interface FestivalBonus {
  id: string;
  employee_id: string;
  festival: string;
  year: number;
  reference_date: string | null;
  /** 建議金額（API 已把 numeric 轉成 number）。 */
  suggested_amount: number | null;
  prorate_months: number | null;
  final_amount: number | null;
  /** `draft`｜`paid`。 */
  status: string;
  paid_on: string | null;
  note: string | null;
  employee_name: string | null;
  emp_no: string | null;
  hire_date: string | null;
}

export interface PrepareFestivalResult {
  created: number;
  updated: number;
  skipped: Array<{ employeeId: string; reason: string }>;
  bonuses: FestivalBonus[];
}

export function getFestivalBonuses(festival: Festival, year: number) {
  return apiFetch<{ bonuses: FestivalBonus[] }>(`/festival-bonuses?festival=${festival}&year=${year}`);
}

/** 產生／重算該節該年的草稿（已發放的列會被跳過並列在 skipped）。 */
export function prepareFestivalBonuses(body: {
  festival: Festival;
  year: number;
  referenceDate: string;
  baseAmount?: number;
}) {
  return apiFetch<PrepareFestivalResult>(`/festival-bonuses/prepare`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 老闆逐人加減（只有 draft 可改；已發放 → 409 already_paid）。 */
export function patchFestivalBonus(id: string, body: { finalAmount?: number | null; note?: string | null }) {
  return apiFetch<{ bonus: FestivalBonus }>(`/festival-bonuses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** 一次發放該節全部草稿並凍結。 */
export function payFestivalBonuses(body: { festival: Festival; year: number; paidOn: string }) {
  return apiFetch<{ paid: number; paidOn: string; bonuses: FestivalBonus[] }>(`/festival-bonuses/pay`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function festivalBonusExportPath(festival: Festival, year: number): string {
  return `/festival-bonuses/export.xlsx?festival=${festival}&year=${year}`;
}

/* ── 加班超額另計（M1；API 由 WP1 實作）──────────────────────────────── */

export const OT_CHANNELS = ["cash", "comp_time", "payroll"] as const;
export type OvertimeChannel = (typeof OT_CHANNELS)[number];

export const OT_CHANNEL_LABEL: Record<OvertimeChannel, string> = {
  cash: "現金",
  comp_time: "補休",
  payroll: "併入薪資",
};

export const OT_SOURCE_LABEL: Record<string, string> = {
  beyond_cap: "月表自動",
  manual: "手動補登",
};

export interface OvertimeSettlement {
  id: string;
  employee_id: string;
  period: string;
  /** `beyond_cap`（月表核准自動產生）｜`manual`。 */
  source: string;
  minutes: number;
  amount: number | null;
  channel: string;
  /** `draft`｜`paid`。 */
  status: string;
  paid_on: string | null;
  note: string | null;
  /** WP1 的列表端點一併帶出姓名／工號（沒帶時頁面退回顯示 id 前 8 碼）。 */
  employee_name?: string | null;
  emp_no?: string | null;
}

export function getOvertimeSettlements(params: { period?: string; status?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.period) qs.set("period", params.period);
  if (params.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<{ settlements: OvertimeSettlement[] }>(`/overtime-settlements${suffix}`);
}

/** 只有 draft 可改（金額／通道／備註）。 */
export function patchOvertimeSettlement(
  id: string,
  body: { amount?: number | null; channel?: OvertimeChannel; minutes?: number; note?: string | null },
) {
  return apiFetch<{ settlement: OvertimeSettlement }>(`/overtime-settlements/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** 標記已付款（付款後整列凍結）。 */
export function payOvertimeSettlement(
  id: string,
  body: { paidOn: string; channel?: OvertimeChannel; amount?: number | null },
) {
  return apiFetch<{ settlement: OvertimeSettlement }>(`/overtime-settlements/${id}/pay`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** HR 手動補一筆（不受「每人每月一列」限制）。 */
export function createOvertimeSettlement(body: {
  employeeId: string;
  period: string;
  minutes: number;
  amount?: number | null;
  channel?: OvertimeChannel;
  note?: string | null;
}) {
  return apiFetch<{ settlement: OvertimeSettlement }>(`/overtime-settlements`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function overtimeSettlementExportPath(period?: string): string {
  return `/overtime-settlements/export.xlsx${period ? `?period=${period}` : ""}`;
}

/* ── 共用小工具 ────────────────────────────────────────────────────── */

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return Math.round(value).toLocaleString("zh-TW");
}

/** 分鐘 → 「X 小時 Y 分」。 */
export function minutesLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分`;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}

export function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
