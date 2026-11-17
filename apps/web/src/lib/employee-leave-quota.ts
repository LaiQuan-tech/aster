/**
 * 員工內頁「休假」分頁（2026-11-17 業主：員工詳情頁最右邊加「休假」，管理員可為這位員工設定每一種假的天數與時數）。
 *
 * 純函式（不碰 React／API，有單元測試）：天＋時換算、列表組裝、儲存計畫、特休來源提示。
 *
 * 資料來源與既有功能完全相同（不新增 API／資料表）：
 *   • 讀：GET /leave-balances/employees/:id?year=（假別、與該年重疊的餘額桶、每日工時、canAdjust）、
 *     GET /leave-types（statutoryKind）、GET /requests?kind=leave&status=pending&employeeId=（簽核中）、
 *     POST /leave-balances/annual-grant { employeeId, dryRun:true }（只預覽，特休來源提示用）。
 *   • 寫：已有餘額桶 → POST /leave-balances/adjustments（指定 balanceId、差額＝新額度−原額度；原因必填、
 *     寫 leave_balance_adjustments 歷程＋樂觀鎖）；還沒有桶 → PUT /leave-balances（該年曆年桶、source=manual、
 *     note 記原因）。兩條路都寫 leave_balances.entitled（DB audit_all trigger 另記稽核），所以 ESS「我的假別額度」、
 *     請假送單擋額度、簽核畫面「各假別已請／剩餘」讀的是同一個桶，自動反映。
 *
 * 「有額度」的定義與擋額度（lib/leave-balance-cap.ts bucketHasQuota）一致：桶的 entitled＋deferred > 0；
 * 沒有桶或 entitled＝0 的記帳桶＝不限額（或依法另有規則，例如生理假、補休）。數字一律是**小時**。
 */
import type { LeaveBalance, LeaveRequest, LeaveType } from "./admin-api";
import type { AnnualGrantResult } from "./leave-balances-api";
import { formatLeaveDuration } from "./leave-duration";
import { localDateKey } from "./ess-format";

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** 額度上限（小時），與 API 調整上限 MAX_DELTA_HOURS 一致。 */
export const MAX_QUOTA_HOURS = 9999.99;
/** 原因欄上限（API note／reason 上限 500，前面還要加「設定額度為…」字首）。 */
export const QUOTA_REASON_MAX = 400;
/** 租戶時區（與後端 DEFAULT_TIMEZONE 相同），把假單起始時間換成日期鍵。 */
const TZ = "Asia/Taipei";

function perDayOf(hoursPerDay: number | undefined): number {
  return Number.isFinite(hoursPerDay) && (hoursPerDay as number) > 0 ? (hoursPerDay as number) : 8;
}

/** 小時 → 「天＋時」輸入框的初值（56 小時、8 小時制 → { days: "7", hours: "0" }；10.5 → 1 天 2.5 時）。 */
export function hoursToDaysHours(totalHours: number, hoursPerDay?: number): { days: string; hours: string } {
  const perDay = perDayOf(hoursPerDay);
  const h = Math.max(0, round2(num(totalHours)));
  const days = Math.floor(h / perDay + 1e-9);
  const rest = round2(h - days * perDay);
  return { days: String(days), hours: String(rest) };
}

/** 「天＋時」→ 小時；空白當 0、負數或非數字 → null。 */
export function quotaInputToHours(days: string, hours: string, hoursPerDay?: number): number | null {
  const d = days.trim() === "" ? 0 : Number(days);
  const h = hours.trim() === "" ? 0 : Number(hours);
  if (!Number.isFinite(d) || !Number.isFinite(h) || d < 0 || h < 0) return null;
  return round2(d * perDayOf(hoursPerDay) + h);
}

/** 約幾天（顯示用，兩位小數）。 */
export function approxDays(hours: number, hoursPerDay?: number): number {
  return round2(num(hours) / perDayOf(hoursPerDay));
}

/** 不限額假別的說明（依法另有規則者寫出規則；其他＝不限額）。 */
export function unlimitedLabel(type: Pick<LeaveType, "code" | "name"> & { statutoryKind?: LeaveType["statutoryKind"] }): string {
  if (type.statutoryKind === "menstrual" || /生理/.test(type.name)) return "依法：每月 1 日，全年超過 3 日併入病假";
  if (type.statutoryKind === "sick") return "依法：未住院全年 30 日（未設額度不擋）";
  if (type.name.replace(/\s+/g, "") === "補休" || /^comp(_time)?$/i.test(type.code.trim())) return "依補休帳（加班換補休）";
  return "不限額";
}

export interface QuotaBucketOption {
  id: string;
  label: string;
}

export interface QuotaRow {
  leaveType: { id: string; code: string; name: string; statutoryKind?: LeaveType["statutoryKind"] };
  /** 與所選年度重疊的桶（新的在前）。 */
  buckets: LeaveBalance[];
  bucketOptions: QuotaBucketOption[];
  /** 目前顯示／編輯的桶；null＝這一年還沒有桶。 */
  bucket: LeaveBalance | null;
  entitled: number;
  deferred: number;
  used: number;
  /** 同期間（沒有桶＝同年度）簽核中假單時數。 */
  pending: number;
  /** entitled＋deferred−used（已核准的已扣，簽核中不扣，與 ESS 我的假別額度相同）。 */
  remaining: number;
  /** 有額度上限（entitled＋deferred > 0）；false＝不限額／依法。 */
  hasQuota: boolean;
  /** 計算簽核中的期間（顯示用）。 */
  periodStart: string;
  periodEnd: string;
}

function bucketLabel(b: LeaveBalance): string {
  if (b.period_start && b.period_end) return `${b.period_start} ～ ${b.period_end}`;
  return `${b.year} 年`;
}

/**
 * 預設要顯示的桶：期間包含參考日者（多個取起日最新，與扣假 resolveBalanceBucket 同規則）；
 * 沒有 → 起日最新的那一個；舊庫（沒有期間）→ 該年那一桶。
 */
export function defaultQuotaBucket(buckets: readonly LeaveBalance[], refDate: string): LeaveBalance | null {
  if (buckets.length === 0) return null;
  const withPeriod = buckets.filter((b) => b.period_start && b.period_end);
  if (withPeriod.length === 0) {
    const year = Number(refDate.slice(0, 4));
    return buckets.find((b) => Number(b.year) === year) ?? buckets[0]!;
  }
  const sorted = [...withPeriod].sort((a, b) => ((a.period_start as string) < (b.period_start as string) ? 1 : -1));
  return sorted.find((b) => (b.period_start as string) <= refDate && refDate <= (b.period_end as string)) ?? sorted[0]!;
}

/** 參考日：今天在所選年度內＝今天；過去年度＝12/31；未來年度＝1/1（同後端 referenceDate）。 */
export function quotaRefDate(year: number, today: string): string {
  const y = Number(today.slice(0, 4));
  if (y === year) return today;
  return y > year ? `${year}-12-31` : `${year}-01-01`;
}

export interface BuildQuotaRowsInput {
  year: number;
  today: string;
  /** 租戶所有假別（GET /leave-balances/employees/:id 的 leaveTypes，已排好序）。 */
  leaveTypes: Array<{ id: string; code: string; name: string }>;
  /** GET /leave-types（只用來補 statutoryKind；讀不到可省略）。 */
  leaveTypeMeta?: ReadonlyArray<Pick<LeaveType, "id" | "statutoryKind">>;
  balances: readonly LeaveBalance[];
  /** 這位員工的假單（只算 kind=leave、status=pending）。 */
  requests?: ReadonlyArray<Pick<LeaveRequest, "kind" | "status" | "leave_type_id" | "start_at" | "hours">>;
  /** 使用者手動選的桶（leaveTypeId → balanceId）。 */
  selectedBucket?: Record<string, string>;
}

/** 組「休假」分頁的列表：每個假別一列（含沒有任何桶的假別），列序沿用 leaveTypes。 */
export function buildQuotaRows(input: BuildQuotaRowsInput): QuotaRow[] {
  const refDate = quotaRefDate(input.year, input.today);
  const metaById = new Map((input.leaveTypeMeta ?? []).map((t) => [t.id, t]));
  const pendingReqs = (input.requests ?? []).filter((r) => r.kind === "leave" && r.status === "pending" && r.leave_type_id);
  return input.leaveTypes.map((type) => {
    const buckets = input.balances
      .filter((b) => b.leave_type_id === type.id)
      .sort((a, b) => ((a.period_start ?? String(a.year)) < (b.period_start ?? String(b.year)) ? 1 : -1));
    const picked = input.selectedBucket?.[type.id];
    const bucket = (picked ? buckets.find((b) => b.id === picked) : undefined) ?? defaultQuotaBucket(buckets, refDate);
    const entitled = bucket ? num(bucket.entitled) : 0;
    const deferred = bucket ? num(bucket.deferred) : 0;
    const used = bucket ? num(bucket.used) : 0;
    const periodStart = bucket?.period_start ?? `${bucket ? bucket.year : input.year}-01-01`;
    const periodEnd = bucket?.period_end ?? `${bucket ? bucket.year : input.year}-12-31`;
    const pending = round2(
      pendingReqs
        .filter((r) => r.leave_type_id === type.id)
        .filter((r) => {
          const d = localDateKey(r.start_at, TZ);
          return d !== "" && periodStart <= d && d <= periodEnd;
        })
        .reduce((s, r) => s + num(r.hours), 0),
    );
    return {
      leaveType: { ...type, statutoryKind: metaById.get(type.id)?.statutoryKind ?? null },
      buckets,
      bucketOptions: buckets.map((b) => ({ id: b.id, label: bucketLabel(b) })),
      bucket,
      entitled: round2(entitled),
      deferred: round2(deferred),
      used: round2(used),
      pending,
      remaining: round2(entitled + deferred - used),
      hasQuota: entitled + deferred > 0.001,
      periodStart,
      periodEnd,
    };
  });
}

export interface QuotaEdit {
  days: string;
  hours: string;
  reason: string;
}

/** 這一列的輸入跟目前額度不同嗎（輸入不合法也算有改，讓儲存時報錯）。 */
export function quotaEditDirty(row: Pick<QuotaRow, "entitled">, edit: QuotaEdit | undefined, hoursPerDay?: number): boolean {
  if (!edit) return false;
  const h = quotaInputToHours(edit.days, edit.hours, hoursPerDay);
  return h === null || h !== round2(row.entitled);
}

export type QuotaSavePlan =
  | { kind: "adjust"; newEntitled: number; body: { employeeId: string; leaveTypeId: string; balanceId: string; deltaHours: number; reason: string } }
  | { kind: "put"; newEntitled: number; body: { employeeId: string; leaveTypeId: string; year: number; entitled: number; note: string } }
  | { kind: "error"; error: string };

/**
 * 儲存計畫（不送 API）：
 *   • 有桶 → POST /leave-balances/adjustments（balanceId、差額＝新額度−原額度，原因前加「設定額度為 N 小時（原 M）」）；
 *   • 沒桶 → PUT /leave-balances（該年 1/1～12/31 曆年桶，note＝「手動設定額度：原因」）。
 * 只改本期給假（entitled）；遞延與已用不動。
 */
export function planQuotaSave(
  row: Pick<QuotaRow, "leaveType" | "bucket" | "entitled">,
  edit: QuotaEdit,
  ctx: { employeeId: string; year: number; hoursPerDay?: number },
): QuotaSavePlan {
  const hours = quotaInputToHours(edit.days, edit.hours, ctx.hoursPerDay);
  if (hours === null) return { kind: "error", error: "天數與時數須為不小於 0 的數字" };
  if (hours > MAX_QUOTA_HOURS) return { kind: "error", error: `額度不可超過 ${MAX_QUOTA_HOURS} 小時` };
  const reason = edit.reason.trim();
  if (row.bucket) {
    const delta = round2(hours - round2(row.entitled));
    if (delta === 0) return { kind: "error", error: "額度沒有變更" };
    if (!reason) return { kind: "error", error: "請填寫調整原因" };
    if (reason.length > QUOTA_REASON_MAX) return { kind: "error", error: `調整原因請在 ${QUOTA_REASON_MAX} 字以內` };
    return {
      kind: "adjust",
      newEntitled: hours,
      body: {
        employeeId: ctx.employeeId,
        leaveTypeId: row.leaveType.id,
        balanceId: row.bucket.id,
        deltaHours: delta,
        reason: `設定額度為 ${hours} 小時（原 ${round2(row.entitled)}）：${reason}`,
      },
    };
  }
  if (hours === 0) return { kind: "error", error: "額度沒有變更（0＝不限額，不需設定）" };
  if (!reason) return { kind: "error", error: "請填寫調整原因" };
  if (reason.length > QUOTA_REASON_MAX) return { kind: "error", error: `調整原因請在 ${QUOTA_REASON_MAX} 字以內` };
  return {
    kind: "put",
    newEntitled: hours,
    body: {
      employeeId: ctx.employeeId,
      leaveTypeId: row.leaveType.id,
      year: ctx.year,
      entitled: hours,
      note: `手動設定額度：${reason}`,
    },
  };
}

/**
 * 特休列的來源提示（依 POST /leave-balances/annual-grant dryRun 的結果；與 services/annual-leave.ts 的行為一致）：
 *   • 曆年制 → 系統不自動給假；
 *   • 週年制、本期還沒發 → 系統將依年資給 X 天；手動先設定的話，同期間自動給假會略過（already_granted）；
 *   • 週年制、本期已有桶 → 系統依年資應給 X 天；這裡修改會直接改這一期額度，之後自動給假不會覆蓋，下一期再依年資給；
 *   • 未滿 6 個月／尚未到職 → 說明尚未給特休。
 * 不是這位員工的特休假別或讀不到 → null。
 */
export function annualLeaveHint(
  grant: AnnualGrantResult | null | undefined,
  leaveTypeId: string,
  hoursPerDay?: number,
): string | null {
  if (!grant || grant.leaveTypeId !== leaveTypeId) return null;
  if (grant.basis === "calendar") return "特休規則為曆年制：系統不自動給假，額度以這裡手動設定為準。";
  const entry = [...grant.granted, ...grant.skipped, ...grant.migrated][0];
  if (!entry) return "系統依年資自動給特休（週年制）；這位員工目前非在職或未填到職日，不會自動給假。";
  const period = entry.periodStart ? `本期 ${entry.periodStart} ～ ${entry.periodEnd}` : "本期";
  const amount = `${entry.days} 天（${formatLeaveDuration(entry.entitledHours, hoursPerDay)}）`;
  if (entry.action === "granted") {
    return `系統將依年資於${period}自動給 ${amount}，目前尚未發放；若先在這裡設定同期間額度，自動給假會略過、以手動為準。`;
  }
  switch (entry.reason) {
    case "already_granted":
      return `系統依年資${period}應給 ${amount}。在這裡修改會直接改這一期的額度（寫入調整歷程），之後自動給假不會覆蓋；下一期仍由系統依年資重新給。`;
    case "under_six_months":
      return "年資未滿 6 個月，系統尚未自動給特休；滿 6 個月後依年資給假。";
    case "not_hired_yet":
      return "到職日晚於今天，系統尚未自動給特休。";
    default:
      return null;
  }
}
