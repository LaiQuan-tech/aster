import { describe, it, expect } from "vitest";
import {
  addDays,
  fmtDateShort,
  fmtDateTime,
  fmtDateWithWeekday,
  fmtHm,
  fmtHours,
  fmtHoursMinutes,
  fmtMoney,
  localDateKey,
  relativeTime,
  todayKey,
  weekdayLabel,
  weekdayOf,
} from "../ess-format";

/**
 * 全部用 UTC ISO 輸入＋ tz:"Asia/Taipei"（UTC+8）驗證：只要有任何一支函式退回
 * `iso.slice()` 的 UTC 切片，跨日的案例（16:30Z → 隔天 00:30）就會抓到。
 */
const TZ = "Asia/Taipei";

describe("fmtHm / localDateKey（時區換算，不是 UTC 切片）", () => {
  it("2026-09-16T16:30:00Z 在台北是 9/17 00:30", () => {
    expect(fmtHm("2026-09-16T16:30:00Z", TZ)).toBe("00:30");
    expect(localDateKey("2026-09-16T16:30:00Z", TZ)).toBe("2026-09-17");
  });

  it("2026-09-17T01:02:00Z → 09:02（一般上班打卡）；跨年 2025-12-31T16:00:00Z → 2026-01-01", () => {
    expect(fmtHm("2026-09-17T01:02:00Z", TZ)).toBe("09:02");
    expect(localDateKey("2026-09-17T01:02:00Z", TZ)).toBe("2026-09-17");
    expect(localDateKey("2025-12-31T16:00:00Z", TZ)).toBe("2026-01-01");
    expect(fmtHm("2025-12-31T16:00:00Z", TZ)).toBe("00:00");
  });

  it("同一時間點在 UTC 與台北給不同答案（證明 tz 參數有生效）", () => {
    expect(fmtHm("2026-09-16T16:30:00Z", "UTC")).toBe("16:30");
    expect(localDateKey("2026-09-16T16:30:00Z", "UTC")).toBe("2026-09-16");
  });

  it("無效輸入不炸：fmtHm → '—'、localDateKey → ''", () => {
    expect(fmtHm("not-a-date", TZ)).toBe("—");
    expect(localDateKey("", TZ)).toBe("");
  });
});

describe("fmtDateShort / fmtDateTime / fmtDateWithWeekday", () => {
  it("ISO 時間依 tz 換算成 MM/DD 與 MM/DD HH:mm", () => {
    expect(fmtDateShort("2026-09-16T16:30:00Z", TZ)).toBe("09/17");
    expect(fmtDateTime("2026-09-16T16:30:00Z", TZ)).toBe("09/17 00:30");
    expect(fmtDateTime("2026-09-17T02:21:00Z", TZ)).toBe("09/17 10:21");
  });

  it("dateKey 直接取月日，不做時區換算", () => {
    expect(fmtDateShort("2026-09-18", TZ)).toBe("09/18");
    expect(fmtDateShort("2026-09-18", "UTC")).toBe("09/18");
  });

  it("fmtDateWithWeekday：2026-09-18 是週五、2026-09-17 是週四；無效 → '—'", () => {
    expect(fmtDateWithWeekday("2026-09-18")).toBe("09/18（五）");
    expect(fmtDateWithWeekday("2026-09-17")).toBe("09/17（四）");
    expect(fmtDateWithWeekday("2026-09-20")).toBe("09/20（日）");
    expect(fmtDateWithWeekday("2026/09/18")).toBe("—");
  });
});

describe("todayKey / addDays / weekdayOf", () => {
  it("todayKey 用注入的 now 與 tz：UTC 16:30 在台北已是隔天", () => {
    expect(todayKey(TZ, "2026-09-16T16:30:00Z")).toBe("2026-09-17");
    expect(todayKey("UTC", "2026-09-16T16:30:00Z")).toBe("2026-09-16");
  });

  it("addDays 跨月／跨年／負數／閏年都用純日曆運算", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-09-18", 0)).toBe("2026-09-18");
    expect(addDays("bad", 3)).toBe("bad");
  });

  it("weekdayOf 同 Date#getDay（0＝日）；weekdayLabel 給中文字", () => {
    expect(weekdayOf("2026-09-20")).toBe(0);
    expect(weekdayOf("2026-09-17")).toBe(4);
    expect(weekdayOf("2026-09-19")).toBe(6);
    expect(weekdayOf("nope")).toBe(-1);
    expect(weekdayLabel("2026-09-17")).toBe("四");
    expect(weekdayLabel("nope")).toBe("");
  });
});

describe("fmtHours / fmtHoursMinutes", () => {
  it("fmtHours：整數不帶小數、小數去尾零、最多兩位", () => {
    expect(fmtHours(8)).toBe("8 小時");
    expect(fmtHours(1.5)).toBe("1.5 小時");
    expect(fmtHours(0.25)).toBe("0.25 小時");
    expect(fmtHours(2.3333)).toBe("2.33 小時");
    expect(fmtHours("24")).toBe("24 小時");
    expect(fmtHours(null)).toBe("—");
    expect(fmtHours(Number.NaN)).toBe("—");
  });

  it("fmtHoursMinutes：8 → 8 小時、1.5 → 1 小時 30 分、0.5 → 30 分、0 → 0 分", () => {
    expect(fmtHoursMinutes(8)).toBe("8 小時");
    expect(fmtHoursMinutes(1.5)).toBe("1 小時 30 分");
    expect(fmtHoursMinutes(0.5)).toBe("30 分");
    expect(fmtHoursMinutes(0)).toBe("0 分");
    expect(fmtHoursMinutes("2.25")).toBe("2 小時 15 分");
    expect(fmtHoursMinutes(undefined)).toBe("—");
  });
});

describe("relativeTime", () => {
  const now = "2026-09-17T08:00:00Z";

  it("剛剛／分鐘／小時／天", () => {
    expect(relativeTime("2026-09-17T07:59:30Z", now)).toBe("剛剛");
    expect(relativeTime("2026-09-17T07:55:00Z", now)).toBe("5 分鐘前");
    expect(relativeTime("2026-09-17T05:00:00Z", now)).toBe("3 小時前");
    expect(relativeTime("2026-09-15T08:00:00Z", now)).toBe("2 天前");
  });

  it("超過 7 天顯示日期（依 tz）；跨年帶年份；未來時間算剛剛；無效 → '—'", () => {
    expect(relativeTime("2026-09-01T16:30:00Z", now, TZ)).toBe("09/02");
    // UTC 12/31 16:30 在台北已是 2026/01/01：同年 → 不帶年份（也證明用 tz 換算而非 UTC 切片）
    expect(relativeTime("2025-12-31T16:30:00Z", now, TZ)).toBe("01/01");
    expect(relativeTime("2025-12-31T16:30:00Z", now, "UTC")).toBe("2025/12/31");
    expect(relativeTime("2025-12-30T00:00:00Z", now, TZ)).toBe("2025/12/30");
    expect(relativeTime("2026-09-17T09:00:00Z", now)).toBe("剛剛");
    expect(relativeTime("x", now)).toBe("—");
  });
});

describe("fmtMoney", () => {
  it("整數千分位、小數最多兩位、字串輸入、負數、非數字", () => {
    expect(fmtMoney(3000)).toBe("NT$ 3,000");
    expect(fmtMoney("1234567")).toBe("NT$ 1,234,567");
    expect(fmtMoney(99.5)).toBe("NT$ 99.5");
    expect(fmtMoney("1,000.256")).toBe("NT$ 1,000.26");
    expect(fmtMoney(0)).toBe("NT$ 0");
    expect(fmtMoney(-250)).toBe("-NT$ 250");
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney("abc")).toBe("—");
  });
});
