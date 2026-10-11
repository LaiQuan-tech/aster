/**
 * worktime-engine — 純函式。把一天的打卡 + 班別 + 規則 + 日屬性,結算成
 * AttendanceDay(工時 / 遲到 / 早退 / 加班 / 夜間,皆以分鐘計)。無 IO。
 *
 * 午休 (2026-10-11):午休落在哪一段由 lunch-window.ts 的單一規則決定。
 *   • 規則 1、2 (班別明設 breakStart / 涵蓋 12:00):工時扣「在班區間與午休的重疊」
 *     (09:00–18:00 扣 60 = 8h;13:30–18:00 不扣),遲到/早退也不計午休那段。
 *   • 規則 3 (午班、夜班等舊推算):維持舊行為——工時固定扣 breakMinutes、遲到/早退
 *     照字面;只有已核准請假跟推算窗相接時,才用它銜接「請假 → 午休 → 到班」。
 * 請假 (ctx.leaveIntervals):已核准請假覆蓋的時段不算遲到/早退。
 */

import {
  resolveDefaultLunch,
  resolveOvertimeMealBreak,
  resolveOvertimeRounding,
  type OvertimeRoundingMode,
  type RuleConfig,
} from "./rules-schema.js";
import { lunchWindowOf } from "./lunch-window.js";
import {
  DAY_TYPE_TO_OVERTIME_WHEN,
  type AttendanceDay,
  type DayContext,
  type DayType,
  type PunchPair,
  type ShiftDef,
  type TimeInterval,
} from "./types.js";

const MS_PER_MIN = 60_000;
const MIN_PER_DAY = 24 * 60;

/** Date | ISO string → epoch ms。 */
function toMs(d: Date | string): number {
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`worktime-engine: invalid date value: ${String(d)}`);
  }
  return ms;
}

/** 'HH:MM' → 自午夜起的分鐘數。 */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 取某 epoch ms 當天午夜(本地時區)的 epoch ms。 */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms
}

function normalizePairs(input: PunchPair | PunchPair[]): Interval[] {
  const pairs = Array.isArray(input) ? input : [input];
  return pairs.map((p) => {
    const start = toMs(p.inAt);
    const end = toMs(p.outAt);
    if (end < start) {
      throw new Error(
        `worktime-engine: outAt (${String(p.outAt)}) is before inAt (${String(p.inAt)})`,
      );
    }
    return { start, end };
  });
}

/** 請假時段 → epoch 區間;起訖不合法或長度 ≤ 0 的略過 (請假只用來「免計」,壞資料不該讓結算丟錯)。 */
function normalizeLeaveIntervals(input: TimeInterval[] | undefined): Interval[] {
  const out: Interval[] = [];
  for (const iv of input ?? []) {
    const start = iv.from instanceof Date ? iv.from.getTime() : new Date(iv.from).getTime();
    const end = iv.to instanceof Date ? iv.to.getTime() : new Date(iv.to).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end });
  }
  return out;
}

/** [from, to) 扣掉 covers 聯集後剩下的毫秒數 (to ≤ from → 0)。 */
function uncoveredMs(from: number, to: number, covers: Interval[]): number {
  if (to <= from) return 0;
  const clipped = covers
    .map((c) => ({ start: Math.max(c.start, from), end: Math.min(c.end, to) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = from;
  for (const c of clipped) {
    const start = Math.max(c.start, cursor);
    if (c.end > start) {
      covered += c.end - start;
      cursor = c.end;
    }
  }
  return to - from - covered;
}

/**
 * 計算多個工作區間與「夜間視窗」重疊的分鐘數。
 * 夜間視窗以 from/to 的 'HH:MM' 給定;當 from >= to 視為跨午夜 (例如
 * 22:00–06:00、或 00:00–08:30 其實不跨,但 00:00–00:00 等特例一律當整日)。
 *
 * 作法:對每個工作區間所橫跨的每一個「本地日」,在該日投影出夜間視窗
 * 的實際 epoch 區段 (跨午夜則延伸到隔日),再與工作區間取交集累加。
 */
function nightOverlapMinutes(
  intervals: Interval[],
  windowFrom: string,
  windowTo: string,
): number {
  const fromMin = hhmmToMinutes(windowFrom);
  const toMin = hhmmToMinutes(windowTo);
  const crossesMidnight = fromMin >= toMin;

  let total = 0;
  for (const iv of intervals) {
    // 列舉工作區間覆蓋到的每個本地日午夜 (含起點前一日,以涵蓋跨午夜視窗)。
    const firstDay = startOfLocalDay(iv.start) - MIN_PER_DAY * MS_PER_MIN;
    const lastDay = startOfLocalDay(iv.end);
    for (let day = firstDay; day <= lastDay; day += MIN_PER_DAY * MS_PER_MIN) {
      const winStart = day + fromMin * MS_PER_MIN;
      const winEnd = crossesMidnight
        ? day + (toMin + MIN_PER_DAY) * MS_PER_MIN
        : day + toMin * MS_PER_MIN;
      const lo = Math.max(iv.start, winStart);
      const hi = Math.min(iv.end, winEnd);
      if (hi > lo) total += (hi - lo) / MS_PER_MIN;
    }
  }
  return Math.round(total);
}

/** 依 mode 把分鐘數對 unit 取整 (unit <= 0 視為不取整)。 */
function roundToUnit(
  minutes: number,
  unit: number,
  mode: OvertimeRoundingMode,
): number {
  if (unit <= 0) return minutes;
  const q = minutes / unit;
  const n =
    mode === "floor" ? Math.floor(q) : mode === "ceil" ? Math.ceil(q) : Math.round(q);
  return n * unit;
}

/**
 * 加班分鐘管線 (順序固定,對應亞斯特出勤表的人工規則):
 *   raw → 用餐扣除 (「延長工時」> afterMinutes 時扣 deductMinutes,不低於 0)
 *       → 取整 (rounding.mode 對 unitMinutes;預設 30 分無條件捨去)
 *       → 最低分鐘 (取整後 < minimumMinutes → 0)
 *       → 保底時數 (該 dayType 的加班規則有 minChargeHours 且結果 > 0 時取 max,
 *                  國定假日「做 1 給 8」)
 *
 * 「延長工時」= 超過每日正常工時 (regularMinutes,預設 payroll.dailyRegularHours)
 * 的部分:平日的 raw 本身就是延長工時;例假/固定假的 raw 是整日工時,其中午休已在
 * computeAttendanceDay 扣過,故只有再超過正常工時 afterMinutes 以上才扣晚餐 (例假日
 * 做滿 8h 不會被扣 30 分 —— 這也是規則二黃金測試「例假日 8h → 480 分」的前提)。
 *
 * 匯出供 API 在人工調整 raw 分鐘後重跑同一條管線;dailyCapMinutes 刻意不在此裁切
 * (只回傳實際分鐘,超過與否由 API 判異常)。
 *
 * @param regularMinutes W9 加班起算基準 (省略 = payroll.dailyRegularHours × 60;
 *   overtime.basis='shift' 時呼叫端帶該日班表淨工時)。
 */
export function applyOvertimePipeline(
  rawMinutes: number,
  rules: RuleConfig,
  dayType: DayType,
  regularMinutes?: number,
): number {
  if (rawMinutes <= 0) return 0;
  let minutes = rawMinutes;

  const meal = resolveOvertimeMealBreak(rules);
  if (meal) {
    const regular = regularMinutes ?? rules.payroll.dailyRegularHours * 60;
    const extendedMinutes =
      dayType === "workday" ? minutes : Math.max(0, minutes - regular);
    if (extendedMinutes > meal.afterMinutes) {
      minutes = Math.max(0, minutes - meal.deductMinutes);
    }
  }

  const rounding = resolveOvertimeRounding(rules);
  minutes = roundToUnit(minutes, rounding.unitMinutes, rounding.mode);
  if (minutes < rounding.minimumMinutes) minutes = 0;

  if (minutes > 0) {
    const rule = rules.overtime.rules.find(
      (r) => r.when === DAY_TYPE_TO_OVERTIME_WHEN[dayType],
    );
    const minCharge = rule?.minChargeHours ?? 0;
    if (minCharge > 0) minutes = Math.max(minutes, Math.round(minCharge * 60));
  }
  return minutes;
}

/**
 * 未排班日的「班別」:整天 00:00–23:59 (沒有應到/應退時間,遲到/早退由呼叫端歸零),
 * 午休 = 租戶預設午休 (attendance.defaultLunch,預設 12:00 起 60 分)→ 工時扣「在班區間
 * 與午休的重疊」:09:00–18:00 = 8h、加班 0;10:00–19:00 同樣 8h;13:30–18:00 不扣。
 */
export function unscheduledShiftDef(rules: RuleConfig): ShiftDef {
  const lunch = resolveDefaultLunch(rules);
  return { start: "00:00", end: "23:59", breakMinutes: lunch.minutes, breakStart: lunch.start };
}

/**
 * 結算一天。
 * @param punches 一個 in/out 對,或多段 (含中離)。
 * @param shift   班別 (start/end 'HH:MM'、breakMinutes、選填 breakStart)。
 * @param rules   RuleConfig (取 night.window、payroll.dailyRegularHours、
 *                overtime.rounding / mealBreak / rules[].minChargeHours)。
 * @param ctx     該日屬性 (date + dayType + 選填 regularMinutes / leaveIntervals /
 *                punchedBreaks)。
 */
export function computeAttendanceDay(
  punches: PunchPair | PunchPair[],
  shift: ShiftDef,
  rules: RuleConfig,
  ctx: DayContext,
): AttendanceDay {
  const intervals = normalizePairs(punches);
  if (intervals.length === 0) {
    return {
      date: ctx.date,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      overtimeMinutesComputed: 0,
      nightMinutes: 0,
      dayType: ctx.dayType,
    };
  }

  // 班表投影的基準日 = 最早一段 inAt 的當天。
  const earliestIn = Math.min(...intervals.map((iv) => iv.start));
  const dayBase = startOfLocalDay(earliestIn);

  // 午休區間 (lunch-window.ts 的單一規則) 投影到基準日。
  const lunch = lunchWindowOf(shift);
  const lunchIv: Interval | null = lunch
    ? { start: dayBase + lunch.start * MS_PER_MIN, end: dayBase + lunch.end * MS_PER_MIN }
    : null;
  const explicitLunch = lunch !== null && lunch.source !== "legacy";

  // 工時 = 在班總分鐘 (各段相加) − 午休。
  //   • 明確的午休 (規則 1、2):扣「在班區間與午休的重疊」。打卡的休息段已從 punches 切掉,
  //     重疊只算到仍在班的部分,不會重複扣 (12:00–12:40 打了休息卡 → 再扣 12:40–13:00;
  //     15:00–15:10 打了休息卡 → 午休照扣 60)。
  //   • 舊推算 (規則 3):維持固定扣 breakMinutes;當天有打卡的休息段 → 已切掉,不再扣。
  const grossMinutes =
    intervals.reduce((acc, iv) => acc + (iv.end - iv.start) / MS_PER_MIN, 0);
  let breakDeduct: number;
  if (explicitLunch && lunchIv) {
    breakDeduct =
      intervals.reduce(
        (acc, iv) => acc + Math.max(0, Math.min(iv.end, lunchIv.end) - Math.max(iv.start, lunchIv.start)),
        0,
      ) / MS_PER_MIN;
  } else {
    breakDeduct = ctx.punchedBreaks ? 0 : shift.breakMinutes;
  }
  const workedMinutes = Math.max(0, Math.round(grossMinutes - breakDeduct));

  // 遲到/早退「免計」的時段:已核准請假,加上午休——明確的午休一律免計;舊推算的
  // 午休只在它跟某段請假相接 (或重疊) 時才用,銜接「請假 → 午休 → 到班」;沒有相接的
  // 請假 (或根本沒請假) 時維持照字面。相接容忍 1 分鐘:推算窗起點可能有小數分鐘
  // (13:00–20:05 → 16:02:30),前端的請假起訖四捨五入到整分。
  const leaveIvs = normalizeLeaveIntervals(ctx.leaveIntervals);
  const excused: Interval[] = [...leaveIvs];
  const legacyBridged =
    lunchIv !== null &&
    !explicitLunch &&
    leaveIvs.some((l) => l.start <= lunchIv.end + MS_PER_MIN && l.end >= lunchIv.start - MS_PER_MIN);
  if (lunchIv && (explicitLunch || legacyBridged)) excused.push(lunchIv);

  // 遲到:班表 start (投影到基準日) 到最早一段 inAt 之間,扣掉免計時段。
  const shiftStartMin = hhmmToMinutes(shift.start);
  const shiftStartMs = dayBase + shiftStartMin * MS_PER_MIN;
  const lateMinutes = Math.round(uncoveredMs(shiftStartMs, earliestIn, excused) / MS_PER_MIN);

  // 早退:最晚一段 outAt 到班表 end (投影到同一基準日;跨日班 end < start 投影到隔天)
  // 之間,扣掉免計時段。例假/固定假沒有「應到班到幾點」→ 0。
  const latestOut = Math.max(...intervals.map((iv) => iv.end));
  const shiftEndMin = hhmmToMinutes(shift.end);
  const shiftEndMs =
    dayBase +
    (shiftEndMin < shiftStartMin ? shiftEndMin + MIN_PER_DAY : shiftEndMin) *
      MS_PER_MIN;
  const earlyLeaveMinutes =
    ctx.dayType === "workday"
      ? Math.round(uncoveredMs(latestOut, shiftEndMs, excused) / MS_PER_MIN)
      : 0;

  // 加班:平日 = 超過「正常工時」的部分;例假/固定假 = 全部工時。正常工時預設是
  // payroll.dailyRegularHours (法定 8 小時);W9 的 basis='shift' 由呼叫端把該日
  // 班表淨工時放進 ctx.regularMinutes。這是 raw 值,再走 用餐扣除 → 取整 →
  // 最低分鐘 → 保底 的管線 (同一個 regularMinutes 也要傳給管線,否則兩段基準不一致)。
  const regularMinutes =
    ctx.regularMinutes != null && ctx.regularMinutes >= 0
      ? Math.round(ctx.regularMinutes)
      : rules.payroll.dailyRegularHours * 60;
  const rawOvertimeMinutes =
    ctx.dayType === "workday"
      ? Math.max(0, workedMinutes - regularMinutes)
      : workedMinutes;
  const overtimeMinutes = applyOvertimePipeline(
    rawOvertimeMinutes,
    rules,
    ctx.dayType,
    regularMinutes,
  );

  // 夜間:工作區間與 night.window 的重疊,再上限到實際工時(避免把休息算進
  // 夜間;當整班都在夜間視窗時,休息分鐘自然從夜間時數扣除)。
  const rawNight = nightOverlapMinutes(
    intervals,
    rules.night.window.from,
    rules.night.window.to,
  );
  const nightMinutes = Math.min(rawNight, workedMinutes);

  return {
    date: ctx.date,
    workedMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeMinutes,
    // 稽核用:引擎輸出時恆等於 overtimeMinutes,人工覆寫後才會分岔。
    overtimeMinutesComputed: overtimeMinutes,
    nightMinutes,
    dayType: ctx.dayType,
  };
}
