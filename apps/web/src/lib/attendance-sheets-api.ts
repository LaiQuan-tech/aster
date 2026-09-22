/**
 * 出勤月表（attendance sheet）client + 型別。
 *
 * 型別手抄自 apps/api/src/services/attendance-sheet-types.ts（P1-API 的資料形狀
 * 合約，該檔本身宣告是 framework-free 的共用合約）。前端刻意不 import 該檔（web
 * 與 api 是各自的 build 邊界，跨 package import 需要額外的 tsconfig 設定），照抄一份
 * 在這裡維護。若之後與 apps/api/src/routes/attendance-sheets.ts 的實際回應外殼
 * 不一致，以後端實際回應為準回來改這裡（欄位命名、是否包一層 `sheet` 等）。
 */
import { apiFetch, apiDownload } from "./api-client";

// ---------------------------------------------------------------------------
// 型別（手抄自 attendance-sheet-types.ts，保持欄位順序與命名一致）
// ---------------------------------------------------------------------------

export type SheetStatus =
  | "draft"
  | "submitted"
  | "manager_reviewed"
  | "approved"
  | "locked"
  | "returned";

export type AnomalySeverity = "info" | "warn" | "error";

export type AnomalyCode =
  | "missing_in"
  | "missing_out"
  | "unpaired_punch"
  | "absent_scheduled"
  | "leave_overlap_work"
  | "late"
  | "early_leave"
  | "overtime_override"
  | "overtime_over_daily_cap"
  | "holiday_work"
  | "outing_unpaired"
  | "manual_punch"
  | "cross_midnight"
  | "meal_deducted"
  | "monthly_ot_threshold"
  /** M1：本月累計加班超過月上限，這天有分鐘落在上限外（info）。 */
  | "overtime_beyond_cap"
  /** M1：同上，且當日沒有已核准的加班單（error，送出前要填說明）。 */
  | "overtime_beyond_cap_unapproved"
  | "consecutive_late"
  | "pending_leave_in_period"
  | "no_salary_structure";

export interface SheetAnomaly {
  code: AnomalyCode;
  severity: AnomalySeverity;
  detail?: Record<string, unknown>;
  message: string;
}

/** 一天的月表列（computed view，非 DB 原始列）。 */
export interface SheetDayView {
  date: string;
  weekday: number;
  dayType: "workday" | "rest_day" | "fixed_holiday";
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  outingMinutes: number;
  leaveMinutes: number;
  leaveSummary: string | null;
  wfh: boolean;
  overtime: {
    computed: number;
    override: number | null;
    overrideReason: string | null;
    /** override ?? computed —— payroll 實際採用的分鐘數。 */
    effective: number;
    tier1: number;
    tier2: number;
    tier3: number;
    /**
     * M1：這天有多少有效加班分鐘落在「月加班上限」之外（依日期序歸給月底那幾天）。
     * 規則 `overtime.beyondCap='settle_separately'` 時這些分鐘不算加班費，改記在
     * 「加班超額另計」帳上另行給付。舊版 API／舊快照沒有這欄 → 讀取端請當 0。
     */
    beyondCap?: number;
  };
  content: string | null;
  outingNote: string | null;
  projectId: string | null;
  projectName: string | null;
  note: string | null;
  anomalyAck: string | null;
  anomalies: SheetAnomaly[];
}

/** 月表表頭/彙總列用的月度加總。 */
export interface SheetTotals {
  attendanceDays: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  leaveMinutes: number;
  leaveByType: Record<string, number>;
  otTier1: number;
  otTier2: number;
  otTier3: number;
  otTotal: number;
  /** M1：本月落在月加班上限之外的分鐘合計；舊版 API 沒有這欄 → 當 0。 */
  overtimeBeyondCapMinutes?: number;
  overtimeMonthlyAlert: "none" | "36" | "40" | "46";
  /**
   * M24：三個加班級距的欄名（後端依規則的 tiers 產生，預設
   * `["≤2h", "3-8h", "9-12h"]`）。舊版 API 沒有這欄 → 用 DEFAULT_OT_TIER_LABELS。
   */
  otTierLabels?: string[];
}

/** `totals.otTierLabels` 缺漏時的預設欄名（＝亞斯特手工 Excel 的三欄）。 */
export const DEFAULT_OT_TIER_LABELS: [string, string, string] = ["≤2h", "3-8h", "9-12h"];

/** 從 totals 取三個加班級距欄名（缺漏或不足三個 → 預設值）。 */
export function otTierLabelsOf(totals: Pick<SheetTotals, "otTierLabels">): [string, string, string] {
  const raw = totals.otTierLabels;
  if (!Array.isArray(raw) || raw.length < 3) return DEFAULT_OT_TIER_LABELS;
  return [
    String(raw[0] ?? DEFAULT_OT_TIER_LABELS[0]),
    String(raw[1] ?? DEFAULT_OT_TIER_LABELS[1]),
    String(raw[2] ?? DEFAULT_OT_TIER_LABELS[2]),
  ];
}

/** 薪資試算（只有 HR 看得到；本人查詢自己的表時是 null）。 */
export interface SheetMoney {
  hourlyWage: number;
  otPay: number;
  otPayByTier: { tier1: number; tier2: number; tier3: number };
  leaveDeduction: number;
  lateEarlyDeduction: number;
  laborInsurance: number;
  healthInsurance: number;
  pensionVoluntary: number;
  advance: number;
  gross: number;
  totalDeductions: number;
  expenses: number;
  net: number;
  netPlusExpenses: number;
}

/** GET /attendance-sheets/:id、/my/attendance-sheet 回傳的完整月表。 */
export interface SheetView {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string | null;
  department: string | null;
  title: string | null;
  period: string;
  status: SheetStatus;
  managerEmpId: string | null;
  managerName: string | null;
  submittedAt: string | null;
  managerReviewedAt: string | null;
  approvedAt: string | null;
  lockedAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  computedAt: string | null;
  days: SheetDayView[];
  monthAnomalies: SheetAnomaly[];
  totals: SheetTotals;
  money: SheetMoney | null;
  anomalyCount: { error: number; warn: number; info: number };
  frozen: boolean;
  /**
   * 這張月表實際被算出來時用的規則版本號（後端 rule_config_version，計算/凍結
   * 當下寫死，不會因為之後 HR 改規則而變動）。C4：畫面顯示「本月適用規則」要
   * 用這個權威值，不要自己依 period 重新推導——推導值只代表「現在看起來應該是
   * 哪版」，回填生效日等情境下會跟這張月表實際算出來的數字對不上。
   */
  ruleConfigVersion: number | null;
}

/** 合法狀態轉移（用來決定按鈕 disabled，不是本檔案唯一真相——後端仍會再擋一次）。 */
export const SHEET_TRANSITIONS: Record<SheetStatus, SheetStatus[]> = {
  draft: ["submitted"],
  returned: ["submitted"],
  submitted: ["manager_reviewed", "returned"],
  manager_reviewed: ["approved", "returned"],
  approved: ["locked", "returned", "draft"],
  locked: [],
};

/** GET /attendance-sheets 清單端點的精簡列，不是完整 SheetView。 */
export interface SheetListItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNo: string | null;
  department: string | null;
  deptId: string | null;
  period: string;
  status: SheetStatus;
  managerEmpId: string | null;
  anomalyCount: { error: number; warn: number; info: number };
  otTotalMinutes: number;
  overtimeMonthlyAlert: "none" | "36" | "40" | "46";
  submittedAt: string | null;
  approvedAt: string | null;
  computedAt: string | null;
}

/**
 * 實際回應形狀（對過 apps/api/src/routes/attendance-sheets.ts 後修正，2026-09-14）：
 * PATCH day 只回扁平的異動欄位（不是完整 SheetDayView，也沒有 effective），
 * submit/review/approve/return/reopen/recompute 只回 `{id, status, ...一兩個時間欄}`
 * 不是 `{sheet}`。前端一律靠 `mergeDayPatch` 合併回既有 day、靠重新 GET 取得
 * 完整 SheetView（見各頁面 handlePatchDay／load 用法），不要假設這些端點會回整份表。
 */
export interface SheetDayPatchResult {
  date: string;
  overtimeMinutesComputed: number;
  overtimeMinutesOverride: number | null;
  overrideReason: string | null;
  otTier1: number;
  otTier2: number;
  otTier3: number;
  content: string | null;
  outingNote: string | null;
  projectId: string | null;
  note: string | null;
  anomalyAck: string | null;
  anomalies: SheetAnomaly[];
}

/** 把 PATCH day 的扁平回應合併回現有的 SheetDayView（保留 firstIn/workedMinutes 等本次不會變的欄位）。 */
export function mergeDayPatch(day: SheetDayView, raw: SheetDayPatchResult): SheetDayView {
  return {
    ...day,
    content: raw.content,
    outingNote: raw.outingNote,
    projectId: raw.projectId,
    note: raw.note,
    anomalyAck: raw.anomalyAck,
    anomalies: raw.anomalies,
    overtime: {
      ...day.overtime,
      computed: raw.overtimeMinutesComputed,
      override: raw.overtimeMinutesOverride,
      overrideReason: raw.overrideReason,
      effective: raw.overtimeMinutesOverride ?? raw.overtimeMinutesComputed,
      tier1: raw.otTier1,
      tier2: raw.otTier2,
      tier3: raw.otTier3,
      // PATCH day 不回 beyondCap（超額是「整個月的分配」，改一天要整月重算）：
      // 先留著舊值，呼叫端重新 GET 整張表時才會更新。
      beyondCap: day.overtime.beyondCap,
    },
  };
}

/** PATCH /attendance-sheets/:id/days/:date 的 body 形狀。 */
export interface SheetDayPatch {
  overtimeMinutesOverride?: number | null;
  overrideReason?: string;
  content?: string;
  outingNote?: string;
  projectId?: string;
  note?: string;
  anomalyAck?: string;
}

export const SHEET_STATUS_LABEL: Record<SheetStatus, string> = {
  draft: "草稿",
  submitted: "已送出",
  manager_reviewed: "經理已審",
  approved: "已核准",
  locked: "已鎖定",
  returned: "已退回",
};

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export function listAttendanceSheets(
  params: { period?: string; status?: string; deptId?: string; anomaly?: boolean } = {},
) {
  const qs = new URLSearchParams();
  if (params.period) qs.set("period", params.period);
  if (params.status) qs.set("status", params.status);
  if (params.deptId) qs.set("deptId", params.deptId);
  if (params.anomaly) qs.set("anomaly", "1");
  const suffix = qs.toString();
  return apiFetch<{ sheets: SheetListItem[] }>(`/attendance-sheets${suffix ? `?${suffix}` : ""}`);
}

export function getAttendanceSheet(id: string) {
  return apiFetch<{ sheet: SheetView }>(`/attendance-sheets/${id}`);
}

export function getMyAttendanceSheet(period: string) {
  return apiFetch<{ sheet: SheetView }>(`/my/attendance-sheet?period=${encodeURIComponent(period)}`);
}

export function generateAttendanceSheets(period: string) {
  return apiFetch<{ generated: number; rebuilt: number; skipped: { employeeId: string; status: SheetStatus }[] }>(
    "/attendance-sheets/generate",
    { method: "POST", body: JSON.stringify({ period }) },
  );
}

export function patchAttendanceSheetDay(sheetId: string, date: string, patch: SheetDayPatch) {
  return apiFetch<{ day: SheetDayPatchResult }>(`/attendance-sheets/${sheetId}/days/${date}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * 送出／審核／核准／退回／重開／重算這六個端點都只回 `{id, status, ...一兩個
 * 時間欄}`，不是完整 SheetView（已對過 apps/api/src/routes/attendance-sheets.ts
 * 實際回應確認）。呼叫端請在成功後重新 GET 該表（或 /my/attendance-sheet）
 * 換回完整 SheetView，不要直接拿這裡的回傳值當新的 sheet 狀態使用。
 */
export function submitAttendanceSheet(id: string) {
  return apiFetch<{ id: string; status: SheetStatus; managerEmpId: string | null }>(
    `/attendance-sheets/${id}/submit`,
    { method: "POST" },
  );
}

/** 給 ESS「待我審核」快速審：主管第一關 approve/return。 */
export function reviewAttendanceSheet(id: string, decision: "approve" | "return", comment?: string) {
  return apiFetch<{ id: string; status: SheetStatus }>(`/attendance-sheets/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ decision, comment }),
  });
}

/** HR 後台：manager_reviewed → approved。 */
export function approveAttendanceSheet(id: string) {
  return apiFetch<{ id: string; status: SheetStatus; approvedAt: string | null }>(
    `/attendance-sheets/${id}/approve`,
    { method: "POST" },
  );
}

export function returnAttendanceSheet(id: string, reason: string) {
  return apiFetch<{ id: string; status: SheetStatus; returnReason: string | null }>(
    `/attendance-sheets/${id}/return`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

export function reopenAttendanceSheet(id: string, reason: string) {
  return apiFetch<{ id: string; status: SheetStatus }>(`/attendance-sheets/${id}/reopen`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function recomputeAttendanceSheet(id: string) {
  return apiFetch<{ id: string; status: SheetStatus; computedAt: string | null }>(
    `/attendance-sheets/${id}/recompute`,
    { method: "POST" },
  );
}

export function exportAttendanceSheetXlsx(id: string, filename: string) {
  return apiDownload(`/attendance-sheets/${id}/export.xlsx`, filename);
}

export function exportAttendanceSheetsXlsx(period: string, filename: string) {
  return apiDownload(`/attendance-sheets/export.xlsx?period=${encodeURIComponent(period)}`, filename);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 錯誤碼對照表——涵蓋 apps/api/src/routes/attendance-sheets.ts 檔頭註解列出的全部 code。 */
const API_ERROR_MESSAGES: Record<string, string> = {
  override_reason_required: "覆寫加班時數時必須填寫原因",
  sheet_not_editable: "此月表目前狀態不可編輯（若是加班覆寫，核准後需先「重開」才能再改）",
  anomalies_unacknowledged: "尚有錯誤等級異常未填寫說明，請先逐項說明後再送出",
  not_found: "找不到這張出勤月表",
  day_not_found: "找不到這一天的資料，或已超出本期範圍",
  invalid_transition: "目前狀態不允許這個操作",
  locked: "此月表已鎖定，不可再變更",
  version_conflict: "資料已被其他人變更，請重新整理後再試",
  sheets_not_migrated: "此租戶尚未啟用出勤月表功能",
  forbidden: "沒有權限執行此操作",
  not_an_employee: "此帳號尚未對應到員工資料",
  unauthorized: "請重新登入",
  invalid_body: "送出的內容格式不正確",
  invalid_query: "查詢參數不正確",
  invalid_date: "日期格式不正確",
  invalid_period: "月份格式不正確，請用 YYYY-MM",
  overtime_settlements_not_migrated: "此租戶尚未啟用加班超額另計功能",
  settlement_paid: "這筆超額另計已標記付款，不可再修改",
};

/** 把 apiFetch 丟出的 Error（訊息格式 `[status] code或訊息`）轉成中文提示；辨識不出來就用原文。 */
export function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    const code = err.message.replace(/^\[\d+\]\s*/, "").trim();
    return API_ERROR_MESSAGES[code] ?? err.message;
  }
  return fallback;
}

/** 送出前的前端自我檢查：找出「錯誤等級且尚未填寫說明」的異常，逐日列出給 UI 顯示。 */
export function unacknowledgedErrors(sheet: SheetView): { date: string; anomaly: SheetAnomaly }[] {
  const out: { date: string; anomaly: SheetAnomaly }[] = [];
  for (const day of sheet.days) {
    if (day.anomalyAck && day.anomalyAck.trim()) continue;
    for (const anomaly of day.anomalies) {
      if (anomaly.severity === "error") out.push({ date: day.date, anomaly });
    }
  }
  return out;
}
