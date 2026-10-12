import { describe, expect, it } from "vitest";
import {
  NO_PUNCH_LABEL,
  findNoPunchDates,
  hasPunchTrace,
  isNoPunchDay,
  isTripsForbidden,
  noPunchRules,
  noPunchSummary,
  tripDateRange,
  type ApprovedTripSpan,
} from "../sheet-no-punch";
import {
  unacknowledgedErrors,
  type AnomalyCode,
  type AnomalySeverity,
  type SheetAnomaly,
  type SheetDayView,
  type SheetView,
} from "../attendance-sheets-api";

/**
 * 員工本人月表的「無打卡紀錄」（2026-10-12 驗收第 17 條）：上班日整天沒打卡、也沒請假／在家／出差公出，
 * 而且早於今天與月表計算日、不早於到職日、沒有 error 級異常，才標。規則寫在 sheet-no-punch.ts 檔頭。
 *
 * 2026-10：10/03 週六、10/04 週日、10/09 週五、10/10 週六、10/12 週一。
 */

const TODAY = "2026-10-12";
/** 月表在 10/12 10:00（台北）算的 → 10/11 以前的打卡都算進來了。 */
const COMPUTED_AT = "2026-10-12T02:00:00.000Z";

function anomaly(code: AnomalyCode, severity: AnomalySeverity, message: string = code): SheetAnomaly {
  return { code, severity, message };
}

type DayOverrides = Partial<Omit<SheetDayView, "overtime">> & { overtime?: Partial<SheetDayView["overtime"]> };

/** 整天什麼都沒有的上班日（沒打卡、沒請假、沒在家）；用 overrides 疊出各種情境。 */
function day(date: string, overrides: DayOverrides = {}): SheetDayView {
  const { overtime, ...rest } = overrides;
  return {
    date,
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
    dayType: "workday",
    firstIn: null,
    lastOut: null,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    outingMinutes: 0,
    leaveMinutes: 0,
    leaveSummary: null,
    wfh: false,
    overtime: { computed: 0, override: null, overrideReason: null, effective: 0, tier1: 0, tier2: 0, tier3: 0, beyondCap: 0, ...overtime },
    content: null,
    outingNote: null,
    projectId: null,
    projectName: null,
    note: null,
    anomalyAck: null,
    anomalies: [],
    ...rest,
  };
}

type SheetInput = Pick<SheetView, "days" | "computedAt" | "hireDate">;

function sheet(days: SheetDayView[], extra: Partial<SheetInput> = {}): SheetInput {
  return { days, computedAt: COMPUTED_AT, hireDate: null, ...extra };
}

function flagged(s: SheetInput, trips: ApprovedTripSpan[] = [], today = TODAY): string[] {
  return findNoPunchDates(s, { today, trips });
}

describe("findNoPunchDates — 會標的日子", () => {
  it("平日整天沒打卡、沒請假、沒在家、沒出差 → 標", () => {
    expect(flagged(sheet([day("2026-10-07")]))).toEqual(["2026-10-07"]);
  });

  it("補班日（週六但日別是 workday）要標", () => {
    expect(flagged(sheet([day("2026-10-03")]))).toEqual(["2026-10-03"]);
  });

  it("結果由早到晚，不管月表原本的順序", () => {
    expect(flagged(sheet([day("2026-10-08"), day("2026-10-02"), day("2026-10-05")]))).toEqual([
      "2026-10-02",
      "2026-10-05",
      "2026-10-08",
    ]);
  });

  it("只看實際打卡：有填內容／備註（員工自己註記）仍然標——標籤只是提示，不需要說明", () => {
    expect(flagged(sheet([day("2026-10-06", { note: "忘記打卡", content: "x" })]))).toEqual(["2026-10-06"]);
  });
});

describe("findNoPunchDates — 不標的日子", () => {
  it("休息日、國定假日（含平日的國定假日）不標", () => {
    expect(flagged(sheet([day("2026-10-04", { dayType: "rest_day" }), day("2026-10-09", { dayType: "fixed_holiday" })]))).toEqual([]);
    // 對照：週六是休息日就不標（上面補班日是 workday 才標）
    expect(flagged(sheet([day("2026-10-10", { dayType: "rest_day" })]))).toEqual([]);
  });

  it("今天（還在進行中）與之後不標", () => {
    const s = sheet([day("2026-10-09"), day("2026-10-12"), day("2026-10-13")], { computedAt: "2026-10-20T02:00:00.000Z" });
    expect(flagged(s)).toEqual(["2026-10-09"]);
  });

  it("月表計算日（computedAt 的台北日期）當天與之後不標——那天之後的打卡可能還沒算進來", () => {
    const s = sheet([day("2026-10-06"), day("2026-10-07"), day("2026-10-08"), day("2026-10-09")], {
      computedAt: "2026-10-08T03:00:00.000Z", // 10/08 11:00 台北
    });
    expect(flagged(s)).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("computedAt 換成台北日期才比：UTC 10/07 17:30 是台北 10/08 01:30 → 10/07 照標、10/08 不標", () => {
    const s = sheet([day("2026-10-07"), day("2026-10-08")], { computedAt: "2026-10-07T17:30:00.000Z" });
    expect(flagged(s)).toEqual(["2026-10-07"]);
  });

  it("computedAt 是 null（或讀不懂）→ 整張不標", () => {
    expect(flagged(sheet([day("2026-10-07")], { computedAt: null }))).toEqual([]);
    expect(flagged(sheet([day("2026-10-07")], { computedAt: "not-a-date" }))).toEqual([]);
  });

  it("到職日之前不標；到職當天起照標；沒有到職日就不限；格式不對當作不知道（不限）", () => {
    const days = [day("2026-10-05"), day("2026-10-06"), day("2026-10-07")];
    expect(flagged(sheet(days, { hireDate: "2026-10-06" }))).toEqual(["2026-10-06", "2026-10-07"]);
    expect(flagged(sheet(days, { hireDate: "2026-10-06T00:00:00+08:00" }))).toEqual(["2026-10-06", "2026-10-07"]);
    expect(flagged(sheet(days, { hireDate: null }))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(flagged(sheet(days, { hireDate: undefined }))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(flagged(sheet(days, { hireDate: "去年" }))).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    // 月中之後才到職：整個月都在到職前
    expect(flagged(sheet(days, { hireDate: "2026-11-01" }))).toEqual([]);
  });

  it("有請假（分鐘數或假別摘要任一個）不標", () => {
    expect(flagged(sheet([day("2026-10-07", { leaveMinutes: 480, leaveSummary: "特休 8h" })]))).toEqual([]);
    expect(flagged(sheet([day("2026-10-07", { leaveMinutes: 240 })]))).toEqual([]);
    expect(flagged(sheet([day("2026-10-07", { leaveSummary: "病假" })]))).toEqual([]);
    // 空白摘要不算請假
    expect(flagged(sheet([day("2026-10-07", { leaveSummary: "  " })]))).toEqual(["2026-10-07"]);
  });

  it("在家工作不標", () => {
    expect(flagged(sheet([day("2026-10-07", { wfh: true })]))).toEqual([]);
  });

  it("已核准的出差涵蓋（換成台北日期，含頭含尾）不標；出差前後的日子照標", () => {
    const trip = { start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-07T15:59:00.000Z" }; // 台北 10/05 00:00～10/07 23:59
    const days = ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => day(d));
    expect(flagged(sheet(days), [trip])).toEqual(["2026-10-02", "2026-10-08"]);
  });

  it("公出（同一天幾個小時）那天不標", () => {
    const outing = { start_at: "2026-10-02T06:00:00.000Z", end_at: "2026-10-02T08:00:00.000Z" }; // 台北 14:00～16:00
    expect(flagged(sheet([day("2026-10-02"), day("2026-10-05")]), [outing])).toEqual(["2026-10-05"]);
  });

  it("出差剛好在午夜結束（end_at 不含）→ 不算到隔天", () => {
    const trip = { start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-05T16:00:00.000Z" }; // 台北 10/05 00:00～10/06 00:00
    expect(flagged(sheet([day("2026-10-05"), day("2026-10-06")]), [trip])).toEqual(["2026-10-06"]);
  });

  it("出差單的起迄讀不懂 → 不知道涵蓋哪幾天，這次整張不標（避免誤標）", () => {
    const bad = { start_at: "壞掉", end_at: "2026-10-07T15:59:00.000Z" };
    expect(flagged(sheet([day("2026-10-02"), day("2026-10-07")]), [bad])).toEqual([]);
  });

  it("有任何打卡的痕跡都不標（上下班時刻、工時、外出、遲到早退、加班、補打卡、外出未配對、跨午夜）", () => {
    const cases: DayOverrides[] = [
      { firstIn: "2026-10-07T01:00:00.000Z" },
      { lastOut: "2026-10-07T10:00:00.000Z" },
      { workedMinutes: 30 },
      { outingMinutes: 60 },
      { lateMinutes: 5 },
      { earlyLeaveMinutes: 15 },
      { overtime: { computed: 60, effective: 60 } },
      { overtime: { computed: 0, override: 90, effective: 90 } },
      { anomalies: [anomaly("manual_punch", "warn")] },
      { anomalies: [anomaly("outing_unpaired", "warn")] },
      { anomalies: [anomaly("cross_midnight", "warn")] },
    ];
    for (const overrides of cases) {
      expect(flagged(sheet([day("2026-10-07", overrides)])), JSON.stringify(overrides)).toEqual([]);
      expect(hasPunchTrace(day("2026-10-07", overrides)), JSON.stringify(overrides)).toBe(true);
    }
    expect(hasPunchTrace(day("2026-10-07"))).toBe(false);
  });

  it("那天已經有 error 級異常（例如缺上班卡是紅色、要填說明）→ 不再疊一個", () => {
    const missingIn = day("2026-10-07", { lastOut: "2026-10-07T10:00:00.000Z", anomalies: [anomaly("missing_in", "error")] });
    expect(flagged(sheet([missingIn]))).toEqual([]);
    // 就算欄位都是空的，只要有 error 級異常就不標
    expect(flagged(sheet([day("2026-10-07", { anomalies: [anomaly("absent_scheduled", "error")] })]))).toEqual([]);
    // info 級（例如扣晚餐）不影響判斷
    expect(flagged(sheet([day("2026-10-07", { anomalies: [anomaly("meal_deducted", "info")] })]))).toEqual(["2026-10-07"]);
  });

  it("today 格式不對、資料缺漏 → 不丟例外、不標", () => {
    expect(flagged(sheet([day("2026-10-07")]), [], "")).toEqual([]);
    expect(flagged(sheet([day("2026-10-07")]), [], "10/12")).toEqual([]);
    // 缺上下班時刻／工時欄位的資料：判斷不了有沒有打卡，寧可不標
    const legacy = { date: "2026-10-07", dayType: "workday" } as unknown as SheetDayView;
    expect(flagged(sheet([legacy]))).toEqual([]);
    expect(flagged({ days: undefined, computedAt: COMPUTED_AT } as unknown as SheetInput)).toEqual([]);
    expect(flagged(sheet([{ ...day("2026-10-07"), date: "壞日期" }]))).toEqual([]);
    expect(flagged(sheet([null as unknown as SheetDayView, day("2026-10-07")]))).toEqual(["2026-10-07"]);
  });
});

describe("noPunchRules／isNoPunchDay", () => {
  it("門檻：today 與 computedAt 台北日期取較早的；到職日；出差區間", () => {
    const rules = noPunchRules(
      { computedAt: "2026-10-08T03:00:00.000Z", hireDate: "2026-10-02" },
      { today: TODAY, trips: [{ start_at: "2026-10-02T06:00:00.000Z", end_at: "2026-10-02T08:00:00.000Z" }] },
    );
    expect(rules).toEqual({ before: "2026-10-08", hireDay: "2026-10-02", tripRanges: [{ from: "2026-10-02", to: "2026-10-02" }] });
    expect(noPunchRules({ computedAt: "2026-10-20T03:00:00.000Z" }, { today: TODAY, trips: [] })?.before).toBe(TODAY);
    expect(noPunchRules({ computedAt: null }, { today: TODAY, trips: [] })).toBeNull();
  });

  it("單日判斷與整張一致", () => {
    const rules = noPunchRules({ computedAt: COMPUTED_AT, hireDate: null }, { today: TODAY, trips: [] });
    expect(rules).not.toBeNull();
    if (!rules) return;
    expect(isNoPunchDay(day("2026-10-07"), rules)).toBe(true);
    expect(isNoPunchDay(day("2026-10-07", { dayType: "rest_day" }), rules)).toBe(false);
    expect(isNoPunchDay(day("2026-10-12"), rules)).toBe(false);
  });
});

describe("tripDateRange — 出差／公出單換成台北日期（含頭含尾，end_at 不含）", () => {
  it("同一天的公出；多天的出差", () => {
    expect(tripDateRange({ start_at: "2026-10-02T06:00:00.000Z", end_at: "2026-10-02T08:00:00.000Z" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
    expect(tripDateRange({ start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-07T15:59:00.000Z" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-07",
    });
  });

  it("用台北日期，不是 UTC：UTC 10/01 16:30 是台北 10/02 00:30", () => {
    expect(tripDateRange({ start_at: "2026-10-01T16:30:00.000Z", end_at: "2026-10-01T18:00:00.000Z" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
    // 帶 +08:00 的寫法一樣
    expect(tripDateRange({ start_at: "2026-10-02T00:30:00+08:00", end_at: "2026-10-02T02:00:00+08:00" })?.from).toBe("2026-10-02");
  });

  it("剛好在午夜結束不算隔天；起迄相同或倒過來只算開始那天；讀不懂 → null", () => {
    expect(tripDateRange({ start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-05T16:00:00.000Z" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-05",
    });
    expect(tripDateRange({ start_at: "2026-10-05T02:00:00.000Z", end_at: "2026-10-05T02:00:00.000Z" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-05",
    });
    expect(tripDateRange({ start_at: "2026-10-06T02:00:00.000Z", end_at: "2026-10-05T02:00:00.000Z" })).toEqual({
      from: "2026-10-06",
      to: "2026-10-06",
    });
    expect(tripDateRange({ start_at: "abc", end_at: "2026-10-05T02:00:00.000Z" })).toBeNull();
    expect(tripDateRange({ start_at: "2026-10-05T02:00:00.000Z", end_at: null as unknown as string })).toBeNull();
  });
});

describe("noPunchSummary — 員工本人頁異常區的一行摘要", () => {
  it("列出天數與 MM/DD 日期，提示補卡與確認單子（草稿／退回：送出時會重算）", () => {
    expect(noPunchSummary(["2026-10-03", "2026-10-07"])).toBe(
      "有 2 個上班日沒有打卡紀錄：10/03、10/07。若是漏打卡請送補卡申請；若當天有請假、出差或公出，請確認單子已核准（核准後，月表送出時會重新計算）。",
    );
    expect(noPunchSummary(["2026-10-03"], true)).toContain("有 1 個上班日沒有打卡紀錄：10/03。");
    expect(noPunchSummary([])).toBeNull();
    expect(noPunchSummary([], false)).toBeNull();
    expect(NO_PUNCH_LABEL).toBe("無打卡紀錄");
  });

  it("已送出（不能再改）：改成請主管或 HR 處理，不說「送出時會重算」", () => {
    const text = noPunchSummary(["2026-10-03", "2026-10-07"], false);
    expect(text).toBe(
      "有 2 個上班日沒有打卡紀錄：10/03、10/07。若是漏打卡請送補卡申請；若當天有請假、出差或公出，請確認單子已核准。月表已送出，要更正請洽主管或 HR。",
    );
    expect(text).not.toContain("送出時會重新計算");
  });
});

describe("不擋送出：標籤不寫進 anomalies，unacknowledgedErrors 不受影響", () => {
  it("被標的日子沒有任何要說明的 error，送出前檢查是空的", () => {
    const days = [day("2026-10-02"), day("2026-10-05"), day("2026-10-06", { firstIn: "2026-10-06T01:00:00.000Z" })];
    const full = { ...sheet(days) } as unknown as SheetView;
    expect(flagged(sheet(days))).toEqual(["2026-10-02", "2026-10-05"]);
    expect(unacknowledgedErrors(full)).toEqual([]);
  });
});

describe("isTripsForbidden — 讀出差單 403＝當作沒有出差；其他錯誤＝整張不標", () => {
  /** apiFetch 丟出的 Error 的樣子：message `[status] code`，另外掛 status／code／body。 */
  function apiError(status: number, code: string): Error {
    return Object.assign(new Error(`[${status}] ${code}`), { status, code, body: { error: code } });
  }

  it("403（員工端「申請」分頁沒開）→ true；只剩訊息的 `[403] …` 也認得", () => {
    expect(isTripsForbidden(apiError(403, "ess_tab_disabled"))).toBe(true);
    expect(isTripsForbidden(new Error("[403] ess_tab_disabled"))).toBe(true);
  });

  it("其他錯誤 → false（呼叫端這次整張不標）", () => {
    for (const err of [
      apiError(500, "internal_server_error"),
      apiError(401, "unauthorized"),
      apiError(404, "not_found"),
      new TypeError("Failed to fetch"),
      new Error("boom"),
      "boom",
      null,
      undefined,
    ]) {
      expect(isTripsForbidden(err)).toBe(false);
    }
  });
});
