import { describe, it, expect } from "vitest";
import type { LateDecision } from "../late-reports-api";
import { approvalsBadgeCount, countPendingLateReports } from "../ess-badges";

const ME = "emp-boss";

function report(employeeId: string, decision: LateDecision = null) {
  return { employeeId, decision };
}

describe("countPendingLateReports（老闆的待決定遲到說明，2026-10-12）", () => {
  it("老闆（canDecide）：算還沒決定的、排除自己的", () => {
    const res = {
      canDecide: true,
      lateReports: [report("emp-a"), report("emp-b"), report(ME), report("emp-c")],
    };
    expect(countPendingLateReports(res, ME)).toBe(3);
  });

  it("已決定（affects／exempt）的不算；decision 缺席（舊資料）當作沒決定", () => {
    const res = {
      canDecide: true,
      lateReports: [
        report("emp-a", "affects"),
        report("emp-b", "exempt"),
        report("emp-c", null),
        { employeeId: "emp-d" } as unknown as { employeeId: string; decision: LateDecision },
      ],
    };
    expect(countPendingLateReports(res, ME)).toBe(2);
  });

  it("不是老闆（canDecide=false：主管／HR 看得到但不能決定）→ 0", () => {
    const res = { canDecide: false, lateReports: [report("emp-a"), report("emp-b")] };
    expect(countPendingLateReports(res, ME)).toBe(0);
  });

  it("空清單、res 缺席、清單不是陣列 → 0", () => {
    expect(countPendingLateReports({ canDecide: true, lateReports: [] }, ME)).toBe(0);
    expect(countPendingLateReports(null, ME)).toBe(0);
    expect(countPendingLateReports(undefined, ME)).toBe(0);
    expect(
      countPendingLateReports({ canDecide: true, lateReports: null } as unknown as { canDecide: boolean; lateReports: [] }, ME),
    ).toBe(0);
  });

  it("只有自己的遲到說明 → 0；me 還沒回來（null）就不排除任何人", () => {
    expect(countPendingLateReports({ canDecide: true, lateReports: [report(ME), report(ME)] }, ME)).toBe(0);
    expect(countPendingLateReports({ canDecide: true, lateReports: [report(ME), report("emp-a")] }, null)).toBe(2);
  });

  it("已經不能決定的（lockedReason：月份已結算／月表已核准或鎖定）不算，紅點不會卡住", () => {
    const res = {
      canDecide: true,
      lateReports: [
        { employeeId: "emp-a", decision: null, lockedReason: "sheet_frozen" as const },
        { employeeId: "emp-b", decision: null, lockedReason: "period_closed" as const },
        { employeeId: "emp-c", decision: null, lockedReason: null },
      ],
    };
    expect(countPendingLateReports(res, ME)).toBe(1);
    // 全部都鎖住 → 0
    expect(
      countPendingLateReports(
        { canDecide: true, lateReports: [{ employeeId: "emp-a", decision: null, lockedReason: "period_closed" as const }] },
        ME,
      ),
    ).toBe(0);
  });

  it("lockedReason 缺席（舊版 API）＝當作還能決定，照算", () => {
    expect(countPendingLateReports({ canDecide: true, lateReports: [report("emp-a"), report("emp-b")] }, ME)).toBe(2);
  });
});

describe("approvalsBadgeCount（員工端簽核紅點）", () => {
  it("待簽申請單＋待決定遲到說明", () => {
    expect(approvalsBadgeCount({ pendingApprovals: 2, pendingLateReports: 3 })).toBe(5);
  });

  it("非老闆（遲到說明 0）＝原本的待簽筆數，行為不變", () => {
    expect(approvalsBadgeCount({ pendingApprovals: 4, pendingLateReports: 0 })).toBe(4);
    expect(approvalsBadgeCount({ pendingApprovals: 0, pendingLateReports: 0 })).toBe(0);
  });

  it("只有遲到說明也會亮紅點", () => {
    expect(approvalsBadgeCount({ pendingApprovals: 0, pendingLateReports: 1 })).toBe(1);
  });

  it("負數／NaN 當 0", () => {
    expect(approvalsBadgeCount({ pendingApprovals: -1, pendingLateReports: Number.NaN })).toBe(0);
  });
});
