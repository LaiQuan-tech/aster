import { describe, it, expect } from "vitest";
import {
  describeLunch,
  fmtMinutes,
  halfDayWindow,
  lunchFitsShift,
  lunchWindowMinutes,
  lunchWindowOfShift,
  shiftWorkHours,
  type ShiftLike,
} from "../leave-hours";
// API 結算（@hr/rules）用的那一份——web 不依賴 @hr/rules 套件（Next 不編譯 workspace 套件的 TS 原始碼），
// 只能各寫一份；這裡直接 import 原始檔與共用案例表，在同一組輸入上比對兩份輸出（同 admin-nav.test.ts 對照
// next.config.ts 的做法）。改任何一邊，這裡就會紅。
import {
  lunchFitsShift as rulesLunchFits,
  lunchWindowMinutes as rulesLunchWindowMinutes,
  lunchWindowOf as rulesLunchWindowOf,
} from "../../../../../packages/rules/src/lunch-window";
import { LUNCH_CASES } from "../../../../../packages/rules/src/__tests__/lunch-window-cases";

/** @hr/rules 的班別形狀 → web 的 ShiftLike（API 回的 snake_case）。 */
function toShiftLike(shift: { start: string; end: string; breakMinutes: number; breakStart?: string | null }): ShiftLike {
  return { start_time: shift.start, end_time: shift.end, break_minutes: shift.breakMinutes, break_start: shift.breakStart ?? null };
}

describe("午休規則：web（leave-hours）與 API（@hr/rules lunch-window）完全一致", () => {
  it.each(LUNCH_CASES)("共用案例：$name", ({ shift, expected }) => {
    expect(lunchWindowOfShift(toShiftLike(shift))).toEqual(expected);
    expect(lunchWindowOfShift(toShiftLike(shift))).toEqual(rulesLunchWindowOf(shift));
  });

  it("數字版逐格比對：上班每 30 分 × 班長 30 分–24 小時 × 休息 0／30／45／60／90 × 午休開始（沒設或每 60 分）", () => {
    // 28.8 萬組：逐組 expect 太慢（並行跑會超過 5 秒），改成收集不一致的組合、最後一次斷言。
    let compared = 0;
    const mismatches: string[] = [];
    for (let start = 0; start < 1440; start += 30) {
      for (let len = 30; len <= 1440; len += 30) {
        const end = start + len;
        for (const bm of [0, 30, 45, 60, 90]) {
          for (let bs = -60; bs < 1440; bs += 60) {
            const breakStart = bs < 0 ? null : bs;
            const web = JSON.stringify(lunchWindowMinutes(start, end, bm, breakStart));
            const api = JSON.stringify(rulesLunchWindowMinutes(start, end, bm, breakStart));
            if (web !== api && mismatches.length < 5) mismatches.push(`${start}-${end} 休${bm} 起${breakStart}: web ${web} / api ${api}`);
            compared += 1;
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(48 * 48 * 5 * 25);
  });

  it("字串版（含 HH:mm:ss、跨日、時間不合法）與「午休在班內」檢查也一致", () => {
    const starts = ["00:00", "06:30", "09:00", "09:00:00", "10:00", "12:00", "14:00", "22:00", "bad", "24:30"];
    const ends = ["06:00", "12:30", "13:00", "17:50", "18:00:00", "19:00", "22:00", "00:00", "24:00"];
    const breakStarts = [null, "", "02:00", "09:00", "12:00", "12:30", "17:30", "23:00", "24:15"];
    for (const start of starts) {
      for (const end of ends) {
        for (const breakMinutes of [0, 45, 60]) {
          for (const breakStart of breakStarts) {
            const shift = { start, end, breakMinutes, breakStart: breakStart || null };
            expect(lunchWindowOfShift(toShiftLike(shift)), JSON.stringify(shift)).toEqual(rulesLunchWindowOf(shift));
            expect(lunchFitsShift(toShiftLike(shift)), JSON.stringify(shift)).toBe(rulesLunchFits(shift));
          }
        }
      }
    }
  });
});

describe("請假上午／下午（web halfDayWindow）與 API 結算的午休窗接得上", () => {
  // 結算判遲到／早退時把「已核准請假 ∪ 明確午休」當免計時段（@hr/rules worktime-engine）：上午假要剛好請到
  // API 的午休開始、下午假要剛好從 API 的午休結束起請，13:00 到班／12:00 下班才不會被記遲到／早退。
  it("以午休為界的班別：上午＝上班～API 午休開始、下午＝API 午休結束～下班；舊推算與沒有休息的班別 → 各半", () => {
    let split = 0;
    let halves = 0;
    const mismatches: string[] = [];
    for (let start = 0; start < 1440; start += 60) {
      for (let len = 120; len <= 960; len += 60) {
        const end = start + len;
        for (const bm of [0, 30, 45, 60]) {
          for (let bs = -60; bs < 1440; bs += 60) {
            const breakStart = bs < 0 ? null : bs;
            const shift: ShiftLike = {
              start_time: fmtMinutes(start),
              end_time: fmtMinutes(end),
              break_minutes: bm,
              break_start: breakStart == null ? null : fmtMinutes(breakStart),
            };
            const api = rulesLunchWindowMinutes(start, end, bm, breakStart);
            const am = halfDayWindow(shift, "am");
            const pm = halfDayWindow(shift, "pm");
            const tag = `${shift.start_time}-${shift.end_time} 休${bm} 起${shift.break_start}`;
            if (api && api.source !== "legacy" && api.start > start && api.end < end) {
              split += 1;
              const ok =
                am.startTime === fmtMinutes(start) &&
                am.endTime === fmtMinutes(api.start) &&
                pm.startTime === fmtMinutes(api.end) &&
                pm.endTime === fmtMinutes(end) &&
                Math.abs(am.hours + pm.hours - shiftWorkHours(shift)) <= 0.011;
              if (!ok && mismatches.length < 5) mismatches.push(`${tag}: am ${JSON.stringify(am)} pm ${JSON.stringify(pm)} api ${JSON.stringify(api)}`);
            } else {
              halves += 1;
              if (am.hours !== pm.hours && mismatches.length < 5) mismatches.push(`${tag}: 各半卻不等長 am ${am.hours} pm ${pm.hours}`);
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(split).toBeGreaterThan(1000);
    expect(halves).toBeGreaterThan(1000);
  });
});

describe("describeLunch（班別頁的午休說明）", () => {
  it("明設／涵蓋 12:00／推算／沒有休息", () => {
    expect(describeLunch({ start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" })).toBe("午休 12:00–13:00");
    expect(describeLunch({ start_time: "09:00:00", end_time: "18:00:00", break_minutes: 60 })).toBe("午休 12:00–13:00（涵蓋 12:00，預設）");
    expect(describeLunch({ start_time: "14:00", end_time: "22:00", break_minutes: 60 })).toBe("午休 17:30–18:30（推算）");
    expect(describeLunch({ start_time: "22:00", end_time: "06:00", break_minutes: 60, break_start: "02:00" })).toBe("午休 02:00–03:00");
    expect(describeLunch({ start_time: "09:00", end_time: "13:00", break_minutes: 0 })).toBe("");
  });
});
