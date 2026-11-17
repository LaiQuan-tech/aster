import { describe, expect, it } from "vitest";
import * as web from "../salary-completeness";
import * as api from "../../../../api/src/services/salary-completeness";

/**
 * 薪資設定完整度（2026-11-17）：web 表單檢查與 API 存檔驗證同一份規則；出勤統計表缺金額文案；
 * 執行薪資略過說明；名單提示句。⚠️ 姓名、金額都是假值。
 */

const CASES: web.SalaryCompletenessInput[] = [
  { method: "monthly", baseSalary: null },
  { method: "monthly", baseSalary: "" },
  { method: "monthly", baseSalary: "0", hourlyWage: "200" },
  { method: "monthly", baseSalary: "33000" },
  { method: null, baseSalary: 1 },
  { method: "hourly", hourlyWage: "" },
  { method: "hourly", hourlyWage: "0" },
  { method: "hourly", hourlyWage: "190.5" },
  { method: "by_attendance_days", dailyWage: "" },
  { method: "by_attendance_days", dailyWage: "1500" },
  { method: "by_attendance_days", dailyWage: "1500", hourlyWage: "187.5" },
  { method: "by_attendance_days", dailyWage: "1500", baseSalary: "30000" },
];

describe("web 與 API 規則一致", () => {
  it.each(CASES)("%o", (c) => {
    expect(web.salaryStructureIssue(c)).toBe(api.salaryStructureIssue(c));
    expect(web.hasWageBasis(c)).toBe(api.hasWageBasis(c));
  });
  it("訊息與標籤一致", () => {
    expect(web.SALARY_STRUCTURE_ISSUE_MESSAGES).toEqual(api.SALARY_STRUCTURE_ISSUE_MESSAGES);
    expect(web.SALARY_STRUCTURE_ISSUE_LABELS).toEqual(api.SALARY_STRUCTURE_ISSUE_LABELS);
  });
});

describe("salaryFormError（表單輸入字串）", () => {
  it("月薪制本薪空 → 中文錯誤；時薪制時薪空 → 中文錯誤；完整 → null", () => {
    expect(web.salaryFormError({ method: "monthly", baseSalary: "", dailyWage: "", hourlyWage: "" })).toBe("月薪制的本薪必須大於 0");
    expect(web.salaryFormError({ method: "hourly", baseSalary: "", dailyWage: "", hourlyWage: "" })).toBe("時薪制的時薪必須大於 0");
    expect(web.salaryFormError({ method: "by_attendance_days", baseSalary: "", dailyWage: "", hourlyWage: "" })).toBe("按出勤天數制的日薪必須大於 0");
    expect(web.salaryFormError({ method: "monthly", baseSalary: "33000", dailyWage: "", hourlyWage: "" })).toBeNull();
  });
});

describe("出勤統計表缺金額文案", () => {
  it("缺本薪／時薪 → 由專屬提示＋連結顯示（這裡回 null）；其他原因各自文案；原因不明 → 原本合併文案", () => {
    expect(web.missingMoneyNote("salary_base_missing")).toBeNull();
    expect(web.missingMoneyNote("salary_structure_missing")).toContain("尚未設定薪資結構");
    expect(web.missingMoneyNote("preview_failed")).toContain("試算失敗");
    expect(web.missingMoneyNote(null)).toBe("沒有薪資資料（未設定薪資結構或尚未產生薪資單），金額顯示「—」");
    expect(web.missingMoneyNote(undefined)).toBe("沒有薪資資料（未設定薪資結構或尚未產生薪資單），金額顯示「—」");
    expect(web.SALARY_BASE_MISSING_NOTE).toContain("員工管理 → 該員工 → 薪資設定");
  });
  it("連結到員工內頁「薪資」分頁", () => {
    expect(web.salarySettingsHref("emp-1")).toBe("/admin/employees/emp-1?tab=salary");
  });
});

describe("名單提示與執行薪資略過說明", () => {
  it("payroll：列人數與將被跳過人數", () => {
    const s = web.incompleteSalarySummary([{ skippedByPayroll: true }, { skippedByPayroll: false }], "payroll");
    expect(s).toContain("以下 2 位員工薪資設定缺本薪／時薪");
    expect(s).toContain("其中 1 位執行薪資時將被跳過");
    expect(web.incompleteSalarySummary([{ skippedByPayroll: true }], "employees")).toContain("1 位員工薪資設定不完整");
  });
  it("payrollSkipText：分原因列名；舊 API 沒 skippedDetails 退回原文案", () => {
    const name = (id: string) => ({ a: "員工甲", b: "員工乙", c: "員工丙" })[id] ?? id;
    expect(web.payrollSkipText({ skipped: ["a"] }, name)).toBe("，略過已定案 1 筆");
    const t = web.payrollSkipText(
      {
        skipped: ["a", "b", "c"],
        skippedDetails: [
          { employeeId: "a", reason: "finalized" },
          { employeeId: "b", reason: "hourly_wage_missing" },
          { employeeId: "c", reason: "sheet_not_approved" },
        ],
      },
      name,
    );
    expect(t).toContain("略過已定案 1 筆");
    expect(t).toContain("缺本薪／時薪、未產生薪資單 1 位");
    expect(t).toContain("員工乙");
    expect(t).toContain("月表未核准、未產生薪資單 1 位：員工丙");
  });
});
