/**
 * 員工本人月表的「無打卡紀錄」（2026-10-12 教育訓練驗收第 17 條）。
 *
 * 班表功能拿掉之後，API 的 absent_scheduled（有排班卻沒打卡）永遠不會觸發：員工整天漏打卡、又沒請假，
 * 月表上那天跟平常一樣（還會被「顯示全月」收起來），員工自己發現不了。這裡由前端補一個提示：
 * 只在員工本人月表（/ess/attendance-sheet）標，後台、主管審核頁、匯出的 xlsx 都不變，列印也不印；
 * 不寫進 anomalies——不需要填說明、不擋送出（unacknowledgedErrors 不受影響）。
 *
 * 一天要「以下全部成立」才標（寧可漏標，不要誤標）：
 *   0. 員工是固定上班日的身分（GET /me 的 employmentType，見 hasFixedWorkdays）：正職 regular、約聘 contract。
 *      工讀／兼職（時薪）parttime（part_time 寫法也算）、實習 intern（客戶的工讀生設成 intern）、派遣、
 *      不認得的值、欄位缺漏（/me 還沒回來或失敗）→ 整張不標：這些人不是每個上班日都要來，平日沒打卡很正常。
 *   1. 日別是 workday（行事曆已含國定假日與補班；週六補班也是 workday）。
 *   2. 早於台北今天（今天還在進行中），也早於月表計算時間（computedAt）的台北日期——月表日資料是上次
 *      產生／重算的快照，computedAt 當天與之後的打卡可能還沒算進來。computedAt 是 null → 整張不標。
 *   3. 不早於到職日（hireDate）。null＝員工主檔沒填到職日 → 不限；不知道到職日 → 整張不標：欄位缺席
 *      （undefined，舊快照）、格式不對，或 2026-10-01 前核准的快照（API 把快照缺的欄位轉成 null，見 hireDayOf）。
 *   4. 完全沒有打卡：上下班時刻都空；工時、外出、遲到早退、加班分鐘都是 0；也沒有缺卡、無法配對、
 *      補打卡、外出未配對、跨午夜這些「其實有打卡」的異常。缺上下班時刻或工時欄位的資料判斷不了，不標。
 *   5. 月表上沒有請假（leaveMinutes 是 0 而且沒有 leaveSummary）。
 *   6. 月表上不是在家工作（wfh）。
 *   7. 沒有已核准的申請單涵蓋那天。月表是快照，快照之後才核准的單子要在這裡即時補上：頁面讀一次本人
 *      所有已核准的單（ess-api getRequests({ scope: "mine", status: "approved" })），看這四種（requestDateRanges）：
 *        請假 leave（整天或部分都算）：有 segments 用每段的 date，沒有 segments 用 start_at～end_at；
 *        在家工作 wfh、出差／公出 business_trip（trip_type outing／business_trip 都算）：start_at～end_at；
 *        補卡 fix_punch：start_at 的台北日期（segments 的 date 也算）。
 *      起迄換成台北日期，end_at 不含（剛好午夜結束不算隔天）。其他種類（加班、零用金預支）不看。
 *   8. 那天沒有 error 級異常（例如缺上班卡已經是紅色、要填說明，不必再疊一個）。
 * 申請單讀不到（403 以外的錯誤）、四種單子裡有看不懂日期的 → 這次整張不標，避免誤標。
 *
 * 純函式、不碰 React／DOM；測試在 `__tests__/sheet-no-punch.test.ts`。
 */
import { SHEET_TIME_ZONE, type SheetDayView, type SheetView } from "./attendance-sheets-api";
import { fmtDateShort, localDateKey } from "./ess-format";

/** 表格上的標籤（琥珀色，與 warn 同色系）。 */
export const NO_PUNCH_LABEL = "無打卡紀錄";

/** 標籤滑過去的說明。 */
export const NO_PUNCH_HINT = "這個上班日沒有任何打卡，也沒有請假、在家工作或出差／公出紀錄";

/**
 * 本人已核准的申請單（ess-api `LeaveRequest` 的子集，整包丟進來即可）：只用種類、起迄時間與逐日切段的日期。
 */
export interface ApprovedRequestSpan {
  kind: string;
  start_at: string;
  end_at: string;
  segments?: ReadonlyArray<{ date: string }> | null;
}

export interface NoPunchContext {
  /** 台北今天 'YYYY-MM-DD'；今天與之後都不標。 */
  today: string;
  /** 本人已核准的申請單，種類不限（讀取失敗時呼叫端不要呼叫，整張不標）。 */
  requests: readonly ApprovedRequestSpan[];
  /** 員工的身分類別（GET /me 的 employmentType）；不是固定上班日的身分或缺漏 → 整張不標。 */
  employmentType: string | null | undefined;
  /** 換算日期用的時區；預設台北（測試才需要帶）。 */
  tz?: string;
}

/** 一張月表算好的判斷門檻（noPunchRules）。 */
export interface NoPunchRules {
  /** 早於這天才標：台北今天與 computedAt 台北日期取較早的那個。 */
  before: string;
  /** 到職日；null＝不限。 */
  hireDay: string | null;
  /** 已核准的請假／在家工作／補卡／出差公出涵蓋的台北日期區間（含頭含尾）。 */
  coveredRanges: DateRange[];
}

export interface DateRange {
  from: string;
  to: string;
}

/** noPunchRules 需要的月表欄位（frozen／approvedAt 用來認出沒存到職日的舊核准快照）。 */
export type NoPunchSheet = Pick<SheetView, "computedAt" | "hireDate" | "frozen" | "approvedAt">;

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

/* ------------------------------------------------------------ 身分類別 --- */

/**
 * 固定上班日的身分類別（employees.employment_type，正規化後比對：去空白、轉小寫、拿掉 _／-）。
 * 系統的值域見 lib/ess-tabs.ts EMPLOYMENT_TYPES：時薪、排班不固定的人另有 parttime（「工讀／兼職（時薪）」），
 * 所以 regular（正職）與 contract（約聘，定期契約、照行事曆上班）算固定上班日。批次邀請的 CSV 會把
 * 身分類別原字存進去，中文寫法（正職／全職／約聘）也認。
 */
const FIXED_WORKDAY_EMPLOYMENT_TYPES: ReadonlySet<string> = new Set([
  "regular",
  "fulltime",
  "contract",
  "正職",
  "全職",
  "約聘",
]);

/**
 * 這個身分類別有沒有固定上班日（＝「無打卡紀錄」要不要標）。名單外一律 false（寧可漏標）：
 * parttime／part_time（工讀／兼職，時薪，一週只來幾天）、intern（實習；客戶的工讀生設成 intern）、
 * dispatched（派遣，只有匯入會出現）、其他不認得的字；null／undefined／空字串（/me 還沒回來、失敗、
 * 舊版 API 沒這欄——DB 欄位是 NOT NULL DEFAULT 'regular'，現行 API 一定會帶，缺了就是不知道）也是 false。
 */
export function hasFixedWorkdays(employmentType: unknown): boolean {
  if (typeof employmentType !== "string") return false;
  const key = employmentType.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return FIXED_WORKDAY_EMPLOYMENT_TYPES.has(key);
}

/* ------------------------------------------------------------ 到職日 --- */

/**
 * 核准快照從這時候起才存 hireDate（2026-09-30 下午上線，取 10/01 00:00 台北涵蓋部署時間差）。
 * 之前核准的快照沒有這欄，但 API 讀快照時把缺的欄位轉成 null（apps/api attendance-sheets.ts
 * sheetViewFromRow 的 `snap.hireDate ?? null`），前端看到的 null 分不出「主檔沒填」還是「舊快照沒存」。
 */
export const HIRE_DATE_IN_SNAPSHOT_SINCE = "2026-10-01T00:00:00+08:00";
const HIRE_DATE_IN_SNAPSHOT_SINCE_MS = Date.parse(HIRE_DATE_IN_SNAPSHOT_SINCE);

/** 已核准／鎖定的月表讀的是核准快照；核准時間早於界線（或讀不懂）＝快照裡沒存到職日。 */
function isSnapshotWithoutHireDate(sheet: NoPunchSheet): boolean {
  if (sheet.frozen !== true) return false;
  const approved = typeof sheet.approvedAt === "string" ? Date.parse(sheet.approvedAt) : Number.NaN;
  return !Number.isFinite(approved) || approved < HIRE_DATE_IN_SNAPSHOT_SINCE_MS;
}

/**
 * 到職日門檻：'YYYY-MM-DD'＝不早於這天才標（也吃完整 ISO，取前 10 碼）；null＝不限（主檔真的沒填）；
 * undefined＝不知道 → 整張不標：欄位缺席（舊快照）、格式不對、舊核准快照的 null（見 isSnapshotWithoutHireDate）。
 */
function hireDayOf(sheet: NoPunchSheet): string | null | undefined {
  const value: unknown = sheet.hireDate;
  if (value === undefined) return undefined;
  if (value === null) return isSnapshotWithoutHireDate(sheet) ? undefined : null;
  if (typeof value !== "string") return undefined;
  const head = value.trim().slice(0, 10);
  return DATE_KEY_RE.test(head) ? head : undefined;
}

/* ------------------------------------------------------------ 申請單 --- */

/** 已核准就代表那天不必有打卡的種類。加班（ot）、零用金預支（petty_cash）不看。 */
const COVERING_KINDS: ReadonlySet<string> = new Set(["leave", "wfh", "fix_punch", "business_trip"]);

/**
 * 起迄 → 涵蓋的台北日期區間（含頭含尾）。end_at 不含：最後一刻是 end_at 前 1 毫秒，
 * 所以剛好在午夜結束的單子不會算到隔天；起迄相同或倒過來 → 只算開始那天。讀不懂 → null。
 * （與 API 月表切在家工作、加班單的算法相同：apps/api attendance-sheets.ts 的 wfh／approved ot。）
 */
export function spanDateRange(
  span: { start_at: string; end_at: string },
  tz: string = SHEET_TIME_ZONE,
): DateRange | null {
  const start = Date.parse(span?.start_at);
  const end = Date.parse(span?.end_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const from = localDateKey(new Date(start).toISOString(), tz);
  const to = end > start ? localDateKey(new Date(end - 1).toISOString(), tz) : from;
  if (!DATE_KEY_RE.test(from) || !DATE_KEY_RE.test(to)) return null;
  return { from, to };
}

/** segments 每段的日期；沒有 segments（缺、null、空陣列）→ []；有任何一段的日期讀不懂 → null。 */
function segmentDays(segments: ApprovedRequestSpan["segments"]): string[] | null {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const days: string[] = [];
  for (const segment of segments) {
    const date: unknown = segment?.date;
    if (typeof date !== "string" || !DATE_KEY_RE.test(date)) return null;
    days.push(date);
  }
  return days;
}

const singleDays = (days: Iterable<string>): DateRange[] => Array.from(new Set(days), (d) => ({ from: d, to: d }));

/**
 * 一張已核准的單涵蓋哪些台北日期（含頭含尾的區間）：
 *   請假：有 segments 用每段的 date（半天假、多天假都是一段一天）；沒有 segments（或有段讀不懂）用 start_at～end_at。
 *   補卡：start_at 的台北日期（補的那一天），segments 的 date 也算。
 *   在家工作、出差／公出：start_at～end_at。
 * 不是這四種 → []（不影響判斷，起迄壞掉也不管）；這四種卻讀不懂日期 → null（呼叫端整張不標）。
 */
export function requestDateRanges(request: ApprovedRequestSpan, tz: string = SHEET_TIME_ZONE): DateRange[] | null {
  const kind: unknown = request?.kind;
  if (typeof kind !== "string" || !COVERING_KINDS.has(kind)) return [];
  if (kind === "leave") {
    const days = segmentDays(request.segments);
    if (days && days.length > 0) return singleDays(days);
    const range = spanDateRange(request, tz);
    return range ? [range] : null;
  }
  if (kind === "fix_punch") {
    const start = Date.parse(request.start_at);
    const startDay = Number.isFinite(start) ? localDateKey(new Date(start).toISOString(), tz) : "";
    const days = [...(DATE_KEY_RE.test(startDay) ? [startDay] : []), ...(segmentDays(request.segments) ?? [])];
    return days.length > 0 ? singleDays(days) : null;
  }
  const range = spanDateRange(request, tz);
  return range ? [range] : null;
}

/* ------------------------------------------------------------ 判斷 --- */

/**
 * 一張月表的判斷門檻。回 null＝這張整張不標：不是固定上班日的身分、today 格式不對、computedAt 是 null
 * 或讀不懂、不知道到職日、四種單子裡有起迄讀不懂的（不知道它涵蓋哪幾天，標了可能是誤標）。
 */
export function noPunchRules(sheet: NoPunchSheet, ctx: NoPunchContext): NoPunchRules | null {
  const tz = ctx.tz ?? SHEET_TIME_ZONE;
  if (!hasFixedWorkdays(ctx.employmentType)) return null;
  if (typeof ctx.today !== "string" || !DATE_KEY_RE.test(ctx.today)) return null;
  if (!sheet.computedAt) return null;
  const computedDay = localDateKey(sheet.computedAt, tz);
  if (!DATE_KEY_RE.test(computedDay)) return null;
  const hireDay = hireDayOf(sheet);
  if (hireDay === undefined) return null;
  const coveredRanges: DateRange[] = [];
  for (const request of Array.isArray(ctx.requests) ? ctx.requests : []) {
    const ranges = requestDateRanges(request, tz);
    if (!ranges) return null;
    coveredRanges.push(...ranges);
  }
  return {
    before: computedDay < ctx.today ? computedDay : ctx.today,
    hireDay,
    coveredRanges,
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

/** 單日判斷：檔頭 1～8 條全部成立才是「無打卡紀錄」（第 0 條在 noPunchRules）。 */
export function isNoPunchDay(day: SheetDayView, rules: NoPunchRules): boolean {
  if (!day || typeof day.date !== "string" || !DATE_KEY_RE.test(day.date)) return false;
  if (day.dayType !== "workday") return false;
  if (day.date >= rules.before) return false;
  if (rules.hireDay && day.date < rules.hireDay) return false;
  if (!hasPunchFields(day) || hasPunchTrace(day)) return false;
  if (num(day.leaveMinutes) > 0 || hasText(day.leaveSummary)) return false;
  if (day.wfh) return false;
  if (rules.coveredRanges.some((r) => r.from <= day.date && day.date <= r.to)) return false;
  const anomalies = Array.isArray(day.anomalies) ? day.anomalies : [];
  if (anomalies.some((a) => a?.severity === "error")) return false;
  return true;
}

/** 整張月表裡「無打卡紀錄」的日期（'YYYY-MM-DD'，由早到晚）；整張不標時回空陣列。 */
export function findNoPunchDates(sheet: NoPunchSheet & Pick<SheetView, "days">, ctx: NoPunchContext): string[] {
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
 * 讀本人已核准的申請單被 403 擋下（員工端「申請」分頁沒開，ess_tab_disabled）＝這個人送不了申請單，
 * 呼叫端當作沒有核准單；其他錯誤（網路、500…）回 false，呼叫端這次整張不標。
 */
export function isRequestsForbidden(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { status?: unknown }).status === 403) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /^\[403\]/.test(message.trim());
}
