import { describe, expect, it } from "vitest";
import {
  anomalyPills,
  approveHint,
  filterBySeverity,
  monthAnomalyHref,
  parseSheetFocusHash,
  severityFilterOf,
  sheetDayRowId,
  sheetFocusHref,
  statusPillFocus,
} from "../sheet-focus";

/** 出勤月表狀態藥丸可點（2026-11-17）：錨點解析、跨頁連結、藥丸清單、核准區說明、異常項目落點。 */

describe("錨點", () => {
  it("parseSheetFocusHash：認得四種，其他回 null", () => {
    expect(parseSheetFocusHash("#anomalies")).toBe("anomalies");
    expect(parseSheetFocusHash("#anomalies-error")).toBe("anomalies-error");
    expect(parseSheetFocusHash("anomalies-warn")).toBe("anomalies-warn");
    expect(parseSheetFocusHash("#approve")).toBe("approve");
    expect(parseSheetFocusHash("#foo")).toBeNull();
    expect(parseSheetFocusHash("")).toBeNull();
    expect(parseSheetFocusHash(null)).toBeNull();
  });
  it("severityFilterOf：需處理→error、提醒→warn、其他不篩", () => {
    expect(severityFilterOf("anomalies-error")).toBe("error");
    expect(severityFilterOf("anomalies-warn")).toBe("warn");
    expect(severityFilterOf("anomalies")).toBeNull();
    expect(severityFilterOf("approve")).toBeNull();
  });
  it("sheetFocusHref：帶 employee、period 與錨點", () => {
    expect(sheetFocusHref("emp-1", "2026-10", "anomalies-error")).toBe(
      "/admin/attendance-statements?employee=emp-1&period=2026-10#anomalies-error",
    );
    expect(sheetFocusHref("emp-1", "2026-10", "approve")).toMatch(/#approve$/);
  });
  it("sheetDayRowId", () => {
    expect(sheetDayRowId("2026-10-03")).toBe("sheet-day-2026-10-03");
  });
});

describe("藥丸", () => {
  it("anomalyPills：需處理／提醒各自一顆、0 不出、有 aria-label", () => {
    expect(anomalyPills({ error: 0, warn: 0 })).toEqual([]);
    const p = anomalyPills({ error: 2, warn: 3 });
    expect(p.map((x) => [x.label, x.focus])).toEqual([
      ["需處理 2", "anomalies-error"],
      ["提醒 3", "anomalies-warn"],
    ]);
    expect(p[0].ariaLabel).toContain("需處理");
  });
  it("statusPillFocus：還沒核准的狀態可點到操作區；已核准／鎖定不可點", () => {
    for (const s of ["draft", "submitted", "manager_reviewed", "returned"] as const) expect(statusPillFocus(s)).toBe("approve");
    expect(statusPillFocus("approved")).toBeNull();
    expect(statusPillFocus("locked")).toBeNull();
  });
});

describe("核准區說明", () => {
  it("已核准／鎖定 → 無；經理已審無異常 → 無", () => {
    expect(approveHint("approved", 3)).toBeNull();
    expect(approveHint("locked", 0)).toBeNull();
    expect(approveHint("manager_reviewed", 0)).toBeNull();
  });
  it("草稿有需處理異常 → 「需先處理 N 項異常才能核准」並可點到異常清單", () => {
    const h = approveHint("draft", 2);
    expect(h?.text).toContain("需先處理 2 項異常才能核准");
    expect(h?.focus).toBe("anomalies-error");
  });
  it("草稿無異常 → 說明要先送出、不可點", () => {
    expect(approveHint("draft", 0)).toEqual({ text: "月表尚未送出：送出並經主管審核後才能核准", focus: null });
    expect(approveHint("returned", 0)?.text).toContain("退回");
  });
  it("已送出 → 待主管審核；經理已審有異常 → 提醒先確認並可點", () => {
    expect(approveHint("submitted", 0)).toEqual({ text: "月表已送出、待主管審核；審核後才能核准", focus: null });
    expect(approveHint("submitted", 1)?.focus).toBe("anomalies-error");
    expect(approveHint("manager_reviewed", 4)).toEqual({ text: "仍有 4 項需處理異常，核准前請先確認", focus: "anomalies-error" });
  });
});

describe("異常項目落點與篩選", () => {
  it("monthAnomalyHref：待簽假單→簽核頁、未核銷→月底核銷、沒薪資結構→員工薪資分頁、其他無", () => {
    expect(monthAnomalyHref("pending_leave_in_period", "e1")).toBe("/admin/approvals");
    expect(monthAnomalyHref("unsettled_leave_in_period", "e1")).toBe("/admin/leave-settlement");
    expect(monthAnomalyHref("no_salary_structure", "e1")).toBe("/admin/employees/e1?tab=salary");
    expect(monthAnomalyHref("no_salary_structure", null)).toBeNull();
    expect(monthAnomalyHref("consecutive_late", "e1")).toBeNull();
  });
  it("filterBySeverity", () => {
    const items = [{ severity: "error" as const }, { severity: "warn" as const }, { severity: "info" as const }];
    expect(filterBySeverity(items, "error")).toHaveLength(1);
    expect(filterBySeverity(items, null)).toHaveLength(3);
  });
});
