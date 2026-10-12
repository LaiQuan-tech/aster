/**
 * 打卡紀錄頁「這天要不要打卡、沒打卡是為什麼」的純邏輯（2026-10-12 教育訓練驗收：國定假日、請假日
 * 被列成「未打卡」還給「申請補卡」，員工會誤送補卡）。不碰 React／DOM／API；
 * 測試在 `__tests__/punch-day-status.test.ts`。
 *
 * ── 行事曆（哪幾天是上班日）──────────────────────────────────────────────
 *   `GET /calendar?year=` 一次一年（任何成員可讀）；查詢區間最長 366 天、最多跨兩年 → `calendarYearsOf`。
 *   回來的列只有「有裁定的日子」（補班 workday、國定假日 fixed_holiday、休息日 rest_day），沒有列＝週一～五上班。
 *   某一年抓不到（403／503 calendar_not_migrated／網路錯）→ 那一年不放進 `dayTypesForYears` 的結果，
 *   那幾天就退回週一～五（與行事曆空白時相同），頁面照常。補不補空列的判斷在 punch-history 的 `isFillDay`。
 *
 * ── 已核准的單涵蓋這天（`approvedCoverageByDate`）─────────────────────────────
 *   資料：`GET /requests?scope=mine&status=approved` 全抓、在這裡依日期過濾（API 的 from/to 只篩 start_at
 *   而且用 UTC 日界，跨區間的多日假會漏，不用）。當地日期／時間一律用頁面分組打卡的同一個時區（`tz`）換算。
 *   - 請假（kind='leave'）：這天的請假時段合起來涵蓋整個上班時段（扣午休）＝整天。上班時段＝預設班別
 *     （租戶最早建立的班別＝請假表單算時數用的同一個；沒有＝09:00–18:00 休 60）。
 *       · 有 segments（請假表單的逐日切段）：每段 date＋startTime／endTime；夜班凌晨的時刻算隔日
 *         （同 leave-hours 與 API settlement.leaveIntervalsOf）。表單的「全天」段＝上班到下班、時數＝
 *         shiftWorkHours，所以「單段宣告時數 ≥ 一天工時」也算整天（班別時間事後改過，舊的全天段照樣算）。
 *       · segments 為 null（舊單／匯入單）：start_at／end_at 換成當地時間，逐日看涵蓋多少上班時段；
 *         落在同一天的單，宣告時數 ≥ 一天工時也算整天。
 *     上午／下午、指定時數這類部分時段不算整天：照樣可以申請補卡，只附小字註記（「請假・特休 13:00–18:00」）。
 *     兩張單（例如上午特休＋下午病假）合起來涵蓋整天，也算整天。
 *   - 公出（kind='business_trip' 且 trip_type='outing'，2026-10-12 調整）：start_at～end_at 換成當地時段，
 *     跟請假時段合起來算——只算落在上班時段內、扣掉午休的部分（公出的宣告時數是牆鐘差、含午休，不拿來判斷）。
 *     請假自己就蓋滿 → 照請假的標籤；要加上公出才蓋滿 → 「請假・特休＋公出」，只有公出 → 「公出」。
 *     蓋不滿（例如只有下午公出）→ 照樣可以申請補卡，附小字註記（「公出 14:00–17:00」）：其餘時段仍應打卡。
 *   - 在家工作（kind='wfh'）：涵蓋到的每個當地日都算整天（表單只有整天：起日 00:00～迄日 23:59；切法同 API
 *     attendance-sheets／settlement 的 sliceWfhDates：end_at 剛好落在午夜算前一天）。
 *   - 出差（kind='business_trip' 且 trip_type='business_trip'）：同在家工作。trip_type 不明的單不比照。
 *   與出勤月表的規則對齊：有已核准請假／在家工作／出差的日子，沒打卡不算缺卡。
 *
 * ── 一列怎麼顯示（`punchRowView`）────────────────────────────────────────────
 *   沒打卡（none）的日子被整天涵蓋 → 標籤改成「請假・特休」「公出」「在家工作」「出差」，不給「申請補卡」。
 *   有打卡的日子照打卡狀態顯示（不論是否上班日、有沒有核准單），核准單只當小字註記。
 *   今天：缺下班＝「上班中」、沒打卡＝「尚未打卡」，都不催補卡（同舊行為）；只有今天沒打卡且整天被涵蓋時，
 *   改顯示單的種類（「尚未打卡」會讓請假中的人以為要打卡；兩者都不給補卡）。
 */
import { addDays, fmtHm, localDateKey } from "./ess-format";
import { DEFAULT_SHIFT, lunchWindowOfShift, normalizeHm, parseHm, type DayType, type ShiftLike } from "./leave-hours";
import { fixPunchTypeOf, type DayRow, type DayRowStatus, type FixPunchType } from "./punch-history";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 86_400_000;
/** 時數四捨五入到小數 2 位（≈0.3 分）的誤差容忍（分鐘）。 */
const TOLERANCE_MIN = 1;
/** 逐日走訪的上限（查詢區間最長 366 天；防呆）。 */
const MAX_WALK_DAYS = 400;

/* ---------------------------------------------------------- 行事曆 --- */

/** 查詢區間涵蓋的年份（`GET /calendar` 一次一年）。日期格式不對或迄早於起 → []；最多 3 年（防呆）。 */
export function calendarYearsOf(from: string, to: string): number[] {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return [];
  const first = Number(from.slice(0, 4));
  const last = Math.min(Number(to.slice(0, 4)), first + 2);
  const years: number[] = [];
  for (let year = first; year <= last; year += 1) years.push(year);
  return years;
}

/** `GET /calendar` 的 `days` → `{ date: day_type }`；不是陣列、缺日期或 day_type 不是字串的列略過。 */
export function dayTypeMapOf(days: unknown): Record<string, DayType> {
  const map: Record<string, DayType> = {};
  if (!Array.isArray(days)) return map;
  for (const day of days) {
    if (!day || typeof day !== "object") continue;
    const { date, day_type: dayType } = day as { date?: unknown; day_type?: unknown };
    if (typeof date === "string" && DATE_RE.test(date) && typeof dayType === "string" && dayType) map[date] = dayType;
  }
  return map;
}

/**
 * 把各年份的行事曆裁定併成一張表。`byYear` 沒有的年份（抓不到）就不放，
 * 那幾天由 punch-history 的 `isFillDay` 退回週一～五。
 */
export function dayTypesForYears(
  years: readonly number[],
  byYear: ReadonlyMap<number, Readonly<Record<string, DayType>>>,
): Record<string, DayType> {
  const merged: Record<string, DayType> = {};
  for (const year of years) Object.assign(merged, byYear.get(year) ?? {});
  return merged;
}

/* ---------------------------------------------------------- 班別 --- */

/** `GET /shifts` 的一列（只取用得到的欄位）。 */
export interface ShiftRowLike extends ShiftLike {
  created_at?: string | null;
}

/** 預設班別＝created_at 最早的班別（與請假頁 pickDefaultShift 同一條規則）；沒有班別 → DEFAULT_SHIFT。 */
export function pickDefaultShift(shifts: readonly ShiftRowLike[] | null | undefined): ShiftLike {
  const valid = (Array.isArray(shifts) ? shifts : []).filter(
    (s): s is ShiftRowLike => !!s && typeof s.start_time === "string" && typeof s.end_time === "string",
  );
  if (valid.length === 0) return DEFAULT_SHIFT;
  return [...valid].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
}

interface WorkWindow {
  /** 班別座標：自當天 00:00 起算的分鐘；跨日班的下班 +1440。 */
  start: number;
  end: number;
  crossesMidnight: boolean;
  lunch: { start: number; end: number } | null;
  /** 一天的工時（分鐘）＝下班 − 上班 − 休息。 */
  workMinutes: number;
}

/** 班別 → 上班時段；時間格式不對或工時算不出正數 → null。 */
function tryWorkWindow(shift: ShiftLike): WorkWindow | null {
  const start = parseHm(shift.start_time);
  let end = parseHm(shift.end_time);
  if (start == null || end == null) return null;
  const crossesMidnight = end <= start;
  if (crossesMidnight) end += MINUTES_PER_DAY;
  const breakRaw = Number(shift.break_minutes ?? 0);
  const workMinutes = end - start - (Number.isFinite(breakRaw) && breakRaw > 0 ? breakRaw : 0);
  if (!(workMinutes > 0)) return null;
  const lunch = lunchWindowOfShift(shift);
  return { start, end, crossesMidnight, lunch: lunch ? { start: lunch.start, end: lunch.end } : null, workMinutes };
}

/** 班別 → 上班時段；省略、時間格式不對或工時算不出正數 → 退回 DEFAULT_SHIFT（一定合法）。 */
function workWindowOf(shift: ShiftLike | undefined): WorkWindow {
  return (shift && tryWorkWindow(shift)) ?? (tryWorkWindow(DEFAULT_SHIFT) as WorkWindow);
}

/* -------------------------------------------------- 已核准的單 --- */

/** 申請單的一段（請假的逐日切段）；舊單／匯入單的欄位可能缺漏，一律 runtime 檢查。 */
export interface SegmentLike {
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  hours?: unknown;
}

/**
 * 已核准的單在這頁用得到的欄位（`GET /requests` 回的 LeaveRequest 是它的超集）。
 * 舊 API／舊列可能缺欄位，讀取一律 runtime 檢查，壞列略過不丟例外。
 */
export interface ApprovedRequestLike {
  kind?: string | null;
  /** 有帶就只認 'approved'（API 已用 status=approved 篩過，這裡是保險）。 */
  status?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  hours?: number | string | null;
  segments?: ReadonlyArray<SegmentLike | null | undefined> | null;
  trip_type?: string | null;
  leave_type_name?: string | null;
}

/** 整天涵蓋的種類；請假＋公出合起來蓋滿算 "leave"（標籤「請假・特休＋公出」）。 */
export type CoverageKind = "leave" | "outing" | "wfh" | "business_trip";

export interface DayCoverage {
  /** 整天涵蓋（沒打卡也不必補卡）：`label` 如「請假・特休」「請假・特休＋公出」「公出」「在家工作」「出差」。 */
  full: { kind: CoverageKind; label: string } | null;
  /** 只涵蓋部分時段的請假／公出給小字註記，例如「請假・特休 13:00–18:00」「公出 14:00–17:00」。 */
  partial: string[];
}

export interface CoverageContext {
  /** 查詢區間（當地日期鍵，含頭尾）；區間外的日子不算。 */
  from: string;
  to: string;
  /** 上班時段用這個班別；省略＝DEFAULT_SHIFT。 */
  shift?: ShiftLike;
  /** 換算當地日期／時間的時區（同頁面分組打卡；省略＝瀏覽器時區）。 */
  tz?: string;
}

interface Span {
  a: number;
  b: number;
}

/** 某天的一塊請假或公出時段。 */
interface TimePiece {
  source: "leave" | "outing";
  /** 這天被涵蓋的時段（班別座標，自當天 00:00 起算）；起訖不明 → null。 */
  span: Span | null;
  /** 宣告時數（小時）；不明 → 0。 */
  hours: number;
  /** 這塊單獨就算整天（請假的宣告時數 ≥ 一天工時；公出一律 false）。 */
  wholeByHours: boolean;
  /** 假別名（可空；公出為空）。 */
  name: string;
  /** 小字註記。 */
  text: string;
}

const OUTING_LABEL = "公出";

const dayIndex = (dateKey: string) => Math.round(Date.parse(`${dateKey}T00:00:00Z`) / MS_PER_DAY);

/** ISO → 當地（日期鍵, 當天第幾分鐘）；無效 → null。 */
function localPoint(iso: unknown, tz?: string): { date: string; minute: number } | null {
  if (typeof iso !== "string" || !iso) return null;
  const date = localDateKey(iso, tz);
  const minute = parseHm(fmtHm(iso, tz));
  return DATE_RE.test(date) && minute != null ? { date, minute } : null;
}

const toNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
};

function leaveLabelOf(names: readonly string[]): string {
  const unique = Array.from(new Set(names.filter(Boolean)));
  return unique.length > 0 ? `請假・${unique.join("、")}` : "請假";
}

/** 從 `from` 走到 `to`（含頭尾、日期鍵），最多 MAX_WALK_DAYS 天。 */
function walkDays(from: string, to: string, visit: (date: string) => void): void {
  let date = from;
  for (let i = 0; i < MAX_WALK_DAYS && date <= to; i += 1) {
    visit(date);
    const next = addDays(date, 1);
    if (next === date) break;
    date = next;
  }
}

/**
 * start_at～end_at 換成當地時間、逐日切成時段塊（只收 `[from, to]` 內的日子）。
 * 沒有 segments 的舊請假單與公出共用；`wholeHours` 省略＝不看宣告時數（公出的時數是牆鐘差、含午休）。
 */
function intervalPiecesOf(
  req: ApprovedRequestLike,
  ctx: CoverageContext,
  base: { source: TimePiece["source"]; name: string; label: string; wholeHours?: (hours: number) => boolean },
  push: (date: string, piece: TimePiece) => void,
): void {
  const start = localPoint(req.start_at, ctx.tz);
  const end = localPoint(req.end_at, ctx.tz);
  if (!start || !end) return;
  const absStart = dayIndex(start.date) * MINUTES_PER_DAY + start.minute;
  const absEnd = dayIndex(end.date) * MINUTES_PER_DAY + end.minute;
  if (!(absEnd > absStart)) return;
  const hours = toNumber(req.hours);
  const sameDay = start.date === end.date;
  const startHm = fmtHm(req.start_at as string, ctx.tz);
  const endHm = fmtHm(req.end_at as string, ctx.tz);
  walkDays(start.date < ctx.from ? ctx.from : start.date, end.date > ctx.to ? ctx.to : end.date, (date) => {
    const offset = dayIndex(date) * MINUTES_PER_DAY;
    const when = sameDay ? `${startHm}–${endHm}` : date === start.date ? `${startHm} 起` : date === end.date ? `至 ${endHm}` : "全天";
    push(date, {
      source: base.source,
      span: { a: absStart - offset, b: absEnd - offset },
      hours: sameDay ? hours : 0,
      wholeByHours: sameDay && !!base.wholeHours?.(hours),
      name: base.name,
      text: `${base.label} ${when}`,
    });
  });
}

/** 一張請假單攤成每天的請假塊（只收 `[from, to]` 內的日子）。 */
function leavePiecesOf(req: ApprovedRequestLike, ctx: CoverageContext, win: WorkWindow, push: (date: string, piece: TimePiece) => void): void {
  const name = typeof req.leave_type_name === "string" ? req.leave_type_name.trim() : "";
  const label = leaveLabelOf([name]);
  const wholeHours = (hours: number) => hours > 0 && hours * 60 >= win.workMinutes - TOLERANCE_MIN;

  const segments = (Array.isArray(req.segments) ? req.segments : []).filter(
    (seg): seg is SegmentLike => !!seg && typeof seg === "object" && typeof seg.date === "string" && DATE_RE.test(seg.date),
  );
  if (segments.length > 0) {
    for (const seg of segments) {
      const date = seg.date as string;
      if (date < ctx.from || date > ctx.to) continue;
      const startTime = typeof seg.startTime === "string" ? seg.startTime : "";
      const endTime = typeof seg.endTime === "string" ? seg.endTime : "";
      const a = parseHm(startTime);
      const b = parseHm(endTime);
      let span: Span | null = null;
      if (a != null && b != null) {
        // 夜班凌晨的時刻算隔日；結束不晚於開始 → 跨日。
        const onAxis = (m: number) => (win.crossesMidnight && m < win.start ? m + MINUTES_PER_DAY : m);
        const from = onAxis(a);
        let to = onAxis(b);
        if (to <= from) to += MINUTES_PER_DAY;
        span = { a: from, b: to };
      }
      const hours = toNumber(seg.hours);
      push(date, {
        source: "leave",
        span,
        hours,
        wholeByHours: wholeHours(hours),
        name,
        text: span ? `${label} ${normalizeHm(startTime)}–${normalizeHm(endTime)}` : label,
      });
    }
    return;
  }

  // 舊單／匯入單：沒有 segments → start_at／end_at 換成當地時間，逐日切。
  intervalPiecesOf(req, ctx, { source: "leave", name, label, wholeHours }, push);
}

/** 在家工作／出差涵蓋到的當地日（同 API sliceWfhDates：end_at 剛好落在午夜算前一天），只收 `[from, to]` 內。 */
function coveredDatesOf(req: ApprovedRequestLike, ctx: CoverageContext): string[] {
  const startMs = typeof req.start_at === "string" ? Date.parse(req.start_at) : NaN;
  if (!Number.isFinite(startMs)) return [];
  const endMs = typeof req.end_at === "string" ? Date.parse(req.end_at) : NaN;
  const first = localDateKey(new Date(startMs).toISOString(), ctx.tz);
  const last = localDateKey(new Date(Math.max(Number.isFinite(endMs) ? endMs - 1 : startMs, startMs)).toISOString(), ctx.tz);
  if (!DATE_RE.test(first) || !DATE_RE.test(last)) return [];
  const out: string[] = [];
  walkDays(first < ctx.from ? ctx.from : first, last > ctx.to ? ctx.to : last, (date) => out.push(date));
  return out;
}

const overlapsWork = (span: Span, win: WorkWindow) => Math.min(span.b, win.end) > Math.max(span.a, win.start);

/** 這些時段合起來涵蓋了多少上班時間（分鐘；夾在上班時段內、扣掉與午休的重疊、重疊的時段不重複算）。 */
function coveredWorkMinutes(spans: readonly Span[], win: WorkWindow): number {
  const clipped = spans
    .map((s) => ({ a: Math.max(s.a, win.start), b: Math.min(s.b, win.end) }))
    .filter((s) => s.b > s.a)
    .sort((x, y) => x.a - y.a);
  let total = 0;
  const add = (s: Span) => {
    const lunch = win.lunch ? Math.max(0, Math.min(s.b, win.lunch.end) - Math.max(s.a, win.lunch.start)) : 0;
    total += s.b - s.a - lunch;
  };
  let current: Span | null = null;
  for (const s of clipped) {
    if (current && s.a <= current.b) {
      current.b = Math.max(current.b, s.b);
    } else {
      if (current) add(current);
      current = { ...s };
    }
  }
  if (current) add(current);
  return total;
}

/**
 * 已核准的單 → 每個當地日的涵蓋情形（只收 `[ctx.from, ctx.to]` 內、有東西的日子）。
 * 規則見檔頭；`requests` 裡的壞列（缺欄位、非 approved、其他種類）略過。
 */
export function approvedCoverageByDate(
  requests: readonly (ApprovedRequestLike | null | undefined)[] | null | undefined,
  ctx: CoverageContext,
): Map<string, DayCoverage> {
  const out = new Map<string, DayCoverage>();
  if (!DATE_RE.test(ctx.from) || !DATE_RE.test(ctx.to) || ctx.to < ctx.from) return out;
  const win = workWindowOf(ctx.shift);

  const piecesByDate = new Map<string, TimePiece[]>();
  const pushPiece = (date: string, piece: TimePiece) => {
    const list = piecesByDate.get(date);
    if (list) list.push(piece);
    else piecesByDate.set(date, [piece]);
  };
  const wfhDates = new Set<string>();
  const tripDates = new Set<string>();
  for (const req of Array.isArray(requests) ? requests : []) {
    if (!req || typeof req !== "object") continue;
    if (req.status != null && req.status !== "approved") continue;
    if (req.kind === "leave") {
      leavePiecesOf(req, ctx, win, pushPiece);
    } else if (req.kind === "wfh") {
      for (const date of coveredDatesOf(req, ctx)) wfhDates.add(date);
    } else if (req.kind === "business_trip" && req.trip_type === "business_trip") {
      for (const date of coveredDatesOf(req, ctx)) tripDates.add(date);
    } else if (req.kind === "business_trip" && req.trip_type === "outing") {
      intervalPiecesOf(req, ctx, { source: "outing", name: "", label: OUTING_LABEL }, pushPiece);
    }
  }

  /** 這些時段塊合起來算不算整天：任一塊宣告時數 ≥ 一天工時，或時段合起來蓋滿上班時段（扣午休）。 */
  const isWhole = (pieces: readonly TimePiece[]) =>
    pieces.some((p) => p.wholeByHours) ||
    coveredWorkMinutes(
      pieces.flatMap((p) => (p.span ? [p.span] : [])),
      win,
    ) >= win.workMinutes - TOLERANCE_MIN;

  const dates = new Set<string>([...piecesByDate.keys(), ...wfhDates, ...tripDates]);
  for (const date of dates) {
    // 只留碰得到上班時段的時段塊（例：結束剛好在午夜的單不會在隔天留註記）。
    const pieces = (piecesByDate.get(date) ?? [])
      .filter((p) => p.wholeByHours || (p.span ? overlapsWork(p.span, win) : p.hours > 0))
      .sort((x, y) => (x.span?.a ?? 0) - (y.span?.a ?? 0));
    const leaves = pieces.filter((p) => p.source === "leave");
    const hasOuting = leaves.length < pieces.length;
    const leaveLabel = leaveLabelOf(leaves.map((p) => p.name));

    // 請假自己蓋滿 → 請假標籤；要加上公出才蓋滿 → 「請假・特休＋公出」，只有公出 → 「公出」。
    let full: DayCoverage["full"] = null;
    if (leaves.length > 0 && isWhole(leaves)) {
      full = { kind: "leave", label: leaveLabel };
    } else if (hasOuting && isWhole(pieces)) {
      full = leaves.length > 0 ? { kind: "leave", label: `${leaveLabel}＋${OUTING_LABEL}` } : { kind: "outing", label: OUTING_LABEL };
    } else if (tripDates.has(date)) {
      full = { kind: "business_trip", label: "出差" };
    } else if (wfhDates.has(date)) {
      full = { kind: "wfh", label: "在家工作" };
    }
    // 整天是請假／公出湊出來的 → 不再逐塊註記；其他（蓋不滿、或整天是出差／在家）→ 每塊各一則註記。
    const piecesMadeFull = full?.kind === "leave" || full?.kind === "outing";
    const partial = piecesMadeFull ? [] : Array.from(new Set(pieces.map((p) => p.text)));
    if (full || partial.length > 0) out.set(date, { full, partial });
  }
  return out;
}

/* ------------------------------------------------------ 一列的顯示 --- */

export type PunchRowTone = "gray" | "green" | "amber" | "blue";

export interface PunchRowView {
  label: string;
  tone: PunchRowTone;
  /** 「申請補卡」要補的卡別；null＝這列不給「申請補卡」。 */
  fixType: FixPunchType | null;
  /** 小字註記（沒改標籤的已核准單，例如半天假）；沒有＝""。 */
  note: string;
}

const STATUS_VIEW: Record<DayRowStatus, { label: string; tone: PunchRowTone }> = {
  complete: { label: "完整", tone: "green" },
  missing_in: { label: "缺上班", tone: "amber" },
  missing_out: { label: "缺下班", tone: "amber" },
  none: { label: "未打卡", tone: "gray" },
};

const noteOf = (items: readonly string[]) => (items.length > 0 ? `已核准：${items.join("、")}` : "");

/**
 * 打卡紀錄一列的狀態標籤、要不要給「申請補卡」（給的話補哪一種卡）、小字註記。
 * `today` 是當地今天的日期鍵；`coverage` 是這天的已核准單（`approvedCoverageByDate`）。
 */
export function punchRowView(row: Pick<DayRow, "date" | "status">, today: string, coverage?: DayCoverage | null): PunchRowView {
  const full = coverage?.full ?? null;
  const partial = coverage?.partial ?? [];
  // 沒打卡、但整天都有已核准的單 → 標籤改成單的種類，不催補卡（今天也一樣）。
  if (row.status === "none" && full) return { label: full.label, tone: "blue", fixType: null, note: noteOf(partial) };

  // 請假、公出本來就有部分時段的，整天要註明「（整天）」；在家工作、出差只有整天，不必加。
  const fullNote = full && (full.kind === "leave" || full.kind === "outing") ? `${full.label}（整天）` : full?.label;
  const note = noteOf(fullNote ? [fullNote, ...partial] : partial);
  // 今天還在進行中：「缺下班」其實是「上班中」、「未打卡」是「尚未打卡」，不該催人補卡。
  if (row.date === today) {
    if (row.status === "missing_out") return { label: "上班中", tone: "blue", fixType: null, note };
    if (row.status === "none") return { label: "尚未打卡", tone: "gray", fixType: null, note };
  }
  const base = STATUS_VIEW[row.status] ?? STATUS_VIEW.none;
  return { ...base, fixType: row.status === "complete" ? null : fixPunchTypeOf(row.status), note };
}
