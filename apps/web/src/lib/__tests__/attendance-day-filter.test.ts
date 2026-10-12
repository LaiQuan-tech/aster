import { describe, it, expect, vi } from "vitest";
import {
  PUNCHES_SHOW_ALL_STORAGE_KEY,
  PUNCH_FILTER_TEXT,
  SHEET_FILTER_TEXT,
  SHEET_SHOW_ALL_STORAGE_KEY,
  browserStorage,
  isNotablePunchRow,
  isNotableSheetDay,
  partitionNotable,
  partitionPunchRows,
  partitionSheetDays,
  punchRowReasons,
  readStoredFlag,
  sheetDayReasons,
  writeStoredFlag,
  type FlagStorage,
} from "../attendance-day-filter";
import {
  unacknowledgedErrors,
  type AnomalyCode,
  type AnomalySeverity,
  type SheetAnomaly,
  type SheetDayView,
  type SheetView,
} from "../attendance-sheets-api";
import type { DayRow } from "../punch-history";

/**
 * 「這天有沒有事」：出勤月表預設只顯示有事的日子（請假、加班、異常、手動註記／審核覆寫），
 * 平淡的正常出勤收起來；打卡紀錄頁預設只列需要處理的日子。規則寫在 attendance-day-filter.ts 檔頭。
 * 最重要的一條：error 級異常的日子**永遠不能被藏起來**（員工送出前要看得到要補的卡）。
 * 2026-10-12：員工本人月表另外傳「無打卡紀錄」（no_punch，lib/sheet-no-punch.ts）進來，那些日子也要預設顯示。
 */

function anomaly(code: AnomalyCode, severity: AnomalySeverity, message = code): SheetAnomaly {
  return { code, severity, message };
}

type DayOverrides = Partial<Omit<SheetDayView, "overtime">> & { overtime?: Partial<SheetDayView["overtime"]> };

/** 平淡的正常出勤日（週二、09:00–18:00、什麼都沒有）；用 overrides 疊出各種情境。 */
function day(overrides: DayOverrides = {}): SheetDayView {
  const { overtime, ...rest } = overrides;
  return {
    date: "2026-09-15",
    weekday: 2,
    dayType: "workday",
    firstIn: "09:00",
    lastOut: "18:00",
    workedMinutes: 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    outingMinutes: 0,
    leaveMinutes: 0,
    leaveSummary: null,
    wfh: false,
    overtime: {
      computed: 0,
      override: null,
      overrideReason: null,
      effective: 0,
      tier1: 0,
      tier2: 0,
      tier3: 0,
      beyondCap: 0,
      ...overtime,
    },
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

describe("sheetDayReasons／isNotableSheetDay — 平淡的正常出勤不算有事", () => {
  it("正常上下班、沒有任何紀錄 → 沒事", () => {
    expect(sheetDayReasons(day())).toEqual([]);
    expect(isNotableSheetDay(day())).toBe(false);
  });

  it("休息日／國定假日沒有任何紀錄、單純在家工作（只掛「在家」標籤）→ 沒事", () => {
    expect(isNotableSheetDay(day({ dayType: "rest_day", firstIn: null, lastOut: null, workedMinutes: 0 }))).toBe(false);
    expect(isNotableSheetDay(day({ dayType: "fixed_holiday", firstIn: null, lastOut: null, workedMinutes: 0 }))).toBe(false);
    expect(isNotableSheetDay(day({ wfh: true, firstIn: null, lastOut: null }))).toBe(false);
  });

  it("只有資訊級異常（扣晚餐、超額另計說明）→ 不算（它們只出現在本來就有加班的日子）", () => {
    const d = day({ anomalies: [anomaly("meal_deducted", "info"), anomaly("overtime_beyond_cap", "info")] });
    expect(isNotableSheetDay(d)).toBe(false);
  });

  it("欄位缺漏的舊版快照（沒有 overtime／anomalies／各分鐘欄）不會丟例外，視為沒事", () => {
    const legacy = { date: "2026-01-05", dayType: "workday", firstIn: null, lastOut: null } as unknown as SheetDayView;
    expect(sheetDayReasons(legacy)).toEqual([]);
    const noOvertimeBeyondCap = day({ overtime: { beyondCap: undefined } });
    expect(isNotableSheetDay(noOvertimeBeyondCap)).toBe(false);
  });
});

describe("sheetDayReasons — 有事的日子", () => {
  it("缺卡等 error 級異常 → 有事（絕不能藏）；warn 級（遲到、補打卡、假日出勤…）也顯示", () => {
    expect(sheetDayReasons(day({ anomalies: [anomaly("missing_out", "error")] }))).toEqual(["error"]);
    expect(sheetDayReasons(day({ anomalies: [anomaly("late", "warn")] }))).toEqual(["warn"]);
    expect(sheetDayReasons(day({ anomalies: [anomaly("manual_punch", "warn")] }))).toEqual(["warn"]);
    expect(sheetDayReasons(day({ anomalies: [anomaly("holiday_work", "warn"), anomaly("missing_in", "error")] }))).toEqual(["error", "warn"]);
  });

  it("每一種 error／warn 級異常代碼都會讓那天顯示（對照後端 computeAnomalies 發的代碼）", () => {
    const errorCodes: AnomalyCode[] = [
      "missing_in",
      "missing_out",
      "unpaired_punch",
      "absent_scheduled",
      "leave_overlap_work",
      "overtime_beyond_cap_unapproved",
    ];
    const warnCodes: AnomalyCode[] = [
      "late",
      "early_leave",
      "overtime_override",
      "overtime_over_daily_cap",
      "holiday_work",
      "outing_unpaired",
      "manual_punch",
      "cross_midnight",
    ];
    for (const code of errorCodes) expect(isNotableSheetDay(day({ anomalies: [anomaly(code, "error")] })), code).toBe(true);
    for (const code of warnCodes) expect(isNotableSheetDay(day({ anomalies: [anomaly(code, "warn")] })), code).toBe(true);
  });

  it("有請假（分鐘數或假別摘要任一個）→ 有事", () => {
    expect(sheetDayReasons(day({ leaveMinutes: 240, leaveSummary: "特休" }))).toEqual(["leave"]);
    expect(sheetDayReasons(day({ leaveMinutes: 0, leaveSummary: "病假" }))).toEqual(["leave"]);
    expect(isNotableSheetDay(day({ leaveSummary: "   " }))).toBe(false);
  });

  it("有加班（有效分鐘、級距分鐘、月上限外另計的分鐘任一個 > 0）→ 有事", () => {
    expect(sheetDayReasons(day({ overtime: { computed: 90, effective: 90, tier1: 90 } }))).toEqual(["overtime"]);
    // 舊快照沒有 effective／computed，只剩級距
    expect(isNotableSheetDay(day({ overtime: { computed: 0, effective: 0, tier2: 30 } }))).toBe(true);
    expect(isNotableSheetDay(day({ overtime: { beyondCap: 45 } }))).toBe(true);
    expect(isNotableSheetDay(day({ overtime: { tier1: 0, tier2: 0, tier3: 0, beyondCap: 0 } }))).toBe(false);
  });

  it("加班被人工覆寫（審核覆寫）→ 有事，連覆寫成 0 也算", () => {
    expect(sheetDayReasons(day({ overtime: { computed: 120, override: 0, overrideReason: "未經核准", effective: 0 } }))).toEqual([
      "overtime",
      "override",
    ]);
    expect(sheetDayReasons(day({ overtime: { computed: 0, override: 0, effective: 0 } }))).toEqual(["override"]);
  });

  it("遲到、早退、外出分鐘 > 0 → 有事（與合計卡片的遲到、外出時數對得起來）", () => {
    expect(sheetDayReasons(day({ lateMinutes: 12 }))).toEqual(["late"]);
    expect(sheetDayReasons(day({ earlyLeaveMinutes: 30 }))).toEqual(["late"]);
    expect(sheetDayReasons(day({ outingMinutes: 90 }))).toEqual(["outing"]);
  });

  it("手動註記：內容、外出地點、備註、異常說明、指定專案任一個有字 → 有事；空白字串不算", () => {
    expect(sheetDayReasons(day({ content: "客戶端駐點" }))).toEqual(["note"]);
    expect(sheetDayReasons(day({ outingNote: "台中" }))).toEqual(["note"]);
    expect(sheetDayReasons(day({ note: "下午補休" }))).toEqual(["note"]);
    expect(sheetDayReasons(day({ anomalyAck: "忘記打卡，已請主管確認" }))).toEqual(["note"]);
    expect(sheetDayReasons(day({ projectId: "p1" }))).toEqual(["note"]);
    expect(sheetDayReasons(day({ projectName: "某案" }))).toEqual(["note"]);
    expect(isNotableSheetDay(day({ content: "  ", note: "", outingNote: null, anomalyAck: "\n" }))).toBe(false);
  });

  it("多個原因並存時順序固定", () => {
    const d = day({
      anomalies: [anomaly("missing_out", "error"), anomaly("late", "warn")],
      leaveMinutes: 60,
      lateMinutes: 5,
      outingMinutes: 30,
      note: "x",
      overtime: { effective: 60, computed: 60, override: 60 },
    });
    expect(sheetDayReasons(d)).toEqual(["error", "warn", "leave", "overtime", "override", "late", "outing", "note"]);
    // 頁面另外傳進來的 no_punch 排在 warn 之後
    expect(sheetDayReasons(d, { noPunch: true })).toEqual([
      "error",
      "warn",
      "no_punch",
      "leave",
      "overtime",
      "override",
      "late",
      "outing",
      "note",
    ]);
  });
});

describe("no_punch（員工本人月表的「無打卡紀錄」，由頁面算好傳進來）", () => {
  const blank = day({ date: "2026-09-08", firstIn: null, lastOut: null, workedMinutes: 0 });

  it("單看當天資料不算有事；頁面傳 noPunch:true 才算；false／不傳一樣不算", () => {
    expect(sheetDayReasons(blank)).toEqual([]);
    expect(sheetDayReasons(blank, { noPunch: true })).toEqual(["no_punch"]);
    expect(isNotableSheetDay(blank, { noPunch: true })).toBe(true);
    expect(isNotableSheetDay(blank, { noPunch: false })).toBe(false);
    expect(isNotableSheetDay(blank, {})).toBe(false);
    expect(isNotableSheetDay(blank)).toBe(false);
  });

  it("partitionSheetDays 帶 extraOf：無打卡的日子預設顯示（不被「顯示全月」收起）；不帶＝行為與以前相同", () => {
    const plain = day({ date: "2026-09-07" });
    const leave = day({ date: "2026-09-09", firstIn: null, lastOut: null, workedMinutes: 0, leaveMinutes: 480, leaveSummary: "特休" });
    const days = [plain, blank, leave];
    const noPunchDates = new Set(["2026-09-08"]);
    const extraOf = (d: SheetDayView) => ({ noPunch: noPunchDates.has(d.date) });

    const withExtra = partitionSheetDays(days, false, extraOf);
    expect(withExtra.entries.filter((e) => !e.hidden).map((e) => e.item.date)).toEqual(["2026-09-08", "2026-09-09"]);
    expect([withExtra.notableCount, withExtra.hiddenCount, withExtra.visibleCount]).toEqual([2, 1, 2]);

    // 不帶（後台、主管審核頁）：整天沒打卡的日子跟以前一樣被收起來
    const without = partitionSheetDays(days, false);
    expect(without.entries.filter((e) => !e.hidden).map((e) => e.item.date)).toEqual(["2026-09-09"]);
    expect(partitionSheetDays(days, false, () => undefined).hiddenCount).toBe(2);

    // 開「顯示全月」：全部顯示，no_punch 的標記仍在
    const all = partitionSheetDays(days, true, extraOf);
    expect(all.hiddenCount).toBe(0);
    expect(all.entries.find((e) => e.item.date === "2026-09-08")?.notable).toBe(true);
  });

  it("不擋送出：no_punch 不是 anomalies，unacknowledgedErrors 不受影響", () => {
    const sheet = { days: [blank] } as unknown as SheetView;
    expect(partitionSheetDays(sheet.days, false, () => ({ noPunch: true })).visibleCount).toBe(1);
    expect(unacknowledgedErrors(sheet)).toEqual([]);
  });
});

describe("partitionSheetDays — 預設只顯示有事的日子、提供顯示全月", () => {
  const plain1 = day({ date: "2026-09-01" });
  const leave = day({ date: "2026-09-02", leaveMinutes: 480, leaveSummary: "特休" });
  const plain2 = day({ date: "2026-09-03" });
  const overtime = day({ date: "2026-09-04", overtime: { computed: 120, effective: 120, tier1: 120 } });
  const missing = day({ date: "2026-09-05", firstIn: "09:00", lastOut: null, anomalies: [anomaly("missing_out", "error")] });
  const plain3 = day({ date: "2026-09-06", dayType: "rest_day", firstIn: null, lastOut: null, workedMinutes: 0 });
  const days = [plain1, leave, plain2, overtime, missing, plain3];

  it("預設（關）：只有請假、加班、缺卡的日子看得到，其餘 3 天收起來；順序不變", () => {
    const p = partitionSheetDays(days, false);
    expect(p.total).toBe(6);
    expect(p.notableCount).toBe(3);
    expect(p.hiddenCount).toBe(3);
    expect(p.visibleCount).toBe(3);
    expect(p.entries.map((e) => e.item.date)).toEqual(days.map((d) => d.date));
    expect(p.entries.filter((e) => !e.hidden).map((e) => e.item.date)).toEqual(["2026-09-02", "2026-09-04", "2026-09-05"]);
  });

  it("開了「顯示全月」：全部顯示、隱藏數 0（有事的標記仍保留）", () => {
    const p = partitionSheetDays(days, true);
    expect(p.hiddenCount).toBe(0);
    expect(p.visibleCount).toBe(6);
    expect(p.entries.every((e) => !e.hidden)).toBe(true);
    expect(p.notableCount).toBe(3);
  });

  it("整個月都平淡 → 預設一天都不顯示（畫面要顯示友善空狀態）；沒有資料 → 全 0", () => {
    const quiet = partitionSheetDays([plain1, plain2, plain3], false);
    expect(quiet.visibleCount).toBe(0);
    expect(quiet.hiddenCount).toBe(3);
    const empty = partitionSheetDays([], false);
    expect([empty.total, empty.hiddenCount, empty.visibleCount]).toEqual([0, 0, 0]);
  });

  it("安全網：所有「錯誤級且尚未說明」的日子（送出前必須處理的）預設一定看得到", () => {
    const unacknowledged = day({ date: "2026-09-10", anomalies: [anomaly("absent_scheduled", "error")] });
    const acknowledged = day({ date: "2026-09-11", anomalies: [anomaly("missing_in", "error")], anomalyAck: "已補卡" });
    const sheet = { days: [plain1, unacknowledged, plain2, acknowledged, plain3] } as unknown as SheetView;
    const blockerDates = unacknowledgedErrors(sheet).map((b) => b.date);
    expect(blockerDates).toEqual(["2026-09-10"]);
    const visibleDates = partitionSheetDays(sheet.days, false)
      .entries.filter((e) => !e.hidden)
      .map((e) => e.item.date);
    for (const date of blockerDates) expect(visibleDates).toContain(date);
    // 已說明的 error 日子同樣顯示（它有 error 異常與手動說明）
    expect(visibleDates).toContain("2026-09-11");
  });
});

describe("打卡紀錄頁 — punchRowReasons／partitionPunchRows", () => {
  const TODAY = "2026-09-17"; // 週四
  const row = (date: string, status: DayRow["status"], durationMin: number | null = null): Pick<DayRow, "date" | "status" | "durationMin"> => ({
    date,
    status,
    durationMin,
  });

  it("上下班都完整的平日 → 沒事", () => {
    expect(punchRowReasons(row("2026-09-16", "complete", 540), TODAY)).toEqual([]);
    expect(isNotablePunchRow(row("2026-09-16", "complete", 540), TODAY)).toBe(false);
  });

  it("缺上班、缺下班、平日完全沒打卡 → 有事（要讓員工看到可以申請補卡）", () => {
    expect(punchRowReasons(row("2026-09-16", "missing_in"), TODAY)).toEqual(["missing_in"]);
    expect(punchRowReasons(row("2026-09-16", "missing_out"), TODAY)).toEqual(["missing_out"]);
    expect(punchRowReasons(row("2026-09-16", "none"), TODAY)).toEqual(["no_punch"]);
  });

  it("今天一律顯示（即使已完整打卡或還沒打卡，進行中的一天不該憑空消失）", () => {
    expect(punchRowReasons(row(TODAY, "complete", 480), TODAY)).toEqual(["today"]);
    expect(punchRowReasons(row(TODAY, "missing_out"), TODAY)).toEqual(["today", "missing_out"]);
    expect(isNotablePunchRow(row(TODAY, "none"), TODAY)).toBe(true);
  });

  it("上下班都有但時長算不出來（下班早於上班）→ 有事", () => {
    expect(punchRowReasons(row("2026-09-16", "complete", null), TODAY)).toEqual(["bad_order"]);
  });

  it("沒有行事曆：週六日有打卡 → 有事（buildDayRows 只會在非上班日有紀錄時才列）", () => {
    expect(punchRowReasons(row("2026-09-12", "complete", 300), TODAY)).toEqual(["non_workday"]); // 週六
    expect(punchRowReasons(row("2026-09-13", "missing_out"), TODAY)).toEqual(["missing_out", "non_workday"]); // 週日
  });

  it("有行事曆（2026-10-12）：平日的國定假日有完整打卡（去加班）→ 有事；補班的週六完整打卡 → 沒事", () => {
    // 2026-10-09 是週五：行事曆標國定假日
    expect(punchRowReasons(row("2026-10-09", "complete", 300), TODAY, "fixed_holiday")).toEqual(["non_workday"]);
    expect(isNotablePunchRow(row("2026-10-09", "complete", 300), TODAY, "fixed_holiday")).toBe(true);
    // 沒傳行事曆時同一天是平日 → 照舊收起（行事曆抓不到的退回規則）
    expect(isNotablePunchRow(row("2026-10-09", "complete", 300), TODAY)).toBe(false);
    // 2026-09-12 是週六：行事曆標補班（workday）→ 是上班日，完整打卡不列
    expect(punchRowReasons(row("2026-09-12", "complete", 480), TODAY, "workday")).toEqual([]);
    // 補班日缺卡／沒打卡照樣列（理由是缺卡，不是非上班日）
    expect(punchRowReasons(row("2026-09-12", "missing_out"), TODAY, "workday")).toEqual(["missing_out"]);
    expect(punchRowReasons(row("2026-09-12", "none"), TODAY, "workday")).toEqual(["no_punch"]);
    // 平日被標休息日（rest_day）也算非上班日
    expect(punchRowReasons(row("2026-09-16", "complete", 480), TODAY, "rest_day")).toEqual(["non_workday"]);
  });

  it("partitionPunchRows：只收起上下班完整的上班日；開全部後都顯示；保持原順序", () => {
    const rows = [
      row("2026-09-17", "missing_out"), // 今天
      row("2026-09-16", "complete", 540),
      row("2026-09-15", "none"),
      row("2026-09-14", "complete", 530),
      row("2026-09-13", "complete", 200), // 週日
    ];
    const hidden = partitionPunchRows(rows, false, TODAY);
    expect(hidden.hiddenCount).toBe(2);
    expect(hidden.entries.filter((e) => !e.hidden).map((e) => e.item.date)).toEqual(["2026-09-17", "2026-09-15", "2026-09-13"]);
    const all = partitionPunchRows(rows, true, TODAY);
    expect(all.hiddenCount).toBe(0);
    expect(all.entries.map((e) => e.item.date)).toEqual(rows.map((r) => r.date));
  });

  it("partitionPunchRows 帶行事曆：國定假日加班預設列出、補班日完整收起；行事曆沒有的日子退回週一～五", () => {
    const rows = [
      row("2026-09-16", "complete", 540), // 週三，行事曆：國定假日（去加班）
      row("2026-09-15", "complete", 530), // 週二，行事曆沒有 → 平日
      row("2026-09-13", "complete", 200), // 週日，行事曆沒有 → 休息日
      row("2026-09-12", "complete", 480), // 週六，行事曆：補班
    ];
    const dayTypeByDate = { "2026-09-16": "fixed_holiday", "2026-09-12": "workday" };
    const p = partitionPunchRows(rows, false, TODAY, dayTypeByDate);
    expect(p.entries.filter((e) => !e.hidden).map((e) => e.item.date)).toEqual(["2026-09-16", "2026-09-13"]);
    expect([p.notableCount, p.hiddenCount, p.visibleCount]).toEqual([2, 2, 2]);
    // 不帶行事曆＝舊規則：週三收起、週六列出
    const legacy = partitionPunchRows(rows, false, TODAY);
    expect(legacy.entries.filter((e) => !e.hidden).map((e) => e.item.date)).toEqual(["2026-09-13", "2026-09-12"]);
    // 空的行事曆（抓到了但這段期間沒有裁定）＝同舊規則
    expect(partitionPunchRows(rows, false, TODAY, {}).hiddenCount).toBe(legacy.hiddenCount);
  });
});

describe("partitionNotable（通用）", () => {
  it("依傳入的判斷分組並維持順序；空陣列安全", () => {
    const p = partitionNotable([1, 2, 3, 4], (n) => n % 2 === 0, false);
    expect(p.entries.map((e) => [e.item, e.notable, e.hidden])).toEqual([
      [1, false, true],
      [2, true, false],
      [3, false, true],
      [4, true, false],
    ]);
    expect(partitionNotable([], () => true, false).total).toBe(0);
  });
});

describe("文案", () => {
  it("月表：與會議決議的字面一致", () => {
    expect(SHEET_FILTER_TEXT.showAll(30)).toBe("顯示全月（30 天）");
    expect(SHEET_FILTER_TEXT.hidden(22)).toBe("已隱藏 22 天正常出勤");
    expect(SHEET_FILTER_TEXT.emptyTitle).toBe("本月沒有請假、加班或異常");
    expect(SHEET_FILTER_TEXT.emptyHint(30)).toContain("顯示全月");
  });

  it("打卡紀錄頁：同樣提示怎麼看全部", () => {
    expect(PUNCH_FILTER_TEXT.showAll(7)).toBe("顯示全部日期（7 天）");
    expect(PUNCH_FILTER_TEXT.hidden(4)).toBe("已隱藏 4 天打卡正常的日子");
    expect(PUNCH_FILTER_TEXT.emptyHint(7)).toContain("顯示全部日期");
  });
});

/** 記憶體版 localStorage；可指定哪些操作要丟例外（模擬私密視窗／封鎖網站資料／空間滿了）。 */
function memoryStorage(initial: Record<string, string> = {}, failing: Array<"getItem" | "setItem" | "removeItem"> = []) {
  const data = new Map(Object.entries(initial));
  const guard = (op: "getItem" | "setItem" | "removeItem") => {
    if (failing.includes(op)) throw new Error(`${op} blocked`);
  };
  const storage: FlagStorage = {
    getItem: (key) => (guard("getItem"), data.get(key) ?? null),
    setItem: (key, value) => (guard("setItem"), void data.set(key, value)),
    removeItem: (key) => (guard("removeItem"), void data.delete(key)),
  };
  return { storage, data };
}

describe("開關記憶（localStorage，讀寫都包 try/catch）", () => {
  const KEY = SHEET_SHOW_ALL_STORAGE_KEY.ess;

  it("ESS 與後台各自記憶：鍵不同；打卡紀錄頁另有一個鍵", () => {
    const keys = new Set([SHEET_SHOW_ALL_STORAGE_KEY.ess, SHEET_SHOW_ALL_STORAGE_KEY.admin, PUNCHES_SHOW_ALL_STORAGE_KEY]);
    expect(keys.size).toBe(3);
  });

  it("沒記憶一律預設關；存了 1 才是開；其他值（壞資料）一律關", () => {
    expect(readStoredFlag(memoryStorage().storage, KEY)).toBe(false);
    expect(readStoredFlag(memoryStorage({ [KEY]: "1" }).storage, KEY)).toBe(true);
    for (const junk of ["0", "true", "yes", "", "{}", "1 "]) {
      expect(readStoredFlag(memoryStorage({ [KEY]: junk }).storage, KEY), junk).toBe(false);
    }
  });

  it("寫入再讀回；各範圍互不影響；關＝移除該鍵", () => {
    const { storage, data } = memoryStorage();
    expect(writeStoredFlag(storage, SHEET_SHOW_ALL_STORAGE_KEY.ess, true)).toBe(true);
    expect(readStoredFlag(storage, SHEET_SHOW_ALL_STORAGE_KEY.ess)).toBe(true);
    expect(readStoredFlag(storage, SHEET_SHOW_ALL_STORAGE_KEY.admin)).toBe(false);
    expect(readStoredFlag(storage, PUNCHES_SHOW_ALL_STORAGE_KEY)).toBe(false);
    expect(writeStoredFlag(storage, SHEET_SHOW_ALL_STORAGE_KEY.ess, false)).toBe(true);
    expect(readStoredFlag(storage, SHEET_SHOW_ALL_STORAGE_KEY.ess)).toBe(false);
    expect(data.size).toBe(0);
  });

  it("儲存空間不可用（getItem／setItem／removeItem 丟例外、storage 為 null／undefined）→ 不丟例外，讀回預設關、寫入回 false", () => {
    expect(readStoredFlag(memoryStorage({ [KEY]: "1" }, ["getItem"]).storage, KEY)).toBe(false);
    expect(writeStoredFlag(memoryStorage({}, ["setItem"]).storage, KEY, true)).toBe(false);
    expect(writeStoredFlag(memoryStorage({}, ["removeItem"]).storage, KEY, false)).toBe(false);
    expect(readStoredFlag(null, KEY)).toBe(false);
    expect(readStoredFlag(undefined, KEY)).toBe(false);
    expect(writeStoredFlag(null, KEY, true)).toBe(false);
  });

  it("browserStorage：沒有 window（伺服端／測試）→ null；window.localStorage 存取就丟例外（被封鎖）也回 null", () => {
    expect(browserStorage()).toBeNull();
    const blocked = {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    };
    vi.stubGlobal("window", blocked);
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    const fakeStorage = memoryStorage().storage;
    vi.stubGlobal("window", { localStorage: fakeStorage });
    try {
      expect(browserStorage()).toBe(fakeStorage);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
