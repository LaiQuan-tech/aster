/**
 * 員工本人月表的「無打卡紀錄」（2026-10-12 教育訓練驗收第 17 條）。
 *
 * 班表功能拿掉之後，API 的 absent_scheduled（有排班卻沒打卡）永遠不會觸發：員工整天漏打卡、又沒請假，
 * 月表上那天跟平常一樣（還會被「顯示全月」收起來），員工自己發現不了。這裡由前端補一個提示：
 * 只在員工本人月表（/ess/attendance-sheet）標，後台、主管審核頁、匯出的 xlsx 都不變；
 * 不寫進 anomalies——不需要填說明、不擋送出（unacknowledgedErrors 不受影響）。
 *
 * 一天要「以下全部成立」才標（寧可漏標，不要誤標）：
 *   1. 日別是 workday（行事曆已含國定假日與補班；週六補班也是 workday）。
 *   2. 早於台北今天（今天還在進行中），也早於月表計算時間（computedAt）的台北日期——月表日資料是上次
 *      產生／重算的快照，computedAt 當天與之後的打卡可能還沒算進來。computedAt 是 null → 整張不標。
 *   3. 不早於到職日（hireDate；沒有就不限）。
 *   4. 完全沒有打卡：上下班時刻都空；工時、外出、遲到早退、加班分鐘都是 0；也沒有缺卡、無法配對、
 *      補打卡、外出未配對、跨午夜這些「其實有打卡」的異常。缺上下班時刻或工時欄位的資料判斷不了，不標。
 *   5. 沒有請假（leaveMinutes 是 0 而且沒有 leaveSummary）。
 *   6. 不是在家工作（wfh）。
 *   7. 沒有已核准的出差或公出涵蓋那天（ess-api 的 getMyApprovedTrips：kind=business_trip，trip_type
 *      outing／business_trip 都算）；start_at～end_at 換成台北日期，end_at 不含（剛好午夜結束不算隔天）。
 *   8. 那天沒有 error 級異常（例如缺上班卡已經是紅色、要填說明，不必再疊一個）。
 * 出差單讀不到（403 以外的錯誤）、讀到看不懂的起迄時間 → 這次整張不標，避免誤標。
 *
 * 純函式、不碰 React／DOM；測試在 `__tests__/sheet-no-punch.test.ts`。
 */
import { SHEET_TIME_ZONE, type SheetDayView, type SheetView } from "./attendance-sheets-api";
import { fmtDateShort, localDateKey } from "./ess-format";

/** 表格上的標籤（琥珀色，與 warn 同色系）。 */
export const NO_PUNCH_LABEL = "無打卡紀錄";

/** 標籤滑過去的說明。 */
export const NO_PUNCH_HINT = "這個上班日沒有任何打卡，也沒有請假、在家工作或出差／公出紀錄";

/** 本人已核准的出差／公出單（ess-api `MyTrip` 的子集，只用起迄時間）。 */
export interface ApprovedTripSpan {
  start_at: string;
  end_at: string;
}

export interface NoPunchContext {
  /** 台北今天 'YYYY-MM-DD'；今天與之後都不標。 */
  today: string;
  /** 本人已核准的出差／公出單（讀取失敗時呼叫端不要呼叫，整張不標）。 */
  trips: readonly ApprovedTripSpan[];
  /** 換算日期用的時區；預設台北（測試才需要帶）。 */
  tz?: string;
}

/** 一張月表算好的判斷門檻（noPunchRules）。 */
export interface NoPunchRules {
  /** 早於這天才標：台北今天與 computedAt 台北日期取較早的那個。 */
  before: string;
  /** 到職日；null＝不限。 */
  hireDay: string | null;
  /** 已核准出差／公出涵蓋的台北日期區間（含頭含尾）。 */
  tripRanges: DateRange[];
}

export interface DateRange {
  from: string;
  to: string;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const hasText = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** 這些異常代表那天其實有打卡（只是缺一半、配不起來、是補打的或跨午夜）。 */
const PUNCH_TRACE_CODES: ReadonlySet<string> = new Set([
  "missing_in",
  "missing_out",
  "unpaired_punch",
  "manual_punch",
  "outing_unpaired",
  "cross_midnight",
]);

/** 到職日 → 'YYYY-MM-DD'（也吃完整 ISO，取前 10 碼）；沒有或格式不對 → null（不限）。 */
function hireDayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.trim().slice(0, 10);
  return DATE_KEY_RE.test(head) ? head : null;
}

/**
 * 出差／公出單 → 涵蓋的台北日期區間（含頭含尾）。end_at 不含：最後一刻是 end_at 前 1 毫秒，
 * 所以剛好在午夜結束的單子不會算到隔天；起迄相同或倒過來 → 只算開始那天。讀不懂 → null。
 */
export function tripDateRange(trip: ApprovedTripSpan, tz: string = SHEET_TIME_ZONE): DateRange | null {
  const start = Date.parse(trip?.start_at);
  const end = Date.parse(trip?.end_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const from = localDateKey(new Date(start).toISOString(), tz);
  const to = end > start ? localDateKey(new Date(end - 1).toISOString(), tz) : from;
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return null;
  return { from, to };
}

/**
 * 一張月表的判斷門檻。回 null＝這張整張不標：computedAt 是 null 或讀不懂、today 格式不對、
 * 有出差單的起迄時間讀不懂（不知道它涵蓋哪幾天，標了可能是誤標）。
 */
export function noPunchRules(
  sheet: Pick<SheetView, "computedAt" | "hireDate">,
  ctx: NoPunchContext,
): NoPunchRules | null {
  const tz = ctx.tz ?? SHEET_TIME_ZONE;
  if (typeof ctx.today !== "string" || !DATE_KEY_RE.test(ctx.today)) return null;
  if (!sheet.computedAt) return null;
  const computedDay = localDateKey(sheet.computedAt, tz);
  if (!DATE_KEY_RE.test(computedDay)) return null;
  const tripRanges: DateRange[] = [];
  for (const trip of Array.isArray(ctx.trips) ? ctx.trips : []) {
    const range = tripDateRange(trip, tz);
    if (!range) return null;
    tripRanges.push(range);
  }
  return {
    before: computedDay < ctx.today ? computedDay : ctx.today,
    hireDay: hireDayOf(sheet.hireDate),
    tripRanges,
  };
}

/** 這天有沒有任何打卡的痕跡（上下班時刻、工時、外出、遲到早退、加班，或打卡相關的異常）。 */
export function hasPunchTrace(day: SheetDayView): boolean {
  if (day.firstIn || day.lastOut) return true;
  if (num(day.workedMinutes) > 0 || num(day.outingMinutes) > 0) return true;
  if (num(day.lateMinutes) > 0 || num(day.earlyLeaveMinutes) > 0) return true;
  const ot = day.overtime;
  if (num(ot?.computed) > 0 || num(ot?.effective) > 0) return true;
  const anomalies = Array.isArray(day.anomalies) ? day.anomalies : [];
  return anomalies.some((a) => typeof a?.code === "string" && PUNCH_TRACE_CODES.has(a.code));
}

/** 打卡欄位齊全（上下班時刻有這兩欄、工時是數字）才判斷得了；缺欄位的資料寧可不標。 */
function hasPunchFields(day: SheetDayView): boolean {
  return day.firstIn !== undefined && day.lastOut !== undefined && typeof day.workedMinutes === "number";
}

/** 單日判斷：檔頭 1～8 條全部成立才是「無打卡紀錄」。 */
export function isNoPunchDay(day: SheetDayView, rules: NoPunchRules): boolean {
  if (!day || typeof day.date !== "string" || !DATE_KEY_RE.test(day.date)) return false;
  if (day.dayType !== "workday") return false;
  if (day.date >= rules.before) return false;
  if (rules.hireDay && day.date < rules.hireDay) return false;
  if (!hasPunchFields(day) || hasPunchTrace(day)) return false;
  if (num(day.leaveMinutes) > 0 || hasText(day.leaveSummary)) return false;
  if (day.wfh) return false;
  if (rules.tripRanges.some((r) => r.from <= day.date && day.date <= r.to)) return false;
  const anomalies = Array.isArray(day.anomalies) ? day.anomalies : [];
  if (anomalies.some((a) => a?.severity === "error")) return false;
  return true;
}

/** 整張月表裡「無打卡紀錄」的日期（'YYYY-MM-DD'，由早到晚）；整張不標時回空陣列。 */
export function findNoPunchDates(
  sheet: Pick<SheetView, "days" | "computedAt" | "hireDate">,
  ctx: NoPunchContext,
): string[] {
  const rules = noPunchRules(sheet, ctx);
  if (!rules) return [];
  const days = Array.isArray(sheet.days) ? sheet.days : [];
  return days
    .filter((day) => isNoPunchDay(day, rules))
    .map((day) => day.date)
    .sort();
}

/**
 * 員工本人月表異常區的一行摘要；沒有就 null。月表是快照，單子核准後要重算才會更新：
 * 還能送出（草稿／退回）→ 提醒送出時會重算；已送出 → 要更正得請主管或 HR 退回。
 */
export function noPunchSummary(dates: readonly string[], editable = true): string | null {
  if (dates.length === 0) return null;
  const list = dates.map((date) => fmtDateShort(date)).join("、");
  const head = `有 ${dates.length} 個上班日沒有打卡紀錄：${list}。若是漏打卡請送補卡申請；若當天有請假、出差或公出，請確認單子已核准`;
  return editable ? `${head}（核准後，月表送出時會重新計算）。` : `${head}。月表已送出，要更正請洽主管或 HR。`;
}

/**
 * 讀出差／公出單被 403 擋下（員工端「申請」分頁沒開，ess_tab_disabled）＝這個人送不了出差單，
 * 呼叫端當作沒有出差；其他錯誤（網路、500…）回 false，呼叫端這次整張不標。
 */
export function isTripsForbidden(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { status?: unknown }).status === 403) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /^\[403\]/.test(message.trim());
}
