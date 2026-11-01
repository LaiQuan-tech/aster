/**
 * 加班事前核准制（2026-11）— 前端共用的純函式（無 React；有 vitest）。
 *
 * 規則：打卡不擋、加班費照算，但休息日／國定假日／平日加班都要事前送加班單給主管核准；
 * 核准有月 40 小時、日 12 小時上限。API 合約（欄位名固定，不可改名）：
 *   1. POST /punch 回應選填 `overtimeNotice?: { kind, dayType, message }`
 *      kind ∈ "unapproved_overtime_day"（黃色提醒＋送加班單）｜"regular_leave_day"（紅色強烈警示）。
 *   2. 建立／核准加班單可能回 409 `{ error: "overtime_cap_exceeded", limit: "monthly"|"daily",
 *      capHours, currentHours, requestedHours }`。
 *   3. GET /reports/unapproved-overtime?period=YYYY-MM（見 lib/unapproved-overtime-api.ts）。
 *   4. 月出勤表日異常碼 `overtime_unapproved`（error 級；標籤見 lib/attendance-sheets-api.ts）。
 *
 * API 尚未部署時這些欄位都不存在：每個讀法都要容忍缺欄位／型別不對，回 null 或預設值，不丟例外。
 */

/* ------------------------------------------------------- 打卡提醒 --- */

export type OvertimeNoticeKind = "unapproved_overtime_day" | "regular_leave_day";

export interface OvertimeNotice {
  kind: OvertimeNoticeKind;
  dayType: string;
  message: string;
}

const NOTICE_KINDS: ReadonlySet<string> = new Set<OvertimeNoticeKind>(["unapproved_overtime_day", "regular_leave_day"]);

/** message 空白時的預設說法。 */
export const OVERTIME_NOTICE_FALLBACK: Record<OvertimeNoticeKind, string> = {
  unapproved_overtime_day: "今天的加班還沒有核准的加班單，請盡快送加班單給主管核准。",
  regular_leave_day: "今天是例假日，依法不得出勤；打卡已記錄，請立即告知主管與人資。",
};

/**
 * 從 POST /punch 回應取出 overtimeNotice；沒有、kind 不認得、型別不對 → null（舊 API 不帶這欄）。
 */
export function overtimeNoticeOf(res: unknown): OvertimeNotice | null {
  if (!res || typeof res !== "object") return null;
  const raw = (res as { overtimeNotice?: unknown }).overtimeNotice;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { kind, dayType, message } = raw as Record<string, unknown>;
  if (typeof kind !== "string" || !NOTICE_KINDS.has(kind)) return null;
  const k = kind as OvertimeNoticeKind;
  return {
    kind: k,
    dayType: typeof dayType === "string" ? dayType : "",
    message: typeof message === "string" && message.trim() ? message.trim() : OVERTIME_NOTICE_FALLBACK[k],
  };
}

/** 員工加班申請頁（預選日期）。 */
export function overtimeRequestHref(date: string): string {
  return `/ess/requests?kind=ot&date=${encodeURIComponent(date)}`;
}

/* ------------------------------------------------------- 日別標籤 --- */

/** 月表 dayType → 中文（休息日／國定假日／例假／平日）；不認得的原樣回傳，空字串回「—」。 */
export const DAY_TYPE_LABEL: Readonly<Record<string, string>> = {
  workday: "平日",
  rest_day: "休息日",
  fixed_holiday: "國定假日",
  regular_leave: "例假",
};

export function dayTypeLabel(dayType: string | null | undefined): string {
  if (!dayType) return "—";
  return Object.prototype.hasOwnProperty.call(DAY_TYPE_LABEL, dayType) ? DAY_TYPE_LABEL[dayType] : dayType;
}

/* ---------------------------------------------------- 上限 409 錯誤 --- */

export interface OvertimeCapExceeded {
  limit: "monthly" | "daily";
  capHours: number | null;
  currentHours: number | null;
  requestedHours: number | null;
}

export const OVERTIME_CAP_CODE = "overtime_cap_exceeded";

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** 從物件（API 409 body 或批次結果的一項）讀上限欄位；error 不是 overtime_cap_exceeded → null。 */
export function overtimeCapFromBody(body: unknown): OvertimeCapExceeded | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.error !== OVERTIME_CAP_CODE) return null;
  return {
    limit: b.limit === "daily" ? "daily" : "monthly",
    capHours: numOrNull(b.capHours),
    currentHours: numOrNull(b.currentHours),
    requestedHours: numOrNull(b.requestedHours),
  };
}

/** apiFetch 丟出的 Error（`code`／`body`，見 lib/api-client.ts）是不是 409 overtime_cap_exceeded。 */
export function overtimeCapExceededOf(err: unknown): OvertimeCapExceeded | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { status?: number; code?: string; body?: unknown };
  if (e.code !== OVERTIME_CAP_CODE && !e.message.includes(OVERTIME_CAP_CODE)) return null;
  return overtimeCapFromBody(e.body) ?? { limit: "monthly", capHours: null, currentHours: null, requestedHours: null };
}

/** 小時數：整數不帶小數，其他最多兩位（38 → "38"、1.5 → "1.5"、2.25 → "2.25"）。 */
export function fmtCapHours(hours: number): string {
  return String(Math.round(hours * 100) / 100);
}

/**
 * 上限錯誤的人話。`verb`＝「送出」（員工送單）或「核准」（主管核准）。
 *   monthly：「本月加班已核准 38 小時，這張 4 小時會超過 40 小時上限，無法核准」
 *   daily：  「當天工時會超過 12 小時上限（這張 4 小時），無法核准」
 * 數字缺漏時退回不帶數字的說法。
 */
export function overtimeCapMessage(info: OvertimeCapExceeded, verb: "送出" | "核准"): string {
  const { limit, capHours, currentHours, requestedHours } = info;
  const cap = capHours !== null ? `${fmtCapHours(capHours)} 小時` : limit === "daily" ? "12 小時" : "40 小時";
  const req = requestedHours !== null ? `這張 ${fmtCapHours(requestedHours)} 小時` : "這張加班單";
  if (limit === "daily") {
    if (currentHours !== null) {
      return `當天已有 ${fmtCapHours(currentHours)} 小時，${req}會讓當天工時超過 ${cap}上限，無法${verb}`;
    }
    return `當天工時會超過 ${cap}上限（${req}），無法${verb}`;
  }
  if (currentHours !== null) return `本月加班已核准 ${fmtCapHours(currentHours)} 小時，${req}會超過 ${cap}上限，無法${verb}`;
  return `${req}會超過本月加班 ${cap}上限，無法${verb}`;
}

/** describeError 用：是上限錯誤就回人話，否則 null。 */
export function overtimeCapErrorText(err: unknown, verb: "送出" | "核准"): string | null {
  const info = overtimeCapExceededOf(err);
  return info ? overtimeCapMessage(info, verb) : null;
}

/* ---------------------------------------------------------- 時:分 --- */

/** 分鐘 → 「時:分」（125 → "2:05"；負數／非數字當 0）。 */
export function fmtMinutesHm(minutes: number): string {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
