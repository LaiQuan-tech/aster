import { describe, it, expect } from "vitest";
import {
  EMPLOYEE_ROLES,
  canGrantGroupFinancialsOf,
  canGrantGroupFinancialsView,
  employeeDetailHref,
  employeeFormFrom,
  employeePatch,
  employeeRoleLabel,
  employeeStatusLabel,
  hasUnsavedChanges,
  validateEmployeeForm,
  type EditableEmployee,
} from "../employee-edit";
import { describeEmployeeError } from "../employee-errors";
import { personalFormFrom } from "../employee-personal";

/**
 * lib/employee-edit.ts：員工內頁（/admin/employees/[id]）編輯表單的純函式。
 * 重點是「只送有變更的欄位」——沒動的角色、班別／功能開關（0068）、所屬公司（0072）、可看集團財務都不能多送。
 */

const base: EditableEmployee & { birthday?: string | null; idNumber?: string | null } = {
  name: "測試員工",
  role: "employee",
  dept_id: "d1",
  emp_no: "A001",
  employment_type: "regular",
  hire_date: "2024-01-02",
  terminated_at: null,
  status: "active",
  default_shift_id: null,
  company_id: "c1",
  features: { wfhPunch: true },
  birthday: "1990-05-06",
  idNumber: "A123456789",
};

describe("employeeFormFrom", () => {
  it("null／缺鍵轉成空字串、開關轉 boolean（舊 API 沒有 seeGroupFinancials 當 false）", () => {
    expect(employeeFormFrom(base)).toEqual({
      name: "測試員工",
      empNo: "A001",
      deptId: "d1",
      employmentType: "regular",
      companyId: "c1",
      role: "employee",
      status: "active",
      hireDate: "2024-01-02",
      terminatedAt: "",
      defaultShiftId: "",
      wfhPunch: true,
      noNightPremium: false,
      seeGroupFinancials: false,
    });
  });

  it("沒有 features／employment_type 時：開關全 false、身分類別預設 regular", () => {
    const form = employeeFormFrom({ ...base, features: null, employment_type: null });
    expect(form.wfhPunch).toBe(false);
    expect(form.noNightPremium).toBe(false);
    expect(form.employmentType).toBe("regular");
  });
});

describe("employeePatch：只送有變更的欄位", () => {
  it("沒改任何東西 → {}", () => {
    expect(employeePatch(base, employeeFormFrom(base))).toEqual({});
  });

  it("只改姓名 → 只送 name（去頭尾空白），角色不送", () => {
    const form = { ...employeeFormFrom(base), name: "  新名字 " };
    expect(employeePatch(base, form)).toEqual({ name: "新名字" });
  });

  it("姓名只多了空白不算變更；清成空白也不送（沿用原行內表單）", () => {
    expect(employeePatch(base, { ...employeeFormFrom(base), name: " 測試員工  " })).toEqual({});
    expect(employeePatch(base, { ...employeeFormFrom(base), name: "   " })).toEqual({});
  });

  it("清空工號／單位／所屬公司／到職日 → 送 null", () => {
    const form = { ...employeeFormFrom(base), empNo: " ", deptId: "", companyId: "", hireDate: "" };
    expect(employeePatch(base, form)).toEqual({ empNo: null, deptId: null, companyId: null, hireDate: null });
  });

  it("角色、狀態、身分類別、離職日、預設班別各自有變才送", () => {
    const form = {
      ...employeeFormFrom(base),
      role: "manager",
      status: "inactive",
      employmentType: "parttime",
      terminatedAt: "2026-10-31",
      defaultShiftId: "s1",
    };
    expect(employeePatch(base, form)).toEqual({
      role: "manager",
      status: "inactive",
      employmentType: "parttime",
      terminatedAt: "2026-10-31",
      defaultShiftId: "s1",
    });
  });

  it("預設班別改回「依公司規則」→ defaultShiftId: null", () => {
    const withShift = { ...base, default_shift_id: "s1" };
    expect(employeePatch(withShift, { ...employeeFormFrom(withShift), defaultShiftId: "" })).toEqual({ defaultShiftId: null });
  });

  it("功能開關只帶有變的鍵（合併寫入）；可看集團財務沒動就絕不送", () => {
    const form = { ...employeeFormFrom(base), noNightPremium: true };
    expect(employeePatch(base, form)).toEqual({ features: { noNightPremium: true } });
    expect(employeePatch(base, form).features).not.toHaveProperty("seeGroupFinancials");
    expect(employeePatch(base, form).features).not.toHaveProperty("wfhPunch");
  });

  it("勾／取消可看集團財務 → features.seeGroupFinancials", () => {
    expect(employeePatch(base, { ...employeeFormFrom(base), seeGroupFinancials: true })).toEqual({
      features: { seeGroupFinancials: true },
    });
    const granted = { ...base, role: "hr_admin", features: { seeGroupFinancials: true } };
    expect(employeePatch(granted, { ...employeeFormFrom(granted), seeGroupFinancials: false })).toEqual({
      features: { seeGroupFinancials: false },
    });
  });
});

describe("hasUnsavedChanges", () => {
  it("員工欄位與個資欄位都沒動 → false", () => {
    expect(hasUnsavedChanges(base, employeeFormFrom(base), personalFormFrom(base))).toBe(false);
  });

  it("只改個資（身分證）→ true", () => {
    expect(hasUnsavedChanges(base, employeeFormFrom(base), { ...personalFormFrom(base), idNumber: "B987654321" })).toBe(true);
  });

  it("只改員工欄位 → true；把姓名清空也算動過", () => {
    expect(hasUnsavedChanges(base, { ...employeeFormFrom(base), wfhPunch: false }, personalFormFrom(base))).toBe(true);
    expect(hasUnsavedChanges(base, { ...employeeFormFrom(base), name: "" }, personalFormFrom(base))).toBe(true);
  });
});

describe("validateEmployeeForm", () => {
  it("姓名必填", () => {
    expect(validateEmployeeForm({ ...employeeFormFrom(base), name: "  " })).toBe("姓名不可空白");
  });
  it("離職日不能早於到職日；同一天可以", () => {
    expect(validateEmployeeForm({ ...employeeFormFrom(base), terminatedAt: "2023-12-31" })).toBe("離職日不能早於到職日");
    expect(validateEmployeeForm({ ...employeeFormFrom(base), terminatedAt: "2024-01-02" })).toBeNull();
  });
  it("正常表單 → null", () => {
    expect(validateEmployeeForm(employeeFormFrom(base))).toBeNull();
  });
});

describe("canGrantGroupFinancialsView：只有平台管理員（老闆）", () => {
  const policy = { bossEmpId: "boss-1", designated: [] };
  it("平台管理員 → true", () => {
    expect(canGrantGroupFinancialsView({ id: "x", role: "platform_admin" }, policy)).toBe(true);
  });
  it("老闆（id 不分大小寫）→ true，不論角色", () => {
    expect(canGrantGroupFinancialsView({ id: "BOSS-1", role: "employee" }, policy)).toBe(true);
  });
  it("一般 HR、會計 → false；沒有老闆設定的 HR → false；登入者未載入 → false", () => {
    expect(canGrantGroupFinancialsView({ id: "hr-1", role: "hr_admin" }, policy)).toBe(false);
    expect(canGrantGroupFinancialsView({ id: "acc", role: "accountant" }, policy)).toBe(false);
    expect(canGrantGroupFinancialsView({ id: "hr-1", role: "hr_admin" }, { bossEmpId: null, designated: [] })).toBe(false);
    expect(canGrantGroupFinancialsView(null, policy)).toBe(false);
  });
});

describe("canGrantGroupFinancialsOf：/me.canGrantGroupFinancials 優先", () => {
  const policy = { bossEmpId: "boss-1", designated: [] };
  it("/me 給 false → false（即使前端推算是老闆）；給 true → true（即使前端推算不是）", () => {
    expect(canGrantGroupFinancialsOf(false, { id: "boss-1", role: "hr_admin" }, policy)).toBe(false);
    expect(canGrantGroupFinancialsOf(true, { id: "hr-1", role: "hr_admin" }, policy)).toBe(true);
  });
  it("舊 API 沒欄位 → 退回前端推算", () => {
    expect(canGrantGroupFinancialsOf(undefined, { id: "boss-1", role: "hr_admin" }, policy)).toBe(true);
    expect(canGrantGroupFinancialsOf(undefined, { id: "hr-1", role: "hr_admin" }, policy)).toBe(false);
  });
});

describe("顯示用", () => {
  it("角色標籤（含平台管理員）與狀態標籤", () => {
    expect(EMPLOYEE_ROLES.map((r) => r.value)).toEqual(["employee", "manager", "accountant", "hr_admin"]);
    expect(employeeRoleLabel("platform_admin")).toBe("平台管理員（老闆）");
    expect(employeeRoleLabel("hr_admin")).toBe("HR");
    expect(employeeRoleLabel("unknown")).toBe("unknown");
    expect(employeeStatusLabel("active")).toBe("在職");
    expect(employeeStatusLabel("inactive")).toBe("停用");
  });
  it("內頁網址會 encode id", () => {
    expect(employeeDetailHref("abc")).toBe("/admin/employees/abc");
    expect(employeeDetailHref("a/b")).toBe("/admin/employees/a%2Fb");
  });
});

describe("describeEmployeeError", () => {
  it("員工內頁會遇到的錯誤碼 → 中文", () => {
    expect(describeEmployeeError(new Error("[409] schema_not_ready"), "x")).toContain("資料庫尚未套用");
    expect(describeEmployeeError(new Error("[400] shift_not_found"), "x")).toContain("班別不存在");
    expect(describeEmployeeError(new Error("[403] group_financials_grant_forbidden"), "x")).toContain("可看集團財務");
    expect(describeEmployeeError(new Error("[403] not_boss"), "x")).toContain("只有平台管理員（老闆）");
  });
  it("查不到 → 原字串；空 → fallback", () => {
    expect(describeEmployeeError(new Error("[500] boom happened"), "更新失敗")).toBe("[500] boom happened");
    expect(describeEmployeeError(null, "更新失敗")).toBe("更新失敗");
  });
});
