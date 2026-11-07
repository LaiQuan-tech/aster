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

/** describeError 用：額度相關錯誤（400/409 不足、503 檢查失敗）→ 人話；否則 null。 */
export function leaveBalanceErrorText(err: unknown, verb: "送出" | "核准", hoursPerDay?: number): string | null {
  if (isCheckFailed(err)) return leaveBalanceCheckFailedMessage(verb);
  const info = leaveBalanceInsufficientOf(err);
  return info ? leaveBalanceMessage(info, verb, hoursPerDay) : null;
}

/** 批次核准逐張結果裡的額度錯誤 → 人話（帶句號）；其他錯誤 → null。 */
export function leaveBalanceBatchItemText(item: unknown, verb: "送出" | "核准", hoursPerDay?: number): string | null {
  if (!item || typeof item !== "object") return null;
  const error = (item as { error?: unknown }).error;
  if (error === LEAVE_BALANCE_CHECK_FAILED_CODE) return `${leaveBalanceCheckFailedMessage(verb)}。`;
  const info = leaveBalanceFromBody(item);
  return info ? `${leaveBalanceMessage(info, verb, hoursPerDay)}。` : null;
}
