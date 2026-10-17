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
import { todayKey } from "./ess-format";
import { describePeriodClosed } from "./period-closed";

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
  /**
   * B8：本月有已核准但人資尚未核銷的假單（月份級；預設 warn，租戶開了
   * blockApproveOnUnsettledLeave 時是 error）。後端以 `as` 轉型送出，共用合約檔沒列，這裡補上。
   */
  | "unsettled_leave_in_period"
  | "no_salary_structure"
  /** 2026-10-11：本月有遲到說明老闆還沒決定（視為影響全勤）。 */
  | "late_reports_undecided"
  /** 2026-10-17 一例一休合規（日級）：連續出勤超過 6 天（跨月也算；error）。 */
  | "seven_day_rule"
  /** 例假出勤（勞基法第 40 條，加發一日工資＋補假；error）。 */
  | "regular_leave_work"
  /** 特休日出勤（HR 處理該特休假單；warn）。 */
  | "pto_work"
  /** 單日正常＋延長工時超過 12 小時（error）。 */
  | "daily_over_12h"
  /** 月延長工時累計跨過 46 小時的那天（error）。 */
  | "monthly_ot_over_46h";

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
  dayType: "workday" | "rest_day" | "regular_leave" | "fixed_holiday";
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
  /**
   * 2026-10-17 晚餐勾選：`taken`＝當日最終值（月表手動優先，否則下班卡勾選；null＝未填＝不扣）、
   * `source`＝manual｜punch｜null、`optIn`＝公司規則「有用晚餐才扣」（false 時不顯示切換）。舊快照／舊 API 沒有。
   */
  dinner?: { taken: boolean | null; source: "manual" | "punch" | null; optIn: boolean };
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
  /** Missing in pre-parity approval snapshots; do not infer from gross. */
  base?: number;
  hourlyWage: number;
  otPay: number;
  otPayByTier: { tier1: number; tier2: number; tier3: number };
  nightPay?: number;
  attendanceBonus?: number;
  allowances?: number;
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
  /** 到職日 'YYYY-MM-DD'（員工主檔）；舊的核准快照沒有這欄 → 讀取端當作不知道。 */
  hireDate?: string | null;
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
  /** 2026-10-17 晚餐：true／false＝手動設定、null＝清掉回到下班卡勾選。改完伺服器重算當天加班，呼叫端要重新 GET 整張表。 */
  dinnerTaken?: boolean | null;
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
  params: {
    period?: string;
    status?: string;
    deptId?: string;
    anomaly?: boolean;
    /**
     * "mine"：不論角色（含 HR／會計）都只列本人＋所管部門員工的月表、忽略 deptId——
     * ESS「待我審核」用；後台不帶（財務角色看全租戶）。
     */
    scope?: "mine";
  } = {},
) {
  const qs = new URLSearchParams();
  if (params.period) qs.set("period", params.period);
  if (params.status) qs.set("status", params.status);
  if (params.deptId) qs.set("deptId", params.deptId);
  if (params.anomaly) qs.set("anomaly", "1");
  if (params.scope) qs.set("scope", params.scope);
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
  // warnings：超過月加班上限另計的提示（例：缺薪資資料，金額未計）；舊 API 不回 → undefined。
  return apiFetch<{ id: string; status: SheetStatus; approvedAt: string | null; warnings?: string[] }>(
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

/**
 * 把 apiFetch 丟出的 Error（訊息格式 `[status] code或訊息`）轉成中文提示；辨識不出來就用原文。
 * 該月已發薪鎖定（409 period_closed）→「YYYY-MM 已結算，請洽管理者」（lib/period-closed.ts）；
 * 出勤月表的產生／重算／逐日修改／送出／審核／核准／退回／重開都會碰到，這個函式是它們共用的出口。
 */
export function friendlyError(err: unknown, fallback: string): string {
  const closed = describePeriodClosed(err);
  if (closed) return closed;
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

/**
 * 出勤月表的「日」一律以台北時間為準（API 用租戶時區、預設 Asia/Taipei；前端拿不到租戶設定，固定台北）。
 */
export const SHEET_TIME_ZONE = "Asia/Taipei";

/**
 * 「這個月」的月表期別 'YYYY-MM'（台北時間；`now` 可注入以利測試）。
 * 不要用 `new Date().toISOString().slice(0, 7)`：那是 UTC，每月 1 日台北 00:00–07:59 會算成上個月。
 * 頁面要在元件裡算（useState 初始化函式），不要放模組層——模組層只在載入時算一次，SSR 時用的還是伺服器時間。
 */
export function currentSheetPeriod(now: Date | number | string = new Date()): string {
  return todayKey(SHEET_TIME_ZONE, now).slice(0, 7);
}

// ---------------------------------------------------------------------------
// 月份級異常（2026-10-12）：月加班門檻、連續遲到、假單待簽核／未核銷、遲到說明未決定、未設定薪資結構。
// 不屬於任何一天，表格的「異常」欄放不下；畫面元件是 components/AttendanceSheetTable 的 SheetMonthAnomalies。
// ---------------------------------------------------------------------------

/** 誰在看：員工端（本人月表、主管審核頁）或後台。 */
export type MonthAnomalyAudience = "ess" | "admin";

/** 只有 HR 能處理、員工端不顯示的月份級異常。 */
const HR_ONLY_MONTH_ANOMALIES: ReadonlySet<string> = new Set<AnomalyCode>(["no_salary_structure"]);

/**
 * message 空白時的中文說明（API 一律會帶中文 message，這是舊快照或欄位缺漏時的保險）。
 * 對照 apps/api/src/services/attendance-sheets.ts 產生月份級異常的那一段。
 */
export const MONTH_ANOMALY_FALLBACK_TEXT: Partial<Record<AnomalyCode, string>> = {
  monthly_ot_threshold: "本月加班累計已達門檻",
  consecutive_late: "本月有連續遲到",
  pending_leave_in_period: "本月仍有假單待簽核，核准後請假時數才會計入",
  unsettled_leave_in_period: "本月有假單已核准但人資尚未核銷",
  late_reports_undecided: "本月有遲到說明老闆尚未決定（視為影響全勤）",
  no_salary_structure: "尚未設定薪資結構，無法試算金額",
};

/** 代碼也不認得時的通用說法。 */
export const MONTH_ANOMALY_GENERIC_TEXT = "本月出勤有一項需要留意的狀況";

const SEVERITY_ORDER: Record<AnomalySeverity, number> = { error: 0, warn: 1, info: 2 };

export interface MonthAnomalyItem {
  code: string;
  severity: AnomalySeverity;
  text: string;
}

/** 一筆月份級異常要顯示的文字：API 的 message；空白時用代碼對照的中文；代碼也不認得就用通用說法。 */
export function monthAnomalyText(anomaly: { code?: unknown; message?: unknown }): string {
  if (typeof anomaly.message === "string" && anomaly.message.trim()) return anomaly.message.trim();
  // hasOwnProperty：避免 constructor／toString 這類代碼撈到 Object.prototype 上的東西。
  const code = typeof anomaly.code === "string" ? anomaly.code : "";
  const byCode = Object.prototype.hasOwnProperty.call(MONTH_ANOMALY_FALLBACK_TEXT, code)
    ? MONTH_ANOMALY_FALLBACK_TEXT[code as AnomalyCode]
    : undefined;
  return byCode ?? MONTH_ANOMALY_GENERIC_TEXT;
}

/**
 * 要顯示的月份級異常：員工端（`"ess"`）拿掉只有 HR 能處理的項目（未設定薪資結構）；嚴重度不認得的當 info；
 * 依嚴重度排序（error → warn → info；同級維持 API 原順序，Array#sort 是穩定排序）。
 * 不是陣列、缺代碼又缺訊息的資料一律略過，不丟例外。
 */
export function visibleMonthAnomalies(
  list: readonly SheetAnomaly[] | null | undefined,
  audience: MonthAnomalyAudience,
): MonthAnomalyItem[] {
  if (!Array.isArray(list)) return [];
  const items: MonthAnomalyItem[] = [];
  for (const raw of list as readonly unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const anomaly = raw as { code?: unknown; severity?: unknown; message?: unknown };
    const code = typeof anomaly.code === "string" ? anomaly.code : "";
    const hasMessage = typeof anomaly.message === "string" && anomaly.message.trim() !== "";
    if (!code && !hasMessage) continue;
    if (audience === "ess" && HR_ONLY_MONTH_ANOMALIES.has(code)) continue;
    const severity: AnomalySeverity = anomaly.severity === "error" || anomaly.severity === "warn" ? anomaly.severity : "info";
    items.push({ code, severity, text: monthAnomalyText(anomaly) });
  }
  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
