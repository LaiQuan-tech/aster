import { describe, it, expect } from "vitest";
import {
  buildInsuredBackfill,
  buildSalaryBackfill,
  diffText,
  fmtAmount,
  pairText,
  salaryFormChanges,
  todayDateKey,
} from "../salary-history";

/**
 * lib/salary-history.ts：員工薪資分頁「調薪歷程」「勞健保調整歷程」的純函式（2026-11-10）。全部是假值。
 */
const LOADED = { baseSalary: "33000", laborGrade: "33300", healthGrade: "33300", pensionWage: "" };

describe("salaryFormChanges：存檔前判斷要不要問生效日", () => {
  it("沒變 → 都 false（字串格式不同但數值相同也算沒變）", () => {
    expect(salaryFormChanges(LOADED, { ...LOADED, baseSalary: "33000.0" })).toEqual({ base: false, insured: false });
  });
  it("本薪變 → base；空白與 0 視為相同", () => {
    expect(salaryFormChanges(LOADED, { ...LOADED, baseSalary: "38000" })).toEqual({ base: true, insured: false });
    expect(salaryFormChanges({ ...LOADED, baseSalary: "" }, { ...LOADED, baseSalary: "0" }).base).toBe(false);
  });
  it("勞保／健保／勞退月提繳任一變 → insured；清空也算", () => {
    expect(salaryFormChanges(LOADED, { ...LOADED, laborGrade: "38200" }).insured).toBe(true);
    expect(salaryFormChanges(LOADED, { ...LOADED, healthGrade: "" }).insured).toBe(true);
    expect(salaryFormChanges(LOADED, { ...LOADED, pensionWage: "38200" }).insured).toBe(true);
  });
});

describe("顯示：原 → 新", () => {
  it("pairText", () => {
    expect(pairText({ prev: 33000, next: 38200 })).toBe("33,000 → 38,200");
    expect(pairText({ prev: 38200, next: 38200 })).toBe("38,200");
    expect(pairText({ prev: null, next: 40100 }, "自動")).toBe("自動 → 40,100");
    expect(pairText({ prev: null, next: null })).toBe("—");
  });
  it("diffText／fmtAmount", () => {
    expect(diffText(5000)).toBe("+5,000");
    expect(diffText(-1000)).toBe("-1,000");
    expect(diffText(null)).toBe("—");
    expect(fmtAmount(null)).toBe("—");
    expect(fmtAmount(38200)).toBe("38,200");
  });
  it("todayDateKey 格式", () => {
    expect(todayDateKey(new Date(2030, 3, 9))).toBe("2030-04-09");
  });
});

describe("補登表單驗證", () => {
  it("調薪：生效日、新本薪必填；原本薪選填", () => {
    expect(buildSalaryBackfill({ effectiveDate: "", prevSalary: "", newSalary: "1", reason: "" })).toEqual({ ok: false, error: "請填生效日" });
    expect(buildSalaryBackfill({ effectiveDate: "2025-03-26", prevSalary: "", newSalary: "", reason: "" }).ok).toBe(false);
    expect(buildSalaryBackfill({ effectiveDate: "2025-03-26", prevSalary: "", newSalary: "33000", reason: " 補登 " })).toEqual({
      ok: true,
      body: { effectiveDate: "2025-03-26", prevSalary: null, newSalary: 33000, reason: "補登" },
    });
  });
  it("投保：至少一項調整後金額、整數", () => {
    const blank = { effectiveOn: "2025-03-26", labor: "", health: "", pension: "", prevLabor: "", prevHealth: "", prevPension: "", note: "" };
    expect(buildInsuredBackfill(blank).ok).toBe(false);
    expect(buildInsuredBackfill({ ...blank, labor: "33000.5" }).ok).toBe(false);
    const ok = buildInsuredBackfill({ ...blank, labor: "33000", prevLabor: "30300", note: "投保薪資調整" });
    expect(ok).toEqual({
      ok: true,
      body: {
        effectiveOn: "2025-03-26",
        laborInsuredSalary: 33000,
        healthInsuredSalary: null,
        pensionWage: null,
        prevLaborInsuredSalary: 30300,
        prevHealthInsuredSalary: null,
        prevPensionWage: null,
        note: "投保薪資調整",
      },
    });
  });
});
