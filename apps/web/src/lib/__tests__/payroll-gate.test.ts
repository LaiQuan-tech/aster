import { describe, expect, it } from "vitest";
import { payrollGateText } from "../payroll-gate";

function apiError(status: number, code: string, body: unknown): Error {
  return Object.assign(new Error(code), { status, code, body });
}

describe("payrollGateText（薪資執行前閘門 409）", () => {
  it("列出前 5 項，多的寫總數", () => {
    const anomalies = Array.from({ length: 6 }, (_, i) => ({ employeeId: `e${i}`, date: `2026-10-0${i + 1}`, code: "seven_day_rule", message: "連續出勤" }));
    const text = payrollGateText(apiError(409, "anomalies_unacknowledged", { anomalies }), (id) => `員工${id}`);
    expect(text).toContain("尚有 6 項出勤異常未填說明");
    expect(text).toContain("員工e0 2026-10-01：連續出勤");
    expect(text).not.toContain("員工e5");
    expect(text).toContain("…等 6 項");
  });

  it("不是這個錯誤 → null", () => {
    expect(payrollGateText(apiError(409, "period_closed", {}), String)).toBeNull();
    expect(payrollGateText(new Error("x"), String)).toBeNull();
    expect(payrollGateText("x", String)).toBeNull();
  });
});
