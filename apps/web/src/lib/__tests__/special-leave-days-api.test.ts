import { describe, expect, it } from "vitest";
import { rangeText, recalcSummary, scopeText } from "../special-leave-days-api";
import { specialDayHint } from "../../app/ess/requests/_components/use-my-special-days";

describe("特殊假日 client 純函式（2026-11-17）", () => {
  it("recalcSummary：已送出／已核准未套用、未定案薪資單、已結算、失敗都要提示", () => {
    expect(recalcSummary([{ period: "2026-10", status: "done", rebuilt: 3, submitted: 0, approved: 0, draftPayslips: 0 }])).toEqual({
      text: "已儲存。2026/10 已重算草稿月表 3 張",
      warn: false,
    });
    const r = recalcSummary([{ period: "2026-10", status: "done", rebuilt: 1, submitted: 2, approved: 1, draftPayslips: 4 }]);
    expect(r.warn).toBe(true);
    expect(r.text).toContain("已送出 2 張、已核准 1 張月表未套用，需退回後重算");
    expect(r.text).toContain("該月已有未定案薪資單（4 張），請重跑薪資");
    expect(recalcSummary([{ period: "2026-09", status: "closed" }]).text).toContain("已結算，不追溯");
    expect(recalcSummary([{ period: "2026-09", status: "failed", error: "x" }]).text).toContain("請到出勤統計表按「重算」");
  });
  it("scopeText／rangeText", () => {
    expect(scopeText({ scope: "all", departmentNames: [], employeeNames: [] })).toBe("全公司");
    expect(scopeText({ scope: "employees", departmentNames: [], employeeNames: ["甲", "乙", "丙", "丁"] })).toBe("甲、乙、丙 等 4 人");
    expect(rangeText("2026-10-13", "2026-10-13")).toBe("10/13（二）");
    expect(rangeText("2026-10-13", "2026-10-14")).toBe("10/13–10/14");
  });
  it("specialDayHint：請假日期碰到特殊假日 → 提示（不擋），沒碰到 → null", () => {
    expect(specialDayHint(["2026-10-13"], { "2026-10-13": "颱風假（無薪）" })).toBe("10/13 為颱風假（無薪），請確認是否仍需請假");
    expect(specialDayHint(["2026-10-15"], { "2026-10-13": "颱風假（無薪）" })).toBeNull();
  });
});
