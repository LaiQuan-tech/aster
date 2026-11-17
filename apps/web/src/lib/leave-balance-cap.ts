/**
 * 請假額度上限（2026-11-08 業主：有額度的假別超過剩餘額度要擋下不能送出）。
 *
 * 與 API `apps/api/src/services/leave-balance-cap.ts` 同一套判斷（web 與 api 是各自的 build 邊界，各寫一份）：
 *   • 申請起日所屬的餘額桶（{@link balanceBucketFor}）entitled＋deferred > 0 才算「有額度」；
 *   • 沒有桶、或只有 entitled=0 的自動記帳桶（事假、病假等不追蹤餘額的假別核准時自動建的）→ 不限額、不擋。
 * 前端只看得到桶（看不到簽核中的其他假單），所以最後以 API 為準：送單 400／核准 409
 * `{ error: "leave_balance_insufficient", leaveTypeId, requestedHours, availableHours }`。
 */
import { balanceBucketFor, type BalanceBucketLike } from "./request-forms";
import { formatLeaveDuration } from "./leave-duration";
import { todayKey } from "./ess-format";

export const LEAVE_BALANCE_INSUFFICIENT_CODE = "leave_balance_insufficient";
export const LEAVE_BALANCE_CHECK_FAILED_CODE = "leave_balance_check_failed";
export const LEAVE_BALANCE_REVERT_FAILED_CODE = "leave_balance_revert_failed";
/** 額度不足、退回待簽核卻失敗（500）：單子仍是已核准、未扣額度。 */
export const LEAVE_BALANCE_REVERT_FAILED_MESSAGE =
  "假別額度不足，但退回待簽核失敗：這張單目前仍是「已核准」（尚未扣額度），請聯絡管理員處理";

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** 這個桶有額度上限嗎（entitled＋deferred > 0）。 */
export function bucketHasQuota(bucket: Pick<BalanceBucketLike, "entitled" | "deferred"> | null | undefined): boolean {
  if (!bucket) return false;
  return num(bucket.entitled) + num(bucket.deferred) > 0.001;
}

/**
 * 有額度假別的剩餘時數（含申請起日那一個桶的 entitled＋deferred−used）；不限額（沒有桶／entitled=0 的記帳桶）→ null。
 */
export function quotaRemainingHours(
  balances: readonly BalanceBucketLike[],
  leaveTypeId: string,
  asOf: string = todayKey(),
): number | null {
  const bucket = balanceBucketFor(balances, leaveTypeId, asOf);
  if (!bucket || !bucketHasQuota(bucket)) return null;
  return round2(num(bucket.entitled) + num(bucket.deferred) - num(bucket.used));
}

/**
 * 補休假別：code 為 comp／comp_time，或名稱（去空白）完全等於「補休」（與 API isCompLeaveType 同一判斷；
 * 「國定假日補休」「颱風補休」不算）。沒有 leave_balances 額度桶時，補休的額度看補休帳（GET /comp-time?scope=mine 的 balance）。
 */
export function isCompLeaveType(type: { code?: string | null; name?: string | null } | null | undefined): boolean {
  if (!type) return false;
  if ((type.name ?? "").replace(/\s+/g, "") === "補休") return true;
  return /^comp(_time)?$/i.test((type.code ?? "").trim());
}

export interface LeaveBalanceInsufficient {
  leaveTypeId: string | null;
  requestedHours: number | null;
  availableHours: number | null;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 從物件讀額度不足欄位；error 不是 leave_balance_insufficient → null。
 * 數字可能扁平（單筆 400／409 body），也可能包在 `balance` 裡（批次核准結果的一項）；`balance` 優先。
 */
export function leaveBalanceFromBody(body: unknown): LeaveBalanceInsufficient | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.error !== LEAVE_BALANCE_INSUFFICIENT_CODE) return null;
  const nested = b.balance && typeof b.balance === "object" && !Array.isArray(b.balance) ? (b.balance as Record<string, unknown>) : {};
  const pick = (key: string) => (nested[key] !== undefined && nested[key] !== null ? nested[key] : b[key]);
  const leaveTypeId = pick("leaveTypeId");
  return {
    leaveTypeId: typeof leaveTypeId === "string" ? leaveTypeId : null,
    requestedHours: numOrNull(pick("requestedHours")),
    availableHours: numOrNull(pick("availableHours")),
  };
}

/** apiFetch 丟出的 Error（`code`／`body`）是不是 leave_balance_insufficient。 */
export function leaveBalanceInsufficientOf(err: unknown): LeaveBalanceInsufficient | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { code?: string; body?: unknown };
  if (e.code !== LEAVE_BALANCE_INSUFFICIENT_CODE && !e.message.includes(LEAVE_BALANCE_INSUFFICIENT_CODE)) return null;
  return leaveBalanceFromBody(e.body) ?? { leaveTypeId: null, requestedHours: null, availableHours: null };
}

/**
 * 人話：「此假別剩餘 1 天，申請 2 天，超過額度無法送出」（時數用天＋時；`verb`＝送出／核准）。
 * 數字缺漏時退回「此假別剩餘額度不足，無法送出」。
 */
export function leaveBalanceMessage(info: LeaveBalanceInsufficient, verb: "送出" | "核准", hoursPerDay?: number): string {
  const { availableHours, requestedHours } = info;
  if (availableHours === null || requestedHours === null) return `此假別剩餘額度不足，無法${verb}`;
  return `此假別剩餘 ${formatLeaveDuration(Math.max(0, availableHours), hoursPerDay)}，申請 ${formatLeaveDuration(requestedHours, hoursPerDay)}，超過額度無法${verb}`;
}

/** 503 leave_balance_check_failed 的人話。 */
export function leaveBalanceCheckFailedMessage(verb: "送出" | "核准"): string {
  return `假別額度檢查暫時失敗，這張單尚未${verb}，請稍後再試`;
}

function isCheckFailed(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  return e.code === LEAVE_BALANCE_CHECK_FAILED_CODE || e.message.includes(LEAVE_BALANCE_CHECK_FAILED_CODE);
}

/* ─────────────── 生理假（2026-11-17，API services/menstrual-leave.ts）─────────────── */

export const MENSTRUAL_MONTHLY_CAP_CODE = "menstrual_monthly_cap";
export const MENSTRUAL_EXCEEDS_SICK_BALANCE_CODE = "menstrual_exceeds_sick_balance";
export const MENSTRUAL_MONTHLY_CAP_MESSAGE = "生理假每月以 1 日為限";

/** 生理假假別：statutoryKind='menstrual'；舊 API 沒回 statutoryKind 時退回名稱／code 判斷（與 API 推斷同規則）。 */
export function isMenstrualLeaveType(
  type: { code?: string | null; name?: string | null; statutoryKind?: string | null } | null | undefined,
): boolean {
  if (!type) return false;
  if (type.statutoryKind !== undefined) return type.statutoryKind === "menstrual";
  return /生理假/.test(type.name ?? "") || /^menstrual/i.test((type.code ?? "").trim());
}

/**
 * 生理假錯誤（400 送單／409 核准，或批次核准的一項）→ 人話；不是生理假錯誤 → null。
 *   menstrual_monthly_cap：「生理假每月以 1 日為限（2026-11 已請 4 小時，本單 8 小時）」
 *   menstrual_exceeds_sick_balance：「生理假全年超過 3 日的部分併入病假計算：本單併入 4 小時，病假剩餘 0 小時，無法送出」
 */
export function menstrualErrorFromBody(body: unknown, verb: "送出" | "核准", hoursPerDay?: number): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const nested = b.menstrual && typeof b.menstrual === "object" ? (b.menstrual as Record<string, unknown>) : {};
  const pick = (key: string) => (nested[key] !== undefined && nested[key] !== null ? nested[key] : b[key]);
  const fmt = (h: number) => formatLeaveDuration(Math.max(0, h), hoursPerDay);
  if (b.error === MENSTRUAL_MONTHLY_CAP_CODE) {
    const month = pick("month");
    const used = numOrNull(pick("usedHours"));
    const requested = numOrNull(pick("requestedHours"));
    if (typeof month === "string" && used !== null && requested !== null) {
      return `${MENSTRUAL_MONTHLY_CAP_MESSAGE}（${month} 已請 ${fmt(used)}，本單 ${fmt(requested)}），無法${verb}`;
    }
    return `${MENSTRUAL_MONTHLY_CAP_MESSAGE}，無法${verb}`;
  }
  if (b.error === MENSTRUAL_EXCEEDS_SICK_BALANCE_CODE) {
    const merged = numOrNull(pick("mergedHours"));
    const available = numOrNull(pick("availableHours"));
    const head = "生理假全年超過 3 日的部分併入病假計算";
    if (merged !== null && available !== null) return `${head}：本單併入 ${fmt(merged)}，病假剩餘 ${fmt(available)}，無法${verb}`;
    return `${head}，病假剩餘不足，無法${verb}`;
  }
  return null;
}

function menstrualErrorOf(err: unknown, verb: "送出" | "核准", hoursPerDay?: number): string | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { code?: string; body?: unknown };
  const code =
    e.code ??
    (e.message.includes(MENSTRUAL_MONTHLY_CAP_CODE)
      ? MENSTRUAL_MONTHLY_CAP_CODE
      : e.message.includes(MENSTRUAL_EXCEEDS_SICK_BALANCE_CODE)
        ? MENSTRUAL_EXCEEDS_SICK_BALANCE_CODE
        : undefined);
  if (code !== MENSTRUAL_MONTHLY_CAP_CODE && code !== MENSTRUAL_EXCEEDS_SICK_BALANCE_CODE) return null;
  const body = e.body && typeof e.body === "object" ? e.body : { error: code };
  return menstrualErrorFromBody({ ...(body as Record<string, unknown>), error: code }, verb, hoursPerDay);
}

/** describeError 用：額度相關錯誤（400/409 不足、503 檢查失敗、生理假上限）→ 人話；否則 null。 */
export function leaveBalanceErrorText(err: unknown, verb: "送出" | "核准", hoursPerDay?: number): string | null {
  if (isCheckFailed(err)) return leaveBalanceCheckFailedMessage(verb);
  const menstrual = menstrualErrorOf(err, verb, hoursPerDay);
  if (menstrual) return menstrual;
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    if (e.code === LEAVE_BALANCE_REVERT_FAILED_CODE || e.message.includes(LEAVE_BALANCE_REVERT_FAILED_CODE)) return LEAVE_BALANCE_REVERT_FAILED_MESSAGE;
  }
  const info = leaveBalanceInsufficientOf(err);
  return info ? leaveBalanceMessage(info, verb, hoursPerDay) : null;
}

/** 批次核准逐張結果裡的額度錯誤 → 人話（帶句號）；其他錯誤 → null。 */
export function leaveBalanceBatchItemText(item: unknown, verb: "送出" | "核准", hoursPerDay?: number): string | null {
  if (!item || typeof item !== "object") return null;
  const error = (item as { error?: unknown }).error;
  if (error === LEAVE_BALANCE_CHECK_FAILED_CODE) return `${leaveBalanceCheckFailedMessage(verb)}。`;
  if (error === LEAVE_BALANCE_REVERT_FAILED_CODE) return `${LEAVE_BALANCE_REVERT_FAILED_MESSAGE}。`;
  const menstrual = menstrualErrorFromBody(item, verb, hoursPerDay);
  if (menstrual) return `${menstrual}。`;
  const info = leaveBalanceFromBody(item);
  return info ? `${leaveBalanceMessage(info, verb, hoursPerDay)}。` : null;
}
