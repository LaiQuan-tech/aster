import { describe, expect, it } from "vitest";
import {
  countTerminated,
  employedInPeriod,
  employeeStatusNote,
  filterByEmploymentStatus,
  isEmployeeActive,
  monthRange,
  parseStatusFilter,
  pickableEmployees,
  searchEmployees,
  terminatedLabel,
  todayTaipei,
} from "../employee-status";
import { employeeOptionsOf } from "../employee-combobox";

const TODAY = "2026-11-17";
const emp = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  emp_no: null as string | null,
  email: null as string | null,
  status: "active",
  terminated_at: null as string | null,
  hire_date: null as string | null,
  ...over,
});

const active = emp("A", { emp_no: "E001", name: "王小明", email: "ming@example.com" });
const leftLastMonth = emp("L", { status: "inactive", terminated_at: "2026-10-31", hire_date: "2025-01-01", name: "李離職" });
const futureLeave = emp("F", { terminated_at: "2026-11-30" });
const lastDayToday = emp("T", { terminated_at: TODAY });
const pastDateStillActive = emp("P", { terminated_at: "2026-11-01" });
const disabledNoDate = emp("D", { status: "inactive" });
const legacyNoStatus = { id: "X", name: "舊", status: undefined, terminated_at: null };

describe("isEmployeeActive", () => {
  it("在職／預告離職／離職當天都算在職", () => {
    expect(isEmployeeActive(active, TODAY)).toBe(true);
    expect(isEmployeeActive(futureLeave, TODAY)).toBe(true);
    expect(isEmployeeActive(lastDayToday, TODAY)).toBe(true);
    expect(isEmployeeActive(legacyNoStatus, TODAY)).toBe(true);
  });
  it("停用、或離職日已過（即使 status 還是 active）都算離職", () => {
    expect(isEmployeeActive(leftLastMonth, TODAY)).toBe(false);
    expect(isEmployeeActive(pastDateStillActive, TODAY)).toBe(false);
    expect(isEmployeeActive(disabledNoDate, TODAY)).toBe(false);
    expect(isEmployeeActive(emp("Z", { status: "terminated" }), TODAY)).toBe(false);
  });
  it("離職日帶時間也只看日期", () => {
    expect(isEmployeeActive(emp("Q", { terminated_at: `${TODAY}T00:00:00Z` }), TODAY)).toBe(true);
  });
});

describe("terminatedLabel / employeeStatusNote", () => {
  it("離職者顯示日期，停用無日期顯示（停用），在職回 null", () => {
    expect(terminatedLabel(leftLastMonth, TODAY)).toBe("已離職（2026-10-31）");
    expect(terminatedLabel(disabledNoDate, TODAY)).toBe("已離職（停用）");
    expect(terminatedLabel(active, TODAY)).toBeNull();
    expect(employeeStatusNote(leftLastMonth, TODAY)).toBe("已離職");
    expect(employeeStatusNote(disabledNoDate, TODAY)).toBe("已停用");
    expect(employeeStatusNote(active, TODAY)).toBeUndefined();
  });
});

describe("pickableEmployees", () => {
  const all = [active, leftLastMonth, futureLeave, disabledNoDate];
  it("預設只留在職者、維持順序", () => {
    expect(pickableEmployees(all, [], TODAY).map((e) => e.id)).toEqual(["A", "F"]);
  });
  it("已選中的離職者保留（既有資料不會變空白）；空值忽略", () => {
    expect(pickableEmployees(all, ["L", "", null, undefined], TODAY).map((e) => e.id)).toEqual(["A", "L", "F"]);
  });
});

describe("employedInPeriod", () => {
  const all = [active, leftLastMonth, disabledNoDate, emp("OLD", { status: "inactive", terminated_at: "2025-03-31" })];
  it("列在職者＋期間內仍在職的離職者＋沒有離職日的停用帳號", () => {
    expect(employedInPeriod(all, "2026-10-01", "2026-10-31", [], TODAY).map((e) => e.id)).toEqual(["A", "L", "D"]);
  });
  it("期間在離職日之後 → 不列（無離職日的停用帳號仍列）", () => {
    expect(employedInPeriod(all, "2026-11-01", "2026-11-30", [], TODAY).map((e) => e.id)).toEqual(["A", "D"]);
  });
  it("期間在到職日之前 → 不列", () => {
    expect(employedInPeriod([leftLastMonth], "2024-01-01", "2024-12-31", [], TODAY)).toEqual([]);
  });
  it("沒有起日＝全列；keepIds 保留目前已選的人", () => {
    expect(employedInPeriod(all, "", "", [], TODAY)).toHaveLength(4);
    expect(employedInPeriod(all, "2026-11-01", "2026-11-30", ["OLD"], TODAY).map((e) => e.id)).toEqual(["A", "D", "OLD"]);
  });
});

describe("monthRange", () => {
  it("回傳月初月底（含閏年）", () => {
    expect(monthRange("2026-11")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(monthRange("2028-02")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(monthRange("bad")).toEqual([null, null]);
  });
});

describe("員工管理列表：狀態篩選＋搜尋", () => {
  const rows = [active, leftLastMonth, futureLeave, disabledNoDate];
  it("parseStatusFilter：不認得＝在職", () => {
    expect(parseStatusFilter(null)).toBe("active");
    expect(parseStatusFilter("xx")).toBe("active");
    expect(parseStatusFilter("terminated")).toBe("terminated");
    expect(parseStatusFilter("all")).toBe("all");
  });
  it("filterByEmploymentStatus 三種", () => {
    expect(filterByEmploymentStatus(rows, "active", TODAY).map((e) => e.id)).toEqual(["A", "F"]);
    expect(filterByEmploymentStatus(rows, "terminated", TODAY).map((e) => e.id)).toEqual(["L", "D"]);
    expect(filterByEmploymentStatus(rows, "all", TODAY)).toHaveLength(4);
  });
  it("countTerminated", () => {
    expect(countTerminated(rows, TODAY)).toBe(2);
  });
  it("searchEmployees：姓名／工號／Email，不分大小寫、多字皆須命中", () => {
    expect(searchEmployees(rows, "e001").map((e) => e.id)).toEqual(["A"]);
    expect(searchEmployees(rows, "MING@").map((e) => e.id)).toEqual(["A"]);
    expect(searchEmployees(rows, "李").map((e) => e.id)).toEqual(["L"]);
    expect(searchEmployees(rows, "王 e002")).toEqual([]);
    expect(searchEmployees(rows, "  ")).toHaveLength(4);
  });
  it("選「已離職」後搜尋可搜到離職者", () => {
    expect(searchEmployees(filterByEmploymentStatus(rows, "terminated", TODAY), "李").map((e) => e.id)).toEqual(["L"]);
    expect(searchEmployees(filterByEmploymentStatus(rows, "active", TODAY), "李")).toEqual([]);
  });
});

describe("employeeOptionsOf 自動標「已離職」", () => {
  it("有在職欄位的離職者帶 note；沒有在職欄位的不加", () => {
    const opts = employeeOptionsOf([active, leftLastMonth]);
    expect(opts[0]).not.toHaveProperty("note");
    expect(opts[1]?.note).toBe("已離職");
    expect(employeeOptionsOf([{ id: "N", name: "無狀態" }])[0]).not.toHaveProperty("note");
  });
});

describe("todayTaipei", () => {
  it("用台北時區", () => {
    expect(todayTaipei(new Date("2026-11-16T17:00:00Z"))).toBe("2026-11-17");
  });
});
