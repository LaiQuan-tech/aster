import { describe, it, expect } from "vitest";
import { computeAttendanceDay, flexShiftDef, unscheduledShiftDef } from "../worktime-engine";
import { computePayslip } from "../payroll-engine";
import { lateAttendanceStatus, normalizeLateDecision, undecidedLateWarning } from "../late-attendance";
import { DEFAULT_FLEX_WINDOW, parseRuleConfig, resolveFlexWindow, type RuleConfig } from "../rules-schema";
import type { AttendanceDay, ShiftDef } from "../types";

/**
 * 彈性上班時窗＋遲到說明 × 全勤（2026-10-11 業主拍板）。時間一律 naive local（無 Z），
 * 與 settlement 餵給引擎的 pairs 相同。
 *   • 未排班的工作日：08:00–10:00 之間上班、做滿 8 小時（不含午休 12:00–13:00）。
 *   • 工時從 max(上班卡, 08:00) 起算；上班卡晚於 10:00 算遲到（整分鐘比較，10:00:59 不算）。
 *   • 應下班 = clamp(上班卡, 08:00, 10:00) + 8 小時 + 午休重疊；早於應下班下班算早退。
 */

const rules: RuleConfig = parseRuleConfig({
  attendance_bonus: {
    base: 2000,
    tiers: [
      { lateMinutesUpTo: 0, deduct: 0 },
      { lateMinutesUpTo: null, deduct: 2000 },
    ],
  },
  overtime: { rules: [{ when: "weekday_ot", multiplier: 1.34 }] },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly", dailyRegularHours: 8 },
});

const D = "2026-10-12"; // 週一
const at = (hms: string, date = D) => `${date}T${hms.length === 5 ? `${hms}:00` : hms}`;
const pair = (a: string, b: string) => ({ inAt: at(a), outAt: at(b) });
const workday = { date: D, dayType: "workday" as const };
const flex = flexShiftDef(rules) as ShiftDef;

describe("彈性上班時窗（attendance.flex）", () => {
  it("預設啟用 08:00–10:00、480 分；明示 null 關閉；startFrom 晚於 startUntil 會被擋", () => {
    expect(rules.attendance).toBeUndefined();
    expect(resolveFlexWindow(rules)).toEqual({ startFrom: "08:00", startUntil: "10:00", workMinutes: 480 });
    expect(DEFAULT_FLEX_WINDOW).toEqual({ startFrom: "08:00", startUntil: "10:00", workMinutes: 480 });
    expect(flex).toEqual({
      start: "08:00",
      end: "23:59",
      breakMinutes: 60,
      breakStart: "12:00",
      flex: { startFrom: "08:00", startUntil: "10:00", workMinutes: 480 },
    });
    const off = parseRuleConfig({ ...rules, attendance: { flex: null } });
    expect(resolveFlexWindow(off)).toBeNull();
    expect(flexShiftDef(off)).toBeNull();
    const custom = parseRuleConfig({ ...rules, attendance: { flex: { startFrom: "07:30", startUntil: "09:30", workMinutes: 450 } } });
    expect(resolveFlexWindow(custom)).toEqual({ startFrom: "07:30", startUntil: "09:30", workMinutes: 450 });
    expect(() => parseRuleConfig({ ...rules, attendance: { flex: { startFrom: "11:00", startUntil: "10:00", workMinutes: 480 } } })).toThrow();
    expect(() => parseRuleConfig({ ...rules, attendance: { flex: { startFrom: "08:00", startUntil: "10:00", workMinutes: 0 } } })).toThrow();
  });

  it.each([
    { name: "09:00–18:00 剛好", inAt: "09:00", outAt: "18:00", worked: 480, late: 0, early: 0, ot: 0 },
    { name: "08:00–17:00 最早", inAt: "08:00", outAt: "17:00", worked: 480, late: 0, early: 0, ot: 0 },
    { name: "10:00–19:00 最晚", inAt: "10:00", outAt: "19:00", worked: 480, late: 0, early: 0, ot: 0 },
    { name: "07:30 到、17:00 走：08:00 前不算工時，應下班 17:00", inAt: "07:30", outAt: "17:00", worked: 480, late: 0, early: 0, ot: 0 },
    { name: "07:00 到、18:30 走：工時從 08:00 起 → 570 → 加班 90（30 分捨去）", inAt: "07:00", outAt: "18:30", worked: 570, late: 0, early: 0, ot: 90 },
    { name: "09:30 到、18:00 走：應下班 18:30 → 早退 30", inAt: "09:30", outAt: "18:00", worked: 450, late: 0, early: 30, ot: 0 },
    { name: "10:30 到、19:00 走：遲到 30，應下班以 10:00 起算＝19:00", inAt: "10:30", outAt: "19:00", worked: 450, late: 30, early: 0, ot: 0 },
    { name: "11:00 到、20:00 走：遲到 60、不早退", inAt: "11:00", outAt: "20:00", worked: 480, late: 60, early: 0, ot: 0 },
    { name: "13:00 到：遲到只算 10:00–12:00（午休不算）", inAt: "13:00", outAt: "19:00", worked: 360, late: 120, early: 0, ot: 0 },
    { name: "09:00–21:00 加班：扣午休後 660 → 加班 180", inAt: "09:00", outAt: "21:00", worked: 660, late: 0, early: 0, ot: 180 },
  ])("$name", ({ inAt, outAt, worked, late, early, ot }) => {
    const day = computeAttendanceDay(pair(inAt, outAt), flex, rules, workday);
    expect(day.workedMinutes).toBe(worked);
    expect(day.lateMinutes).toBe(late);
    expect(day.earlyLeaveMinutes).toBe(early);
    expect(day.overtimeMinutes).toBe(ot);
  });

  it("遲到以整分鐘比較：10:00:59 不算、10:01:00 算 1 分；應下班也以整分鐘的上班時間起算", () => {
    expect(computeAttendanceDay(pair("10:00:59", "19:00"), flex, rules, workday).lateMinutes).toBe(0);
    expect(computeAttendanceDay(pair("10:01:00", "19:00"), flex, rules, workday).lateMinutes).toBe(1);
    // 09:00:40 到 → 視為 09:00 → 應下班 18:00 → 18:00 走不算早退
    expect(computeAttendanceDay(pair("09:00:40", "18:00"), flex, rules, workday).earlyLeaveMinutes).toBe(0);
  });

  it("已核准請假覆蓋的時段不算遲到／早退（連同午休）", () => {
    const leave = (a: string, b: string) => ({ from: at(a), to: at(b) });
    // 上午請 09:00–12:00、13:00 到 → 遲到 0
    expect(
      computeAttendanceDay(pair("13:00", "18:00"), flex, rules, { ...workday, leaveIntervals: [leave("09:00", "12:00")] }).lateMinutes,
    ).toBe(0);
    // 下午請 14:00–18:00、09:00 到 14:00 走 → 應下班 18:00，14:00–18:00 有請假 → 早退 0
    expect(
      computeAttendanceDay(pair("09:00", "14:00"), flex, rules, { ...workday, leaveIntervals: [leave("14:00", "18:00")] })
        .earlyLeaveMinutes,
    ).toBe(0);
    // 沒請假同樣情境 → 早退 240（14:00–18:00）
    expect(computeAttendanceDay(pair("09:00", "14:00"), flex, rules, workday).earlyLeaveMinutes).toBe(240);
  });

  it("夜間分鐘也只算 08:00 之後（08:00 前不算工時）", () => {
    const day = computeAttendanceDay(pair("05:00", "14:00"), flex, rules, workday);
    expect(day.workedMinutes).toBe(300); // 08:00–14:00 扣午休
    expect(day.nightMinutes).toBe(0);
  });

  it("例假日不套彈性（settlement 只在工作日用 flexShiftDef）：同一段打卡在例假日照整天算", () => {
    const rest = computeAttendanceDay(pair("07:00", "12:00"), unscheduledShiftDef(rules), rules, { date: D, dayType: "rest_day" });
    expect(rest.workedMinutes).toBe(300);
  });

  it("有排班的日子照班別起訖：09:00–18:00 班 09:01 到 → 遲到 1；09:00:59 → 0", () => {
    const shift: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "12:00" };
    expect(computeAttendanceDay(pair("09:01", "18:00"), shift, rules, workday).lateMinutes).toBe(1);
    expect(computeAttendanceDay(pair("09:00:59", "18:00"), shift, rules, workday).lateMinutes).toBe(0);
  });
});

describe("遲到說明 × 全勤（lateExempt／lateAttendanceStatus）", () => {
  const day = (date: string, lateMinutes: number, extra: Partial<AttendanceDay> = {}): AttendanceDay => ({
    date,
    workedMinutes: 480,
    lateMinutes,
    overtimeMinutes: 0,
    nightMinutes: 0,
    dayType: "workday",
    ...extra,
  });
  const salary = { method: "monthly" as const, baseSalary: 36000 };

  it("payroll-engine：老闆決定不影響全勤（lateExempt）的那天不累計；沒決定照算", () => {
    const counted = computePayslip([day("2026-10-12", 30), day("2026-10-13", 0)], salary, rules);
    expect(counted.attendanceDeduction).toBe(2000);
    const exempt = computePayslip([day("2026-10-12", 30, { lateExempt: true }), day("2026-10-13", 0)], salary, rules);
    expect(exempt.attendanceDeduction).toBe(0);
    expect(exempt.attendanceBonus).toBe(2000);
  });

  it("lateAttendanceStatus：未決定視為影響；exempt 的日子不計；依階梯判斷是否失去全勤", () => {
    const days = [
      { date: "2026-10-12", lateMinutes: 30 },
      { date: "2026-10-13", lateMinutes: 15 },
      { date: "2026-10-14", lateMinutes: 0 },
    ];
    const allExempt = lateAttendanceStatus({
      days,
      reports: [
        { workDate: "2026-10-12", lateMinutes: 30, decision: "exempt" },
        { workDate: "2026-10-13", lateMinutes: 15, decision: "exempt" },
      ],
      tiers: rules.attendance_bonus.tiers,
    });
    expect(allExempt).toMatchObject({ exemptCount: 2, undecidedCount: 0, countingLateMinutes: 0, attendanceDeduction: 0, losesFullAttendance: false });
    expect(allExempt.exemptDates).toEqual(["2026-10-12", "2026-10-13"]);

    const oneUndecided = lateAttendanceStatus({
      days,
      reports: [
        { workDate: "2026-10-12", lateMinutes: 30, decision: "exempt" },
        { workDate: "2026-10-13", lateMinutes: 15, decision: null },
      ],
      tiers: rules.attendance_bonus.tiers,
    });
    expect(oneUndecided).toMatchObject({ undecidedCount: 1, countingLateMinutes: 15, attendanceDeduction: 2000, losesFullAttendance: true });

    // 沒給 tiers：有任何計入的遲到分鐘就算失去全勤
    expect(lateAttendanceStatus({ reports: [{ workDate: "2026-10-12", lateMinutes: 5, decision: "affects" }] })).toMatchObject({
      affectsCount: 1,
      countingLateMinutes: 5,
      attendanceDeduction: null,
      losesFullAttendance: true,
    });
    expect(lateAttendanceStatus({ reports: [] }).losesFullAttendance).toBe(false);
  });

  it("normalizeLateDecision／undecidedLateWarning", () => {
    expect(normalizeLateDecision("affects")).toBe("affects");
    expect(normalizeLateDecision("exempt")).toBe("exempt");
    expect(normalizeLateDecision("whatever")).toBeNull();
    expect(normalizeLateDecision(null)).toBeNull();
    expect(undecidedLateWarning(0)).toBeNull();
    expect(undecidedLateWarning(2)).toBe("2 筆遲到說明老闆尚未決定（視為影響全勤）");
  });
});
