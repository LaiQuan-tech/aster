/**
 * 發薪鎖定（月結）client＋純函式（2026-10-11 業主拍板）：**每個月一個月結開關，HR 按「完成本月發薪」就鎖住該月**。
 *
 * 對應後端 apps/api/src/routes/payroll-periods.ts（形狀手抄自 services/payroll-period.ts；web 與 api 是各自的 build 邊界）：
 *   GET  /payroll-periods?months=12          最近 N 個月每個月的狀態；HR 或可解鎖的人才看得到（其他人 403）
 *   GET  /payroll-periods/:period/checklist  HR：四項檢查清單（出勤月表／假單核銷／報銷月結／薪資單定稿）
 *   POST /payroll-periods/:period/close      HR：四項全過才鎖（沒有強制略過）；409 checklist_incomplete 附整份清單
 *   POST /payroll-periods/:period/reopen     只有老闆與老闆指定的人（HR 也一樣）；body { reason } 至少 5 個字
 * 鎖住之後其他寫入端點回 409 period_closed 的友善訊息在 lib/period-closed.ts。
 * 「誰能重新開放」的名單存在 tenants.features.payroll.periodUnlockEmpIds，只有老闆（或 platform_admin）能改
 * （PUT /api/tenant/settings，否則 403 not_boss）；讀名單與判斷誰能改的純函式也放在這裡。
 *
 * 這支的純函式（狀態文字、按鈕顯示規則、理由驗證、檢查清單整理、名單 helper）全部有單元測試：
 * __tests__/payroll-periods.test.ts。
 */
import { apiErrorMessage, apiFetch, type ApiError } from "./api-client";
import { fmtDateTime } from "./ess-format";
import { describePeriodClosed } from "./period-closed";

/* ------------------------------------------------------------------ 型別 --- */

export type PeriodStatus = "open" | "closed" | "reopened";

/** GET /payroll-periods 的一個月份。 */
export interface PayrollPeriodRow {
  /** 'YYYY-MM' */
  period: string;
  /** open＝開放中（沒有月結紀錄）；closed＝已結算（鎖定）；reopened＝已重新開放（要再過一次檢查清單才能再鎖）。 */
  status: PeriodStatus;
  closedAt: string | null;
  closedByEmpId: string | null;
  closedByName: string | null;
  reopenedAt: string | null;
  reopenedByEmpId: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
  sheetCount: number;
  lockedCount: number;
}

export interface PayrollPeriodsResponse {
  /** 租戶當地的本月 'YYYY-MM'。 */
  currentPeriod: string;
  /** 呼叫者是 HR：可以「完成發薪並鎖定」。 */
  canClose: boolean;
  /** 呼叫者是老闆或老闆指定的人：可以重新開放。 */
  canReopen: boolean;
  /** 新的月份在前，含當月。 */
  periods: PayrollPeriodRow[];
}

export type ChecklistKey = "sheets" | "leave_settlement" | "expense_settlement" | "payslips";

export interface ChecklistPendingEntry {
  employeeId: string | null;
  employeeName: string;
  /** 該筆的 id（月表／假單／薪資單）；整批性質的（報銷）為 null。 */
  refId: string | null;
  /** 機器可讀的狀態：missing／draft／submitted／manager_reviewed／returned／unsettled…。 */
  status: string;
  /** 給人看的說明。 */
  detail: string;
}

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  /** 完成數。 */
  done: number;
  /** 應完成數。 */
  total: number;
  passed: boolean;
  /** 未完成清單（伺服器最多回 50 筆）。 */
  pending: ChecklistPendingEntry[];
  /** 未完成的真實筆數（≥ pending.length）。 */
  pendingCount: number;
}

export interface ChecklistWarning {
  code: "pending_requests";
  count: number;
  message: string;
}

export interface PeriodChecklist {
  period: string;
  /** 四項全過＝可以鎖。 */
  ready: boolean;
  items: ChecklistItem[];
  /** 只提醒、不擋鎖定（例如還有待簽核的申請單碰到這個月）。 */
  warnings: ChecklistWarning[];
}

export interface PeriodChecklistResponse {
  period: string;
  status: PeriodStatus;
  checklist: PeriodChecklist;
}

export interface PayrollCloseResult {
  period: string;
  status: "closed";
  closedAt: string;
  closedByEmpId: string | null;
  sheetCount: number;
  lockedCount: number;
  /** 這次新鎖的月表張數。 */
  lockedNow: number;
  snapshotManifestPath: string | null;
}

export interface PayrollReopenResult {
  period: string;
  status: "reopened";
  reopenedAt: string;
  reopenedByEmpId: string | null;
  reopenReason: string | null;
  /** 鎖定的出勤月表轉回已核准的張數。 */
  unlockedSheets: number;
  /** 已定稿的薪資單轉回草稿的張數。 */
  revertedPayslips: number;
  /** 通知了幾個人（老闆與 HR）。 */
  notified: number;
}

/**
 * 「完成發薪並鎖定」的結果：成功；或兩種預期中的 409（清單沒全過／已經鎖了），這兩種不丟例外，
 * 讓畫面直接用回傳的資料更新。其他錯誤（403、5xx、網路）照 apiFetch 慣例丟 Error。
 */
export type PayrollCloseOutcome =
  | { ok: true; result: PayrollCloseResult }
  | {
      ok: false;
      error: "checklist_incomplete";
      /** 409 body 附的整份清單；伺服器沒附或形狀不對時是 null（畫面改重抓清單）。 */
      checklist: PeriodChecklist | null;
    }
  | { ok: false; error: "already_closed" };

/* ------------------------------------------------------------------- API --- */

/** 後台列表顯示最近幾個月。 */
export const PERIOD_LIST_MONTHS = 12;

export function listPayrollPeriods(months: number = PERIOD_LIST_MONTHS) {
  return apiFetch<PayrollPeriodsResponse>(`/payroll-periods?months=${encodeURIComponent(String(months))}`);
}

export function getPeriodChecklist(period: string) {
  return apiFetch<PeriodChecklistResponse>(`/payroll-periods/${encodeURIComponent(period)}/checklist`);
}

/**
 * 完成該月發薪並鎖定。409 checklist_incomplete 的 body 帶整份清單、409 already_closed 都變成
 * {@link PayrollCloseOutcome}（apiFetch 的 Error 本來就有 `.body`，不用另外 fetch）；其餘錯誤照丟。
 */
export async function closePayrollPeriod(period: string): Promise<PayrollCloseOutcome> {
  try {
    const result = await apiFetch<PayrollCloseResult>(`/payroll-periods/${encodeURIComponent(period)}/close`, {
      method: "POST",
    });
    return { ok: true, result };
  } catch (err) {
    const outcome = closeOutcomeOf(err);
    if (outcome) return outcome;
    throw err;
  }
}

/** 重新開放（只有老闆與老闆指定的人）。理由送出前去頭尾空白；至少 5 個字由 {@link reopenReasonError} 在畫面先擋。 */
export function reopenPayrollPeriod(period: string, reason: string) {
  return apiFetch<PayrollReopenResult>(`/payroll-periods/${encodeURIComponent(period)}/reopen`, {
    method: "POST",
    body: JSON.stringify({ reason: reason.trim() }),
  });
}

/* ----------------------------------------------------- 錯誤碼／409 的處理 --- */

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** apiFetch 的錯誤碼（`.code`，沒有就從 `[status] code` 的 message 取）；不是 Error → null。 */
function codeOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  const match = /^\[\d{3}\]\s*([a-z][a-z0-9_]*)\s*$/i.exec(err.message.trim());
  return match?.[1] ?? null;
}

/** 是不是形狀對得上的檢查清單（只看畫面會用到的骨架：ready 與 items 陣列）。 */
function isChecklist(value: unknown): value is PeriodChecklist {
  const v = recordOf(value);
  return !!v && typeof v.ready === "boolean" && Array.isArray(v.items) && v.items.every((item) => !!recordOf(item));
}

/**
 * apiFetch 丟出的錯誤若是 close 端點預期中的 409 → 對應的 {@link PayrollCloseOutcome}；不是 → null（呼叫端照丟）。
 * 分開成純函式，單元測試不必打 fetch。
 */
export function closeOutcomeOf(err: unknown): Extract<PayrollCloseOutcome, { ok: false }> | null {
  if (!(err instanceof Error) || (err as ApiError).status !== 409) return null;
  const body = recordOf((err as ApiError).body);
  const code = codeOf(err) ?? (typeof body?.error === "string" ? body.error : null);
  if (code === "checklist_incomplete") {
    const checklist = body?.checklist;
    return { ok: false, error: "checklist_incomplete", checklist: isChecklist(checklist) ? checklist : null };
  }
  if (code === "already_closed") return { ok: false, error: "already_closed" };
  return null;
}

const UNLOCK_FORBIDDEN_FALLBACK = "只有老闆、老闆指定的人或平台管理員可以重新開放已結算的月份";

const PERIOD_ERROR_TEXT: Record<string, string> = {
  checklist_incomplete: "檢查清單還沒全部通過，請先處理未完成的項目",
  already_closed: "這個月份已經完成發薪並鎖定",
  already_reopened: "這個月份已經是重新開放的狀態",
  period_not_closed: "這個月份目前不是已結算狀態，請重新整理確認",
  invalid_period: "月份格式不正確，請用 YYYY-MM",
  invalid_body: "送出的內容格式不正確",
  forbidden: "沒有權限執行此操作",
  not_an_employee: "這個帳號尚未對應到員工資料",
  unauthorized: "登入已逾期，請重新登入",
  // 503：資料庫還沒套用月結的遷移（period_closes 表不存在）。
  period_closes_not_migrated: "這個環境還沒啟用月結功能（資料庫尚未套用遷移），請聯絡系統管理員",
};

/**
 * 月結端點的錯誤 → 友善中文：已結算（period_closed）、403 unlock_forbidden（顯示後端的 message）、
 * 理由太短／太長、已鎖／已重新開放…；對不上的照 apiErrorMessage（伺服器 message 優先，再來 Error.message）。
 */
export function payrollPeriodErrorMessage(err: unknown, fallback = "操作失敗"): string {
  const closed = describePeriodClosed(err);
  if (closed) return closed;
  const code = codeOf(err);
  if (code === "unlock_forbidden") {
    const server = (err as ApiError).serverMessage?.trim();
    return server || UNLOCK_FORBIDDEN_FALLBACK;
  }
  if (code === "reason_too_short") return `重新開放的理由至少 ${REOPEN_REASON_MIN} 個字`;
  if (code === "reason_too_long") return `重新開放的理由最多 ${REOPEN_REASON_MAX} 字`;
  const text = code ? PERIOD_ERROR_TEXT[code] : undefined;
  return text ?? apiErrorMessage(err, fallback);
}

/** 錯誤是不是 403（月結列表只有 HR 與可解鎖的人能看，其他人讀不到）。 */
export function isForbiddenError(err: unknown): boolean {
  return err instanceof Error && (err as ApiError).status === 403;
}

/* ------------------------------------------------------------- 狀態顯示 --- */

/** 狀態名稱：開放中／已結算／已重新開放。 */
export function periodStatusLabel(status: PeriodStatus | string): string {
  switch (status) {
    case "open":
      return "開放中";
    case "closed":
      return "已結算";
    case "reopened":
      return "已重新開放";
    default:
      return String(status);
  }
}

/** 狀態的誰／何時（／理由）；沒有就空字串。GET /attendance-sheets/period-closes 的紀錄也吃得進來（結構型別）。 */
export interface PeriodStatusFields {
  status: PeriodStatus | string;
  closedAt?: string | null;
  closedByName?: string | null;
  reopenedAt?: string | null;
  reopenedByName?: string | null;
  reopenReason?: string | null;
}

function whenText(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "";
  const text = fmtDateTime(iso, tz);
  return text === "—" ? "" : text;
}

function joinParts(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("，");
}

/**
 * 狀態括號裡的內容：已結算「王小明，10/12 14:30」；已重新開放「王小明，10/13 09:10，理由：補登漏掉的獎金」；
 * 開放中沒有。缺的欄位（沒有姓名、沒有時間）直接略過，不留空逗號。`tz` 預設瀏覽器時區（測試用）。
 */
export function periodStatusDetail(row: PeriodStatusFields, tz?: string): string {
  if (row.status === "closed") return joinParts([row.closedByName, whenText(row.closedAt, tz)]);
  if (row.status === "reopened") {
    const reason = row.reopenReason?.trim();
    return joinParts([row.reopenedByName, whenText(row.reopenedAt, tz), reason ? `理由：${reason}` : ""]);
  }
  return "";
}

/**
 * 一列月份的狀態文字：「開放中」「已結算（王小明，10/12 14:30）」
 * 「已重新開放（王小明，10/13 09:10，理由：補登漏掉的獎金）」。
 */
export function periodStatusText(row: PeriodStatusFields, tz?: string): string {
  const label = periodStatusLabel(row.status);
  const detail = periodStatusDetail(row, tz);
  return detail ? `${label}（${detail}）` : label;
}

/* ------------------------------------------------------------ 按鈕規則 --- */

/** 重新開放鈕顯示不出來時（已結算、但呼叫者沒有解鎖權限）改顯示的說明。 */
export const REOPEN_FORBIDDEN_HINT = "只有老闆、老闆指定的人或平台管理員可以重新開放";

export interface PeriodActions {
  /** 顯示「完成 YYYY-MM 發薪並鎖定」：HR，且該月開放中或已重新開放。 */
  showClose: boolean;
  /** 顯示「重新開放」：老闆或老闆指定的人，且該月已結算。 */
  showReopen: boolean;
  /** 已結算、但呼叫者不能重新開放（例如 HR 不在名單上）→ 顯示這句說明；其他情況 null。 */
  reopenForbiddenHint: string | null;
}

/** 一個月份該顯示哪些按鈕。 */
export function periodActionsOf(
  status: PeriodStatus,
  perms: { canClose: boolean; canReopen: boolean },
): PeriodActions {
  const closed = status === "closed";
  return {
    showClose: perms.canClose && (status === "open" || status === "reopened"),
    showReopen: perms.canReopen && closed,
    reopenForbiddenHint: closed && !perms.canReopen ? REOPEN_FORBIDDEN_HINT : null,
  };
}

/** 鎖定鈕文字（固定）：「完成 2026-10 發薪並鎖定」。 */
export function closeButtonLabel(period: string): string {
  return `完成 ${period} 發薪並鎖定`;
}

/** 鎖定成功的提示：「2026-10 已完成發薪並鎖定」。 */
export function closeSuccessMessage(period: string): string {
  return `${period} 已完成發薪並鎖定`;
}

/** 重新開放成功的提示（含連動回復的張數）。 */
export function reopenSuccessMessage(result: Pick<PayrollReopenResult, "period" | "unlockedSheets" | "revertedPayslips">): string {
  return (
    `${result.period} 已重新開放：${result.unlockedSheets} 張出勤月表回到已核准、` +
    `${result.revertedPayslips} 張薪資單回到草稿；要再鎖定須重新通過檢查清單`
  );
}

/* ------------------------------------------------------ 重新開放的理由 --- */

/** 重新開放的理由至少幾個字（trim 後），與後端 REOPEN_REASON_MIN 一致。 */
export const REOPEN_REASON_MIN = 5;
/** 上限，與後端 REOPEN_REASON_MAX 一致。 */
export const REOPEN_REASON_MAX = 500;

/** 理由不合格的原因（附目前字數）；合格 → null。 */
export function reopenReasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REOPEN_REASON_MIN) return `重新開放的理由至少 ${REOPEN_REASON_MIN} 個字（目前 ${length} 字）`;
  if (length > REOPEN_REASON_MAX) return `重新開放的理由最多 ${REOPEN_REASON_MAX} 字（目前 ${length} 字）`;
  return null;
}

export function isValidReopenReason(reason: string): boolean {
  return reopenReasonError(reason) === null;
}

/**
 * 薪資已經匯款的月份不建議重新開放；改在下個月薪資做「前期更正」補發或扣回。
 * 重新開放對話框**一定**要顯示這句（醒目提示框）。
 */
export const PRIOR_PERIOD_CORRECTION_HINT =
  "如果這個月薪資已經匯款，建議不要重新開放，改在下個月薪資用「前期更正」補發或扣回";

/**
 * 「前期更正」的入口連結：薪資作業頁的「薪資加減項（前期更正）」卡（`id="payroll-adjustments"`，
 * app/admin/payroll/_components/PayrollAdjustmentsCard.tsx）——可對每位員工在某月加一行有說明的補發或扣回，
 * 薪資執行時併進該月薪資單並標「更正 YYYY-MM」（lib/payroll-adjustments-api.ts）。
 * 有值時重新開放對話框會在提示後面附連結（點了先關掉對話框再捲到那張卡）；null 就不顯示。
 */
export const PRIOR_PERIOD_CORRECTION_HREF: string | null = "/admin/payroll#payroll-adjustments";

/** 重新開放對話框的後果說明。 */
export const REOPEN_EFFECT_NOTE =
  "重新開放後：該月已鎖定的出勤月表會回到已核准、已定稿的薪資單會回到草稿，重新試算定稿後要再過一次檢查清單才能再鎖定";

/* ------------------------------------------------------------ 檢查清單 --- */

/** 每一項最多列出幾筆未完成（其餘寫「還有 N 筆」）。 */
export const CHECKLIST_PENDING_SHOW = 10;

/** 每項不通過時，HR 到哪裡去處理（都是後台既有頁面）。 */
export const CHECKLIST_FIX_HREF: Record<ChecklistKey, string> = {
  sheets: "/admin/attendance-sheets",
  leave_settlement: "/admin/leave-settlement",
  expense_settlement: "/admin/expenses",
  payslips: "/admin/payslips",
};

const CHECKLIST_LABEL: Record<ChecklistKey, string> = {
  sheets: "出勤月表已核准或鎖定",
  leave_settlement: "已核准假單已核銷",
  expense_settlement: "報銷已月結",
  payslips: "薪資單已定稿",
};

export interface ChecklistItemView {
  key: ChecklistKey;
  label: string;
  done: number;
  total: number;
  /** 「完成數/應完成數」，例如 "3/5"。 */
  progress: string;
  passed: boolean;
  /** 最多 {@link CHECKLIST_PENDING_SHOW} 筆未完成明細。 */
  shown: ChecklistPendingEntry[];
  /** 沒列出來的筆數（以伺服器的真實總數 pendingCount 算，不是 pending 陣列長度）。 */
  moreCount: number;
  /** 「還有 N 筆」；沒有被折起來的就是 null。 */
  moreLabel: string | null;
  /** 沒通過時去哪裡處理；通過了是 null。 */
  fixHref: string | null;
}

/** 未完成明細的一行字：「王小明：月表還是草稿（員工尚未送出）」；沒有姓名就只有說明。 */
export function pendingEntryText(entry: Pick<ChecklistPendingEntry, "employeeName" | "detail">): string {
  const name = (entry.employeeName ?? "").trim();
  const detail = (entry.detail ?? "").trim();
  if (name && detail) return `${name}：${detail}`;
  return name || detail;
}

/** 檢查清單 → 畫面每一列（進度、通過與否、最多 10 筆未完成、「還有 N 筆」、處理連結）。 */
export function checklistViews(checklist: Pick<PeriodChecklist, "items">): ChecklistItemView[] {
  return checklist.items.map((item) => {
    const pending = Array.isArray(item.pending) ? item.pending : [];
    const shown = pending.slice(0, CHECKLIST_PENDING_SHOW);
    const total = typeof item.pendingCount === "number" ? item.pendingCount : pending.length;
    const moreCount = Math.max(0, total - shown.length);
    return {
      key: item.key,
      label: item.label || CHECKLIST_LABEL[item.key] || String(item.key),
      done: item.done,
      total: item.total,
      progress: `${item.done}/${item.total}`,
      passed: item.passed === true,
      shown,
      moreCount,
      moreLabel: moreCount > 0 ? `還有 ${moreCount} 筆` : null,
      fixHref: item.passed === true ? null : (CHECKLIST_FIX_HREF[item.key] ?? null),
    };
  });
}

/** 清單全部通過：伺服器說 ready，而且沒有任何一項沒過（兩邊都要，寧可多擋）。 */
export function isChecklistReady(checklist: PeriodChecklist | null | undefined): boolean {
  return !!checklist && checklist.ready === true && checklist.items.length > 0 && checklist.items.every((item) => item.passed === true);
}

/** 清單上方的一句話：「4 項檢查全部通過，可以鎖定」「還有 2 項未通過，處理完才能鎖定」。 */
export function checklistSummary(checklist: PeriodChecklist): string {
  if (isChecklistReady(checklist)) return `${checklist.items.length} 項檢查全部通過，可以鎖定`;
  const failing = checklist.items.filter((item) => item.passed !== true).length;
  return `還有 ${failing} 項未通過，處理完才能鎖定`;
}

/**
 * 對話框的「確認鎖定」鈕能不能按：**清單全過（ready=true）才啟用**；載入中、送出中、該月其實已經鎖了都不行。
 * 沒有任何強制略過。
 */
export function canConfirmClose(state: {
  checklist: PeriodChecklist | null | undefined;
  loading: boolean;
  submitting: boolean;
  /** 清單回應附的月份狀態；已經是 closed 就不能再鎖。 */
  periodStatus?: PeriodStatus | null;
}): boolean {
  if (state.loading || state.submitting) return false;
  if (state.periodStatus === "closed") return false;
  return isChecklistReady(state.checklist);
}

/* ------------------------------------------- 「誰能重新開放」名單（設定頁）--- */

/** 員工 id 一律轉小寫比對（UUID 不分大小寫；後端也存小寫）。 */
function lower(id: string): string {
  return id.toLowerCase();
}

/**
 * 從 tenants.features（GET /api/tenant/branding 的 features）取「老闆指定可重新開放的人」：
 * features.payroll.periodUnlockEmpIds。沒設定／格式不對＝空陣列；只收非空字串、轉小寫、去重（後端也是存小寫）。
 */
export function periodUnlockEmpIdsOf(features: Record<string, unknown> | null | undefined): string[] {
  const payroll = recordOf(features?.payroll);
  const raw = payroll?.periodUnlockEmpIds;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !value.trim()) continue;
    const id = lower(value.trim());
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 老闆＝features.approval.fallbackApproverEmpId（找不到主管時的最後簽核人）；沒設定＝null。 */
export function approvalBossEmpIdOf(features: Record<string, unknown> | null | undefined): string | null {
  const approval = recordOf(features?.approval);
  const id = approval?.fallbackApproverEmpId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * 登入者是不是老闆：員工 id 等於 features.approval.fallbackApproverEmpId（不分大小寫）。
 * 租戶沒設定老闆、features 拿不到、或登入者 id 還沒取得，一律 false（呼叫端「拿不到就照舊」）。
 * ESS 殼用它決定老闆要不要永遠看得到「簽核」分頁（遲到說明要老闆決定，見 lib/ess-tabs.ts bottomTabs）。
 */
export function isApprovalBoss(features: Record<string, unknown> | null | undefined, meId: string | null | undefined): boolean {
  const boss = approvalBossEmpIdOf(features);
  return !!boss && !!meId && lower(boss) === lower(meId);
}

/**
 * 登入者算不算老闆：老闆本人或 platform_admin（2026-10-27 業主：「以後平台管理員就是老闆」；不需要老闆已設定）。
 * 與後端 apps/api/src/lib/boss.ts isBossOrPlatformAdmin 同一判準。後端另外擋；前端用它決定 ESS 殼要不要永遠顯示
 * 「簽核」分頁、要不要抓待決定的遲到說明紅點、能不能改解鎖名單。
 */
export function isBossOrPlatformAdmin(
  features: Record<string, unknown> | null | undefined,
  me: { id?: string | null; role?: string | null } | null | undefined,
): boolean {
  if (!me?.id) return false;
  if (me.role === "platform_admin") return true;
  return isApprovalBoss(features, me.id);
}

/**
 * 目前登入者能不能改「誰能重新開放」名單：**只有老闆**（員工 id 等於 fallbackApproverEmpId）或 platform_admin。
 * 與後端 canEditUnlockList 同一個判準（後端另外擋，這裡只決定畫面要不要讓人勾）。
 */
export function canEditUnlockList(
  me: { id: string; role: string } | null | undefined,
  bossEmpId: string | null | undefined,
): boolean {
  if (!me) return false;
  if (me.role === "platform_admin") return true;
  return !!bossEmpId && lower(bossEmpId) === lower(me.id);
}

/** 勾選／取消勾選一位（回新陣列，不改原陣列；小寫、去重）。 */
export function toggleUnlockEmpId(list: readonly string[], empId: string, enabled: boolean): string[] {
  const id = lower(empId);
  const rest = list.map(lower).filter((value) => value !== id);
  const unique = rest.filter((value, index) => rest.indexOf(value) === index);
  return enabled ? [...unique, id] : unique;
}

/** 設定頁清單吃的員工欄位（admin-api 的 Employee 符合）。 */
export interface UnlockEmployeeLike {
  id: string;
  name: string;
  emp_no: string | null;
  status: string;
}

export interface UnlockCandidate {
  id: string;
  name: string;
  empNo: string | null;
  /** 在職中。 */
  active: boolean;
  /** 老闆本人（永遠可以重新開放，不必勾）。 */
  isBoss: boolean;
  /** 在老闆指定的名單裡。 */
  checked: boolean;
}

/**
 * 設定頁的勾選清單：所有在職員工＋「已被指定、但已不在職」的人（讓老闆看得到、取消得掉，
 * 否則離職同仁會永遠留在名單裡）。老闆排最前面，其餘依姓名排序。
 */
export function unlockCandidates(
  employees: readonly UnlockEmployeeLike[],
  designatedIds: readonly string[],
  bossEmpId: string | null | undefined,
): UnlockCandidate[] {
  const designated = new Set(designatedIds.map(lower));
  const boss = bossEmpId ? lower(bossEmpId) : null;
  return employees
    .filter((e) => e.status === "active" || designated.has(lower(e.id)) || lower(e.id) === boss)
    .map((e) => ({
      id: e.id,
      name: e.name,
      empNo: e.emp_no,
      active: e.status === "active",
      isBoss: lower(e.id) === boss,
      checked: designated.has(lower(e.id)),
    }))
    .sort((a, b) => Number(b.isBoss) - Number(a.isBoss) || a.name.localeCompare(b.name, "zh-Hant"));
}

/** 依姓名或工號搜尋（不分大小寫）；沒有關鍵字就是全部。 */
export function filterUnlockCandidates(list: readonly UnlockCandidate[], keyword: string): UnlockCandidate[] {
  const term = keyword.trim().toLowerCase();
  if (!term) return [...list];
  return list.filter((c) => [c.name, c.empNo].some((value) => (value ?? "").toLowerCase().includes(term)));
}

/** 名單人數上限（後端 periodUnlockEmpIds 的 zod `.max(50)`；超過會是 400 invalid_body）。 */
export const UNLOCK_LIST_MAX = 50;

/** 設定頁唯讀時、以及後端回 403 not_boss 時都顯示這句。 */
export const UNLOCK_LIST_BOSS_ONLY_NOTE = "只有老闆可以指定誰能重新開放已結算的月份";

/** 儲存名單失敗的訊息：403 not_boss → 只有老闆可以指定；400 invalid_employee；其餘照原文。 */
export function unlockListSaveErrorMessage(err: unknown, fallback = "儲存失敗"): string {
  const code = codeOf(err);
  if (code === "not_boss") return UNLOCK_LIST_BOSS_ONLY_NOTE;
  if (code === "invalid_employee") return "名單裡有不屬於本公司的員工，請重新整理頁面後再試";
  if (code === "forbidden") return "目前的帳號沒有儲存設定的權限（需要 HR）";
  return apiErrorMessage(err, fallback);
}
