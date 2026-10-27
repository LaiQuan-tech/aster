/**
 * 遲到說明（late_reports，2026-10-11）client＋型別。後台「出勤 → 遲到說明」與員工端簽核頁共用。
 *
 *   GET  /late-reports?period=&employeeId=&decision=   老闆／HR 看全公司、主管看部屬、每人看自己
 *   POST /late-reports/:id/decision { decision, note? } 只有老闆（其他人 403 not_boss）
 *
 * 形狀手抄自 apps/api/src/services/late-reports.ts 的 LateReportView。
 */
import { apiFetch } from "./api-client";
import { describePeriodClosed } from "./period-closed";

export type LateDecision = "affects" | "exempt" | null;
export type LateDecisionFilter = "undecided" | "affects" | "exempt" | "all";
/** 不能再決定的原因（2026-10-12）：period_closed＝那個月已結算；sheet_frozen＝該員那個月的出勤月表已核准／鎖定。 */
export type LateLockedReason = "period_closed" | "sheet_frozen";

export interface LateReport {
  id: string;
  employeeId: string;
  employeeName: string;
  /** 'YYYY-MM-DD'（租戶時區的上班日）。 */
  workDate: string;
  /** 上班卡時間（ISO）。 */
  punchAt: string;
  lateMinutes: number;
  reason: string;
  /** affects＝影響全勤、exempt＝不影響、null＝老闆尚未決定（視為影響）。 */
  decision: LateDecision;
  decidedByEmpId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /**
   * 不能再決定的原因；null／缺席＝還能決定。只有 GET /late-reports 的列表會帶
   * （決定的回應、舊版 API 沒有這個欄位）。
   */
  lockedReason?: LateLockedReason | null;
  /** 這筆是呼叫者自己的遲到說明（2026-10-27）：自己的不能自己決定，畫面不給按鈕。只有列表帶。 */
  own?: boolean;
}

/** 自己的遲到說明取代按鈕的灰字。 */
export const OWN_LATE_REPORT_NOTE = "這是你自己的遲到說明，請由其他平台管理員（老闆）決定。";

export interface LateReportList {
  lateReports: LateReport[];
  /** 呼叫者是不是老闆（只有老闆能按決定）。 */
  canDecide: boolean;
  scope: "all" | "team";
}

export function getLateReports(params: { period?: string; employeeId?: string; decision?: LateDecisionFilter } = {}) {
  const qs = new URLSearchParams();
  if (params.period) qs.set("period", params.period);
  if (params.employeeId) qs.set("employeeId", params.employeeId);
  if (params.decision) qs.set("decision", params.decision);
  const query = qs.toString();
  return apiFetch<LateReportList>(`/late-reports${query ? `?${query}` : ""}`);
}

export function decideLateReport(id: string, decision: "affects" | "exempt", note?: string) {
  return apiFetch<{ lateReport: LateReport }>(`/late-reports/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(note && note.trim() ? { note: note.trim() } : {}) }),
  });
}

/** 那個月的出勤月表已核准／鎖定（409 sheet_frozen）時固定顯示的說法（2026-10-12 教育訓練驗收）。 */
export const LATE_SHEET_FROZEN_MESSAGE = "本月出勤表已核准或鎖定，不能再改，請洽 HR";

/**
 * API 沒附中文 message 時的中文說法（對照 apps/api/src/routes/late-reports.ts 與共用的 auth 中介層）。
 * not_boss 平常有附中文 message，這裡是只剩 `[403] not_boss` 時的保險。
 */
const LATE_DECISION_ERROR_TEXT: Record<string, string> = {
  not_boss: "只有老闆可以決定遲到是否影響全勤",
  own_late_report: "不能決定自己的遲到說明，請由其他平台管理員（老闆）決定",
  not_found: "找不到這筆遲到說明，請重新整理後再試",
  invalid_body: "送出的內容格式不正確",
  not_an_employee: "此帳號尚未對應到員工資料",
  unauthorized: "登入已過期，請重新登入",
  invalid_token: "登入已過期，請重新登入",
};

/** 含中日韓文字＝是給人看的中文說明（排除 statusText 這類英文）。 */
const CJK_RE = /[\u3400-\u9fff]/;

/** apiFetch 的訊息格式 `[409] sheet_frozen`（也相容沒有狀態前綴的純代碼）。 */
const CODE_MESSAGE_RE = /^(?:\[\d{3}\]\s*)?([a-z][a-z0-9_]*)$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 錯誤碼：apiFetch 掛上的 `.code`、整包回應的 `.body.error`，或從 `[409] sheet_frozen` 這種訊息取出。 */
function errorCodeOf(err: unknown): string | null {
  const top = record(err);
  if (typeof top?.code === "string" && top.code) return top.code;
  const bodyError = record(top?.body)?.error;
  if (typeof bodyError === "string" && bodyError) return bodyError;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return CODE_MESSAGE_RE.exec(message.trim())?.[1] ?? null;
}

/** API 附的中文說明（apiFetch 掛的 `.serverMessage`，或整包回應的 `.body.message`）；不是中文就不用。 */
function chineseServerMessageOf(err: unknown): string | null {
  const top = record(err);
  for (const candidate of [top?.serverMessage, record(top?.body)?.message]) {
    if (typeof candidate === "string" && CJK_RE.test(candidate)) return candidate.trim();
  }
  return null;
}

/**
 * 決定遲到說明失敗的訊息（toast 用），一律是中文、不露 `[409] sheet_frozen` 這種原碼：
 *   • 409 period_closed（那天所在月份已發薪鎖定）→「YYYY-MM 已結算，請洽管理者」（lib/period-closed.ts）；
 *   • 409 sheet_frozen（那個月的出勤月表已核准或鎖定）→ 固定「本月出勤表已核准或鎖定，不能再改，請洽 HR」；
 *   • 其他碼優先用 API 附的中文 message（例如 403 not_boss），沒有就用代碼對照的中文，再沒有就用 fallback。
 */
export function lateDecisionErrorMessage(err: unknown, fallback = "決定失敗"): string {
  const closed = describePeriodClosed(err);
  if (closed) return closed;
  const code = errorCodeOf(err);
  if (code === "sheet_frozen") return LATE_SHEET_FROZEN_MESSAGE;
  // hasOwnProperty：避免 constructor／toString 這類代碼撈到 Object.prototype 上的東西。
  const mapped = code && Object.prototype.hasOwnProperty.call(LATE_DECISION_ERROR_TEXT, code) ? LATE_DECISION_ERROR_TEXT[code] : null;
  return chineseServerMessageOf(err) ?? mapped ?? fallback;
}
