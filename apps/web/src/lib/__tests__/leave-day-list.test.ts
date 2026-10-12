import { describe, it, expect } from "vitest";
import type { LeaveRequest } from "../admin-api";
import type { CreateRequestBody } from "../ess-api";
import { contentLines } from "../approval-view";
import { summarizeSegments } from "../ess-notifications";
import { formatLeaveDuration } from "../leave-duration";
import { describeLeaveDayRow, nextLeaveDate, resolveLeaveDayList, type LeaveDayListContext, type LeaveDayRow } from "../leave-day-list";
import { hasWorkdayGap, needsDayList } from "../leave-gaps";
import type { LeavePeriod, ShiftLike } from "../leave-hours";
import { buildCreateBody, describeBody, describeRequest, isBuildError } from "../request-forms";

/**
 * 多日請假改成自選日期清單（2026-10-12 業主：自己挑日期、一天一天新增，日期可以不連續）。
 * 2026-10-12 是週一：10/12（一）、10/14（三）、10/20（二）；10/17、10/18 是週末。
 * 日班 09:00–18:00 休 60、午休 12:00–13:00：全天 8 時、上午 09:00–12:00 3 時、下午 13:00–18:00 5 時。
 */
const DAY_SHIFT: ShiftLike = { start_time: "09:00:00", end_time: "18:00:00", break_minutes: 60 };
const ctx = (dayTypeByDate: LeaveDayListContext["dayTypeByDate"] = {}): LeaveDayListContext => ({
  shiftByDate: {},
  defaultShift: DAY_SHIFT,
  dayTypeByDate,
});
const row = (id: string, date: string, period: LeavePeriod = "full", hoursStart = "", hoursCount = 0): LeaveDayRow => ({
  id,
  date,
  period,
  hoursStart,
  hoursCount,
});
const local = (s: string) => new Date(s).getTime();
const at = (iso: string) => new Date(iso).getTime();
function ok(result: ReturnType<typeof buildCreateBody>): CreateRequestBody {
  if (isBuildError(result)) throw new Error(result.error);
  return result;
}

const FULL = (date: string) => ({ date, startTime: "09:00", endTime: "18:00", hours: 8 });

describe("resolveLeaveDayList — 不連續的日期清單", () => {
  it("10/12 全天、10/14 下午、10/20 全天 → 三段（依日期）、合計 21 時＝2 天 5 時；body 一張單帶三段", () => {
    const list = resolveLeaveDayList([row("a", "2026-10-12"), row("b", "2026-10-14", "pm"), row("c", "2026-10-20")], ctx());
    expect(list.error).toBeUndefined();
    expect(list.warnings).toEqual([]);
    expect(list.segments).toEqual([
      FULL("2026-10-12"),
      { date: "2026-10-14", startTime: "13:00", endTime: "18:00", hours: 5 },
      FULL("2026-10-20"),
    ]);
    expect(list.totalHours).toBe(21);
    expect(formatLeaveDuration(list.totalHours)).toBe("2 天 5 時");
    expect(formatLeaveDuration(list.totalHours, 8)).toBe("2 天 5 時");

    const body = ok(buildCreateBody("leave", { leaveTypeId: "lt-annual", segments: list.segments, hours: list.totalHours, reason: "" }));
    expect(body.kind).toBe("leave");
    expect(body.segments).toEqual(list.segments);
    expect(body.hours).toBe(21);
    expect(at(body.startAt)).toBe(local("2026-10-12T09:00:00"));
    expect(at(body.endAt)).toBe(local("2026-10-20T18:00:00"));

    // 摘要逐日一行＋成功畫面／我的申請的那一行逐日列出（不會寫成「10/12–10/20」）
    expect(list.segments.map((seg) => describeLeaveDayRow(seg, DAY_SHIFT))).toEqual([
      "10/12（一）全天",
      "10/14（三）下午 13:00–18:00 5 時",
      "10/20（二）全天",
    ]);
    expect(describeBody(body, { shift: DAY_SHIFT })).toBe("10/12、10/14 下午、10/20 · 2 天 5 時");
  });

  it("列的順序是使用者排的（畫面不跳動），送出的 segments 依日期排序；body 的起訖取最早與最晚", () => {
    const list = resolveLeaveDayList([row("c", "2026-10-20"), row("a", "2026-10-12"), row("b", "2026-10-14", "pm")], ctx());
    expect(list.rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(list.segments.map((s) => s.date)).toEqual(["2026-10-12", "2026-10-14", "2026-10-20"]);

    // buildLeave 自己也會排序（就算傳進來的 segments 是亂的）
    const body = ok(
      buildCreateBody("leave", {
        leaveTypeId: "",
        segments: [FULL("2026-10-20"), FULL("2026-10-12"), { date: "2026-10-14", startTime: "13:00", endTime: "18:00", hours: 5 }],
        hours: 21,
        reason: "",
      }),
    );
    expect(body.segments?.map((s) => s.date)).toEqual(["2026-10-12", "2026-10-14", "2026-10-20"]);
    expect(at(body.startAt)).toBe(local("2026-10-12T09:00:00"));
    expect(at(body.endAt)).toBe(local("2026-10-20T18:00:00"));
  });

  it("同一天選兩次 → 第二列擋下（第一列沒事），整份不能送、segments 為空", () => {
    const list = resolveLeaveDayList([row("a", "2026-10-12"), row("b", "2026-10-14"), row("c", "2026-10-12", "pm")], ctx());
    expect(list.rows[0].error).toBeUndefined();
    expect(list.rows[1].error).toBeUndefined();
    expect(list.rows[2].error).toBe("這天已經選過了，同一天只能選一次");
    expect(list.error).toBe("10/12（一）：這天已經選過了，同一天只能選一次");
    expect(list.segments).toEqual([]);
    expect(list.totalHours).toBe(0);
  });

  it("休息日／國定假日／週末 → 提示但仍可送出（照單日的做法）；補班的週六不提示", () => {
    const list = resolveLeaveDayList(
      [row("a", "2026-10-19"), row("b", "2026-10-17"), row("c", "2026-10-16"), row("d", "2026-10-24")],
      ctx({ "2026-10-16": "rest_day", "2026-10-19": "fixed_holiday", "2026-10-24": "workday" }),
    );
    expect(list.error).toBeUndefined();
    expect(list.rows.map((r) => r.warning)).toEqual([
      "這天是國定假日，仍可送出",
      "這天是週末，仍可送出",
      "這天是休息日，仍可送出",
      undefined,
    ]);
    // 摘要的提示帶日期、依日期排序
    expect(list.warnings).toEqual([
      "10/16（五）是休息日，仍可送出",
      "10/17（六）是週末，仍可送出",
      "10/19（一）是國定假日，仍可送出",
    ]);
    expect(list.segments).toHaveLength(4);
    expect(list.totalHours).toBe(32);
    expect(formatLeaveDuration(list.totalHours)).toBe("4 天");
  });

  it("上午／指定時數和單日同一套：上午 09:00–12:00 3 時；10:00 起 3 小時跳過午休 → 10:00–14:00；合計 6 時", () => {
    const list = resolveLeaveDayList([row("a", "2026-10-20", "hours", "10:00", 3), row("b", "2026-10-21", "am")], ctx());
    expect(list.error).toBeUndefined();
    expect(list.segments).toEqual([
      { date: "2026-10-20", startTime: "10:00", endTime: "14:00", hours: 3 },
      { date: "2026-10-21", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]);
    expect(list.rows[0].hoursStartValue).toBe("10:00");
    expect(list.rows[0].hoursCountValue).toBe(3);
    expect(list.rows[0].startOptions[0]).toBe("09:00");
    expect(list.totalHours).toBe(6);
    expect(formatLeaveDuration(list.totalHours)).toBe("6 時");
    expect(list.segments.map((seg) => describeLeaveDayRow(seg, DAY_SHIFT))).toEqual([
      "10/20（二）10:00–14:00 3 時",
      "10/21（三）上午 09:00–12:00 3 時",
    ]);
    // 每日工時 7.5：合計換算跟著規則走
    const full = resolveLeaveDayList([row("a", "2026-10-12"), row("b", "2026-10-14", "pm"), row("c", "2026-10-20")], ctx());
    expect(formatLeaveDuration(full.totalHours, 7.5)).toBe("2 天 6 時");
  });

  it("日期沒填、清單空的、超過 31 天、中間隔一整個月 → 擋送出", () => {
    const blank = resolveLeaveDayList([row("a", "2026-10-12"), row("b", "")], ctx());
    expect(blank.rows[1].error).toBe("請選擇日期");
    expect(blank.error).toBe("請選擇日期");

    expect(resolveLeaveDayList([], ctx()).error).toBe("請新增請假日期");

    const many = Array.from({ length: 32 }, (_, i) => row(`r${i}`, `2026-1${i < 31 ? "0" : "1"}-${String((i % 31) + 1).padStart(2, "0")}`));
    expect(resolveLeaveDayList(many, ctx()).error).toBe("一次最多申請 31 天，請分開申請");

    // 10/30 ＋ 12/02：11 月整個是空檔，月份層級的檢查（發薪鎖定、月表）會把 11 月也當成碰到 → 請分兩張
    const gapMonth = resolveLeaveDayList([row("a", "2026-10-30"), row("b", "2026-12-02")], ctx());
    expect(gapMonth.error).toBe("日期中間隔了一整個月，請分成兩張申請");
    expect(gapMonth.segments).toEqual([]);
    // 相鄰月份可以：10/30 ＋ 11/30
    expect(resolveLeaveDayList([row("a", "2026-10-30"), row("b", "2026-11-30")], ctx()).error).toBeUndefined();
  });
});

describe("nextLeaveDate — 新增一列帶上一列的下一個上班日", () => {
  it("週五的下一列是下週一；碰到國定假日再往後；已在清單上的日子跳過；補班的週六算上班日", () => {
    expect(nextLeaveDate([row("a", "2026-10-09")], {}, "2026-10-09")).toBe("2026-10-12");
    expect(nextLeaveDate([row("a", "2026-10-09")], { "2026-10-12": "fixed_holiday" }, "2026-10-09")).toBe("2026-10-13");
    // 上一列＝最後一列（10/12），下一天 10/13 已經選了 → 10/14
    expect(nextLeaveDate([row("a", "2026-10-13"), row("b", "2026-10-12")], {}, "2026-10-12")).toBe("2026-10-14");
    expect(nextLeaveDate([row("a", "2026-10-23")], { "2026-10-24": "workday" }, "2026-10-23")).toBe("2026-10-24");
    // 最後一列沒填日期 → 看前一列；清單上都沒有日期 → 從 fallback（含）起找
    expect(nextLeaveDate([row("a", "2026-10-12"), row("b", "")], {}, "2026-10-01")).toBe("2026-10-13");
    expect(nextLeaveDate([], {}, "2026-10-17")).toBe("2026-10-19");
  });
});

describe("hasWorkdayGap 與顯示端（我的申請、簽核卡、後台簽核）", () => {
  it("中間有沒請的上班日才算不連續；只隔週末（週五＋週一）、連續日期、單段 → 連續", () => {
    expect(hasWorkdayGap([FULL("2026-10-12"), FULL("2026-10-14"), FULL("2026-10-20")])).toBe(true);
    expect(hasWorkdayGap([FULL("2026-10-20"), FULL("2026-10-12")])).toBe(true);
    expect(hasWorkdayGap([FULL("2026-10-09"), FULL("2026-10-12")])).toBe(false);
    expect(hasWorkdayGap([FULL("2026-10-12"), FULL("2026-10-13")])).toBe(false);
    expect(hasWorkdayGap([FULL("2026-10-12")])).toBe(false);
    expect(hasWorkdayGap(null)).toBe(false);
  });

  it("我的申請：連續的維持「首日–末日」，不連續的逐日列出，超過 4 天只列前 3 天＋等 N 個日期", () => {
    const base = { kind: "leave" as const, start_at: "2026-10-12T01:00:00Z", end_at: "2026-10-20T10:00:00Z", payout: null, trip_type: null, location: null, trip_scope: null, advance_requested: null, estimated_cost: null };
    expect(describeRequest({ ...base, hours: 16, segments: [FULL("2026-10-12"), FULL("2026-10-13")] }, { shift: DAY_SHIFT })).toBe("10/12–10/13 · 2 天");
    expect(describeRequest({ ...base, hours: 16, segments: [FULL("2026-10-09"), FULL("2026-10-12")] }, { shift: DAY_SHIFT })).toBe("10/09–10/12 · 2 天");
    expect(
      describeRequest({ ...base, hours: 24, segments: [FULL("2026-10-12"), FULL("2026-10-14"), FULL("2026-10-20")] }, { shift: DAY_SHIFT }),
    ).toBe("10/12、10/14、10/20 · 3 天");
    const five = ["2026-10-12", "2026-10-14", "2026-10-16", "2026-10-20", "2026-10-22"].map(FULL);
    expect(describeRequest({ ...base, hours: 40, segments: five }, { shift: DAY_SHIFT })).toBe("10/12、10/14、10/16…等 5 個日期 · 5 天");
  });

  it("連續但中間某天只請半天、首日只請上午 → 也逐日列出（「10/13–10/15」會看起來每天都整天）；舊多日的首尾部分天照舊", () => {
    const base = { kind: "leave" as const, start_at: "2026-10-13T01:00:00Z", end_at: "2026-10-15T10:00:00Z", payout: null, trip_type: null, location: null, trip_scope: null, advance_requested: null, estimated_cost: null };
    const am = (date: string) => ({ date, startTime: "09:00", endTime: "12:00", hours: 3 });
    const middleHalf = [FULL("2026-10-13"), am("2026-10-14"), FULL("2026-10-15")];
    expect(needsDayList(middleHalf)).toBe(true);
    expect(describeRequest({ ...base, hours: 19, segments: middleHalf }, { shift: DAY_SHIFT })).toBe("10/13、10/14 上午、10/15 · 2 天 3 時");
    const firstAm = [am("2026-10-13"), FULL("2026-10-14")];
    expect(describeRequest({ ...base, hours: 11, segments: firstAm }, { shift: DAY_SHIFT })).toBe("10/13 上午、10/14 · 1 天 3 時");
    const allAm = [am("2026-10-13"), am("2026-10-14"), am("2026-10-15")];
    expect(describeRequest({ ...base, hours: 9, segments: allAm }, { shift: DAY_SHIFT })).toBe("10/13 上午、10/14 上午、10/15 上午 · 1 天 1 時");
    // 舊多日表單的形狀（首日 14:00 起、中間整天、末日到 12:00）→ 維持「起 – 迄」
    const legacy = [
      { date: "2026-10-13", startTime: "14:00", endTime: "18:00", hours: 4 },
      FULL("2026-10-14"),
      { date: "2026-10-15", startTime: "09:00", endTime: "12:00", hours: 3 },
    ];
    expect(needsDayList(legacy)).toBe(false);
    expect(describeRequest({ ...base, hours: 15, segments: legacy }, { shift: DAY_SHIFT })).toBe("10/13 14:00 – 10/15 12:00 · 1 天 7 時");
    // 簽核卡 >3 段：中間一天只請上午 → 逐段一行
    const four = [FULL("2026-10-13"), am("2026-10-14"), FULL("2026-10-15"), FULL("2026-10-16")];
    expect(summarizeSegments(four).split("\n")).toEqual([
      "10/13 09:00–18:00 · 1 天",
      "10/14 09:00–12:00 · 3 時",
      "10/15 09:00–18:00 · 1 天",
      "10/16 09:00–18:00 · 1 天",
      "共 3 天 3 時",
    ]);
  });

  it("主管簽核卡：>3 段且不連續 → 不壓成「首日–末日」，逐段一行＋合計；連續的照舊壓縮", () => {
    const segs = ["2026-10-12", "2026-10-14", "2026-10-20", "2026-10-22"].map(FULL);
    expect(summarizeSegments(segs).split("\n")).toEqual([
      "10/12 09:00–18:00 · 1 天",
      "10/14 09:00–18:00 · 1 天",
      "10/20 09:00–18:00 · 1 天",
      "10/22 09:00–18:00 · 1 天",
      "共 4 天",
    ]);
    expect(summarizeSegments(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map(FULL))).toBe("10/12–10/15 全天 ×4 · 4 天");
  });

  it("後台簽核內容欄：不連續、每天都整天 → 也加「逐日」行（第一行的起 → 迄看不出空檔）", () => {
    const row = {
      id: "r1",
      tenant_id: "t",
      employee_id: "e",
      kind: "leave",
      leave_type_id: null,
      start_at: "2026-10-12T01:00:00+00:00",
      end_at: "2026-10-20T10:00:00+00:00",
      hours: 24,
      reason: null,
      agent_name: null,
      payout: null,
      trip_type: null,
      location: null,
      remark: null,
      segments: [FULL("2026-10-12"), FULL("2026-10-14"), FULL("2026-10-20")],
      status: "pending",
      current_step: 1,
      current_approver_emp_id: null,
      created_at: "2026-10-11T08:30:00+00:00",
    } as unknown as LeaveRequest;
    const lines = contentLines(row);
    expect(lines[1]).toBe("逐日：10/12 09:00–18:00 · 1 天、10/14 09:00–18:00 · 1 天、10/20 09:00–18:00 · 1 天");
  });
});
