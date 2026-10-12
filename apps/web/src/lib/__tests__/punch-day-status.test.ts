import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SHIFT, type ShiftLike } from "../leave-hours";
import { buildDayRows, type PunchHistoryRecord } from "../punch-history";
import {
  approvedCoverageByDate,
  calendarYearsOf,
  dayTypeMapOf,
  dayTypesForYears,
  pickDefaultShift,
  punchRowView,
  settleWithin,
  type ApprovedRequestLike,
  type DayCoverage,
} from "../punch-day-status";

/**
 * 全部用 UTC ISO 輸入＋ tz:"Asia/Taipei"（UTC+8）：當地 09:00 ＝ 01:00Z、當地 00:00 ＝ 前一天 16:00Z。
 * 行事曆裁定都是測試用的假設資料（不是真的公告）。日班 09:00–18:00 休 60（午休 12:00–13:00，一天 8 小時）。
 */
const TZ = "Asia/Taipei";
const DAY_SHIFT = { start_time: "09:00", end_time: "18:00", break_minutes: 60 };
const ctx = (from: string, to: string, shift = DAY_SHIFT) => ({ from, to, shift, tz: TZ });

const seg = (date: string, startTime: string, endTime: string, hours: number) => ({ date, startTime, endTime, hours });

function leave(
  segments: ReturnType<typeof seg>[] | null,
  extra: Partial<ApprovedRequestLike> = {},
): ApprovedRequestLike {
  return {
    kind: "leave",
    status: "approved",
    start_at: "2026-09-14T01:00:00Z",
    end_at: "2026-09-14T10:00:00Z",
    hours: null,
    segments,
    leave_type_name: "特休",
    ...extra,
  };
}

/** 當地 startDate 00:00 ～ endDate 23:59（在家工作、出差表單的慣例）。 */
function wholeDays(kind: string, startUtc: string, endUtc: string, extra: Partial<ApprovedRequestLike> = {}): ApprovedRequestLike {
  return { kind, status: "approved", start_at: startUtc, end_at: endUtc, segments: null, ...extra };
}

/** 公出：單日起訖時刻；hours＝牆鐘差（表單算法，含午休）。 */
function outing(startUtc: string, endUtc: string, hours: number | null = null): ApprovedRequestLike {
  return { kind: "business_trip", trip_type: "outing", status: "approved", start_at: startUtc, end_at: endUtc, hours, segments: null };
}

let seq = 0;
function punch(type: string, punchAt: string): PunchHistoryRecord {
  seq += 1;
  return { id: `p${seq}`, type, punch_at: punchAt, source: "web" };
}

/* ---------------------------------------------------------- 行事曆 --- */

describe("calendarYearsOf", () => {
  it("同一年 → 一年；跨年 → 兩年（每年各抓一次）", () => {
    expect(calendarYearsOf("2026-09-01", "2026-09-30")).toEqual([2026]);
    expect(calendarYearsOf("2025-12-29", "2026-01-04")).toEqual([2025, 2026]);
  });

  it("格式不對、迄早於起 → []；年份跨太多只抓前 3 年（防呆）", () => {
    expect(calendarYearsOf("2026-01-05", "2025-12-29")).toEqual([]);
    expect(calendarYearsOf("", "2026-01-01")).toEqual([]);
    expect(calendarYearsOf("2020-01-01", "2026-01-01")).toEqual([2020, 2021, 2022]);
  });
});

describe("dayTypeMapOf", () => {
  it("只收有日期、有 day_type 字串的列，壞列略過", () => {
    expect(
      dayTypeMapOf([
        { date: "2026-10-09", day_type: "fixed_holiday", label: "測試假日" },
        { date: "2026-09-19", day_type: "workday", label: null },
        null,
        { date: "bad", day_type: "rest_day" },
        { date: "2026-09-16" },
        { date: "2026-09-17", day_type: 3 },
      ]),
    ).toEqual({ "2026-10-09": "fixed_holiday", "2026-09-19": "workday" });
    expect(dayTypeMapOf(undefined)).toEqual({});
    expect(dayTypeMapOf("oops")).toEqual({});
  });
});

describe("跨年區間＋行事曆抓不到退回週一～五（dayTypesForYears → buildDayRows）", () => {
  // 2025-12-27（六）補班、2026-01-01（四）國定假日、2026-01-03／04 是週末。
  const range = ["2025-12-27", "2026-01-04"] as const;
  const y2025: Record<string, string> = { "2025-12-27": "workday" };
  const y2026: Record<string, string> = { "2026-01-01": "fixed_holiday" };
  const datesWith = (byYear: Map<number, Record<string, string>>) =>
    buildDayRows([], range[0], range[1], TZ, {
      dayTypeByDate: dayTypesForYears(calendarYearsOf(range[0], range[1]), byYear),
    }).map((row) => row.date);

  it("兩年都抓到：補班週六補列、國定假日不補", () => {
    expect(datesWith(new Map([[2025, y2025], [2026, y2026]]))).toEqual([
      "2026-01-02",
      "2025-12-31",
      "2025-12-30",
      "2025-12-29",
      "2025-12-27",
    ]);
  });

  it("2026 抓不到：那一年退回週一～五（01-01 又列出來），2025 照裁定", () => {
    expect(datesWith(new Map([[2025, y2025]]))).toEqual([
      "2026-01-02",
      "2026-01-01",
      "2025-12-31",
      "2025-12-30",
      "2025-12-29",
      "2025-12-27",
    ]);
  });

  it("兩年都抓不到 → 完全是舊規則週一～五", () => {
    expect(datesWith(new Map())).toEqual(["2026-01-02", "2026-01-01", "2025-12-31", "2025-12-30", "2025-12-29"]);
  });
});

/* -------------------------------------------------- 等待上限 --- */

describe("settleWithin（參考資料各自最多等幾秒，卡住就退回舊規則）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("期限內成功 → 結果；fallback 不會被呼叫", async () => {
    const fallback = vi.fn(() => "退回");
    await expect(settleWithin(Promise.resolve("行事曆"), 5_000, fallback)).resolves.toBe("行事曆");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("失敗（reject）→ fallback，不丟例外", async () => {
    await expect(settleWithin(Promise.reject(new Error("503")), 5_000, () => "退回")).resolves.toBe("退回");
  });

  it("卡住（一直沒回應）→ 剛好在期限到時給 fallback；之前不會先給", async () => {
    vi.useFakeTimers();
    const hang = new Promise<string>(() => undefined);
    let result: string | undefined;
    void settleWithin(hang, 5_000, () => "退回").then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe("退回");
  });

  it("逾時後才回來的結果不會改掉已給的 fallback；fallback 在逾時當下才算（用得到那時已快取的資料）", async () => {
    vi.useFakeTimers();
    let release!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    const cache: string[] = [];
    const settled = settleWithin(slow, 5_000, () => `退回（已快取 ${cache.length} 年）`);
    cache.push("2026"); // 期限內先到的另一年
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(settled).resolves.toBe("退回（已快取 1 年）");
    release("晚到的行事曆");
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe("退回（已快取 1 年）");
  });

  it("打卡紀錄頁情境：三支參考資料一支卡住，Promise.all 仍在 5 秒後帶著退回值完成（打卡紀錄照常顯示）", async () => {
    vi.useFakeTimers();
    const records = Promise.resolve([{ id: "p1", type: "in", punch_at: "2026-09-14T01:00:00Z" }]);
    const stuckCalendar = new Promise<Record<string, string>>(() => undefined);
    let done: unknown[] | undefined;
    void Promise.all([
      records,
      settleWithin(stuckCalendar, 5_000, () => ({})),
      settleWithin(Promise.resolve([leave(null)]), 5_000, (): ApprovedRequestLike[] => []),
      settleWithin<ShiftLike>(Promise.resolve(DAY_SHIFT), 5_000, () => pickDefaultShift(null)),
    ]).then((value) => {
      done = value;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBeDefined();
    const [punches, dayTypes, approved, shift] = done as [unknown[], Record<string, string>, ApprovedRequestLike[], unknown];
    expect(punches).toHaveLength(1);
    expect(dayTypes).toEqual({}); // 行事曆退回週一～五
    expect(approved).toHaveLength(1); // 沒卡住的照用
    expect(shift).toBe(DAY_SHIFT);
  });

  it("fallback 自己丟例外 → reject（不會永遠停在等待）", async () => {
    await expect(
      settleWithin(Promise.reject(new Error("x")), 5_000, () => {
        throw new Error("fallback 壞了");
      }),
    ).rejects.toThrow("fallback 壞了");
  });
});

/* ---------------------------------------------------------- 班別 --- */

describe("pickDefaultShift", () => {
  it("取 created_at 最早的班別；沒有或壞資料 → DEFAULT_SHIFT", () => {
    const late = { start_time: "10:00", end_time: "19:00", break_minutes: 60, created_at: "2026-03-01T00:00:00Z" };
    const early = { start_time: "08:30", end_time: "17:30", break_minutes: 60, created_at: "2026-01-01T00:00:00Z" };
    expect(pickDefaultShift([late, early])).toBe(early);
    expect(pickDefaultShift([])).toBe(DEFAULT_SHIFT);
    expect(pickDefaultShift(null)).toBe(DEFAULT_SHIFT);
    expect(pickDefaultShift([{ start_time: null, end_time: "18:00" } as never])).toBe(DEFAULT_SHIFT);
  });
});

/* -------------------------------------------------- 已核准的單 --- */

describe("approvedCoverageByDate：請假（有 segments）", () => {
  it("全天段（上班到下班、8 小時）→ 整天，標籤帶假別", () => {
    const map = approvedCoverageByDate([leave([seg("2026-09-15", "09:00", "18:00", 8)])], ctx("2026-09-14", "2026-09-18"));
    expect(map.get("2026-09-15")).toEqual({ full: { kind: "leave", label: "請假・特休" }, partial: [] });
    expect(map.size).toBe(1);
  });

  it("上午半天、指定時數 → 不算整天，只有註記", () => {
    const map = approvedCoverageByDate(
      [leave([seg("2026-09-16", "09:00", "12:00", 3)]), leave([seg("2026-09-17", "09:00", "14:00", 4)], { leave_type_name: "事假" })],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-16")).toEqual({ full: null, partial: ["請假・特休 09:00–12:00"] });
    expect(map.get("2026-09-17")).toEqual({ full: null, partial: ["請假・事假 09:00–14:00"] });
  });

  it("上午特休＋下午病假兩張單合起來涵蓋整天 → 整天（午休不必請）", () => {
    const map = approvedCoverageByDate(
      [leave([seg("2026-09-16", "09:00", "12:00", 3)]), leave([seg("2026-09-16", "13:00", "18:00", 5)], { leave_type_name: "病假" })],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-16")).toEqual({ full: { kind: "leave", label: "請假・特休、病假" }, partial: [] });
  });

  it("多日請假：首日下午起、中間整天、末日請到中午", () => {
    const map = approvedCoverageByDate(
      [leave([seg("2026-09-14", "13:00", "18:00", 5), seg("2026-09-15", "09:00", "18:00", 8), seg("2026-09-16", "09:00", "12:00", 3)])],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-14")).toEqual({ full: null, partial: ["請假・特休 13:00–18:00"] });
    expect(map.get("2026-09-15")?.full?.label).toBe("請假・特休");
    expect(map.get("2026-09-16")).toEqual({ full: null, partial: ["請假・特休 09:00–12:00"] });
  });

  it("班別事後改成 08:30–17:30：舊的全天段（09:00–18:00、8 小時）仍算整天；時數 0 的匯入段看起訖", () => {
    const shifted = { start_time: "08:30", end_time: "17:30", break_minutes: 60 };
    const map = approvedCoverageByDate(
      [leave([seg("2026-09-15", "09:00", "18:00", 8)]), leave([seg("2026-09-16", "08:30", "17:30", 0)])],
      ctx("2026-09-14", "2026-09-18", shifted),
    );
    expect(map.get("2026-09-15")?.full?.kind).toBe("leave");
    expect(map.get("2026-09-16")?.full?.kind).toBe("leave");
  });

  it("沒有假別名 → 「請假」；HH:mm:ss 也吃", () => {
    const map = approvedCoverageByDate(
      [leave([seg("2026-09-15", "09:00:00", "12:00:00", 3)], { leave_type_name: null })],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-15")).toEqual({ full: null, partial: ["請假 09:00–12:00"] });
  });

  it("夜班 22:00–06:00：整段算整天；凌晨那段（02:30–06:00）算隔日時段、不是整天", () => {
    const night = { start_time: "22:00", end_time: "06:00", break_minutes: 60 };
    const map = approvedCoverageByDate(
      [leave([seg("2026-09-15", "22:00", "06:00", 7), seg("2026-09-16", "02:30", "06:00", 3.5)])],
      ctx("2026-09-14", "2026-09-18", night),
    );
    expect(map.get("2026-09-15")?.full?.kind).toBe("leave");
    expect(map.get("2026-09-16")).toEqual({ full: null, partial: ["請假・特休 02:30–06:00"] });
  });
});

describe("approvedCoverageByDate：segments 為 null 的舊單／匯入單", () => {
  it("同一天 09:00–18:00（當地）→ 整天；09:00–12:00 → 註記", () => {
    const map = approvedCoverageByDate(
      [
        leave(null, { start_at: "2026-09-17T01:00:00Z", end_at: "2026-09-17T10:00:00Z" }),
        leave(null, { start_at: "2026-09-18T01:00:00Z", end_at: "2026-09-18T04:00:00Z", leave_type_name: "事假" }),
      ],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-17")).toEqual({ full: { kind: "leave", label: "請假・特休" }, partial: [] });
    expect(map.get("2026-09-18")).toEqual({ full: null, partial: ["請假・事假 09:00–12:00"] });
  });

  it("用當地日期切（不是 UTC 切片）：09-16T16:00Z ～ 09-17T15:59Z 是台北 09-17 整天", () => {
    const map = approvedCoverageByDate(
      [leave(null, { start_at: "2026-09-16T16:00:00Z", end_at: "2026-09-17T15:59:00Z" })],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect([...map.keys()]).toEqual(["2026-09-17"]);
    expect(map.get("2026-09-17")?.full?.kind).toBe("leave");
  });

  it("多日：首日 13:00 起、中間整天、末日到 12:00；剛好午夜結束不會留到隔天", () => {
    const map = approvedCoverageByDate(
      [
        leave(null, { start_at: "2026-09-14T05:00:00Z", end_at: "2026-09-16T04:00:00Z" }),
        // 台北 09-17 09:00 ～ 09-18 00:00
        leave(null, { start_at: "2026-09-17T01:00:00Z", end_at: "2026-09-17T16:00:00Z", leave_type_name: "病假" }),
      ],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-14")).toEqual({ full: null, partial: ["請假・特休 13:00 起"] });
    expect(map.get("2026-09-15")?.full?.label).toBe("請假・特休");
    expect(map.get("2026-09-16")).toEqual({ full: null, partial: ["請假・特休 至 12:00"] });
    expect(map.get("2026-09-17")?.full?.label).toBe("請假・病假");
    expect(map.has("2026-09-18")).toBe(false);
  });

  it("班別事後改過：同一天的舊單宣告時數（字串也吃）≥ 一天工時 → 整天", () => {
    const shifted = { start_time: "08:30", end_time: "17:30", break_minutes: 60 };
    const map = approvedCoverageByDate(
      [leave(null, { start_at: "2026-09-17T01:00:00Z", end_at: "2026-09-17T10:00:00Z", hours: "8" })],
      ctx("2026-09-14", "2026-09-18", shifted),
    );
    expect(map.get("2026-09-17")?.full?.kind).toBe("leave");
  });

  it("跨年的多日假：兩邊年份的日子都算到", () => {
    // 台北 2025-12-31 09:00 ～ 2026-01-02 18:00
    const map = approvedCoverageByDate(
      [leave(null, { start_at: "2025-12-31T01:00:00Z", end_at: "2026-01-02T10:00:00Z" })],
      ctx("2025-12-29", "2026-01-04"),
    );
    expect([...map.keys()].sort()).toEqual(["2025-12-31", "2026-01-01", "2026-01-02"]);
    expect([...map.values()].every((c) => c.full?.kind === "leave")).toBe(true);
  });
});

describe("approvedCoverageByDate：在家工作、出差、公出", () => {
  it("在家工作涵蓋的每個當地日都算整天", () => {
    // 台北 09-14 00:00 ～ 09-15 23:59
    const map = approvedCoverageByDate([wholeDays("wfh", "2026-09-13T16:00:00Z", "2026-09-15T15:59:00Z")], ctx("2026-09-14", "2026-09-18"));
    expect([...map.keys()].sort()).toEqual(["2026-09-14", "2026-09-15"]);
    expect(map.get("2026-09-14")).toEqual({ full: { kind: "wfh", label: "在家工作" }, partial: [] });
  });

  it("出差（trip_type=business_trip）算整天；trip_type 不明的單不比照", () => {
    const map = approvedCoverageByDate(
      [
        wholeDays("business_trip", "2026-09-16T16:00:00Z", "2026-09-18T15:59:00Z", { trip_type: "business_trip" }),
        wholeDays("business_trip", "2026-09-15T01:00:00Z", "2026-09-15T10:00:00Z", { trip_type: null }),
      ],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect([...map.keys()].sort()).toEqual(["2026-09-17", "2026-09-18"]);
    expect(map.get("2026-09-17")).toEqual({ full: { kind: "business_trip", label: "出差" }, partial: [] });
  });

  it("出差那天另有半天公出：整天標出差，公出留註記", () => {
    const map = approvedCoverageByDate(
      [
        wholeDays("business_trip", "2026-09-16T16:00:00Z", "2026-09-17T15:59:00Z", { trip_type: "business_trip" }),
        outing("2026-09-17T06:00:00Z", "2026-09-17T09:00:00Z", 3),
      ],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-17")).toEqual({ full: { kind: "business_trip", label: "出差" }, partial: ["公出 14:00–17:00"] });
  });

  it("在家工作那天另有半天假：整天標在家工作，半天假留註記", () => {
    const map = approvedCoverageByDate(
      [wholeDays("wfh", "2026-09-14T16:00:00Z", "2026-09-15T15:59:00Z"), leave([seg("2026-09-15", "09:00", "12:00", 3)])],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect(map.get("2026-09-15")).toEqual({ full: { kind: "wfh", label: "在家工作" }, partial: ["請假・特休 09:00–12:00"] });
  });
});

/**
 * 公出（2026-10-12 調整）：起訖時段跟請假時段合起來算，蓋滿上班時段（午休不必蓋）才算整天、不給補卡；
 * 蓋不滿照樣可補卡、附註記。`view` 走完整條：已核准的單 → 涵蓋 → 沒打卡那一列的顯示。
 */
describe("approvedCoverageByDate＋punchRowView：公出", () => {
  const TODAY = "2026-10-12";
  const viewOn = (date: string, approved: ApprovedRequestLike[], status: "none" | "missing_out" = "none") =>
    punchRowView({ date, status }, TODAY, approvedCoverageByDate(approved, ctx("2026-09-14", "2026-09-18")).get(date));

  it("整天公出 → 標「公出」、不給補卡；起訖超出上班時段也只算上班時段", () => {
    expect(viewOn("2026-09-14", [outing("2026-09-14T01:00:00Z", "2026-09-14T10:00:00Z", 9)])).toEqual({
      label: "公出",
      tone: "blue",
      fixType: null,
      note: "",
    });
    // 08:00–19:00
    expect(viewOn("2026-09-15", [outing("2026-09-15T00:00:00Z", "2026-09-15T11:00:00Z", 11)])).toMatchObject({
      label: "公出",
      fixType: null,
    });
    const map = approvedCoverageByDate([outing("2026-09-14T01:00:00Z", "2026-09-14T10:00:00Z", 9)], ctx("2026-09-14", "2026-09-18"));
    expect(map.get("2026-09-14")).toEqual({ full: { kind: "outing", label: "公出" }, partial: [] });
  });

  it("半天公出 → 仍可補卡（補上班卡），附註記", () => {
    expect(viewOn("2026-09-16", [outing("2026-09-16T06:00:00Z", "2026-09-16T09:00:00Z", 3)])).toEqual({
      label: "未打卡",
      tone: "gray",
      fixType: "in",
      note: "已核准：公出 14:00–17:00",
    });
  });

  it("上午請假＋下午公出 → 算整天（標「請假・特休＋公出」、不給補卡）；公出從 12:00 起接在請假後面也算", () => {
    const am = leave([seg("2026-09-17", "09:00", "12:00", 3)]);
    expect(viewOn("2026-09-17", [am, outing("2026-09-17T05:00:00Z", "2026-09-17T10:00:00Z", 5)])).toEqual({
      label: "請假・特休＋公出",
      tone: "blue",
      fixType: null,
      note: "",
    });
    expect(viewOn("2026-09-17", [am, outing("2026-09-17T04:00:00Z", "2026-09-17T10:00:00Z", 6)])).toMatchObject({
      label: "請假・特休＋公出",
      fixType: null,
    });
    // 沒有假別名 →「請假＋公出」
    expect(
      viewOn("2026-09-17", [leave([seg("2026-09-17", "09:00", "12:00", 3)], { leave_type_name: null }), outing("2026-09-17T05:00:00Z", "2026-09-17T10:00:00Z", 5)]),
    ).toMatchObject({ label: "請假＋公出", fixType: null });
  });

  it("公出跨午休只算上班時段：公出 8 小時（10:00–18:00、09:00–17:00 都含午休）不等於整天；補上 09:00–10:00 的假才蓋滿", () => {
    expect(viewOn("2026-09-18", [outing("2026-09-18T02:00:00Z", "2026-09-18T10:00:00Z", 8)])).toEqual({
      label: "未打卡",
      tone: "gray",
      fixType: "in",
      note: "已核准：公出 10:00–18:00",
    });
    expect(viewOn("2026-09-18", [outing("2026-09-18T01:00:00Z", "2026-09-18T09:00:00Z", 8)])).toMatchObject({
      label: "未打卡",
      fixType: "in",
    });
    expect(
      viewOn("2026-09-18", [leave([seg("2026-09-18", "09:00", "10:00", 1)]), outing("2026-09-18T02:00:00Z", "2026-09-18T10:00:00Z", 8)]),
    ).toMatchObject({ label: "請假・特休＋公出", fixType: null });
  });

  it("公出＋請假仍蓋不滿 → 可補卡，兩則註記依時間排；請假自己就蓋滿時標籤不帶公出", () => {
    expect(
      viewOn("2026-09-16", [outing("2026-09-16T06:00:00Z", "2026-09-16T09:00:00Z", 3), leave([seg("2026-09-16", "09:00", "11:00", 2)])]),
    ).toEqual({ label: "未打卡", tone: "gray", fixType: "in", note: "已核准：請假・特休 09:00–11:00、公出 14:00–17:00" });
    expect(
      viewOn("2026-09-16", [leave([seg("2026-09-16", "09:00", "18:00", 8)]), outing("2026-09-16T06:00:00Z", "2026-09-16T09:00:00Z", 3)]),
    ).toMatchObject({ label: "請假・特休", fixType: null });
  });

  it("有打卡的日子照打卡狀態，整天公出只當註記", () => {
    expect(viewOn("2026-09-14", [outing("2026-09-14T01:00:00Z", "2026-09-14T10:00:00Z", 9)], "missing_out")).toEqual({
      label: "缺下班",
      tone: "amber",
      fixType: "out",
      note: "已核准：公出（整天）",
    });
  });
});

describe("approvedCoverageByDate：過濾與防呆", () => {
  it("只收 approved；加班、補卡等其他種類不算；區間外的日子不收", () => {
    const map = approvedCoverageByDate(
      [
        leave([seg("2026-09-15", "09:00", "18:00", 8)], { status: "pending" }),
        { kind: "ot", status: "approved", start_at: "2026-09-15T10:00:00Z", end_at: "2026-09-15T12:00:00Z" },
        { kind: "fix_punch", status: "approved", start_at: "2026-09-15T01:00:00Z", end_at: "2026-09-15T01:00:00Z" },
        leave([seg("2026-09-20", "09:00", "18:00", 8), seg("2026-09-18", "09:00", "18:00", 8)]),
        wholeDays("wfh", "2026-09-10T16:00:00Z", "2026-09-14T15:59:00Z"),
      ],
      ctx("2026-09-14", "2026-09-18"),
    );
    expect([...map.keys()].sort()).toEqual(["2026-09-14", "2026-09-18"]);
  });

  it("壞資料不丟例外：null、缺欄位、看不懂的時間、區間無效", () => {
    const junk = [
      null,
      undefined,
      {},
      { kind: "leave" },
      { kind: "leave", status: "approved", start_at: "garbage", end_at: "garbage", segments: [null, { date: "bad" }] },
      { kind: "leave", status: "approved", segments: [{ date: "2026-09-15", startTime: "??", endTime: "18:00" }] },
      { kind: "wfh", status: "approved", start_at: null, end_at: null },
      { kind: "business_trip", trip_type: "outing", status: "approved", start_at: "garbage", end_at: "2026-09-15T10:00:00Z" },
      // 結束早於開始的公出
      { kind: "business_trip", trip_type: "outing", status: "approved", start_at: "2026-09-15T10:00:00Z", end_at: "2026-09-15T01:00:00Z" },
    ] as unknown as ApprovedRequestLike[];
    expect(() => approvedCoverageByDate(junk, ctx("2026-09-14", "2026-09-18"))).not.toThrow();
    expect(approvedCoverageByDate(junk, ctx("2026-09-14", "2026-09-18")).size).toBe(0);
    expect(approvedCoverageByDate(null, ctx("2026-09-14", "2026-09-18")).size).toBe(0);
    expect(approvedCoverageByDate([leave([seg("2026-09-15", "09:00", "18:00", 8)])], ctx("2026-09-18", "2026-09-14")).size).toBe(0);
  });
});

/* ------------------------------------------------------ 一列的顯示 --- */

describe("punchRowView", () => {
  const TODAY = "2026-09-18";
  const fullLeave: DayCoverage = { full: { kind: "leave", label: "請假・特休" }, partial: [] };
  const halfLeave: DayCoverage = { full: null, partial: ["請假・特休 09:00–12:00"] };
  const wfhWithHalf: DayCoverage = { full: { kind: "wfh", label: "在家工作" }, partial: ["請假・特休 09:00–12:00"] };
  const trip: DayCoverage = { full: { kind: "business_trip", label: "出差" }, partial: [] };
  const row = (status: "complete" | "missing_in" | "missing_out" | "none", date = "2026-09-15") => ({ date, status });

  it("沒有核准單：照打卡狀態；缺下班補 out、缺上班／沒打卡補 in、完整不給補卡", () => {
    expect(punchRowView(row("none"), TODAY)).toEqual({ label: "未打卡", tone: "gray", fixType: "in", note: "" });
    expect(punchRowView(row("missing_out"), TODAY)).toEqual({ label: "缺下班", tone: "amber", fixType: "out", note: "" });
    expect(punchRowView(row("missing_in"), TODAY)).toEqual({ label: "缺上班", tone: "amber", fixType: "in", note: "" });
    expect(punchRowView(row("complete"), TODAY)).toEqual({ label: "完整", tone: "green", fixType: null, note: "" });
  });

  it("整天請假／在家工作／出差且沒打卡 → 標籤改成單的種類、不給補卡", () => {
    expect(punchRowView(row("none"), TODAY, fullLeave)).toEqual({ label: "請假・特休", tone: "blue", fixType: null, note: "" });
    expect(punchRowView(row("none"), TODAY, trip)).toMatchObject({ label: "出差", fixType: null });
    expect(punchRowView(row("none"), TODAY, wfhWithHalf)).toEqual({
      label: "在家工作",
      tone: "blue",
      fixType: null,
      note: "已核准：請假・特休 09:00–12:00",
    });
  });

  it("半天假仍可補卡（附註記）；有打卡的日子照打卡狀態，核准單只當註記", () => {
    expect(punchRowView(row("none"), TODAY, halfLeave)).toEqual({
      label: "未打卡",
      tone: "gray",
      fixType: "in",
      note: "已核准：請假・特休 09:00–12:00",
    });
    expect(punchRowView(row("missing_out"), TODAY, fullLeave)).toEqual({
      label: "缺下班",
      tone: "amber",
      fixType: "out",
      note: "已核准：請假・特休（整天）",
    });
    expect(punchRowView(row("complete"), TODAY, trip)).toMatchObject({ label: "完整", fixType: null, note: "已核准：出差" });
  });

  it("今天：上班中／尚未打卡不催補卡；缺上班照樣可補；整天請假改標籤", () => {
    expect(punchRowView(row("missing_out", TODAY), TODAY)).toEqual({ label: "上班中", tone: "blue", fixType: null, note: "" });
    expect(punchRowView(row("none", TODAY), TODAY)).toEqual({ label: "尚未打卡", tone: "gray", fixType: null, note: "" });
    expect(punchRowView(row("missing_in", TODAY), TODAY)).toMatchObject({ label: "缺上班", fixType: "in" });
    expect(punchRowView(row("none", TODAY), TODAY, fullLeave)).toMatchObject({ label: "請假・特休", fixType: null });
    expect(punchRowView(row("none", TODAY), TODAY, halfLeave)).toEqual({
      label: "尚未打卡",
      tone: "gray",
      fixType: null,
      note: "已核准：請假・特休 09:00–12:00",
    });
  });
});

/* -------------------------------------------------------- 整頁情境 --- */

describe("打卡紀錄兩週情境（行事曆＋已核准的單＋打卡 → 每列標籤與補卡卡別）", () => {
  it("國定假日不列、補班週六列出；整天假／整天公出／在家／出差不給補卡；半天假、半天公出照樣可補；缺下班補 out", () => {
    const from = "2026-09-28";
    const to = "2026-10-11";
    const dayTypeByDate = { "2026-10-03": "workday", "2026-10-09": "fixed_holiday", "2026-10-10": "fixed_holiday" };
    const records = [
      punch("in", "2026-09-28T01:00:00Z"), // 09-28 09:00
      punch("out", "2026-09-28T10:00:00Z"), // 09-28 18:00
      punch("in", "2026-10-06T05:00:00Z"), // 10-06 13:00（上午請病假）
      punch("out", "2026-10-08T10:05:00Z"), // 10-08 18:05（忘了打上班）
    ];
    const approved: ApprovedRequestLike[] = [
      wholeDays("business_trip", "2026-09-28T16:00:00Z", "2026-09-30T15:59:00Z", { trip_type: "business_trip" }), // 09-29～09-30
      outing("2026-10-01T06:00:00Z", "2026-10-01T09:00:00Z", 3), // 10-01 14:00–17:00（半天）
      outing("2026-10-02T01:00:00Z", "2026-10-02T10:00:00Z", 9), // 10-02 09:00–18:00（整天）
      leave([seg("2026-10-05", "09:00", "18:00", 8)], { start_at: "2026-10-05T01:00:00Z", end_at: "2026-10-05T10:00:00Z" }),
      leave([seg("2026-10-06", "09:00", "12:00", 3)], {
        start_at: "2026-10-06T01:00:00Z",
        end_at: "2026-10-06T04:00:00Z",
        leave_type_name: "病假",
      }),
      wholeDays("wfh", "2026-10-06T16:00:00Z", "2026-10-07T15:59:00Z"), // 10-07
    ];

    const rows = buildDayRows(records, from, to, TZ, { dayTypeByDate });
    const coverage = approvedCoverageByDate(approved, { from, to, shift: DAY_SHIFT, tz: TZ });
    const table = rows.map((r) => {
      const view = punchRowView(r, "2026-10-12", coverage.get(r.date));
      return [r.date, view.label, view.fixType, view.note];
    });

    expect(table).toEqual([
      ["2026-10-08", "缺上班", "in", ""],
      ["2026-10-07", "在家工作", null, ""],
      ["2026-10-06", "缺下班", "out", "已核准：請假・病假 09:00–12:00"],
      ["2026-10-05", "請假・特休", null, ""],
      ["2026-10-03", "未打卡", "in", ""], // 補班週六
      ["2026-10-02", "公出", null, ""], // 整天公出
      ["2026-10-01", "未打卡", "in", "已核准：公出 14:00–17:00"], // 半天公出，其餘時段仍應打卡
      ["2026-09-30", "出差", null, ""],
      ["2026-09-29", "出差", null, ""],
      ["2026-09-28", "完整", null, ""],
    ]);
  });
});
