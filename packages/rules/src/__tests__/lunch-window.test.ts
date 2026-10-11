import { describe, it, expect } from "vitest";
import {
  NOON_MINUTES,
  hhmmToMinutesOrNull,
  lunchFitsShift,
  lunchWindowMinutes,
  lunchWindowOf,
  overlapMinutes,
} from "../lunch-window";
import { computeAttendanceDay, unscheduledShiftDef } from "../worktime-engine";
import {
  DEFAULT_LUNCH,
  parseRuleConfig,
  resolveDefaultLunch,
  type RuleConfig,
} from "../rules-schema";
import type { ShiftDef } from "../types";
import { LUNCH_CASES } from "./lunch-window-cases";

/**
 * 午休時窗（2026-10-11 業主決定：午休 12:00–13:00，「做滿 8 小時」不含午休）＋
 * 請假時段不算遲到／早退。時間一律用 naive local（無 Z），與 settlement 餵給引擎的 pairs 相同。
 */

const rules: RuleConfig = parseRuleConfig({
  attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
  overtime: { rules: [{ when: "weekday_ot", multiplier: 1.34 }] },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly", dailyRegularHours: 8 },
});

const D = "2026-09-01"; // 週二
const at = (hhmm: string, date = D) => `${date}T${hhmm}:00`;
const pair = (a: string, b: string) => ({ inAt: at(a), outAt: at(b) });
const workday = { date: D, dayType: "workday" as const };

const DAY: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60 };
const DAY_SET: ShiftDef = { ...DAY, breakStart: "12:00" };
const AFTERNOON: ShiftDef = { start: "14:00", end: "22:00", breakMinutes: 60 };

describe("lunchWindowOf — 共用案例表（web 的 lunch-window-parity.test.ts 用同一張）", () => {
  it.each(LUNCH_CASES)("$name", ({ shift, expected }) => {
    expect(lunchWindowOf(shift)).toEqual(expected);
  });

  it("lunchWindowMinutes 是同一條規則的數字版（下班已換到班別座標）", () => {
    expect(lunchWindowMinutes(540, 1080, 60, null)).toEqual({ start: NOON_MINUTES, end: 780, source: "noon" });
    expect(lunchWindowMinutes(1320, 1800, 60, 120)).toEqual({ start: 1560, end: 1620, source: "break_start" });
    expect(lunchWindowMinutes(540, 1080, 0, 720)).toBeNull();
    expect(lunchWindowMinutes(540, 540, 60, null)).toBeNull(); // 長度 0 的班
  });

  it("hhmmToMinutesOrNull：HH:MM／HH:MM:SS；格式不對 → null", () => {
    expect(hhmmToMinutesOrNull("12:00")).toBe(720);
    expect(hhmmToMinutesOrNull("09:30:00")).toBe(570);
    expect(hhmmToMinutesOrNull("24:00")).toBe(1440);
    expect(hhmmToMinutesOrNull("24:30")).toBeNull();
    expect(hhmmToMinutesOrNull("25:00")).toBeNull();
    expect(hhmmToMinutesOrNull("12:60")).toBeNull();
    expect(hhmmToMinutesOrNull("")).toBeNull();
    expect(hhmmToMinutesOrNull(null)).toBeNull();
  });

  it("lunchFitsShift：整段午休要在上班時間內（晚於上班開始、不晚於下班結束）；沒有午休一律 true", () => {
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "12:00" })).toBe(true);
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "17:00" })).toBe(true);
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "17:30" })).toBe(false);
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "08:00" })).toBe(false);
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "09:00" })).toBe(false); // 上班第一個小時
    expect(lunchFitsShift({ start: "bad", end: "18:00", breakMinutes: 60, breakStart: "12:00" })).toBe(false);
    expect(lunchFitsShift({ start: "22:00", end: "06:00", breakMinutes: 60, breakStart: "02:00" })).toBe(true);
    expect(lunchFitsShift({ start: "22:00", end: "06:00", breakMinutes: 60, breakStart: "06:00" })).toBe(false);
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 60 })).toBe(true); // 規則 2
    expect(lunchFitsShift({ start: "09:00", end: "18:00", breakMinutes: 0, breakStart: "20:00" })).toBe(true);
  });

  it("overlapMinutes：半開區間重疊長度", () => {
    expect(overlapMinutes(540, 1080, 720, 780)).toBe(60);
    expect(overlapMinutes(810, 1080, 720, 780)).toBe(0); // 13:30–18:00
    expect(overlapMinutes(750, 1080, 720, 780)).toBe(30); // 12:30–18:00
    expect(overlapMinutes(780, 1080, 720, 780)).toBe(0); // 剛好接在午休後
  });
});

describe("預設午休（attendance.defaultLunch）", () => {
  it("省略 → 12:00 起 60 分；舊 config 不帶 attendance 照樣 parse", () => {
    expect(rules.attendance).toBeUndefined();
    expect(resolveDefaultLunch(rules)).toEqual({ start: "12:00", minutes: 60 });
    expect(DEFAULT_LUNCH).toEqual({ start: "12:00", minutes: 60 });
    expect(unscheduledShiftDef(rules)).toEqual({ start: "00:00", end: "23:59", breakMinutes: 60, breakStart: "12:00" });
  });

  it("可覆寫；格式不對／分鐘超出範圍會被擋", () => {
    const custom = parseRuleConfig({ ...rules, attendance: { defaultLunch: { start: "12:30", minutes: 45 } } });
    expect(resolveDefaultLunch(custom)).toEqual({ start: "12:30", minutes: 45 });
    expect(() => parseRuleConfig({ ...rules, attendance: { defaultLunch: { start: "12", minutes: 60 } } })).toThrow();
    expect(() => parseRuleConfig({ ...rules, attendance: { defaultLunch: { start: "12:00", minutes: -1 } } })).toThrow();
    expect(() => parseRuleConfig({ ...rules, attendance: { defaultLunch: { start: "12:00", minutes: 300 } } })).toThrow();
    // attendance: {} 合法，仍用預設
    expect(resolveDefaultLunch(parseRuleConfig({ ...rules, attendance: {} }))).toEqual(DEFAULT_LUNCH);
  });
});

describe("未排班日（unscheduledShiftDef）：在班區間與 12:00–13:00 重疊多少就扣多少", () => {
  const shift = unscheduledShiftDef(rules);

  it.each([
    { inAt: "09:00", outAt: "18:00", worked: 480, ot: 0, why: "業主：09:00–18:00 剛好 8 小時、加班 0" },
    { inAt: "10:00", outAt: "19:00", worked: 480, ot: 0, why: "10:00–19:00 同樣 8 小時" },
    { inAt: "13:30", outAt: "18:00", worked: 270, ot: 0, why: "13:30 才到：不重疊午休 → 不扣" },
    { inAt: "12:30", outAt: "18:00", worked: 300, ot: 0, why: "12:30 到：只重疊 30 分 → 扣 30" },
    { inAt: "09:00", outAt: "12:00", worked: 180, ot: 0, why: "只做上午：不扣" },
    { inAt: "09:00", outAt: "21:00", worked: 660, ot: 180, why: "做到 21:00：扣午休後 11h → 加班 3h（未超過 180 分不扣晚餐）" },
    { inAt: "08:30", outAt: "18:45", worked: 555, ot: 60, why: "淨 555 → 超過 480 的 75 分 → 取整 60" },
  ])("$inAt–$outAt → 工時 $worked、加班 $ot（$why）", ({ inAt, outAt, worked, ot }) => {
    const day = computeAttendanceDay(pair(inAt, outAt), shift, rules, workday);
    expect(day.workedMinutes).toBe(worked);
    expect(day.overtimeMinutes).toBe(ot);
  });

  it("多段打卡（中午打卡離開）：只扣仍在班的那部分重疊", () => {
    const day = computeAttendanceDay([pair("09:00", "12:15"), pair("12:50", "18:00")], shift, rules, workday);
    // 在班 195 + 310 = 505；與 12:00–13:00 重疊 15 + 10 = 25 → 480。
    expect(day.workedMinutes).toBe(480);
  });

  it("租戶把預設午休改成 12:30 起 30 分 → 09:00–18:00 扣 30 = 510", () => {
    const custom = parseRuleConfig({ ...rules, attendance: { defaultLunch: { start: "12:30", minutes: 30 } } });
    const day = computeAttendanceDay(pair("09:00", "18:00"), unscheduledShiftDef(custom), custom, workday);
    expect(day.workedMinutes).toBe(510);
  });

  it("打卡休息段已從 punches 切掉：午休只扣仍在班的重疊，不會重複扣", () => {
    const ctx = { ...workday, punchedBreaks: true };
    // 12:00–13:00 整段打卡休息 → 剩下的區間不碰午休 → 480
    expect(computeAttendanceDay([pair("09:00", "12:00"), pair("13:00", "18:00")], shift, rules, ctx).workedMinutes).toBe(480);
    // 12:00–12:40 打卡休息 → 切掉 40，午休再扣 12:40–13:00 的 20 → 480
    expect(computeAttendanceDay([pair("09:00", "12:00"), pair("12:40", "18:00")], shift, rules, ctx).workedMinutes).toBe(480);
    // 15:00–15:10 打卡休息 → 切掉 10，午休 12:00–13:00 照扣 60 → 470、加班 0
    const short = computeAttendanceDay([pair("09:00", "15:00"), pair("15:10", "18:00")], shift, rules, ctx);
    expect(short.workedMinutes).toBe(470);
    expect(short.overtimeMinutes).toBe(0);
  });

  it("舊推算班別（午班）有打卡休息段 → 維持舊行為：不再固定扣 breakMinutes", () => {
    const day = computeAttendanceDay([pair("14:00", "17:00"), pair("17:30", "22:00")], AFTERNOON, rules, {
      ...workday,
      punchedBreaks: true,
    });
    expect(day.workedMinutes).toBe(450);
  });
});

describe("有排班：明確午休（規則 1、2）扣重疊；舊推算（規則 3）維持固定扣", () => {
  it("日班整天 09:00–18:00：規則 1、2 都是 480（與舊的固定扣 60 相同）", () => {
    expect(computeAttendanceDay(pair("09:00", "18:00"), DAY, rules, workday).workedMinutes).toBe(480);
    expect(computeAttendanceDay(pair("09:00", "18:00"), DAY_SET, rules, workday).workedMinutes).toBe(480);
  });

  it("日班只做下午 13:30–18:00 → 270（舊算法固定扣 60 會變 210）", () => {
    expect(computeAttendanceDay(pair("13:30", "18:00"), DAY_SET, rules, workday).workedMinutes).toBe(270);
  });

  it("日班只做上午 09:00–12:00 → 180（舊算法 120）", () => {
    expect(computeAttendanceDay(pair("09:00", "12:00"), DAY, rules, workday).workedMinutes).toBe(180);
  });

  it("午班 14:00–22:00（不涵蓋 12:00）行為不變：14:00–17:00 仍固定扣 60 → 120", () => {
    expect(computeAttendanceDay(pair("14:00", "17:00"), AFTERNOON, rules, workday).workedMinutes).toBe(120);
    expect(computeAttendanceDay(pair("14:00", "22:00"), AFTERNOON, rules, workday).workedMinutes).toBe(420);
  });

  it("午班明設晚餐 18:00（規則 1）→ 改扣重疊：14:00–17:00 → 180", () => {
    const set: ShiftDef = { ...AFTERNOON, breakStart: "18:00" };
    expect(computeAttendanceDay(pair("14:00", "17:00"), set, rules, workday).workedMinutes).toBe(180);
    expect(computeAttendanceDay(pair("14:00", "22:00"), set, rules, workday).workedMinutes).toBe(420);
  });

  it("夜班明設 02:00（跨日）→ 22:00–06:00 扣隔日 02:00–03:00 → 420", () => {
    const night: ShiftDef = { start: "22:00", end: "06:00", breakMinutes: 60, breakStart: "02:00" };
    const day = computeAttendanceDay(
      { inAt: at("22:00"), outAt: at("06:00", "2026-09-02") },
      night,
      rules,
      workday,
    );
    expect(day.workedMinutes).toBe(420);
    expect(day.earlyLeaveMinutes).toBe(0);
  });
});

describe("遲到／早退：不計午休（規則 1、2）", () => {
  it("沒請假、13:00 才到 → 遲到 180（09–12；12–13 是午休，舊算法 240）", () => {
    const day = computeAttendanceDay(pair("13:00", "18:00"), DAY, rules, workday);
    expect(day.lateMinutes).toBe(180);
  });

  it("沒請假、12:00 走 → 早退 300（13–18；舊算法 360）；12:30 走一樣 300", () => {
    expect(computeAttendanceDay(pair("09:00", "12:00"), DAY, rules, workday).earlyLeaveMinutes).toBe(300);
    expect(computeAttendanceDay(pair("09:00", "12:30"), DAY, rules, workday).earlyLeaveMinutes).toBe(300);
  });

  it("沒碰到午休的遲到／早退照舊：09:13 到 → 13；17:00 走 → 60", () => {
    expect(computeAttendanceDay(pair("09:13", "18:00"), DAY, rules, workday).lateMinutes).toBe(13);
    expect(computeAttendanceDay(pair("09:00", "17:00"), DAY, rules, workday).earlyLeaveMinutes).toBe(60);
  });

  it("午班（舊推算）沒請假維持照字面：19:00 才到 → 遲到 300", () => {
    expect(computeAttendanceDay(pair("19:00", "22:00"), AFTERNOON, rules, workday).lateMinutes).toBe(300);
  });
});

describe("請假時段不算遲到／早退（ctx.leaveIntervals：已核准請假）", () => {
  const leave = (a: string, b: string, date = D) => ({ from: at(a, date), to: at(b, date) });

  it("業主例：上午請 09:00–12:00、13:00 到班 → 遲到 0（12:00–13:00 是午休）", () => {
    const day = computeAttendanceDay(pair("13:00", "18:00"), DAY, rules, { ...workday, leaveIntervals: [leave("09:00", "12:00")] });
    expect(day.lateMinutes).toBe(0);
    expect(day.workedMinutes).toBe(300);
  });

  it("上午請 09:00–12:00、13:20 才到 → 遲到 20", () => {
    const day = computeAttendanceDay(pair("13:20", "18:00"), DAY, rules, { ...workday, leaveIntervals: [leave("09:00", "12:00")] });
    expect(day.lateMinutes).toBe(20);
  });

  it("請假期間就到班（11:00 到）→ 遲到 0", () => {
    const day = computeAttendanceDay(pair("11:00", "18:00"), DAY, rules, { ...workday, leaveIntervals: [leave("09:00", "12:00")] });
    expect(day.lateMinutes).toBe(0);
  });

  it("業主例：下午請 14:00–18:00、14:00 下班 → 早退 0；13:30 走 → 早退 30", () => {
    const ctx = { ...workday, leaveIntervals: [leave("14:00", "18:00")] };
    expect(computeAttendanceDay(pair("09:00", "14:00"), DAY, rules, ctx).earlyLeaveMinutes).toBe(0);
    expect(computeAttendanceDay(pair("09:00", "13:30"), DAY, rules, ctx).earlyLeaveMinutes).toBe(30);
  });

  it("下午請 14:00–18:00、12:00 就走 → 早退 60（13:00–14:00 沒上到）", () => {
    const day = computeAttendanceDay(pair("09:00", "12:00"), DAY, rules, { ...workday, leaveIntervals: [leave("14:00", "18:00")] });
    expect(day.earlyLeaveMinutes).toBe(60);
  });

  it("請中間 10:00–12:00、13:00 才到 → 只算 09:00–10:00 沒到：遲到 60", () => {
    const day = computeAttendanceDay(pair("13:00", "18:00"), DAY, rules, { ...workday, leaveIntervals: [leave("10:00", "12:00")] });
    expect(day.lateMinutes).toBe(60);
  });

  it("午班（舊推算 17:30–18:30）的推算窗只在跟請假相接時才銜接：請 21:00–22:00、18:30 到 → 遲到 270（照字面）", () => {
    const day = computeAttendanceDay(pair("18:30", "21:00"), AFTERNOON, rules, {
      ...workday,
      leaveIntervals: [leave("21:00", "22:00")],
    });
    expect(day.lateMinutes).toBe(270);
    expect(day.earlyLeaveMinutes).toBe(0);
  });

  it("午班（舊推算 17:30–18:30）有請假時用推算窗銜接：請 14:00–17:30、18:30 到 → 遲到 0", () => {
    const day = computeAttendanceDay(pair("18:30", "22:00"), AFTERNOON, rules, {
      ...workday,
      leaveIntervals: [leave("14:00", "17:30")],
    });
    expect(day.lateMinutes).toBe(0);
    // 工時仍走舊行為（固定扣 60）：210 − 60 = 150。
    expect(day.workedMinutes).toBe(150);
  });

  it("舊推算窗有小數分鐘（13:00–20:05 → 16:02:30–17:02:30）：前端四捨五入的上午假 13:00–16:02 仍算接上 → 17:03 到只差 1 分", () => {
    const odd: ShiftDef = { start: "13:00", end: "20:05", breakMinutes: 60 };
    const am = computeAttendanceDay(pair("17:03", "20:05"), odd, rules, { ...workday, leaveIntervals: [leave("13:00", "16:02")] });
    expect(am.lateMinutes).toBe(1);
    const pm = computeAttendanceDay(pair("13:00", "16:02"), odd, rules, { ...workday, leaveIntervals: [leave("17:03", "20:05")] });
    expect(pm.earlyLeaveMinutes).toBe(1);
  });

  it("請假跨日（ISO 字串、整段涵蓋）也只看與遲到區段的交集；起訖顛倒的壞資料略過", () => {
    const day = computeAttendanceDay(pair("13:00", "18:00"), DAY, rules, {
      ...workday,
      leaveIntervals: [
        { from: "2026-08-31T09:00:00", to: at("12:00") },
        { from: at("17:00"), to: at("16:00") },
      ],
    });
    expect(day.lateMinutes).toBe(0);
  });

  it("請假不影響工時、加班與夜間", () => {
    const withLeave = computeAttendanceDay(pair("13:00", "20:00"), DAY, rules, {
      ...workday,
      leaveIntervals: [leave("09:00", "12:00")],
    });
    const without = computeAttendanceDay(pair("13:00", "20:00"), DAY, rules, workday);
    expect(withLeave.workedMinutes).toBe(without.workedMinutes);
    expect(withLeave.overtimeMinutes).toBe(without.overtimeMinutes);
    expect(withLeave.nightMinutes).toBe(without.nightMinutes);
  });
});
