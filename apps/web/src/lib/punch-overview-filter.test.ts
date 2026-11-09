import { describe, expect, it, vi } from "vitest";

vi.mock("./api-client", () => ({ apiFetch: vi.fn() }));

import {
  countByFilter,
  filterEmployeesByDay,
  parseDayFilter,
  type OverviewDay,
  type OverviewEmployee,
  type OverviewStatus,
} from "./punch-overview";

const DAY = "2026-11-09";

function emp(id: string, o: Partial<OverviewDay> & { status: OverviewStatus }, hasIn = false): OverviewEmployee {
  const day: OverviewDay = {
    date: DAY,
    dayType: "workday",
    shift: { label: "09:00-18:00", source: "x", start: "09:00", end: "18:00", crossesMidnight: false },
    in: hasIn ? { id: "p", at: "2026-11-09T01:00:00Z", source: "web", lat: null, lng: null, geoStatus: null, ip: null, wfh: false } : null,
    out: null,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    leaveMinutes: 0,
    statusLabel: "",
    statusTone: "muted",
    tags: [],
    provisional: false,
    ...o,
  };
  return { id, empNo: null, name: id, deptId: null, deptName: null, days: [day] };
}

const employees = [
  emp("a", { status: "done" }, true),
  emp("b", { status: "working", lateMinutes: 10 }, true),
  emp("c", { status: "done", lateMinutes: 5 }, true),
  emp("d", { status: "absent" }),
  emp("e", { status: "leave" }),
  emp("f", { status: "business_trip" }),
  emp("g", { status: "wfh" }),
  emp("h", { status: "off", dayType: "rest_day" }),
];

describe("當日總覽統計卡篩選", () => {
  const counts = countByFilter(employees, DAY);

  it("各分類計數等於篩選後列數", () => {
    for (const k of ["arrived", "late", "absent", "onLeave"] as const) {
      expect(filterEmployeesByDay(employees, DAY, k)).toHaveLength(counts[k]);
    }
    expect(counts).toEqual({ expected: 5, arrived: 4, late: 2, absent: 1, onLeave: 2 });
  });

  it("all 回傳全部員工；數字為 0 時回傳空陣列", () => {
    expect(filterEmployeesByDay(employees, DAY, "all")).toHaveLength(employees.length);
    expect(filterEmployeesByDay([emp("z", { status: "done" }, true)], DAY, "late")).toEqual([]);
  });

  it("沒有該日資料的員工只出現在全部", () => {
    const x: OverviewEmployee = { ...employees[0], id: "x", days: [] };
    expect(filterEmployeesByDay([x], DAY, "all")).toHaveLength(1);
    expect(filterEmployeesByDay([x], DAY, "arrived")).toHaveLength(0);
  });

  it("兼職不排班：沒來（工作日 off「未排班」）不算應到；有來照算應到／已到", () => {
    const pt = { label: "兼職（不排班）", source: "parttime", start: null, end: null, crossesMidnight: false };
    const idle = emp("pt-idle", { status: "off", statusLabel: "未排班", shift: pt });
    const came = emp("pt-came", { status: "working", shift: pt }, true);
    expect(countByFilter([idle, came], DAY)).toMatchObject({ expected: 1, arrived: 1, absent: 0, late: 0 });
  });

  it("parseDayFilter 未知值回全部", () => {
    expect(parseDayFilter("late")).toBe("late");
    expect(parseDayFilter("zzz")).toBe("all");
    expect(parseDayFilter(null)).toBe("all");
  });
});
