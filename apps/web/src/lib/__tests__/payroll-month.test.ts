import { describe, expect, it } from "vitest";
import {
  filterRoster,
  lockBlockersOf,
  payslipCell,
  rosterCounts,
  settlementCell,
  sheetCell,
  stepViews,
  type PeriodEmployeeRow,
} from "../payroll-month-api";

// ⚠️ 假資料（repo 公開）。
function row(id: string, over: Partial<PeriodEmployeeRow> = {}): PeriodEmployeeRow {
  return {
    employeeId: id,
    employeeName: `員工${id}`,
    empNo: `E${id}`,
    status: "active",
    employedInPeriod: true,
    sheet: { id: `s${id}`, status: "approved", ready: true },
    pendingRequests: { total: 0, byKind: {} },
    unsettledLeaves: 0,
    undecidedLateReports: 0,
    submittedExpenses: { count: 0, amount: 0 },
    openAdvances: 0,
    payslip: { id: `p${id}`, status: "finalized", required: true, stale: [], sentAt: null, net: 30000 },
    blockers: [],
    reminders: [],
    ready: true,
    ...over,
  };
}

const rows = [
  row("1"),
  row("2", { blockers: ["sheets", "payslips"], ready: false, sheet: { id: "s2", status: "submitted", ready: false }, payslip: { id: "p2", status: "draft", required: true, stale: ["fixed_allowances"], sentAt: null, net: 100 } }),
  row("3", { reminders: ["pending_requests"], pendingRequests: { total: 2, byKind: { leave: 2 } }, payslip: { id: "p3", status: "finalized", required: true, stale: [], sentAt: "2026-10-01T00:00:00Z", net: 1 } }),
  row("4", { payslip: { id: null, status: "none", required: false, stale: [], sentAt: null, net: null } }),
];

describe("月結發薪：篩選與計數", () => {
  it("全部／未就緒／已就緒／有提醒＋關鍵字（工號或姓名）", () => {
    expect(filterRoster(rows, "all", "").map((r) => r.employeeId)).toEqual(["1", "2", "3", "4"]);
    expect(filterRoster(rows, "blocked", "").map((r) => r.employeeId)).toEqual(["2"]);
    expect(filterRoster(rows, "ready", "").map((r) => r.employeeId)).toEqual(["1", "3", "4"]);
    expect(filterRoster(rows, "reminders", "").map((r) => r.employeeId)).toEqual(["3"]);
    expect(filterRoster(rows, "all", "e3").map((r) => r.employeeId)).toEqual(["3"]);
    expect(filterRoster(rows, "all", "員工4").map((r) => r.employeeId)).toEqual(["4"]);
    expect(rosterCounts(rows)).toEqual({ all: 4, blocked: 1, ready: 3, reminders: 1 });
  });
});

describe("月結發薪：步驟條", () => {
  it("①檢查待辦不算薪資單、②③只算應有薪資單的人、④只算已定案的、⑤看月份狀態", () => {
    const steps = stepViews(rows, "open");
    expect(steps.map((s) => [s.key, s.progress, s.done])).toEqual([
      ["check", "3/4", false],
      ["run", "3/3", true],
      ["finalize", "2/3", false],
      ["send", "1/2", false],
      ["lock", "未鎖定", false],
    ]);
    expect(stepViews(rows, "closed")[4]).toMatchObject({ progress: "已鎖定", done: true });
  });
});

describe("月結發薪：鎖定卡住清單與儲存格", () => {
  it("列出卡在誰、哪一項", () => {
    expect(lockBlockersOf(rows)).toEqual([{ employeeId: "2", label: "E2 · 員工2", items: ["出勤月表未核准", "薪資單未定案"] }]);
  });

  it("儲存格文字與顏色", () => {
    expect(sheetCell(rows[1])).toEqual({ text: "待主管", tone: "bad" });
    expect(sheetCell(row("x", { sheet: null }))).toEqual({ text: "—", tone: "none" });
    expect(payslipCell(rows[1])).toEqual({ text: "需重算 100", tone: "bad" });
    expect(payslipCell(rows[0]).tone).toBe("ok");
    expect(payslipCell(row("y", { payslip: { id: null, status: "none", required: true, stale: [], sentAt: null, net: null } }))).toEqual({ text: "未產生", tone: "bad" });
    expect(settlementCell(row("z", { unsettledLeaves: 1, submittedExpenses: { count: 2, amount: 9 } }))).toEqual({ text: "假單 1、報銷 2 未處理", tone: "bad" });
    expect(settlementCell(row("w", { openAdvances: 1 }))).toEqual({ text: "預支 1 未沖", tone: "ok" });
  });
});
