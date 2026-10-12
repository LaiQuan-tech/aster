import { describe, expect, it } from "vitest";
import {
  HIRE_DATE_IN_SNAPSHOT_SINCE,
  NO_PUNCH_LABEL,
  findNoPunchDates,
  hasFixedWorkdays,
  hasPunchTrace,
  isNoPunchDay,
  isRequestsForbidden,
  noPunchRules,
  noPunchSummary,
  requestDateRanges,
  spanDateRange,
  type ApprovedRequestSpan,
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
 * 員工本人月表的「無打卡紀錄」（2026-10-12 驗收第 17 條）：固定上班日的員工、上班日整天沒打卡、也沒請假／在家／
 * 出差公出（月表快照上的，加上頁面即時讀到的已核准請假／在家工作／補卡／出差公出單），而且早於今天與月表計算日、
 * 不早於到職日、沒有 error 級異常，才標。規則寫在 sheet-no-punch.ts 檔頭。
 *
 * 2026-10：10/03 週六、10/04 週日、10/09 週五、10/10 週六、10/12 週一。時間一律寫 UTC，註解標台北時間。
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

type SheetInput = Pick<SheetView, "days" | "computedAt" | "hireDate" | "frozen" | "approvedAt">;

/** 預設：即時算的月表（草稿），主檔沒填到職日。 */
function sheet(days: SheetDayView[], extra: Partial<SheetInput> = {}): SheetInput {
  return { days, computedAt: COMPUTED_AT, hireDate: null, frozen: false, approvedAt: null, ...extra };
}

/** 整個拿掉 hireDate 這個欄位（舊快照沒存；跟 null 不一樣）。 */
function withoutHireDate(s: SheetInput): SheetInput {
  const { hireDate: _omitted, ...rest } = s;
  return rest as SheetInput;
}

interface FlagOptions {
  today?: string;
  /** 預設 regular（正職）；要測「缺漏」就明確傳 null／undefined。 */
  employmentType?: string | null;
}

function flagged(s: SheetInput, requests: ApprovedRequestSpan[] = [], opts: FlagOptions = {}): string[] {
  const employmentType = "employmentType" in opts ? opts.employmentType : "regular";
  return findNoPunchDates(s, { today: opts.today ?? TODAY, requests, employmentType });
}

/* ── 申請單（已核准）的樣子：ess-api LeaveRequest 的子集 ── */

function leave(start_at: string, end_at: string, segmentDates?: string[]): ApprovedRequestSpan {
  return {
    kind: "leave",
    start_at,
    end_at,
    segments: segmentDates?.map((date) => ({ date, startTime: "09:00", endTime: "18:00", hours: 8 })),
  };
}

const trip = (start_at: string, end_at: string): ApprovedRequestSpan => ({ kind: "business_trip", start_at, end_at });

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
    expect(flagged(sheet([day("2026-10-07")]), [], { today: "" })).toEqual([]);
    expect(flagged(sheet([day("2026-10-07")]), [], { today: "10/12" })).toEqual([]);
    // 缺上下班時刻／工時欄位的資料：判斷不了有沒有打卡，寧可不標
    const legacy = { date: "2026-10-07", dayType: "workday" } as unknown as SheetDayView;
    expect(flagged(sheet([legacy]))).toEqual([]);
    expect(flagged({ ...sheet([]), days: undefined } as unknown as SheetInput)).toEqual([]);
    expect(flagged(sheet([{ ...day("2026-10-07"), date: "壞日期" }]))).toEqual([]);
    expect(flagged(sheet([null as unknown as SheetDayView, day("2026-10-07")]))).toEqual(["2026-10-07"]);
  });
});

/**
 * 審查發現 1：月表日資料是快照（GET 不重算），快照之後才核准的單子在快照上看不到——以前請假、在家工作只看快照，
 * 那天會被誤標、摘要還叫員工送補卡。現在頁面一次讀本人所有已核准的單，請假／在家工作／補卡／出差公出涵蓋的日子都不標。
 */
describe("findNoPunchDates — 快照之後才核准的單（快照上那天還是空的）", () => {
  const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  const weekSheet = () => sheet(WEEK.map((d) => day(d)));

  it("整天請假（segments 的 date）→ 那天不標，其他天照標", () => {
    const fullDay = leave("2026-10-07T01:00:00.000Z", "2026-10-07T10:00:00.000Z", ["2026-10-07"]); // 台北 10/07 09:00～18:00
    expect(flagged(weekSheet(), [fullDay])).toEqual(["2026-10-05", "2026-10-06", "2026-10-08"]);
  });

  it("半天假（部分請假）也算：那天不標", () => {
    const halfDay: ApprovedRequestSpan = {
      kind: "leave",
      start_at: "2026-10-06T05:00:00.000Z", // 台北 13:00
      end_at: "2026-10-06T09:00:00.000Z", // 台北 17:00
      segments: [{ date: "2026-10-06" }],
    };
    expect(flagged(weekSheet(), [halfDay])).toEqual(["2026-10-05", "2026-10-07", "2026-10-08"]);
  });

  it("多天假：有 segments 只算那幾段的日期（中間沒請的上班日照標）", () => {
    // 起迄是 10/05～10/08，但 segments 只有 10/05 與 10/08
    const split = leave("2026-10-05T01:00:00.000Z", "2026-10-08T10:00:00.000Z", ["2026-10-05", "2026-10-08"]);
    expect(flagged(weekSheet(), [split])).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("沒有 segments 的請假（後台補登等）→ 用 start_at～end_at 換台北日期", () => {
    const noSegments = leave("2026-10-05T01:00:00.000Z", "2026-10-07T10:00:00.000Z"); // 台北 10/05 09:00～10/07 18:00
    expect(flagged(weekSheet(), [noSegments])).toEqual(["2026-10-08"]);
    expect(flagged(weekSheet(), [{ ...noSegments, segments: null }])).toEqual(["2026-10-08"]);
    expect(flagged(weekSheet(), [{ ...noSegments, segments: [] }])).toEqual(["2026-10-08"]);
  });

  it("segments 有一段讀不懂 → 退回用 start_at～end_at（寧可多排除）", () => {
    const broken: ApprovedRequestSpan = {
      kind: "leave",
      start_at: "2026-10-05T01:00:00.000Z",
      end_at: "2026-10-06T10:00:00.000Z",
      segments: [{ date: "2026-10-05" }, { date: "壞掉" }],
    };
    expect(flagged(weekSheet(), [broken])).toEqual(["2026-10-07", "2026-10-08"]);
  });

  it("在家工作（start_at～end_at，整天型存成 00:00～23:59）→ 涵蓋的日子不標", () => {
    const wfh: ApprovedRequestSpan = { kind: "wfh", start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-06T15:59:00.000Z" }; // 台北 10/05 00:00～10/06 23:59
    expect(flagged(weekSheet(), [wfh])).toEqual(["2026-10-07", "2026-10-08"]);
  });

  it("補卡（start_at 的台北日期）→ 那天不標；台北日期不是 UTC 日期", () => {
    const fix: ApprovedRequestSpan = {
      kind: "fix_punch",
      start_at: "2026-10-07T01:00:00.000Z", // 台北 10/07 09:00 上班卡
      end_at: "2026-10-07T01:00:00.000Z",
      segments: [{ date: "2026-10-07" }],
    };
    expect(flagged(weekSheet(), [fix])).toEqual(["2026-10-05", "2026-10-06", "2026-10-08"]);
    // UTC 10/07 16:30 是台北 10/08 00:30 → 算 10/08
    const nearMidnight: ApprovedRequestSpan = { kind: "fix_punch", start_at: "2026-10-07T16:30:00.000Z", end_at: "2026-10-07T16:30:00.000Z" };
    expect(flagged(weekSheet(), [nearMidnight])).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("出差（多天）與公出（同一天幾個小時）→ 涵蓋的日子不標；出差前後的日子照標", () => {
    const days = ["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d) => day(d));
    const businessTrip = trip("2026-10-04T16:00:00.000Z", "2026-10-07T15:59:00.000Z"); // 台北 10/05 00:00～10/07 23:59
    expect(flagged(sheet(days), [businessTrip])).toEqual(["2026-10-02", "2026-10-08"]);
    const outing = trip("2026-10-02T06:00:00.000Z", "2026-10-02T08:00:00.000Z"); // 公出：台北 14:00～16:00
    expect(flagged(sheet([day("2026-10-02"), day("2026-10-05")]), [outing])).toEqual(["2026-10-05"]);
  });

  it("出差剛好在午夜結束（end_at 不含）→ 不算到隔天", () => {
    const midnight = trip("2026-10-04T16:00:00.000Z", "2026-10-05T16:00:00.000Z"); // 台北 10/05 00:00～10/06 00:00
    expect(flagged(sheet([day("2026-10-05"), day("2026-10-06")]), [midnight])).toEqual(["2026-10-06"]);
  });

  it("加班單、零用金預支不影響判斷（起迄壞掉也不管）", () => {
    const others: ApprovedRequestSpan[] = [
      { kind: "ot", start_at: "2026-10-07T10:00:00.000Z", end_at: "2026-10-07T12:00:00.000Z" },
      { kind: "petty_cash", start_at: "壞掉", end_at: "" },
      { kind: "something_new", start_at: "壞掉", end_at: "壞掉" },
    ];
    expect(flagged(weekSheet(), others)).toEqual(WEEK);
  });

  it("請假／在家工作／補卡／出差公出的日期讀不懂 → 不知道涵蓋哪幾天，這次整張不標（避免誤標）", () => {
    const bad: ApprovedRequestSpan[] = [
      trip("壞掉", "2026-10-07T15:59:00.000Z"),
      leave("壞掉", "2026-10-07T10:00:00.000Z"),
      { kind: "wfh", start_at: "2026-10-05T01:00:00.000Z", end_at: null as unknown as string },
      { kind: "fix_punch", start_at: "壞掉", end_at: "壞掉", segments: [{ date: "也壞掉" }] },
    ];
    for (const request of bad) {
      expect(flagged(weekSheet(), [request]), JSON.stringify(request)).toEqual([]);
    }
  });
});

/**
 * 審查發現 2：班表移除後只看行事曆，一週只來幾天的工讀／兼職每月會被標 8–10 個平日。
 * 只有固定上班日的身分（正職 regular、約聘 contract）才標；值域見 lib/ess-tabs.ts EMPLOYMENT_TYPES。
 */
describe("身分類別：只有固定上班日的員工才標", () => {
  const s = () => sheet([day("2026-10-05"), day("2026-10-07")]);

  it("正職、約聘（含大小寫、前後空白、中文寫法）→ 標", () => {
    for (const employmentType of ["regular", "Regular", " regular ", "contract", "full_time", "Full-Time", "正職", "全職", "約聘"]) {
      expect(flagged(s(), [], { employmentType }), employmentType).toEqual(["2026-10-05", "2026-10-07"]);
      expect(hasFixedWorkdays(employmentType), employmentType).toBe(true);
    }
  });

  it("工讀／兼職（parttime、part_time、Part-Time…）、實習 intern、派遣、中文的兼職／工讀／實習 → 整張不標", () => {
    for (const employmentType of ["parttime", "part_time", "Part-Time", "part time", "intern", "dispatched", "兼職", "工讀", "實習"]) {
      expect(flagged(s(), [], { employmentType }), employmentType).toEqual([]);
      expect(hasFixedWorkdays(employmentType), employmentType).toBe(false);
    }
  });

  it("欄位缺漏（/me 還沒回來、失敗、舊版 API）或不認得的值 → 不知道是不是固定上班日，整張不標", () => {
    for (const employmentType of [null, undefined, "", "  ", "hourly", "constructor"]) {
      expect(flagged(s(), [], { employmentType }), String(employmentType)).toEqual([]);
    }
    expect(hasFixedWorkdays(42)).toBe(false);
    expect(hasFixedWorkdays({})).toBe(false);
  });
});

/**
 * 審查發現 3：到職日。null＝主檔沒填 → 不限（維持現行）；不知道到職日 → 整張不標。
 * 9/30 以前核准的快照沒存 hireDate：欄位缺席時（undefined）不標；API 讀快照時把缺的欄位轉成 null，
 * 所以已核准／鎖定、核准時間早於 HIRE_DATE_IN_SNAPSHOT_SINCE 的 null 也當不知道。
 */
describe("到職日", () => {
  const days = () => [day("2026-10-05"), day("2026-10-06"), day("2026-10-07")];
  const ALL = ["2026-10-05", "2026-10-06", "2026-10-07"];

  it("到職日之前不標；到職當天起照標（也吃完整 ISO）；整個月都在到職前 → 不標", () => {
    expect(flagged(sheet(days(), { hireDate: "2026-10-06" }))).toEqual(["2026-10-06", "2026-10-07"]);
    expect(flagged(sheet(days(), { hireDate: "2026-10-06T00:00:00+08:00" }))).toEqual(["2026-10-06", "2026-10-07"]);
    expect(flagged(sheet(days(), { hireDate: "2026-11-01" }))).toEqual([]);
  });

  it("null（主檔真的沒有到職日）→ 不限，照舊", () => {
    expect(flagged(sheet(days(), { hireDate: null }))).toEqual(ALL);
  });

  it("欄位缺席（舊快照，undefined）→ 整張不標；跟 null 分開", () => {
    const absent = withoutHireDate(sheet(days()));
    expect("hireDate" in absent).toBe(false);
    expect(flagged(absent)).toEqual([]);
    expect(flagged(sheet(days(), { hireDate: undefined }))).toEqual([]);
  });

  it("格式不對 → 不知道到職日，整張不標", () => {
    expect(flagged(sheet(days(), { hireDate: "去年" }))).toEqual([]);
  });

  it("已核准快照、核准時間早於界線、hireDate 是 null（API 把缺的欄位轉成 null）→ 整張不標", () => {
    const old = sheet(days(), { frozen: true, approvedAt: "2026-09-15T08:00:00.000Z", hireDate: null });
    expect(flagged(old)).toEqual([]);
    // 核准時間讀不到也當舊快照
    expect(flagged(sheet(days(), { frozen: true, approvedAt: null, hireDate: null }))).toEqual([]);
    // 舊快照但 hireDate 有值（日後 API 補上了）→ 照到職日判斷
    expect(flagged(sheet(days(), { frozen: true, approvedAt: "2026-09-15T08:00:00.000Z", hireDate: "2026-10-06" }))).toEqual([
      "2026-10-06",
      "2026-10-07",
    ]);
  });

  it("界線之後核准的快照：null＝主檔沒填，照舊不限；界線本身算新快照", () => {
    expect(HIRE_DATE_IN_SNAPSHOT_SINCE).toBe("2026-10-01T00:00:00+08:00");
    expect(flagged(sheet(days(), { frozen: true, approvedAt: "2026-10-05T02:00:00.000Z", hireDate: null }))).toEqual(ALL);
    expect(flagged(sheet(days(), { frozen: true, approvedAt: "2026-09-30T16:00:00.000Z", hireDate: null }))).toEqual(ALL);
    expect(flagged(sheet(days(), { frozen: true, approvedAt: "2026-09-30T15:59:59.999Z", hireDate: null }))).toEqual([]);
  });

  it("還沒核准的月表（即時算的，frozen=false）就算核准時間欄是舊的也不受影響", () => {
    expect(flagged(sheet(days(), { frozen: false, approvedAt: "2026-09-15T08:00:00.000Z", hireDate: null }))).toEqual(ALL);
  });
});

describe("noPunchRules／isNoPunchDay", () => {
  it("門檻：today 與 computedAt 台北日期取較早的；到職日；已核准單涵蓋的區間", () => {
    const rules = noPunchRules(
      { computedAt: "2026-10-08T03:00:00.000Z", hireDate: "2026-10-02", frozen: false, approvedAt: null },
      {
        today: TODAY,
        employmentType: "regular",
        requests: [
          trip("2026-10-02T06:00:00.000Z", "2026-10-02T08:00:00.000Z"),
          leave("2026-10-05T01:00:00.000Z", "2026-10-06T10:00:00.000Z", ["2026-10-05", "2026-10-06"]),
          { kind: "ot", start_at: "2026-10-07T10:00:00.000Z", end_at: "2026-10-07T12:00:00.000Z" },
        ],
      },
    );
    expect(rules).toEqual({
      before: "2026-10-08",
      hireDay: "2026-10-02",
      coveredRanges: [
        { from: "2026-10-02", to: "2026-10-02" },
        { from: "2026-10-05", to: "2026-10-05" },
        { from: "2026-10-06", to: "2026-10-06" },
      ],
    });
    const base = { computedAt: "2026-10-20T03:00:00.000Z", hireDate: null, frozen: false, approvedAt: null };
    expect(noPunchRules(base, { today: TODAY, requests: [], employmentType: "regular" })?.before).toBe(TODAY);
    expect(noPunchRules({ ...base, computedAt: null }, { today: TODAY, requests: [], employmentType: "regular" })).toBeNull();
    expect(noPunchRules(base, { today: TODAY, requests: [], employmentType: "parttime" })).toBeNull();
  });

  it("單日判斷與整張一致", () => {
    const rules = noPunchRules(
      { computedAt: COMPUTED_AT, hireDate: null, frozen: false, approvedAt: null },
      { today: TODAY, requests: [], employmentType: "regular" },
    );
    expect(rules).not.toBeNull();
    if (!rules) return;
    expect(isNoPunchDay(day("2026-10-07"), rules)).toBe(true);
    expect(isNoPunchDay(day("2026-10-07", { dayType: "rest_day" }), rules)).toBe(false);
    expect(isNoPunchDay(day("2026-10-12"), rules)).toBe(false);
  });
});

describe("spanDateRange — 起迄換成台北日期（含頭含尾，end_at 不含）", () => {
  it("同一天的公出；多天的出差", () => {
    expect(spanDateRange({ start_at: "2026-10-02T06:00:00.000Z", end_at: "2026-10-02T08:00:00.000Z" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
    expect(spanDateRange({ start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-07T15:59:00.000Z" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-07",
    });
  });

  it("用台北日期，不是 UTC：UTC 10/01 16:30 是台北 10/02 00:30", () => {
    expect(spanDateRange({ start_at: "2026-10-01T16:30:00.000Z", end_at: "2026-10-01T18:00:00.000Z" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
    // 帶 +08:00 的寫法一樣
    expect(spanDateRange({ start_at: "2026-10-02T00:30:00+08:00", end_at: "2026-10-02T02:00:00+08:00" })?.from).toBe("2026-10-02");
  });

  it("剛好在午夜結束不算隔天；起迄相同或倒過來只算開始那天；讀不懂 → null", () => {
    expect(spanDateRange({ start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-05T16:00:00.000Z" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-05",
    });
    expect(spanDateRange({ start_at: "2026-10-05T02:00:00.000Z", end_at: "2026-10-05T02:00:00.000Z" })).toEqual({
      from: "2026-10-05",
      to: "2026-10-05",
    });
    expect(spanDateRange({ start_at: "2026-10-06T02:00:00.000Z", end_at: "2026-10-05T02:00:00.000Z" })).toEqual({
      from: "2026-10-06",
      to: "2026-10-06",
    });
    expect(spanDateRange({ start_at: "abc", end_at: "2026-10-05T02:00:00.000Z" })).toBeNull();
    expect(spanDateRange({ start_at: "2026-10-05T02:00:00.000Z", end_at: null as unknown as string })).toBeNull();
  });
});

describe("requestDateRanges — 一張已核准的單涵蓋哪幾天", () => {
  it("請假：segments 每段一天（重複的日期只算一次）；沒有 segments 用起迄", () => {
    expect(requestDateRanges(leave("2026-10-05T01:00:00.000Z", "2026-10-07T10:00:00.000Z", ["2026-10-05", "2026-10-07", "2026-10-07"]))).toEqual([
      { from: "2026-10-05", to: "2026-10-05" },
      { from: "2026-10-07", to: "2026-10-07" },
    ]);
    expect(requestDateRanges(leave("2026-10-05T01:00:00.000Z", "2026-10-07T10:00:00.000Z"))).toEqual([{ from: "2026-10-05", to: "2026-10-07" }]);
  });

  it("補卡：start_at 的台北日期加上 segments 的 date；兩個都讀不懂 → null", () => {
    expect(
      requestDateRanges({ kind: "fix_punch", start_at: "2026-10-07T10:00:00.000Z", end_at: "2026-10-07T10:00:00.000Z", segments: [{ date: "2026-10-07" }] }),
    ).toEqual([{ from: "2026-10-07", to: "2026-10-07" }]);
    expect(requestDateRanges({ kind: "fix_punch", start_at: "壞掉", end_at: "壞掉", segments: [{ date: "2026-10-07" }] })).toEqual([
      { from: "2026-10-07", to: "2026-10-07" },
    ]);
    expect(requestDateRanges({ kind: "fix_punch", start_at: "壞掉", end_at: "壞掉" })).toBeNull();
  });

  it("在家工作、出差／公出：起迄；其他種類 → []（不管起迄）", () => {
    expect(requestDateRanges({ kind: "wfh", start_at: "2026-10-04T16:00:00.000Z", end_at: "2026-10-05T15:59:00.000Z" })).toEqual([
      { from: "2026-10-05", to: "2026-10-05" },
    ]);
    expect(requestDateRanges(trip("2026-10-04T16:00:00.000Z", "2026-10-06T15:59:00.000Z"))).toEqual([{ from: "2026-10-05", to: "2026-10-06" }]);
    expect(requestDateRanges({ kind: "ot", start_at: "壞掉", end_at: "壞掉" })).toEqual([]);
    expect(requestDateRanges(null as unknown as ApprovedRequestSpan)).toEqual([]);
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

describe("isRequestsForbidden — 讀已核准單 403＝當作沒有核准單；其他錯誤＝整張不標", () => {
  /** apiFetch 丟出的 Error 的樣子：message `[status] code`，另外掛 status／code／body。 */
  function apiError(status: number, code: string): Error {
    return Object.assign(new Error(`[${status}] ${code}`), { status, code, body: { error: code } });
  }

  it("403（員工端「申請」分頁沒開）→ true；只剩訊息的 `[403] …` 也認得", () => {
    expect(isRequestsForbidden(apiError(403, "ess_tab_disabled"))).toBe(true);
    expect(isRequestsForbidden(new Error("[403] ess_tab_disabled"))).toBe(true);
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
      expect(isRequestsForbidden(err)).toBe(false);
    }
  });
});
