import { describe, expect, it } from "vitest";
import { countText, fixedAllowanceSummaryText, historyTitle, nhiHeadline, taxDependentsHeadline } from "../payroll-panel-text";

/** lib/payroll-panel-text.ts：員工薪資頁下半部精簡列的顯示字（2026-11-17）。假值。 */

describe("payroll-panel-text", () => {
  it("固定津貼摘要：無／N 項／N 項＋本月合計", () => {
    expect(fixedAllowanceSummaryText(0, 0)).toBe("無");
    expect(fixedAllowanceSummaryText(2, 0)).toBe("2 項");
    expect(fixedAllowanceSummaryText(2, 3000)).toBe("2 項・本月合計 3,000 元");
  });
  it("歷程紀錄標題與筆數", () => {
    expect(historyTitle(0, 0)).toBe("歷程紀錄（無紀錄）");
    expect(historyTitle(2, 1)).toBe("歷程紀錄（調薪 2・投保 1）");
    expect(countText(0)).toBe("無紀錄");
    expect(countText(3)).toBe("3 筆");
  });
  it("健保眷屬一行：依明細／直接輸入／超過 3 人標計費", () => {
    expect(nhiHeadline(null, 2)).toBe("健保眷屬：明細 2 筆");
    expect(nhiHeadline({ effective: 2, billable: 2, override: null }, 2)).toBe("健保眷屬：2 人（依明細）");
    expect(nhiHeadline({ effective: 5, billable: 3, override: 5 }, 0)).toBe("健保眷屬：5 人（計費 3 人・直接輸入）");
  });
  it("扶養親屬一行", () => {
    expect(taxDependentsHeadline(0)).toBe("扶養親屬：0 人");
  });
});
