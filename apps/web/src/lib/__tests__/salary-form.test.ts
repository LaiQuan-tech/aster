/** 2026-11-17 業主回報「儲存薪資資料」按了沒反應：用那組實際值回歸。假資料。 */
import { describe, expect, it } from "vitest";
import { buildSalaryPutBody, salaryFormFromStructure } from "../salary-form";
import { salaryFormChanges } from "../salary-history";
import { salaryFormError, wageFieldsChanged } from "../salary-completeness";

// 既有資料：月薪制、本薪 null、時薪 0、日薪 null、勞健保有值；PostgREST numeric 以「數字」回來。
const loadedNumeric = {
  method: "monthly",
  base_salary: null,
  daily_wage: null,
  hourly_wage: 0,
  labor_insured_salary: 30300,
  health_insured_salary: 30300,
  pension_voluntary_rate: 0,
  pension_wage: null,
  pension_new_system: true,
  agreed_hours_per_week: null,
  agreed_days_per_week: null,
};

describe("salary-form：月薪制補本薪 42,000、時薪 0、勞健保 42,000、自提 0、勞退月提繳工資空", () => {
  it("舊寫法：數字直接進比對 → 丟 TypeError（就是按了沒反應的原因），現在已防呆", () => {
    // 修正後 numOrNull／sameAmount 都吃數字，不再丟錯
    expect(() =>
      salaryFormChanges(
        { baseSalary: "", laborGrade: 30300 as unknown as string, healthGrade: 30300 as unknown as string, pensionWage: "" },
        { baseSalary: "42000", laborGrade: "42000", healthGrade: "42000", pensionWage: "" },
      ),
    ).not.toThrow();
    expect(() =>
      wageFieldsChanged(
        { method: "monthly", baseSalary: "", dailyWage: "", hourlyWage: 0 as unknown as string },
        { method: "monthly", baseSalary: "", dailyWage: "", hourlyWage: 0 as unknown as string },
      ),
    ).not.toThrow();
  });

  it("載入一律轉字串；改值後前端檢查通過、會問生效日（本薪＋投保都有變）、body 正確", () => {
    const loaded = salaryFormFromStructure(loadedNumeric);
    expect(loaded).toMatchObject({ method: "monthly", baseSalary: "", hourlyWage: "0", laborGrade: "30300", pensionPct: "0", pensionWage: "" });
    const form = { ...loaded, baseSalary: "42000", laborGrade: "42000", healthGrade: "42000" };
    expect(salaryFormError(form)).toBeNull();
    expect(
      salaryFormChanges(
        { baseSalary: loaded.baseSalary, laborGrade: loaded.laborGrade, healthGrade: loaded.healthGrade, pensionWage: loaded.pensionWage },
        { baseSalary: form.baseSalary, laborGrade: form.laborGrade, healthGrade: form.healthGrade, pensionWage: form.pensionWage },
      ),
    ).toEqual({ base: true, insured: true });
    const body = buildSalaryPutBody(
      form,
      {
        wage: { method: loaded.method, baseSalary: loaded.baseSalary, dailyWage: loaded.dailyWage, hourlyWage: loaded.hourlyWage },
        pension: { wage: loaded.pensionWage, newSystem: loaded.pensionNewSystem },
      },
      { effectiveDate: "2026-11-17", reason: null, note: null },
    );
    expect(body).toEqual({
      method: "monthly",
      baseSalary: 42000,
      dailyWage: null,
      hourlyWage: 0,
      agreedHoursPerWeek: null,
      agreedDaysPerWeek: null,
      laborInsuredSalary: 42000,
      healthInsuredSalary: 42000,
      pensionVoluntaryRate: 0,
      change: { effectiveDate: "2026-11-17", reason: null, note: null },
    });
  });

  it("月薪制時薪留空＝送 0（依本薪自動換算），不擋", () => {
    const form = { ...salaryFormFromStructure(loadedNumeric), baseSalary: "42000", hourlyWage: "" };
    expect(salaryFormError(form)).toBeNull();
    expect(buildSalaryPutBody(form, { wage: null, pension: { wage: "", newSystem: true } }).hourlyWage).toBe(0);
  });

  it("numeric 字串（\"30300.00\"）也正常", () => {
    const f = salaryFormFromStructure({ ...loadedNumeric, labor_insured_salary: "30300.00", hourly_wage: "0.00", pension_voluntary_rate: "0.0000" });
    expect(f.laborGrade).toBe("30300");
    expect(f.hourlyWage).toBe("0");
    expect(f.pensionPct).toBe("0");
  });
});
