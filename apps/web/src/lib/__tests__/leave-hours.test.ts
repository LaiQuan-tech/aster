import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHIFT,
  computeLeaveSegments,
  customHours,
  describeHalfDays,
  endTimeForHours,
  endTimeOptions,
  halfDayWindow,
  isWorkday,
  listDates,
  maxHoursFrom,
  normalizeHm,
  pickOption,
  resolveLeavePick,
  shiftWorkHours,
  startTimeOptions,
  type LeaveHoursInput,
  type LeavePickState,
  type ShiftLike,
} from "../leave-hours";

/**
 * 日班（正式租戶的第一個 shift）；DB time 欄位會回 HH:mm:ss，這裡故意用這種格式。
 * 沒設 break_start、涵蓋 12:00 → 午休 12:00–13:00（2026-10-11 業主決定；以前推成 13:00–14:00）。
 */
const DAY_SHIFT: ShiftLike = { start_time: "09:00:00", end_time: "18:00:00", break_minutes: 60 };
/** 夜班 22:00–06:00 休 60 → 7 小時。 */
const NIGHT_SHIFT: ShiftLike = { start_time: "22:00", end_time: "06:00", break_minutes: 60 };
/** 09:00–17:50 休 45 → 485 分 = 8.0833… → 8.08；涵蓋 12:00 → 午休 12:00–12:45。 */
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

  it("上午／下午以午休為界（2026-10-11 業主採 B）：日班上午 09:00–12:00 3 小時、下午 13:00–18:00 5 小時", () => {
    expect(halfDayWindow(DAY_SHIFT, "am")).toEqual({ startTime: "09:00", endTime: "12:00", hours: 3 });
    expect(halfDayWindow(DAY_SHIFT, "pm")).toEqual({ startTime: "13:00", endTime: "18:00", hours: 5 });
    expect(halfDayWindow(DEFAULT_SHIFT, "am")).toEqual({ startTime: "09:00", endTime: "12:00", hours: 3 });
    expect(halfDayWindow(DEFAULT_SHIFT, "pm")).toEqual({ startTime: "13:00", endTime: "18:00", hours: 5 });
    // 時數與同一段的自訂起訖一致，上午＋下午＝全天
    expect(customHours(DAY_SHIFT, "09:00", "12:00")).toBe(3);
    expect(customHours(DAY_SHIFT, "13:00", "18:00")).toBe(5);
    expect(halfDayWindow(DAY_SHIFT, "am").hours + halfDayWindow(DAY_SHIFT, "pm").hours).toBe(shiftWorkHours(DAY_SHIFT));
    // 午休明設 12:00（正式租戶日班回填後的樣子）結果相同
    const set12: ShiftLike = { ...DAY_SHIFT, break_start: "12:00" };
    expect(halfDayWindow(set12, "am")).toEqual({ startTime: "09:00", endTime: "12:00", hours: 3 });
    expect(halfDayWindow(set12, "pm")).toEqual({ startTime: "13:00", endTime: "18:00", hours: 5 });
  });

  it("班別明設午休（break_start）→ 以它為界：13:00 起 → 上午 09:00–13:00 4、下午 14:00–18:00 4；12:30 起 → 3.5／4.5", () => {
    const set: ShiftLike = { ...DAY_SHIFT, break_start: "13:00" };
    expect(halfDayWindow(set, "am")).toEqual({ startTime: "09:00", endTime: "13:00", hours: 4 });
    expect(halfDayWindow(set, "pm")).toEqual({ startTime: "14:00", endTime: "18:00", hours: 4 });
    expect(customHours(set, "13:30", "17:00")).toBe(3);
    const half: ShiftLike = { ...DAY_SHIFT, break_start: "12:30" };
    expect(halfDayWindow(half, "am")).toEqual({ startTime: "09:00", endTime: "12:30", hours: 3.5 });
    expect(halfDayWindow(half, "pm")).toEqual({ startTime: "13:30", endTime: "18:00", hours: 4.5 });
  });

  it("晚到班 10:00–19:00 休 60（涵蓋 12:00）→ 午休 12:00–13:00；上午 10:00–12:00 2 小時、下午 13:00–19:00 6 小時", () => {
    const late: ShiftLike = { start_time: "10:00", end_time: "19:00", break_minutes: 60 };
    expect(halfDayWindow(late, "am")).toEqual({ startTime: "10:00", endTime: "12:00", hours: 2 });
    expect(halfDayWindow(late, "pm")).toEqual({ startTime: "13:00", endTime: "19:00", hours: 6 });
  });

  it("午班 14:00–22:00 休 60（不涵蓋午休，舊推算 17:30–18:30）維持各半：上午 14:00–17:30、下午 18:30–22:00 各 3.5", () => {
    const pm: ShiftLike = { start_time: "14:00", end_time: "22:00", break_minutes: 60 };
    expect(halfDayWindow(pm, "am")).toEqual({ startTime: "14:00", endTime: "17:30", hours: 3.5 });
    expect(halfDayWindow(pm, "pm")).toEqual({ startTime: "18:30", endTime: "22:00", hours: 3.5 });
    expect(customHours(pm, "17:00", "19:00")).toBe(1);
  });

  it("沒有休息的班別 09:00–17:00 → 沒有分界，維持各半：上午 09:00–13:00、下午 13:00–17:00 各 4", () => {
    const noBreak: ShiftLike = { start_time: "09:00", end_time: "17:00", break_minutes: 0 };
    expect(halfDayWindow(noBreak, "am")).toEqual({ startTime: "09:00", endTime: "13:00", hours: 4 });
    expect(halfDayWindow(noBreak, "pm")).toEqual({ startTime: "13:00", endTime: "17:00", hours: 4 });
  });

  it("表單說明 describeHalfDays：日班「以午休為界…」；午班／沒有休息的班別「…各半」", () => {
    expect(describeHalfDays(DAY_SHIFT)).toBe("以午休為界：上午 09:00–12:00（3 時）、下午 13:00–18:00（5 時）");
    expect(describeHalfDays({ start_time: "14:00", end_time: "22:00", break_minutes: 60 })).toBe(
      "這個班別沒有涵蓋午休，上午、下午各半：上午 14:00–17:30（3 時 30 分）、下午 18:30–22:00（3 時 30 分）",
    );
    expect(describeHalfDays({ start_time: "09:00", end_time: "17:00", break_minutes: 0 })).toBe(
      "這個班別沒有午休，上午、下午各半：上午 09:00–13:00（4 時）、下午 13:00–17:00（4 時）",
    );
  });

  it("自訂 09:00–18:00 扣除午休 12:00–13:00 ＝ 8 小時", () => {
    expect(customHours(DAY_SHIFT, "09:00", "18:00")).toBe(8);
  });

  it("自訂 12:30–17:00：牆鐘 4.5 小時，與午休 12:00–13:00 重疊 30 分 → 4 小時；13:30–17:00 不重疊 → 3.5", () => {
    expect(customHours(DAY_SHIFT, "12:30", "17:00")).toBe(4);
    expect(customHours(DAY_SHIFT, "13:30", "17:00")).toBe(3.5);
  });

  it("自訂結束不晚於開始（日班）→ 0；格式不對 → 0", () => {
    expect(customHours(DAY_SHIFT, "14:00", "14:00")).toBe(0);
    expect(customHours(DAY_SHIFT, "15:00", "14:00")).toBe(0);
    expect(customHours(DAY_SHIFT, "abc", "14:00")).toBe(0);
  });

  it("夜班跨日：22:00–06:00 休 60 → 7 小時；沒設休息開始 → 維持各半：上午 22:00–01:30、下午 02:30–06:00；自訂 23:00–02:00 = 3 小時（休息窗 01:30–02:30 重疊 30 分 → 2.5）", () => {
    expect(shiftWorkHours(NIGHT_SHIFT)).toBe(7);
    expect(halfDayWindow(NIGHT_SHIFT, "am")).toEqual({ startTime: "22:00", endTime: "01:30", hours: 3.5 });
    expect(halfDayWindow(NIGHT_SHIFT, "pm")).toEqual({ startTime: "02:30", endTime: "06:00", hours: 3.5 });
    expect(customHours(NIGHT_SHIFT, "23:00", "02:00")).toBe(2.5);
  });

  it("夜班明設休息開始 02:00（管理員自己設的分界）→ 以它為界：上午 22:00–02:00 4、下午 03:00–06:00 3", () => {
    const set: ShiftLike = { ...NIGHT_SHIFT, break_start: "02:00" };
    expect(halfDayWindow(set, "am")).toEqual({ startTime: "22:00", endTime: "02:00", hours: 4 });
    expect(halfDayWindow(set, "pm")).toEqual({ startTime: "03:00", endTime: "06:00", hours: 3 });
  });

  it("四捨五入 2 位：09:00–17:50 休 45 → 8.08；午休 12:00–12:45 為界 → 上午 3、下午 12:45–17:50 5.08", () => {
    expect(shiftWorkHours(ODD_SHIFT)).toBe(8.08);
    expect(halfDayWindow(ODD_SHIFT, "am")).toEqual({ startTime: "09:00", endTime: "12:00", hours: 3 });
    expect(halfDayWindow(ODD_SHIFT, "pm")).toEqual({ startTime: "12:45", endTime: "17:50", hours: 5.08 });
  });

  it("各半的四捨五入：午班 14:00–21:50 休 45 → 7.08，上下午各 3.54（推算休息在中點，差 0.3 分不算跨過）", () => {
    const odd: ShiftLike = { start_time: "14:00", end_time: "21:50", break_minutes: 45 };
    expect(shiftWorkHours(odd)).toBe(7.08);
    expect(halfDayWindow(odd, "am")).toEqual({ startTime: "14:00", endTime: "17:32", hours: 3.54 });
    expect(halfDayWindow(odd, "pm")).toEqual({ startTime: "18:18", endTime: "21:50", hours: 3.54 });
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

  it("單日上午 09:00–12:00 · 3 小時、下午 13:00–18:00 · 5 小時（以午休為界）", () => {
    const am = computeLeaveSegments(base({ period: "am" }));
    expect(am.segments).toEqual([{ date: "2026-09-18", startTime: "09:00", endTime: "12:00", hours: 3 }]);
    expect(am.totalHours).toBe(3);
    const pm = computeLeaveSegments(base({ period: "pm" }));
    expect(pm.segments).toEqual([{ date: "2026-09-18", startTime: "13:00", endTime: "18:00", hours: 5 }]);
    expect(pm.totalHours).toBe(5);
    // 有排班的日子用該日班別：午班仍各半
    const pmShift: ShiftLike = { start_time: "14:00", end_time: "22:00", break_minutes: 60 };
    const amOnPm = computeLeaveSegments(base({ period: "am", shiftByDate: { "2026-09-18": pmShift } }));
    expect(amOnPm.segments).toEqual([{ date: "2026-09-18", startTime: "14:00", endTime: "17:30", hours: 3.5 }]);
  });

  it("單日自訂 12:30–17:00 → 4 小時（午休重疊 30 分不算）；缺時間或結束不晚於開始 → error", () => {
    const ok = computeLeaveSegments(base({ period: "custom", customStart: "12:30", customEnd: "17:00" }));
    expect(ok.segments[0]).toEqual({ date: "2026-09-18", startTime: "12:30", endTime: "17:00", hours: 4 });
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

/* ------------------------------------------------------------------------
 * 請假單位精細到小時（2026-10-11）：1 小時一格的時間選項、單日指定時數、多日首尾部分天。
 * 日班 09:00–18:00 休 60 → 午休 12:00–13:00；2026-10-13 是週二（10/17、10/18 週末）。
 * ---------------------------------------------------------------------- */

describe("startTimeOptions／endTimeOptions（1 小時一格，午休不給選）", () => {
  it("日班：開始 09:00 起每小時一格、12:00（午休內）不給，13:00 給；17:00 還剩 1 小時是最後一格", () => {
    expect(startTimeOptions(DAY_SHIFT)).toEqual(["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
  });

  it("日班：結束 10:00 起，12:00（請到午休開始）可選、13:00 與午休內不給，最後一格固定是下班 18:00", () => {
    expect(endTimeOptions(DAY_SHIFT)).toEqual(["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
  });

  it("下班時間不在整點格上（09:00–17:50 休 45，午休 12:00–12:45）：開始不給 12:00、少最後一格；結束最後一格是 17:50", () => {
    expect(startTimeOptions(ODD_SHIFT)).toEqual(["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]);
    expect(endTimeOptions(ODD_SHIFT).slice(-3)).toEqual(["16:00", "17:00", "17:50"]);
  });

  it("午班 14:00–22:00（舊推算午休 17:30–18:30）時間選項與以前相同", () => {
    const pm: ShiftLike = { start_time: "14:00", end_time: "22:00", break_minutes: 60 };
    expect(startTimeOptions(pm)).toEqual(["14:00", "15:00", "16:00", "17:00", "19:00", "20:00", "21:00"]);
    expect(endTimeOptions(pm)).toEqual(["15:00", "16:00", "17:00", "19:00", "20:00", "21:00", "22:00"]);
  });

  it("夜班 22:00–06:00：開始 22:00、23:00、00:00、01:00，02:00 在午休（01:30–02:30）裡不給；結束最後一格 06:00", () => {
    expect(startTimeOptions(NIGHT_SHIFT)).toEqual(["22:00", "23:00", "00:00", "01:00", "03:00", "04:00", "05:00"]);
    expect(endTimeOptions(NIGHT_SHIFT)).toEqual(["23:00", "00:00", "01:00", "03:00", "04:00", "05:00", "06:00"]);
  });

  it("沒有休息（0 分）的短班 09:00–13:00：開始 09:00–12:00 四格、結束 10:00–13:00 四格", () => {
    const half: ShiftLike = { start_time: "09:00", end_time: "13:00", break_minutes: 0 };
    expect(startTimeOptions(half)).toEqual(["09:00", "10:00", "11:00", "12:00"]);
    expect(endTimeOptions(half)).toEqual(["10:00", "11:00", "12:00", "13:00"]);
  });

  it("pickOption：選的值在選項裡就用；不在（換班別）或空 → 退回第一格／最後一格；選項為空 → 空字串", () => {
    const options = ["09:00", "10:00", "11:00"];
    expect(pickOption(options, "10:00", "first")).toBe("10:00");
    expect(pickOption(options, "", "first")).toBe("09:00");
    expect(pickOption(options, "08:30", "first")).toBe("09:00");
    expect(pickOption(options, "08:30", "last")).toBe("11:00");
    expect(pickOption(options, undefined, "last")).toBe("11:00");
    expect(pickOption([], "09:00", "first")).toBe("");
  });
});

describe("maxHoursFrom／endTimeForHours（指定時數：自動算結束時間、跳過午休）", () => {
  it("maxHoursFrom：09:00 起 8、10:00 起 7、11:00 起 6（午休不算）、13:00 起 5、14:00 起 4、17:00 起 1", () => {
    expect(maxHoursFrom(DAY_SHIFT, "09:00")).toBe(8);
    expect(maxHoursFrom(DAY_SHIFT, "10:00")).toBe(7);
    expect(maxHoursFrom(DAY_SHIFT, "11:00")).toBe(6);
    expect(maxHoursFrom(DAY_SHIFT, "13:00")).toBe(5);
    expect(maxHoursFrom(DAY_SHIFT, "14:00")).toBe(4);
    expect(maxHoursFrom(DAY_SHIFT, "17:00")).toBe(1);
  });

  it("maxHoursFrom：午休內、上班前、下班時間、格式不對 → 0；工時有小數（8.08）無條件捨去成 8", () => {
    expect(maxHoursFrom(DAY_SHIFT, "12:00")).toBe(0);
    expect(maxHoursFrom(DAY_SHIFT, "12:30")).toBe(0);
    expect(maxHoursFrom(DAY_SHIFT, "08:00")).toBe(0);
    expect(maxHoursFrom(DAY_SHIFT, "18:00")).toBe(0);
    expect(maxHoursFrom(DAY_SHIFT, "abc")).toBe(0);
    expect(maxHoursFrom(ODD_SHIFT, "09:00")).toBe(8);
  });

  it("endTimeForHours：09:00 起 3 小時 → 12:00（剛好到午休開始）、4 小時 → 14:00、5 小時 → 15:00（午休不算）、8 小時 → 18:00", () => {
    expect(endTimeForHours(DAY_SHIFT, "09:00", 3)).toBe("12:00");
    expect(endTimeForHours(DAY_SHIFT, "09:00", 4)).toBe("14:00");
    expect(endTimeForHours(DAY_SHIFT, "09:00", 5)).toBe("15:00");
    expect(endTimeForHours(DAY_SHIFT, "09:00", 8)).toBe("18:00");
    expect(endTimeForHours(DAY_SHIFT, "10:00", 2)).toBe("12:00");
    expect(endTimeForHours(DAY_SHIFT, "10:00", 3)).toBe("14:00");
    expect(endTimeForHours(DAY_SHIFT, "11:00", 3)).toBe("15:00");
    expect(endTimeForHours(DAY_SHIFT, "13:00", 2)).toBe("15:00");
    expect(endTimeForHours(DAY_SHIFT, "14:00", 4)).toBe("18:00");
    expect(endTimeForHours(DAY_SHIFT, "17:00", 1)).toBe("18:00");
    expect(endTimeForHours(DAY_SHIFT, "09:00", 0.5)).toBe("09:30");
  });

  it("endTimeForHours：超過下班、午休內開始、時數不是正數、格式不對 → null", () => {
    expect(endTimeForHours(DAY_SHIFT, "09:00", 9)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "14:00", 5)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "17:00", 2)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "12:00", 1)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "09:00", 0)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "09:00", -1)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "09:00", Number.NaN)).toBeNull();
    expect(endTimeForHours(DAY_SHIFT, "xx", 1)).toBeNull();
  });

  it("夜班：23:00 起 3 小時 → 03:00（跳過 01:30–02:30 午休）、00:00 起 2 小時 → 03:00；22:00 起最多 7 小時", () => {
    expect(endTimeForHours(NIGHT_SHIFT, "23:00", 3)).toBe("03:00");
    expect(endTimeForHours(NIGHT_SHIFT, "00:00", 2)).toBe("03:00");
    expect(maxHoursFrom(NIGHT_SHIFT, "22:00")).toBe(7);
    expect(endTimeForHours(NIGHT_SHIFT, "22:00", 7)).toBe("06:00");
  });

  it("每個開始時間 × 每個可選時數：結束時間算得出來，且用 customHours 反算回來剛好是那個時數（三種班別）", () => {
    for (const shift of [DAY_SHIFT, NIGHT_SHIFT, ODD_SHIFT]) {
      const starts = startTimeOptions(shift);
      expect(starts.length).toBeGreaterThan(0);
      for (const start of starts) {
        const max = maxHoursFrom(shift, start);
        expect(max).toBeGreaterThanOrEqual(1);
        for (let h = 1; h <= max; h += 1) {
          const end = endTimeForHours(shift, start, h);
          expect(end, `${JSON.stringify(shift)} ${start} +${h}h`).not.toBeNull();
          expect(customHours(shift, start, end as string), `${JSON.stringify(shift)} ${start}–${end}`).toBe(h);
        }
        expect(endTimeForHours(shift, start, max + 1)).toBeNull();
      }
    }
  });
});

describe("computeLeaveSegments — 單日指定時數", () => {
  const TUE = "2026-10-13";

  it("10:00 起 3 小時 → 10:00–14:00（午休 12:00–13:00 不算）· 3 小時；10:00 起 2 小時 → 10:00–12:00", () => {
    const r = computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "10:00", hoursCount: 3 }));
    expect(r.error).toBeUndefined();
    expect(r.segments).toEqual([{ date: TUE, startTime: "10:00", endTime: "14:00", hours: 3 }]);
    expect(r.totalHours).toBe(3);
    const two = computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "10:00", hoursCount: 2 }));
    expect(two.segments).toEqual([{ date: TUE, startTime: "10:00", endTime: "12:00", hours: 2 }]);
  });

  it("跨午休：11:00 起 3 小時 → 11:00–15:00（午休 12:00–13:00 不算）· 3 小時；09:00 起 3 小時 ＝ 上午、13:00 起 5 小時 ＝ 下午", () => {
    const across = computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "11:00", hoursCount: 3 }));
    expect(across.segments).toEqual([{ date: TUE, startTime: "11:00", endTime: "15:00", hours: 3 }]);
    const am = computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "09:00", hoursCount: 3 }));
    expect(am.segments[0]).toEqual({ ...halfDayWindow(DAY_SHIFT, "am"), date: TUE });
    const pm = computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "13:00", hoursCount: 5 }));
    expect(pm.segments[0]).toEqual({ ...halfDayWindow(DAY_SHIFT, "pm"), date: TUE });
  });

  it("開始時間可帶 HH:mm:ss；有排班的日子用該日班別（夜班 23:00 起 3 小時 → 23:00–03:00）", () => {
    const r = computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "10:00:00", hoursCount: 1 }));
    expect(r.segments[0]).toEqual({ date: TUE, startTime: "10:00", endTime: "11:00", hours: 1 });
    const night = computeLeaveSegments(
      base({ startDate: TUE, period: "hours", hoursStart: "23:00", hoursCount: 3, shiftByDate: { [TUE]: NIGHT_SHIFT } }),
    );
    expect(night.segments[0]).toEqual({ date: TUE, startTime: "23:00", endTime: "03:00", hours: 3 });
  });

  it("缺開始時間／時數、開始在午休、時數超過下班前可請的 → error", () => {
    expect(computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursCount: 2 })).error).toBe("請選擇開始時間");
    expect(computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "10:00" })).error).toBe("請選擇請假時數");
    expect(computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "10:00", hoursCount: 0 })).error).toBe(
      "請選擇請假時數",
    );
    expect(computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "12:00", hoursCount: 1 })).error).toBe(
      "開始時間要在上班時間內，且不能落在午休",
    );
    expect(computeLeaveSegments(base({ startDate: TUE, period: "hours", hoursStart: "14:00", hoursCount: 5 })).error).toBe(
      "請假時數超過當天開始時間之後可請的時數",
    );
  });

  it("單日選到週末：指定時數照算，只給 warning", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-17", period: "hours", hoursStart: "09:00", hoursCount: 2 }));
    expect(r.segments).toEqual([{ date: "2026-10-17", startTime: "09:00", endTime: "11:00", hours: 2 }]);
    expect(r.warning).toBe("這天是週末，仍可送出");
  });
});

describe("computeLeaveSegments — 多日首尾部分天", () => {
  it("週二 14:00 → 週四 12:00：首日 14:00–18:00 4 小時、週三整天 8 小時、末日 09:00–12:00 3 小時，共 15 小時", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-15", startTime: "14:00", endTime: "12:00" }));
    expect(r.error).toBeUndefined();
    expect(r.segments).toEqual([
      { date: "2026-10-13", startTime: "14:00", endTime: "18:00", hours: 4 },
      { date: "2026-10-14", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2026-10-15", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]);
    expect(r.totalHours).toBe(15);
    expect(r.skipped).toEqual([]);
  });

  it("首尾跨午休：首日 11:00 起（11–12＋13–18 ＝ 6 小時）、末日請到 15:00（09–12＋13–15 ＝ 5 小時）", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-15", startTime: "11:00", endTime: "15:00" }));
    expect(r.segments).toEqual([
      { date: "2026-10-13", startTime: "11:00", endTime: "18:00", hours: 6 },
      { date: "2026-10-14", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2026-10-15", startTime: "09:00", endTime: "15:00", hours: 5 },
    ]);
    expect(r.totalHours).toBe(19);
  });

  it("首日 13:00 起（午休後）＝ 5 小時；末日請到 12:00（午休開始）＝ 3 小時，請到 13:00（午休結束）一樣 3 小時", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-14", startTime: "13:00", endTime: "12:00" }));
    expect(r.segments).toEqual([
      { date: "2026-10-13", startTime: "13:00", endTime: "18:00", hours: 5 },
      { date: "2026-10-14", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]);
    expect(r.totalHours).toBe(8);
    const toLunchEnd = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-14", startTime: "13:00", endTime: "13:00" }));
    expect(toLunchEnd.segments[1]).toEqual({ date: "2026-10-14", startTime: "09:00", endTime: "13:00", hours: 3 });
  });

  it("遇週末：週五 14:00 → 下週一 12:00，週六日自動不計 → 週五 4 小時＋週一 3 小時 ＝ 7 小時", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-16", endDate: "2026-10-19", startTime: "14:00", endTime: "12:00" }));
    expect(r.segments).toEqual([
      { date: "2026-10-16", startTime: "14:00", endTime: "18:00", hours: 4 },
      { date: "2026-10-19", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]);
    expect(r.totalHours).toBe(7);
    expect(r.skipped).toEqual([
      { date: "2026-10-17", reason: "weekend" },
      { date: "2026-10-18", reason: "weekend" },
    ]);
  });

  it("遇國定假日：中間的假日不計；補班的週六算工作日（整天）", () => {
    const r = computeLeaveSegments(
      base({
        startDate: "2026-10-15",
        endDate: "2026-10-19",
        startTime: "16:00",
        endTime: "11:00",
        dayTypeByDate: { "2026-10-16": "fixed_holiday", "2026-10-17": "workday" },
      }),
    );
    expect(r.segments).toEqual([
      { date: "2026-10-15", startTime: "16:00", endTime: "18:00", hours: 2 },
      { date: "2026-10-17", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2026-10-19", startTime: "09:00", endTime: "11:00", hours: 2 },
    ]);
    expect(r.totalHours).toBe(12);
    expect(r.skipped).toEqual([
      { date: "2026-10-16", reason: "fixed_holiday" },
      { date: "2026-10-18", reason: "weekend" },
    ]);
  });

  it("起始日是休息日：開始時間對它沒有意義，第一個工作日整天；結束日是休息日：結束時間同理", () => {
    const startOnHoliday = computeLeaveSegments(
      base({
        startDate: "2026-10-13",
        endDate: "2026-10-15",
        startTime: "14:00",
        endTime: "12:00",
        dayTypeByDate: { "2026-10-13": "fixed_holiday" },
      }),
    );
    expect(startOnHoliday.segments).toEqual([
      { date: "2026-10-14", startTime: "09:00", endTime: "18:00", hours: 8 },
      { date: "2026-10-15", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]);
    expect(startOnHoliday.skipped).toEqual([{ date: "2026-10-13", reason: "fixed_holiday" }]);

    const endOnWeekend = computeLeaveSegments(base({ startDate: "2026-10-16", endDate: "2026-10-17", startTime: "14:00", endTime: "12:00" }));
    expect(endOnWeekend.segments).toEqual([{ date: "2026-10-16", startTime: "14:00", endTime: "18:00", hours: 4 }]);
    expect(endOnWeekend.skipped).toEqual([{ date: "2026-10-17", reason: "weekend" }]);
  });

  it("開始＝上班時間、結束＝下班時間（或不傳）＝每天整天，與原本多日行為相同", () => {
    const whole = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-15", startTime: "09:00", endTime: "18:00" }));
    const omitted = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-15" }));
    expect(whole).toEqual(omitted);
    expect(whole.segments.every((s) => s.startTime === "09:00" && s.endTime === "18:00" && s.hours === 8)).toBe(true);
    expect(whole.totalHours).toBe(24);
    // 早於上班的開始時間／晚於下班的結束時間也只是整天，不會多算
    const loose = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-15", startTime: "08:00", endTime: "20:00" }));
    expect(loose).toEqual(omitted);
  });

  it("多日只看 startTime／endTime，不看 period（傳 am 也不影響）；單日不看 startTime／endTime", () => {
    const multi = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-14", period: "am", startTime: "14:00" }));
    expect(multi.segments.map((s) => s.hours)).toEqual([4, 8]);
    const single = computeLeaveSegments(base({ startDate: "2026-10-13", period: "full", startTime: "14:00", endTime: "12:00" }));
    expect(single.segments).toEqual([{ date: "2026-10-13", startTime: "09:00", endTime: "18:00", hours: 8 }]);
  });

  it("兩端各用自己那天的班別：首日是 09:00–17:50（休 45）14:00 起 → 3.83 小時，末日日班請到 12:00 → 3 小時", () => {
    const r = computeLeaveSegments(
      base({
        startDate: "2026-10-13",
        endDate: "2026-10-14",
        startTime: "14:00",
        endTime: "12:00",
        shiftByDate: { "2026-10-13": ODD_SHIFT },
      }),
    );
    expect(r.segments).toEqual([
      { date: "2026-10-13", startTime: "14:00", endTime: "17:50", hours: 3.83 },
      { date: "2026-10-14", startTime: "09:00", endTime: "12:00", hours: 3 },
    ]);
    expect(r.totalHours).toBe(6.83);
  });

  it("夜班多日：週二 23:00 起（23:00–06:00 扣午休 ＝ 6 小時）→ 週三請到 03:00（22:00–03:00 扣午休 ＝ 4 小時）", () => {
    const r = computeLeaveSegments(
      base({ startDate: "2026-10-13", endDate: "2026-10-14", startTime: "23:00", endTime: "03:00", defaultShift: NIGHT_SHIFT }),
    );
    expect(r.segments).toEqual([
      { date: "2026-10-13", startTime: "23:00", endTime: "06:00", hours: 6 },
      { date: "2026-10-14", startTime: "22:00", endTime: "03:00", hours: 4 },
    ]);
    expect(r.totalHours).toBe(10);
  });

  it("開始時間不早於下班、結束時間不晚於上班、格式不對 → error", () => {
    const range = { startDate: "2026-10-13", endDate: "2026-10-15" };
    expect(computeLeaveSegments(base({ ...range, startTime: "18:00" })).error).toBe("開始時間需早於當天下班時間");
    expect(computeLeaveSegments(base({ ...range, startTime: "19:30" })).error).toBe("開始時間需早於當天下班時間");
    expect(computeLeaveSegments(base({ ...range, endTime: "09:00" })).error).toBe("結束時間需晚於當天上班時間");
    expect(computeLeaveSegments(base({ ...range, endTime: "07:00" })).error).toBe("結束時間需晚於當天上班時間");
    expect(computeLeaveSegments(base({ ...range, startTime: "abc" })).error).toBe("開始時間格式不正確");
    expect(computeLeaveSegments(base({ ...range, endTime: "xx" })).error).toBe("結束時間格式不正確");
  });

  it("首日請到下班前最後 1 小時（17:00 起）也算；整段範圍沒有工作日仍是 error", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-14", startTime: "17:00", endTime: "10:00" }));
    expect(r.segments.map((s) => s.hours)).toEqual([1, 1]);
    expect(r.totalHours).toBe(2);
    const none = computeLeaveSegments(base({ startDate: "2026-10-17", endDate: "2026-10-18", startTime: "14:00" }));
    expect(none.error).toBe("這個範圍沒有工作日");
  });

  it("多日請假的逐日 hours 加總等於 totalHours，且每段 hours 與 customHours（起訖＋午休）一致", () => {
    const r = computeLeaveSegments(base({ startDate: "2026-10-13", endDate: "2026-10-16", startTime: "12:00", endTime: "15:00" }));
    const sum = r.segments.reduce((acc, seg) => acc + seg.hours, 0);
    expect(r.totalHours).toBe(Math.round(sum * 100) / 100);
    for (const seg of r.segments) expect(customHours(DAY_SHIFT, seg.startTime, seg.endTime)).toBe(seg.hours);
  });

  it("同一天的區間（多日模式選到同一天）用單日自訂起訖：14:00–18:00 ＝ 4 小時、11:00–15:00 ＝ 3 小時", () => {
    const pm = computeLeaveSegments(base({ startDate: "2026-10-13", period: "custom", customStart: "14:00", customEnd: "18:00" }));
    expect(pm.segments).toEqual([{ date: "2026-10-13", startTime: "14:00", endTime: "18:00", hours: 4 }]);
    const across = computeLeaveSegments(base({ startDate: "2026-10-13", period: "custom", customStart: "11:00", customEnd: "15:00" }));
    expect(across.segments[0].hours).toBe(3);
  });
});

describe("resolveLeavePick（表單的選項＋預設值＋時數一次算完）", () => {
  const CTX = { shiftByDate: {}, defaultShift: DAY_SHIFT, dayTypeByDate: {} };
  function state(over: Partial<LeavePickState>): LeavePickState {
    return {
      mode: "single",
      startDate: "2026-10-13",
      endDate: "2026-10-13",
      period: "full",
      hoursStart: "",
      hoursCount: 0,
      rangeStart: "",
      rangeEnd: "",
      ...over,
    };
  }

  it("單日預設：全天 09:00–18:00 8 小時；指定時數的預設是上班時間起 1 小時（最多 8 小時）", () => {
    const pick = resolveLeavePick(state({}), CTX);
    expect(pick.result.segments).toEqual([{ date: "2026-10-13", startTime: "09:00", endTime: "18:00", hours: 8 }]);
    expect(pick.startOptions).toEqual(["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
    expect(pick.hoursStartValue).toBe("09:00");
    expect(pick.maxHours).toBe(8);
    expect(pick.hoursCountValue).toBe(1);
    const hours = resolveLeavePick(state({ period: "hours" }), CTX);
    expect(hours.result.segments).toEqual([{ date: "2026-10-13", startTime: "09:00", endTime: "10:00", hours: 1 }]);
  });

  it("單日指定時數：10:00 起 3 小時 → 10:00–14:00（跳過午休）；時數超過上限會夾到上限（17:00 起最多 1 小時）", () => {
    const three = resolveLeavePick(state({ period: "hours", hoursStart: "10:00", hoursCount: 3 }), CTX);
    expect(three.maxHours).toBe(7);
    expect(three.hoursCountValue).toBe(3);
    expect(three.result.segments[0]).toMatchObject({ startTime: "10:00", endTime: "14:00", hours: 3 });
    const clamped = resolveLeavePick(state({ period: "hours", hoursStart: "17:00", hoursCount: 5 }), CTX);
    expect(clamped.maxHours).toBe(1);
    expect(clamped.hoursCountValue).toBe(1);
    expect(clamped.result.segments[0]).toMatchObject({ startTime: "17:00", endTime: "18:00", hours: 1 });
  });

  it("選的開始時間不在選項裡（午休內、或換了日期班別不同）→ 退回上班時間，不會送出不合法的組合", () => {
    const inBreak = resolveLeavePick(state({ period: "hours", hoursStart: "12:00", hoursCount: 2 }), CTX);
    expect(inBreak.hoursStartValue).toBe("09:00");
    expect(inBreak.result.error).toBeUndefined();
    const night = resolveLeavePick(state({ period: "hours", hoursStart: "10:00", hoursCount: 2 }), {
      ...CTX,
      shiftByDate: { "2026-10-13": NIGHT_SHIFT },
    });
    expect(night.hoursStartValue).toBe("22:00");
    expect(night.result.segments[0]).toMatchObject({ startTime: "22:00", endTime: "00:00", hours: 2 });
  });

  it("多日預設＝每天整天（開始＝上班、結束＝下班）；選了首日 14:00／末日 12:00 → 4＋8＋3 小時", () => {
    const whole = resolveLeavePick(state({ mode: "range", endDate: "2026-10-15" }), CTX);
    expect(whole.rangeStartValue).toBe("09:00");
    expect(whole.rangeEndValue).toBe("18:00");
    expect(whole.endOptions).toEqual(["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    expect(whole.result.totalHours).toBe(24);

    const partial = resolveLeavePick(state({ mode: "range", endDate: "2026-10-15", rangeStart: "14:00", rangeEnd: "12:00" }), CTX);
    expect(partial.result.segments.map((s) => s.hours)).toEqual([4, 8, 3]);
    expect(partial.result.totalHours).toBe(15);
  });

  it("多日：末日班別不同（09:00–17:50），之前選的結束時間 18:00 不在選項裡 → 退回該日下班時間 17:50（整天 8.08 小時）", () => {
    const pick = resolveLeavePick(state({ mode: "range", endDate: "2026-10-15", rangeEnd: "18:00" }), {
      ...CTX,
      shiftByDate: { "2026-10-15": ODD_SHIFT },
    });
    expect(pick.rangeEndValue).toBe("17:50");
    expect(pick.endOptions.slice(-1)).toEqual(["17:50"]);
    expect(pick.result.segments.at(-1)).toEqual({ date: "2026-10-15", startTime: "09:00", endTime: "17:50", hours: 8.08 });
    expect(pick.result.totalHours).toBe(24.08);
  });

  it("多日卻選到同一天 → 那天的一段時間：14:00–18:00 ＝ 4 小時；結束不晚於開始 → error", () => {
    const pm = resolveLeavePick(state({ mode: "range", rangeStart: "14:00", rangeEnd: "18:00" }), CTX);
    expect(pm.result.segments).toEqual([{ date: "2026-10-13", startTime: "14:00", endTime: "18:00", hours: 4 }]);
    const across = resolveLeavePick(state({ mode: "range", rangeStart: "11:00", rangeEnd: "15:00" }), CTX);
    expect(across.result.segments[0].hours).toBe(3);
    const whole = resolveLeavePick(state({ mode: "range" }), CTX);
    expect(whole.result.segments).toEqual([{ date: "2026-10-13", startTime: "09:00", endTime: "18:00", hours: 8 }]);
    const bad = resolveLeavePick(state({ mode: "range", rangeStart: "14:00", rangeEnd: "12:00" }), CTX);
    expect(bad.result.error).toBe("結束時間需晚於開始時間");
  });

  it("多日模式不看 period／指定時數；單日模式不看多日的開始／結束時間", () => {
    const range = resolveLeavePick(state({ mode: "range", endDate: "2026-10-14", period: "hours", hoursStart: "10:00", hoursCount: 2 }), CTX);
    expect(range.result.totalHours).toBe(16);
    const single = resolveLeavePick(state({ mode: "single", endDate: "2026-10-15", rangeStart: "14:00", rangeEnd: "12:00" }), CTX);
    expect(single.result.segments).toEqual([{ date: "2026-10-13", startTime: "09:00", endTime: "18:00", hours: 8 }]);
  });
});
