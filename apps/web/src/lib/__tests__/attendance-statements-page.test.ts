import { describe, expect, it } from "vitest";
import type { Employee } from "../admin-api";
import type { SheetListItem } from "../attendance-sheets-api";
import {
  buildRoster,
  buildStatementsSearch,
  filterRoster,
  readStatementsQuery,
  sheetActions,
  statusStats,
} from "../attendance-statements-page";

function emp(id: string, empNo: string, name: string, extra: Partial<Employee> = {}): Employee {
  return {
    id,
    tenant_id: "t",
    user_id: `u-${id}`,
    name,
    role: "employee",
    dept_id: "d1",
    emp_no: empNo,
    employment_type: null,
    hire_date: null,
    terminated_at: null,
    status: "active",
    created_at: "2026-01-01",
    email: null,
    ...extra,
  };
}

function sheet(employeeId: string, extra: Partial<SheetListItem> = {}): SheetListItem {
  return {
    id: `s-${employeeId}`,
    employeeId,
    employeeName: `N-${employeeId}`,
    employeeNo: null,
    department: "業務部",
    deptId: "d1",
    period: "2026-10",
    status: "draft",
    managerEmpId: null,
    anomalyCount: { error: 0, warn: 0, info: 0 },
    otTotalMinutes: 0,
    overtimeMonthlyAlert: "none",
    submittedAt: null,
    approvedAt: null,
    computedAt: null,
    ...extra,
  };
}

describe("網址 query", () => {
  it("讀：employee／period／status／dept（含舊參數 deptId）／anomaly／sheet；不合法的丟掉", () => {
    expect(readStatementsQuery("?employee=e1&period=2026-10&status=approved&dept=d2&anomaly=1")).toEqual({
      employee: "e1",
      period: "2026-10",
      status: "approved",
      dept: "d2",
      anomaly: true,
      sheet: null,
    });
    expect(readStatementsQuery("?period=2026-13&status=bogus&deptId=d9&sheet=abc")).toEqual({
      employee: null,
      period: null,
      status: "",
      dept: "d9",
      anomaly: false,
      sheet: "abc",
    });
    expect(readStatementsQuery("")).toMatchObject({ employee: null, period: null, status: "", dept: "", anomaly: false });
  });

  it("寫：只寫有值的；來回一致；不寫 sheet", () => {
    const q = { employee: "e1", period: "2026-10", status: "submitted" as const, dept: "d1", anomaly: true };
    const search = buildStatementsSearch(q);
    expect(search).toBe("?employee=e1&period=2026-10&status=submitted&dept=d1&anomaly=1");
    expect(readStatementsQuery(search)).toEqual({ ...q, sheet: null });
    expect(buildStatementsSearch({ employee: null, period: null, status: "", dept: "", anomaly: false })).toBe("");
  });
});

describe("員工清單", () => {
  const employees = [
    emp("e2", "A002", "李小華", { dept_id: "d2" }),
    emp("e1", "A001", "王小明"),
    emp("e3", "A003", "陳離職", { status: "terminated" }),
    emp("e4", "A004", "林已離有表", { status: "terminated" }),
  ];
  const sheets = [
    sheet("e1", { status: "manager_reviewed", anomalyCount: { error: 2, warn: 0, info: 0 } }),
    sheet("e2", { status: "approved", deptId: "d2", anomalyCount: { error: 0, warn: 1, info: 0 } }),
    sheet("e4", { status: "draft" }),
    sheet("x9", { employeeNo: "Z999", employeeName: "主檔外" }),
  ];

  it("在職全列、離職只列有月表的；主檔外的月表也列；在職在前、工號排序", () => {
    const rows = buildRoster(employees, sheets);
    expect(rows.map((r) => r.employeeId)).toEqual(["e1", "e2", "x9", "e4"]);
    expect(rows.find((r) => r.employeeId === "e1")?.sheet?.status).toBe("manager_reviewed");
    expect(rows.find((r) => r.employeeId === "e4")?.active).toBe(false);
  });

  it("篩選：狀態、部門、只看異常、關鍵字（工號／姓名，多字都要中）", () => {
    const rows = buildRoster(employees, sheets);
    const base = { status: "" as const, dept: "", anomaly: false, query: "" };
    expect(filterRoster(rows, { ...base, status: "approved" }).map((r) => r.employeeId)).toEqual(["e2"]);
    expect(filterRoster(rows, { ...base, dept: "d2" }).map((r) => r.employeeId)).toEqual(["e2"]);
    expect(filterRoster(rows, { ...base, anomaly: true }).map((r) => r.employeeId)).toEqual(["e1", "e2"]);
    expect(filterRoster(rows, { ...base, query: "a001" }).map((r) => r.employeeId)).toEqual(["e1"]);
    expect(filterRoster(rows, { ...base, query: "小 李" }).map((r) => r.employeeId)).toEqual(["e2"]);
  });
});

describe("狀態磚與動作", () => {
  it("計數只吃部門篩選；待核准＝經理已審；有 error 的張數", () => {
    const list = [
      sheet("a", { status: "manager_reviewed", anomalyCount: { error: 1, warn: 0, info: 0 } }),
      sheet("b", { status: "locked" }),
      sheet("c", { status: "locked", deptId: "d2" }),
    ];
    const all = statusStats(list, "");
    expect(all.total).toBe(3);
    expect(all.byStatus.locked).toBe(2);
    expect(all.byStatus.draft).toBe(0);
    expect(all.pendingApproval).toBe(1);
    expect(all.hasError).toBe(1);
    expect(statusStats(list, "d2")).toMatchObject({ total: 1, pendingApproval: 0, hasError: 0 });
  });

  it("依狀態可用的動作與原詳細頁相同", () => {
    expect(sheetActions("manager_reviewed")).toEqual({ approve: true, return: true, reopen: false, recompute: false });
    expect(sheetActions("submitted")).toEqual({ approve: false, return: true, reopen: false, recompute: false });
    expect(sheetActions("approved")).toEqual({ approve: false, return: true, reopen: true, recompute: false });
    expect(sheetActions("draft")).toEqual({ approve: false, return: false, reopen: false, recompute: true });
    expect(sheetActions("returned")).toEqual({ approve: false, return: false, reopen: false, recompute: true });
    expect(sheetActions("locked")).toEqual({ approve: false, return: false, reopen: false, recompute: false });
  });
});
