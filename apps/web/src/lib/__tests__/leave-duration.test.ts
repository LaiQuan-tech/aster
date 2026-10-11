import { describe, it, expect } from "vitest";
import {
  DEFAULT_LEAVE_HOURS_PER_DAY,
  formatLeaveDuration,
  formatLeaveDurationMinutes,
  formatLeaveRemaining,
  formatRequestHours,
  leaveHoursInputHint,
  normalizeHoursPerDay,
  reformatLeaveSummary,
} from "../leave-duration";
// API（xlsx、通知文字）用的那一份——web 與 api 是各自的 build 邊界，只能各寫一份；這裡 import 原始檔與共用案例表，
// 在同一組輸入上比對兩份輸出（同 lunch-window-parity.test.ts 的做法）。改任何一邊，這裡就會紅。
import {
  formatLeaveDuration as apiFormatLeaveDuration,
  formatLeaveDurationMinutes as apiFormatLeaveDurationMinutes,
  formatLeaveRemaining as apiFormatLeaveRemaining,
  normalizeHoursPerDay as apiNormalizeHoursPerDay,
} from "../../../../api/src/lib/leave-duration";
import { LEAVE_DURATION_CASES, LEAVE_MINUTES_CASES } from "../../../../api/src/__tests__/leave-duration-cases";

describe("formatLeaveDuration — 共用案例表（API 那份用同一張）", () => {
  it.each(LEAVE_DURATION_CASES)("$name", ({ hours, hoursPerDay, duration }) => {
    expect(formatLeaveDuration(hours, hoursPerDay)).toBe(duration);
  });
});

describe("formatLeaveRemaining — 負數寫成「超用」", () => {
  it.each(LEAVE_DURATION_CASES)("$name", ({ hours, hoursPerDay, remaining }) => {
    expect(formatLeaveRemaining(hours, hoursPerDay)).toBe(remaining);
  });
});

describe("formatLeaveDurationMinutes — 總分鐘版", () => {
  it.each(LEAVE_MINUTES_CASES)("$name", ({ minutes, hoursPerDay, expected }) => {
    expect(formatLeaveDurationMinutes(minutes, hoursPerDay)).toBe(expected);
  });
});

describe("web 與 API 兩份實作完全一致", () => {
  it("共用案例：四支函式輸出相同", () => {
    for (const c of LEAVE_DURATION_CASES) {
      expect(formatLeaveDuration(c.hours, c.hoursPerDay), c.name).toBe(apiFormatLeaveDuration(c.hours, c.hoursPerDay));
      expect(formatLeaveRemaining(c.hours, c.hoursPerDay), c.name).toBe(apiFormatLeaveRemaining(c.hours, c.hoursPerDay));
    }
    for (const c of LEAVE_MINUTES_CASES) {
      expect(formatLeaveDurationMinutes(c.minutes, c.hoursPerDay), c.name).toBe(apiFormatLeaveDurationMinutes(c.minutes, c.hoursPerDay));
    }
  });

  it("數字格：−50 ～ 400 小時（每 0.05 小時）× 每日工時 6／7／7.5／8／9／10／24／不合法／省略", () => {
    // 逐組 expect 太慢，收集不一致的組合、最後一次斷言。
    const perDays: Array<number | null | undefined> = [6, 7, 7.5, 8, 9, 10, 24, 0, -1, null, undefined];
    const mismatches: string[] = [];
    let compared = 0;
    for (let tick = -1000; tick <= 8000; tick += 1) {
      const hours = tick / 20;
      for (const perDay of perDays) {
        const web = `${formatLeaveDuration(hours, perDay)}|${formatLeaveRemaining(hours, perDay)}`;
        const api = `${apiFormatLeaveDuration(hours, perDay)}|${apiFormatLeaveRemaining(hours, perDay)}`;
        if (web !== api && mismatches.length < 5) mismatches.push(`${hours} 小時／日 ${perDay}：web ${web} / api ${api}`);
        compared += 1;
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(9001 * perDays.length);
  });

  it("分鐘格：−600 ～ 6000 分鐘（逐分）× 每日工時 7.5／8／9", () => {
    const mismatches: string[] = [];
    for (let minutes = -600; minutes <= 6000; minutes += 1) {
      for (const perDay of [7.5, 8, 9]) {
        const web = formatLeaveDurationMinutes(minutes, perDay);
        const api = apiFormatLeaveDurationMinutes(minutes, perDay);
        if (web !== api && mismatches.length < 5) mismatches.push(`${minutes} 分／日 ${perDay}：web ${web} / api ${api}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("每日工時的預設與正規化相同", () => {
    expect(DEFAULT_LEAVE_HOURS_PER_DAY).toBe(8);
    for (const v of [undefined, null, "", 0, -1, Number.NaN, 7.5, "9", 8]) {
      expect(normalizeHoursPerDay(v)).toBe(apiNormalizeHoursPerDay(v));
    }
  });
});

describe("格式規則", () => {
  it("只寫非零的部分，順序固定天 → 時 → 分，不會出現「0 時」「0 分」", () => {
    for (let minutes = 0; minutes <= 3 * 480; minutes += 1) {
      const text = formatLeaveDurationMinutes(minutes);
      expect(text, `${minutes} 分`).not.toMatch(/(^|\s)0 [時分]/);
      expect(text, `${minutes} 分`).toMatch(/^(\d+ 天)?( ?\d+ 時)?( ?\d+ 分)?$/);
    }
  });

  it("逐分鐘往上數，天＋時＋分換算回來剛好等於原本的分鐘", () => {
    for (const perDay of [8, 7.5]) {
      const dayMinutes = Math.round(perDay * 60);
      for (let minutes = 0; minutes <= 3 * dayMinutes; minutes += 1) {
        const text = formatLeaveDurationMinutes(minutes, perDay);
        const days = Number(/(\d+) 天/.exec(text)?.[1] ?? 0);
        const h = Number(/(\d+) 時/.exec(text)?.[1] ?? 0);
        const m = Number(/(\d+) 分/.exec(text)?.[1] ?? 0);
        expect(days * dayMinutes + h * 60 + m, `${perDay} 時/日：${minutes} 分 → ${text}`).toBe(minutes);
        expect(h * 60 + m, `${text} 的時分部分必須小於一天`).toBeLessThan(dayMinutes);
      }
    }
  });
});

describe("formatRequestHours — 各種申請混在一起的地方：請假天＋時，其他類型維持小時", () => {
  it("請假 → 天＋時（每日工時可帶）", () => {
    expect(formatRequestHours("leave", 15)).toBe("1 天 7 時");
    expect(formatRequestHours("leave", "8.00")).toBe("1 天");
    expect(formatRequestHours("leave", 2.5)).toBe("2 時 30 分");
    expect(formatRequestHours("leave", 15, 7.5)).toBe("2 天");
  });

  it("加班、在家工作、出差、補卡… → 「N 小時」（不會被換成天）", () => {
    for (const kind of ["ot", "wfh", "business_trip", "fix_punch", "petty_cash"]) {
      expect(formatRequestHours(kind, 3), kind).toBe("3 小時");
      expect(formatRequestHours(kind, 8), kind).toBe("8 小時"); // 8 小時不是「1 天」
      expect(formatRequestHours(kind, 15), kind).toBe("15 小時");
    }
    expect(formatRequestHours("ot", "2.50")).toBe("2.5 小時");
  });

  it("沒有時數／不是數字 →「—」；kind 缺席當作非請假", () => {
    expect(formatRequestHours("leave", null)).toBe("—");
    expect(formatRequestHours("ot", undefined)).toBe("—");
    expect(formatRequestHours("leave", "abc")).toBe("—");
    expect(formatRequestHours(undefined, 8)).toBe("8 小時");
    expect(formatRequestHours(null, 8)).toBe("8 小時");
  });
});

describe("leaveHoursInputHint — 小時輸入框旁的即時換算", () => {
  it("空白或不是數字只提示單位；有值就換算", () => {
    expect(leaveHoursInputHint("")).toBe("以小時輸入");
    expect(leaveHoursInputHint("   ")).toBe("以小時輸入");
    expect(leaveHoursInputHint("abc")).toBe("以小時輸入");
    expect(leaveHoursInputHint("56")).toBe("以小時輸入 · = 7 天");
    expect(leaveHoursInputHint("108")).toBe("以小時輸入 · = 13 天 4 時");
    expect(leaveHoursInputHint("0")).toBe("以小時輸入 · = 0 天");
    expect(leaveHoursInputHint("2.5")).toBe("以小時輸入 · = 2 時 30 分");
  });

  it("輸入負數是調減，照實顯示負號（不寫成超用）", () => {
    expect(leaveHoursInputHint("-4")).toBe("以小時輸入 · = −4 時");
  });

  it("每日工時不是 8 時照該值換算", () => {
    expect(leaveHoursInputHint("15", 7.5)).toBe("以小時輸入 · = 2 天");
  });
});

describe("reformatLeaveSummary — 出勤月表每天的請假摘要（存起來的「N h」字串）", () => {
  it("逐段換成天＋時，分隔符號「；」保留", () => {
    expect(reformatLeaveSummary("病假 1.5h；特休 8h")).toBe("病假 1 時 30 分；特休 1 天");
    expect(reformatLeaveSummary("特休 4h")).toBe("特休 4 時");
    expect(reformatLeaveSummary("事假 0.5h")).toBe("事假 30 分");
    expect(reformatLeaveSummary("特休 16h；病假 0.25h")).toBe("特休 2 天；病假 15 分");
  });

  it("假別名稱本身有空白、數字也照常處理（只看結尾的「 數字h」）", () => {
    expect(reformatLeaveSummary("特別 休假 2 8h")).toBe("特別 休假 2 1 天");
    expect(reformatLeaveSummary("zzz 0.5h")).toBe("zzz 30 分");
  });

  it("每日工時不是 8 時照該值換算", () => {
    expect(reformatLeaveSummary("特休 7.5h", 7.5)).toBe("特休 1 天");
    expect(reformatLeaveSummary("特休 8h", 7.5)).toBe("特休 1 天 30 分");
  });

  it("null 原樣回 null；格式不認得的段落原樣保留、絕不丟字", () => {
    expect(reformatLeaveSummary(null)).toBeNull();
    expect(reformatLeaveSummary(undefined)).toBeNull();
    expect(reformatLeaveSummary("")).toBe("");
    expect(reformatLeaveSummary("特休 1 天")).toBe("特休 1 天"); // 已經是新格式（例如日後 API 改了）→ 不再轉
    expect(reformatLeaveSummary("特休 8h；怪怪的段落")).toBe("特休 1 天；怪怪的段落");
    expect(reformatLeaveSummary("8h")).toBe("8h"); // 沒有假別名稱
  });
});
