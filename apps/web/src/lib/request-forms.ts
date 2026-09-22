/**
 * 請假／申請頁的純函式：表單值 → `POST /requests` body、清單文案、簽核狀態文案。
 * 不碰 React／DOM／API（只用型別）；全部有單元測試。
 *
 * 送出 body 慣例（沿用舊頁面，後端契約 `apps/api/src/routes/requests.ts` createSchema）：
 *   - `startAt`／`endAt` 為 ISO（`toIso`：把本地 `YYYY-MM-DDTHH:mm` 轉 UTC ISO）。
 *   - `reason` 空字串一律省略（zod `min(1)`），最長 250。
 *   - 加班 reason 後綴「休息扣除：N 分鐘｜給付方式：X」、`hours = 差 − 休息`、`payout`。
 *   - 補卡 `segments:[{date,startTime:t,endTime:t,hours:0,type}]`、`startAt = endAt`。
 *   - 公出／出差沿用 `tripType / location / tripScope / estimatedCost / advanceRequested` 欄位名。
 *   - 零用金預支 `advanceRequested` 必填、`reason` 必填、`startAt = endAt = now`。
 */
import type { CreateRequestBody, LeaveRequest, LeaveSegment, RequestKind, RequestStatus } from "./ess-api";
import { fmtDateShort, fmtDateTime, fmtDateWithWeekday, fmtHm, fmtHours, fmtMoney, localDateKey } from "./ess-format";
import { DEFAULT_SHIFT, addDaysIfCrossesMidnight, halfDayWindow, normalizeHm, parseHm, type ShiftLike } from "./leave-hours";

/* ------------------------------------------------------------ 標籤 --- */

export const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  fix_punch: "補卡",
  ot: "加班",
  business_trip: "公出／出差",
  petty_cash: "零用金預支",
  wfh: "在家工作",
};

/** 種類切換列的短標（手機 390px 五顆要放得下）。 */
export const KIND_SHORT: Record<RequestKind, string> = {
  leave: "請假",
  fix_punch: "補卡",
  ot: "加班",
  business_trip: "公出",
  petty_cash: "預支",
  wfh: "在家",
};

/**
 * 種類切換列的順序＝可送出的種類。`wfh`（在家工作，M2）的標籤已在上面，但表單
 * （WfhForm／buildWfhBody）由 WP2 補；補完再把 "wfh" 加進這裡，切換列才會出現。
 */
export const KIND_ORDER: RequestKind[] = ["leave", "fix_punch", "ot", "business_trip", "petty_cash"];

export function isRequestKind(value: string | null | undefined): value is RequestKind {
  return !!value && (KIND_ORDER as string[]).includes(value);
}

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "待簽核",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已撤回",
};

export const STATUS_TONE: Record<RequestStatus, "amber" | "green" | "red" | "gray"> = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  cancelled: "gray",
};

export const PAYOUT_LABEL: Record<"pay" | "comp_time", string> = {
  pay: "加班費",
  comp_time: "補休",
};

export const PUNCH_TYPE_LABEL: Record<"in" | "out", string> = { in: "上班", out: "下班" };

export const TRIP_TYPE_LABEL: Record<"outing" | "business_trip", string> = { outing: "公出", business_trip: "出差" };

export const TRIP_SCOPE_LABEL: Record<string, string> = {
  local: "市內",
  domestic_intercity: "跨縣市",
  overseas: "海外",
};

/** 事由上限（createSchema `reason.max(250)`）。 */
export const REASON_MAX = 250;

/** API 錯誤碼 → 中文（找不到的碼由呼叫端退回 attendance-sheets-api 的 friendlyError）。 */
export const REQUEST_ERROR_MESSAGES: Record<string, string> = {
  no_approver_available: "找不到可簽核的主管，請聯絡 HR 設定簽核流程",
  proxy_filing_requires_hr: "只有 HR 可以代同仁申請",
  target_employee_not_found: "找不到這位同仁",
  attachment_required: "此假別需要附上憑證",
  not_pending: "這張申請已不是待簽核狀態",
  not_found: "找不到這張申請",
  invalid_body: "送出的內容格式不正確，請檢查日期與時間",
  payload_too_large: "附件太大，單檔限 3 MB",
};

/** 從 apiFetch 的錯誤訊息（`[status] code`）取出錯誤碼；不是 Error → null。 */
export function requestErrorCode(err: unknown): string | null {
  if (!(err instanceof Error) || !err.message) return null;
  return err.message.replace(/^\[\d+\]\s*/, "").trim() || null;
}

/* --------------------------------------------------------- 表單型別 --- */

interface CommonFormValues {
  reason: string;
  /** HR 代同仁申請；空字串／undefined ＝ 本人。 */
  onBehalfOfEmployeeId?: string;
}

export interface LeaveFormValues extends CommonFormValues {
  /** 空字串＝不指定（租戶沒有假別清單時）。 */
  leaveTypeId: string;
  segments: LeaveSegment[];
  hours: number;
}

export interface FixPunchFormValues extends CommonFormValues {
  date: string;
  type: "in" | "out";
  /** `HH:mm` */
  time: string;
}

export interface OvertimeFormValues extends CommonFormValues {
  date: string;
  startTime: string;
  endTime: string;
  /** 分鐘，字串（來自 input）；空／非數字視為 0。 */
  breakMinutes: string | number;
  payout: "pay" | "comp_time";
}

export interface TripFormValues extends CommonFormValues {
  tripType: "outing" | "business_trip";
  /** 公出：單日＋起訖時間。 */
  date: string;
  startTime: string;
  endTime: string;
  /** 出差：起迄日期（全天）。 */
  startDate: string;
  endDate: string;
  tripScope: "local" | "domestic_intercity" | "overseas";
  location: string;
  estimatedCost: string | number;
  advanceWanted: boolean;
  advanceRequested: string | number;
}

export interface PettyCashFormValues extends CommonFormValues {
  amount: string | number;
}

export interface FormValuesByKind {
  leave: LeaveFormValues;
  fix_punch: FixPunchFormValues;
  ot: OvertimeFormValues;
  business_trip: TripFormValues;
  petty_cash: PettyCashFormValues;
}

export type BuildResult = CreateRequestBody | { error: string };

export function isBuildError(result: BuildResult): result is { error: string } {
  return "error" in result && typeof (result as { error?: unknown }).error === "string" && !("kind" in result);
}

/* ------------------------------------------------------------ 工具 --- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地 `YYYY-MM-DDTHH:mm`（或 Date）→ API 要的 ISO 字串（沿用舊頁面的 toIso 慣例）。 */
export function toIso(local: string | Date): string {
  return (local instanceof Date ? local : new Date(local)).toISOString();
}

function localIso(date: string, hm: string): string {
  return toIso(`${date}T${normalizeHm(hm)}:00`);
}

function cleanReason(reason: string | null | undefined): string | undefined {
  const r = (reason ?? "").trim();
  return r ? r : undefined;
}

function reasonTooLong(reason: string | undefined): boolean {
  return !!reason && reason.length > REASON_MAX;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const s = String(value).replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function proxy(values: CommonFormValues): string | undefined {
  const id = (values.onBehalfOfEmployeeId ?? "").trim();
  return id ? id : undefined;
}

/* ------------------------------------------------------- buildCreateBody --- */

function buildLeave(form: LeaveFormValues): BuildResult {
  const segments = (form.segments ?? []).map((s) => ({
    date: s.date,
    startTime: normalizeHm(s.startTime),
    endTime: normalizeHm(s.endTime),
    hours: round2(Number(s.hours) || 0),
  }));
  if (segments.length === 0) return { error: "請選擇日期" };
  if (segments.some((s) => !DATE_RE.test(s.date) || parseHm(s.startTime) == null || parseHm(s.endTime) == null)) {
    return { error: "日期或時間格式不正確" };
  }
  const reason = cleanReason(form.reason);
  if (reasonTooLong(reason)) return { error: `事由請在 ${REASON_MAX} 字以內` };
  const first = segments[0];
  const last = segments[segments.length - 1];
  const hours = round2(Number(form.hours) || segments.reduce((sum, s) => sum + s.hours, 0));
  const body: CreateRequestBody = {
    kind: "leave",
    startAt: localIso(first.date, first.startTime),
    endAt: localIso(addDaysIfCrossesMidnight(last.date, last.startTime, last.endTime), last.endTime),
    hours,
    segments,
  };
  const leaveTypeId = (form.leaveTypeId ?? "").trim();
  if (leaveTypeId) body.leaveTypeId = leaveTypeId;
  if (reason) body.reason = reason;
  const behalf = proxy(form);
  if (behalf) body.onBehalfOfEmployeeId = behalf;
  return body;
}

function buildFixPunch(form: FixPunchFormValues): BuildResult {
  if (!DATE_RE.test(form.date ?? "")) return { error: "請選擇日期" };
  if (parseHm(form.time) == null) return { error: "請輸入時間" };
  if (form.type !== "in" && form.type !== "out") return { error: "請選擇上班或下班" };
  const reason = cleanReason(form.reason);
  if (!reason) return { error: "請填寫補卡原因" };
  if (reasonTooLong(reason)) return { error: `事由請在 ${REASON_MAX} 字以內` };
  const time = normalizeHm(form.time);
  const at = localIso(form.date, time);
  const body: CreateRequestBody = {
    kind: "fix_punch",
    startAt: at,
    endAt: at,
    reason,
    segments: [{ date: form.date, startTime: time, endTime: time, hours: 0, type: form.type }],
  };
  const behalf = proxy(form);
  if (behalf) body.onBehalfOfEmployeeId = behalf;
  return body;
}

/** 加班：起訖差（結束不晚於開始視為跨日）− 休息，四捨五入 2 位。 */
export function overtimeHours(startTime: string, endTime: string, breakMinutes: string | number): number | null {
  const a = parseHm(startTime);
  let b = parseHm(endTime);
  if (a == null || b == null) return null;
  if (b <= a) b += 24 * 60;
  const brk = Math.max(0, Math.floor(toNumber(breakMinutes) ?? 0));
  return round2((b - a - brk) / 60);
}

function buildOvertime(form: OvertimeFormValues): BuildResult {
  if (!DATE_RE.test(form.date ?? "")) return { error: "請選擇日期" };
  const a = parseHm(form.startTime);
  const b = parseHm(form.endTime);
  if (a == null || b == null) return { error: "請輸入起訖時間" };
  const brk = Math.max(0, Math.floor(toNumber(form.breakMinutes) ?? 0));
  const hours = overtimeHours(form.startTime, form.endTime, brk);
  if (hours == null) return { error: "請輸入起訖時間" };
  if (hours > 16) return { error: "加班時數超過 16 小時，請確認起訖時間" };
  if (hours <= 0) return { error: "加班時數需大於 0，請確認起訖時間與休息扣除" };
  const payout = form.payout === "comp_time" ? "comp_time" : "pay";
  const free = cleanReason(form.reason);
  const reason = [free, `休息扣除：${brk} 分鐘`, `給付方式：${PAYOUT_LABEL[payout]}`].filter(Boolean).join("｜");
  if (reason.length > REASON_MAX) return { error: `事由請在 ${REASON_MAX - (reason.length - (free?.length ?? 0))} 字以內` };
  const endDate = addDaysIfCrossesMidnight(form.date, form.startTime, form.endTime);
  const body: CreateRequestBody = {
    kind: "ot",
    startAt: localIso(form.date, form.startTime),
    endAt: localIso(endDate, form.endTime),
    hours,
    reason,
    payout,
  };
  const behalf = proxy(form);
  if (behalf) body.onBehalfOfEmployeeId = behalf;
  return body;
}

function buildTrip(form: TripFormValues): BuildResult {
  const tripType = form.tripType === "business_trip" ? "business_trip" : "outing";
  const location = (form.location ?? "").trim();
  if (!location) return { error: "請填寫地點" };
  if (location.length > 250) return { error: "地點請在 250 字以內" };
  const reason = cleanReason(form.reason);
  if (reasonTooLong(reason)) return { error: `事由請在 ${REASON_MAX} 字以內` };

  let startAt: string;
  let endAt: string;
  let hours: number | undefined;
  if (tripType === "outing") {
    if (!DATE_RE.test(form.date ?? "")) return { error: "請選擇日期" };
    const a = parseHm(form.startTime);
    const b = parseHm(form.endTime);
    if (a == null || b == null) return { error: "請輸入起訖時間" };
    if (b <= a) return { error: "結束時間需晚於開始時間" };
    startAt = localIso(form.date, form.startTime);
    endAt = localIso(form.date, form.endTime);
    hours = round2((b - a) / 60);
  } else {
    if (!DATE_RE.test(form.startDate ?? "") || !DATE_RE.test(form.endDate ?? "")) return { error: "請選擇起迄日期" };
    if (form.endDate < form.startDate) return { error: "結束日期不可早於開始日期" };
    startAt = localIso(form.startDate, "00:00");
    endAt = localIso(form.endDate, "23:59");
  }

  const estimatedCost = toNumber(form.estimatedCost);
  if (String(form.estimatedCost ?? "").trim() !== "" && (estimatedCost == null || estimatedCost < 0)) {
    return { error: "預估花費請填正數" };
  }
  let advanceRequested: number | undefined;
  if (form.advanceWanted) {
    const amount = toNumber(form.advanceRequested);
    if (amount == null || amount <= 0) return { error: "請填寫預支金額" };
    advanceRequested = amount;
  }

  const scope =
    form.tripScope === "domestic_intercity" || form.tripScope === "overseas" || form.tripScope === "local"
      ? form.tripScope
      : "local";
  const body: CreateRequestBody = {
    kind: "business_trip",
    startAt,
    endAt,
    tripType,
    location,
    // 公出一律市內；出差依表單。expenses 模組綁出差單時會看 trip_scope，所以兩種都送。
    tripScope: tripType === "outing" ? "local" : scope,
  };
  if (hours != null) body.hours = hours;
  if (reason) body.reason = reason;
  if (estimatedCost != null && estimatedCost >= 0) body.estimatedCost = estimatedCost;
  if (advanceRequested != null) body.advanceRequested = advanceRequested;
  const behalf = proxy(form);
  if (behalf) body.onBehalfOfEmployeeId = behalf;
  return body;
}

function buildPettyCash(form: PettyCashFormValues, now: Date): BuildResult {
  const amount = toNumber(form.amount);
  if (amount == null || amount <= 0) return { error: "請填寫預支金額" };
  const reason = cleanReason(form.reason);
  if (!reason) return { error: "請填寫用途" };
  if (reasonTooLong(reason)) return { error: `事由請在 ${REASON_MAX} 字以內` };
  const at = toIso(now);
  const body: CreateRequestBody = {
    kind: "petty_cash",
    startAt: at,
    endAt: at,
    reason,
    advanceRequested: amount,
  };
  const behalf = proxy(form);
  if (behalf) body.onBehalfOfEmployeeId = behalf;
  return body;
}

/**
 * 表單值 → `POST /requests` body；驗證不過回 `{ error }`。
 * 請假的「必選假別」與「需憑證假別必附檔」由頁面層檢查（這裡不知道假別清單與檔案）。
 */
export function buildCreateBody<K extends keyof FormValuesByKind>(
  kind: K,
  form: FormValuesByKind[K],
  opts: { now?: Date } = {},
): BuildResult {
  switch (kind) {
    case "leave":
      return buildLeave(form as LeaveFormValues);
    case "fix_punch":
      return buildFixPunch(form as FixPunchFormValues);
    case "ot":
      return buildOvertime(form as OvertimeFormValues);
    case "business_trip":
      return buildTrip(form as TripFormValues);
    case "petty_cash":
      return buildPettyCash(form as PettyCashFormValues, opts.now ?? new Date());
    default:
      return { error: "未知的申請種類" };
  }
}

/* -------------------------------------------------------- 清單文案 --- */

/** 一段請假在單日時的時段標籤：對得上班別的全天／上午／下午就用字，否則顯示時間。 */
function periodLabel(seg: LeaveSegment, shift: ShiftLike | undefined): string {
  const start = normalizeHm(seg.startTime);
  const end = normalizeHm(seg.endTime);
  if (shift) {
    const full = { startTime: normalizeHm(shift.start_time), endTime: normalizeHm(shift.end_time) };
    if (start === full.startTime && end === full.endTime) return "全天";
    const am = halfDayWindow(shift, "am");
    if (start === am.startTime && end === am.endTime) return "上午";
    const pm = halfDayWindow(shift, "pm");
    if (start === pm.startTime && end === pm.endTime) return "下午";
  }
  return `${start}–${end}`;
}

function hoursOf(r: Pick<LeaveRequest, "hours" | "segments">): number | null {
  if (r.hours != null && Number.isFinite(Number(r.hours))) return Number(r.hours);
  if (Array.isArray(r.segments) && r.segments.length > 0) {
    return round2(r.segments.reduce((sum, s) => sum + (Number(s.hours) || 0), 0));
  }
  return null;
}

function rangeFromIso(startIso: string, endIso: string, tz?: string): string {
  const sd = localDateKey(startIso, tz);
  const ed = localDateKey(endIso, tz);
  if (!sd || !ed) return "—";
  if (sd === ed) return `${fmtDateWithWeekday(sd)}${fmtHm(startIso, tz)}–${fmtHm(endIso, tz)}`;
  return `${fmtDateShort(sd)}–${fmtDateShort(ed)}`;
}

/** 清單每列第 2 行的期間摘要（五種申請各自的格式，API 新欄位缺席時退化到 start_at／end_at）。 */
export function describeRequest(
  r: Pick<
    LeaveRequest,
    | "kind"
    | "start_at"
    | "end_at"
    | "hours"
    | "segments"
    | "payout"
    | "trip_type"
    | "location"
    | "trip_scope"
    | "advance_requested"
  >,
  opts: { shift?: ShiftLike; tz?: string } = {},
): string {
  const tz = opts.tz;
  const segments = Array.isArray(r.segments) ? r.segments.filter((s) => s && DATE_RE.test(s.date)) : [];
  switch (r.kind) {
    case "leave": {
      const hours = hoursOf(r);
      const hoursText = hours == null ? "" : ` · ${fmtHours(hours)}`;
      if (segments.length === 1) {
        const seg = segments[0];
        return `${fmtDateWithWeekday(seg.date)}${periodLabel(seg, opts.shift ?? DEFAULT_SHIFT)}${hoursText}`;
      }
      if (segments.length > 1) {
        const first = segments[0].date;
        const last = segments[segments.length - 1].date;
        return `${fmtDateShort(first)}–${fmtDateShort(last)} · ${segments.length} 天${hoursText}`;
      }
      return `${rangeFromIso(r.start_at, r.end_at, tz)}${hoursText}`;
    }
    case "ot": {
      const hours = hoursOf(r);
      const payout = r.payout === "comp_time" || r.payout === "pay" ? ` · ${PAYOUT_LABEL[r.payout]}` : "";
      return `${rangeFromIso(r.start_at, r.end_at, tz)}${hours == null ? "" : ` · ${fmtHours(hours)}`}${payout}`;
    }
    case "fix_punch": {
      const seg = segments[0];
      if (seg) {
        const type = seg.type === "in" || seg.type === "out" ? PUNCH_TYPE_LABEL[seg.type] : "補卡";
        return `${fmtDateWithWeekday(seg.date)}${type} ${normalizeHm(seg.startTime)}`;
      }
      return fmtDateTime(r.start_at, tz);
    }
    case "business_trip": {
      const type = r.trip_type === "business_trip" || r.trip_type === "outing" ? TRIP_TYPE_LABEL[r.trip_type] : "公出／出差";
      const scope = r.trip_type === "business_trip" && r.trip_scope && TRIP_SCOPE_LABEL[r.trip_scope] ? `（${TRIP_SCOPE_LABEL[r.trip_scope]}）` : "";
      const location = (r.location ?? "").trim();
      const parts = [rangeFromIso(r.start_at, r.end_at, tz), location || null, `${type}${scope}`].filter(Boolean);
      return parts.join(" · ");
    }
    case "petty_cash": {
      const amount = r.advance_requested;
      return amount == null || amount === "" ? "—" : fmtMoney(amount);
    }
    default:
      return rangeFromIso(r.start_at, r.end_at, tz);
  }
}

/** 成功畫面的摘要：從剛送出的 body 反推成清單同款文案（不用等列表重載）。 */
export function describeBody(body: CreateRequestBody, opts: { shift?: ShiftLike; tz?: string } = {}): string {
  return describeRequest(
    {
      kind: body.kind,
      start_at: body.startAt,
      end_at: body.endAt,
      hours: body.hours ?? null,
      segments: body.segments ?? null,
      payout: body.payout ?? null,
      trip_type: body.tripType ?? null,
      location: body.location ?? null,
      trip_scope: body.tripScope ?? null,
      advance_requested: body.advanceRequested ?? null,
    },
    opts,
  );
}

/** 清單每列第 1 行的標題：種類（請假加假別名；公出／出差依 trip_type）。 */
export function requestTitle(r: Pick<LeaveRequest, "kind" | "leave_type_name" | "trip_type">): string {
  if (r.kind === "leave") {
    const name = (r.leave_type_name ?? "").trim();
    return name ? `請假 · ${name}` : "請假";
  }
  if (r.kind === "business_trip") {
    return r.trip_type === "business_trip" || r.trip_type === "outing" ? TRIP_TYPE_LABEL[r.trip_type] : KIND_LABEL.business_trip;
  }
  return KIND_LABEL[r.kind] ?? r.kind;
}

/** 多位候選簽核人的連接符（與後端 `current_approver_name` 相同）。 */
const APPROVER_JOINER = "／";

/**
 * 清單每列第 3 行：pending「等待 王小明 簽核（第 1／2 關）」、rejected「駁回理由：…」、
 * approved「已核准 · 09/17 10:21」、cancelled → null。欄位缺席時退化成 null（舊 API）。
 * 多級簽核（2026-09-22）起同一關可有多位候選：有 `current_approver_names` 就用它串「／」，
 * `current_step_kind === "hr"`（HR 覆核關）加註 →「等待 王小明／李小華（HR 覆核）簽核（第 3／3 關）」；
 * 沒有新欄位時維持原樣（用 `current_approver_name`）。
 */
export function approvalLine(
  r: Pick<
    LeaveRequest,
    | "status"
    | "current_step"
    | "total_steps"
    | "current_approver_name"
    | "current_approver_names"
    | "current_step_kind"
    | "decision_comment"
    | "decided_at"
  >,
  opts: { tz?: string } = {},
): string | null {
  switch (r.status) {
    case "pending": {
      const names = (r.current_approver_names ?? []).map((n) => n.trim()).filter(Boolean);
      const name = names.length > 0 ? names.join(APPROVER_JOINER) : (r.current_approver_name ?? "").trim();
      const hrNote = r.current_step_kind === "hr" ? "（HR 覆核）" : "";
      const total = r.total_steps != null && Number(r.total_steps) > 0 ? Number(r.total_steps) : null;
      const step = r.current_step != null && Number(r.current_step) > 0 ? Number(r.current_step) : 1;
      const stepText = total && total > 1 ? `（第 ${step}／${total} 關）` : "";
      // 有加註時全形括號後直接接「簽核」，不再留半形空白
      if (name) return `等待 ${name}${hrNote || " "}簽核${stepText}`;
      if (total) return `等待簽核${stepText}`;
      return null;
    }
    case "rejected": {
      const comment = (r.decision_comment ?? "").trim();
      if (comment) return `駁回理由：${comment}`;
      return r.decided_at ? `已駁回 · ${fmtDateTime(r.decided_at, opts.tz)}` : null;
    }
    case "approved":
      return r.decided_at ? `已核准 · ${fmtDateTime(r.decided_at, opts.tz)}` : null;
    default:
      return null;
  }
}

/** pending 請假、假別需憑證、且一個附件都沒有 → 顯示「缺憑證」＋「上傳憑證」。 */
export function needsAttachment(
  r: Pick<LeaveRequest, "status" | "kind" | "requires_attachment" | "attachment_count">,
): boolean {
  return r.status === "pending" && r.kind === "leave" && r.requires_attachment === true && r.attachment_count === 0;
}

/** 假別剩餘時數：跨年度加總 entitled + deferred − used；沒有任何列 → null（尚未設定額度）。 */
export function remainingHours(
  balances: Array<{ leave_type_id: string; entitled: number | string; used: number | string; deferred: number | string }>,
  leaveTypeId: string,
): number | null {
  const rows = balances.filter((b) => b.leave_type_id === leaveTypeId);
  if (rows.length === 0) return null;
  return round2(rows.reduce((sum, b) => sum + (Number(b.entitled) || 0) + (Number(b.deferred) || 0) - (Number(b.used) || 0), 0));
}
