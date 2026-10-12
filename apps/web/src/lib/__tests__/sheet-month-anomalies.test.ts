import { describe, expect, it } from "vitest";
import {
  MONTH_ANOMALY_FALLBACK_TEXT,
  MONTH_ANOMALY_GENERIC_TEXT,
  monthAnomalyText,
  visibleMonthAnomalies,
  type AnomalyCode,
  type SheetAnomaly,
  type SheetView,
} from "../attendance-sheets-api";

/**
 * 月份級異常（2026-10-12 驗收第 10 條）：異常計數早就含月級（後台列表 error×／warn×），但點進月表看不到。
 * 這裡測顯示用的純函式：員工端不顯示只有 HR 能處理的「未設定薪資結構」、嚴重度排序、message 空白時的中文。
 * 訊息照抄 apps/api/src/services/attendance-sheets.ts 產生月份級異常的那一段。
 */

const API_MONTH_ANOMALIES: SheetAnomaly[] = [
  { code: "monthly_ot_threshold", severity: "warn", detail: { hours: 38, threshold: 36 }, message: "本月加班累計 38 小時，已達 36 小時門檻" },
  { code: "consecutive_late", severity: "warn", detail: { days: 3 }, message: "連續 3 日遲到（2026-10-05 ～ 2026-10-07）" },
  { code: "pending_leave_in_period", severity: "warn", detail: { count: 1 }, message: "本月仍有 1 張假單待簽核，核准後請假時數才會計入" },
  { code: "unsettled_leave_in_period", severity: "error", detail: { count: 2 }, message: "本月有 2 張假單已核准但人資尚未核銷" },
  { code: "late_reports_undecided", severity: "warn", detail: { count: 1 }, message: "1 筆遲到說明老闆尚未決定（視為影響全勤）" },
  { code: "no_salary_structure", severity: "warn", message: "尚未設定薪資結構，無法試算金額" },
];

describe("visibleMonthAnomalies — 誰看得到哪些", () => {
  it("後台：全部顯示；error 排最前面，同級維持 API 原順序", () => {
    const items = visibleMonthAnomalies(API_MONTH_ANOMALIES, "admin");
    expect(items.map((i) => i.code)).toEqual([
      "unsettled_leave_in_period",
      "monthly_ot_threshold",
      "consecutive_late",
      "pending_leave_in_period",
      "late_reports_undecided",
      "no_salary_structure",
    ]);
    expect(items[0]).toEqual({ code: "unsettled_leave_in_period", severity: "error", text: "本月有 2 張假單已核准但人資尚未核銷" });
  });

  it("員工端（本人月表、主管審核頁）：不顯示「未設定薪資結構」（HR 才能處理），其餘照顯示", () => {
    const items = visibleMonthAnomalies(API_MONTH_ANOMALIES, "ess");
    expect(items.map((i) => i.code)).not.toContain("no_salary_structure");
    expect(items).toHaveLength(5);
    expect(visibleMonthAnomalies([API_MONTH_ANOMALIES[5]], "ess")).toEqual([]);
    expect(visibleMonthAnomalies([API_MONTH_ANOMALIES[5]], "admin")).toHaveLength(1);
  });

  it("顯示的文字就是 API 的中文 message（前後空白去掉）", () => {
    expect(visibleMonthAnomalies(API_MONTH_ANOMALIES, "admin").map((i) => i.text)).toEqual([
      "本月有 2 張假單已核准但人資尚未核銷",
      "本月加班累計 38 小時，已達 36 小時門檻",
      "連續 3 日遲到（2026-10-05 ～ 2026-10-07）",
      "本月仍有 1 張假單待簽核，核准後請假時數才會計入",
      "1 筆遲到說明老闆尚未決定（視為影響全勤）",
      "尚未設定薪資結構，無法試算金額",
    ]);
    expect(monthAnomalyText({ code: "consecutive_late", message: "  連續 4 日遲到  " })).toBe("連續 4 日遲到");
  });

  it("嚴重度：error → warn → info；不認得的嚴重度當 info（灰色）", () => {
    const items = visibleMonthAnomalies(
      [
        { code: "late_reports_undecided", severity: "info", message: "c" },
        { code: "consecutive_late", severity: "warn", message: "b" },
        { code: "monthly_ot_threshold", severity: "critical", message: "d" } as unknown as SheetAnomaly,
        { code: "monthly_ot_threshold", severity: "error", message: "a" },
      ],
      "admin",
    );
    expect(items.map((i) => [i.text, i.severity])).toEqual([
      ["a", "error"],
      ["b", "warn"],
      ["c", "info"],
      ["d", "info"],
    ]);
  });

  it("沒有資料、不是陣列、壞掉的項目 → 略過、不丟例外", () => {
    expect(visibleMonthAnomalies([], "ess")).toEqual([]);
    expect(visibleMonthAnomalies(null, "ess")).toEqual([]);
    expect(visibleMonthAnomalies(undefined, "admin")).toEqual([]);
    expect(visibleMonthAnomalies({} as unknown as SheetAnomaly[], "admin")).toEqual([]);
    const junk = [null, 42, "x", {}, { severity: "warn" }, { code: "", message: "  " }] as unknown as SheetAnomaly[];
    expect(visibleMonthAnomalies(junk, "admin")).toEqual([]);
  });
});

describe("monthAnomalyText — message 空白時用代碼對照的中文", () => {
  it("每一種月份級代碼都有中文（含後端以 as 轉型送出的 unsettled_leave_in_period）", () => {
    const codes: AnomalyCode[] = [
      "monthly_ot_threshold",
      "consecutive_late",
      "pending_leave_in_period",
      "unsettled_leave_in_period",
      "late_reports_undecided",
      "no_salary_structure",
    ];
    for (const code of codes) {
      const text = monthAnomalyText({ code, message: "" });
      expect(text, code).toBe(MONTH_ANOMALY_FALLBACK_TEXT[code]);
      expect(text, code).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("代碼也不認得（含 constructor 這種 Object 原型上的名字）→ 通用中文，不會露出代碼", () => {
    expect(monthAnomalyText({ code: "brand_new_code", message: "" })).toBe(MONTH_ANOMALY_GENERIC_TEXT);
    expect(monthAnomalyText({ code: "constructor", message: undefined })).toBe(MONTH_ANOMALY_GENERIC_TEXT);
    expect(monthAnomalyText({})).toBe(MONTH_ANOMALY_GENERIC_TEXT);
    expect(visibleMonthAnomalies([{ code: "brand_new_code", severity: "warn", message: "" } as unknown as SheetAnomaly], "ess")).toEqual([
      { code: "brand_new_code", severity: "warn", text: MONTH_ANOMALY_GENERIC_TEXT },
    ]);
  });
});

describe("型別：web 的合約補上後端實際會送的欄位", () => {
  it("SheetView.hireDate（選填）、AnomalyCode 含 unsettled_leave_in_period", () => {
    const code: AnomalyCode = "unsettled_leave_in_period";
    const withHire: Pick<SheetView, "hireDate"> = { hireDate: "2026-10-01" };
    const legacy: Pick<SheetView, "hireDate"> = {};
    expect([code, withHire.hireDate, legacy.hireDate]).toEqual(["unsettled_leave_in_period", "2026-10-01", undefined]);
  });
});
