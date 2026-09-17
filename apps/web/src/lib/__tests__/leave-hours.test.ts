import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHIFT,
  computeLeaveSegments,
  customHours,
  halfDayWindow,
  isWorkday,
  listDates,
  normalizeHm,
  shiftWorkHours,
  type LeaveHoursInput,
  type ShiftLike,
} from "../leave-hours";

/** 日班（正式租戶的第一個 shift）；DB time 欄位會回 HH:mm:ss，這裡故意用這種格式。 */
const DAY_SHIFT: ShiftLike = { start_time: "09:00:00", end_time: "18:00:00", break_minutes: 60 };
/** 夜班 22:00–06:00 休 60 → 7 小時。 */
const NIGHT_SHIFT: ShiftLike = { start_time: "22:00", end_time: "06:00", break_minutes: 60 };
/** 09:00–17:50 休 45 → 485 分 = 8.0833… → 8.08。 */
const ODD_SHIFT: ShiftLike = { start_time: "09:00", end_time: "17:50", break_minutes: 45 };

function base(over: Partial<LeaveHoursInput>): LeaveHoursInput {
  return {
    startDate: "2026-09-18", // 週五
    period: "full",
    shiftByDate: {},
    defaultShift: DAY_SHIFT,
    dayTypeByDate: {},
    ...over,
  };
}

describe("shiftWorkHours / halfDayWindow / customHours", () => {
  it("日班 09:00–18:00 休 60 → 8 小時（HH:mm:ss 也能吃）", () => {
    expect(shiftWorkHours(DAY_SHIFT)).toBe(8);
    expect(shiftWorkHours(DEFAULT_SHIFT)).toBe(8);
    expect(normalizeHm("09:00:00")).toBe("09:00");
  });

  it("上午 09:00–13:00／下午 14:00–18:00 各 4 小時", () => {
    expect(halfDayWindow(DAY_SHIFT, "am")).toEqual({ startTime: "09:00", endTime: "13:00", hours: 4 });
    expect(halfDayWindow(DAY_SHIFT, "pm")).toEqual({ startTime: "14:00", endTime: "18:00", hours: 4 });
  });

  it("自訂 09:00–18:00 扣除休息窗 13:00–14:00 ＝ 8 小時", () => {
    expect(customHours(DAY_SHIFT, "09:00", "18:00")).toBe(8);
  });

  it("自訂 13:30–17:00：牆鐘 3.5 小時，與休息窗重疊 30 分 → 3 小時", () => {
    expect(customHours(DAY_SHIFT, "13:30", "17:00")).toBe(3);
  });

  it("自訂結束不晚於開始（日班）→ 0；格式不對 → 0", () => {
    expect(customHours(DAY_SHIFT, "14:00", "14:00")).toBe(0);
    expect(customHours(DAY_SHIFT, "15:00", "14:00")).toBe(0);
    expect(customHours(DAY_SHIFT, "abc", "14:00")).toBe(0);
  });

  it("夜班跨日：22:00–06:00 休 60 → 7 小時；上午 22:00–01:30、下午 02:30–06:00；自訂 23:00–02:00 = 3 小時（休息窗 01:30–02:30 重疊 30 分 → 2.5）", () => {
    expect(shiftWorkHours(NIGHT_SHIFT)).toBe(7);
    expect(halfDayWindow(NIGHT_SHIFT, "am")).toEqual({ startTime: "22:00", endTime: "01:30", hours: 3.5 });
    expect(halfDayWindow(NIGHT_SHIFT, "pm")).toEqual({ startTime: "02:30", endTime: "06:00", hours: 3.5 });
    expect(customHours(NIGHT_SHIFT, "23:00", "02:00")).toBe(2.5);
  });

  it("四捨五入 2 位：09:00–17:50 休 45 → 8.08，上下午各 4.04", () => {
    expect(shiftWorkHours(ODD_SHIFT)).toBe(8.08);
    expect(halfDayWindow(ODD_SHIFT, "am").hours).toBe(4.04);
  });
});

describe("listDates / isWorkday", () => {
  it("listDates 含起迄；迄早於起 → []", () => {
    expect(listDates("2026-09-18", "2026-09-21")).toEqual(["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"]);
    expect(listDates("2026-09-21", "2026-09-18")).toEqual([]);
    expect(listDates("2026-12-31", "2027-01-01")).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("isWorkday：workday → true；rest_day／fixed_holiday → false；未裁定看週六日", () => {
    expect(isWorkday("2026-09-19", "workday")).toBe(true); // 週六補班
    expect(isWorkday("2026-09-18", "rest_day")).toBe(false);
    expect(isWorkday("2026-09-18", "fixed_holiday")).toBe(false);
    expect(isWorkday("2026-09-18", undefined)).toBe(true); // 週五
    expect(isWorkday("2026-09-19", undefined)).toBe(false); // 週六
    expect(isWorkday("2026-09-20", undefined)).toBe(false); // 週日
  });
});

describe("computeLeaveSegments", () => {
  it("單日全天 → 1 段 09:00–18:00 · 8 小時", () => {
    const r = computeLeaveSegments(base({}));
    expect(r.error).toBeUndefined();
    expect(r.segments).toEqual([{ date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 }]);
    expect(r.totalHours).toBe(8);
    expect(r.skipped).toEqual([]);
  });

  it("單日上午／下午各 4 小時", () => {
    expect(computeLeaveSegments(base({ period: "am" })).segments[0]).toEqual({
      date: "2026-09-18",
      startTime: "09:00",
      endTime: "13:00",
      hours: 4,
    });
    expect(computeLeaveSegments(base({ period: "pm" })).totalHours).toBe(4);
  });

  it("單日自訂 13:30–17:00 → 3 小時；缺時間或結束不晚於開始 → error", () => {
    const ok = computeLeaveSegments(base({ period: "custom", customStart: "13:30", customEnd: "17:00" }));
    expect(ok.segments[0]).toEqual({ date: "2026-09-18", startTime: "13:30", endTime: "17:00", hours: 3 });
    expect(computeLeaveSegments(base({ period: "custom" })).error).toBe("請輸入起訖時間");
    expect(computeLeaveSegments(base({ period: "custom", customStart: "15:00", customEnd: "14:00" })).error).toBe(
      "結束時間需晚於開始時間",
    );
  });

  it("多日跨週末：09/18（五）–09/21（一）→ 2 段 16 小時、略過六日；多日鎖全天（傳 am 也算全天）", () => {
    const r = computeLeaveSegments(base({ endDate: "2026-09-21", period: "am" }));
    expect(r.error).toBeUndefined();
    expect(r.segments.map((s) => s.date)).toEqual(["2026-09-18", "2026-09-21"]);
    expect(r.segments.every((s) => s.hours === 8)).toBe(true);
    expect(r.totalHours).toBe(16);
    expect(r.skipped).toEqual([
      { date: "2026-09-19", reason: "weekend" },
      { date: "2026-09-20", reason: "weekend" },
    ]);
  });

  it("行事曆裁定 workday 的週六（補班）保留；fixed_holiday 的平日跳過並標理由", () => {
    const r = computeLeaveSegments(
      base({
        startDate: "2026-09-18",
        endDate: "2026-09-22",
        dayTypeByDate: { "2026-09-19": "workday", "2026-09-21": "fixed_holiday", "2026-09-22": "rest_day" },
      }),
    );
    expect(r.segments.map((s) => s.date)).toEqual(["2026-09-18", "2026-09-19"]);
    expect(r.totalHours).toBe(16);
    expect(r.skipped).toEqual([
      { date: "2026-09-20", reason: "weekend" },
      { date: "2026-09-21", reason: "fixed_holiday" },
      { date: "2026-09-22", reason: "rest_day" },
    ]);
  });

  it("多日範圍內沒有工作日 → error「這個範圍沒有工作日」", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-09-19", endDate: "2026-09-20" }));
    expect(r.error).toBe("這個範圍沒有工作日");
    expect(r.segments).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it("單日選到週末／假日：不跳過但給 warning", () => {
    const weekend = computeLeaveSegments(base({ startDate: "2026-09-19" }));
    expect(weekend.error).toBeUndefined();
    expect(weekend.segments).toHaveLength(1);
    expect(weekend.warning).toBe("這天是週末，仍可送出");
    const holiday = computeLeaveSegments(base({ dayTypeByDate: { "2026-09-18": "fixed_holiday" } }));
    expect(holiday.warning).toBe("這天是國定假日，仍可送出");
  });

  it("有排班的日子用該日班別，沒排班用 defaultShift；連 shift 都沒有用 DEFAULT_SHIFT", () => {
    const r = computeLeaveSegments(
      base({
        endDate: "2026-09-21",
        shiftByDate: { "2026-09-21": ODD_SHIFT },
      }),
    );
    expect(r.segments).toEqual([
      { date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2026-09-21", startTime: "09:00", endTime: "17:50", hours: 8.08 },
    ]);
    expect(r.totalHours).toBe(16.08);

    const noShift = computeLeaveSegments(base({ defaultShift: DEFAULT_SHIFT }));
    expect(noShift.segments[0]).toEqual({ date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 });
  });

  it("夜班跨日全天：22:00–06:00 · 7 小時", () => {
    const r = computeLeaveSegments(base({ defaultShift: NIGHT_SHIFT }));
    expect(r.segments[0]).toEqual({ date: "2026-09-18", startTime: "22:00", endTime: "06:00", hours: 7 });
  });

  it("日期缺漏／迄早於起 → error；超過 31 個工作日 → error", () => {
    expect(computeLeaveSegments(base({ startDate: "" })).error).toBe("請選擇日期");
    expect(computeLeaveSegments(base({ endDate: "2026-09-17" })).error).toBe("結束日期不可早於開始日期");
    const tooLong = computeLeaveSegments(base({ startDate: "2026-09-01", endDate: "2026-10-31" }));
    expect(tooLong.error).toMatch(/最多申請 31 天/);
  });
});
