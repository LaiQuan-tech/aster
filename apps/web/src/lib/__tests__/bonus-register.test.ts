import { describe, expect, it } from "vitest";
import { buildBonusRegisterRows } from "../bonus-register";

const base = {
  projectId: "p1", projectCode: "AT-115-010", projectName: "測試案", shareMode: "pool_pct",
  bonusPool: 50_000, bonusRatePct: 5, contractTotal: 1_000_000, previousReceived: 400_000,
  previousReceivedPct: 0.4, currentReceived: 200_000, currentReceivedPct: 0.2, receivedTotal: 600_000,
  receivedPct: 0.6, unallocatedPct: 10, projectNote: "備註", entitledCumulative: 0, paidBefore: 0,
  overpaid: false, overpaidBy: 0, id: null, runId: null, empNo: null, shareAmount: null,
};

describe("bonus register rows", () => {
  it("groups employee items into one project row and fixed role slots", () => {
    const rows = buildBonusRegisterRows([
      { ...base, employeeId: "m", employeeName: "經理甲", roleInProject: "manager", sharePct: 30, amount: 3_000 },
      { ...base, employeeId: "l", employeeName: "主辦乙", roleInProject: "lead", sharePct: 60, amount: 6_000 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].currentBonus).toBe(9_000);
    expect(rows[0].manager?.employeeName).toBe("經理甲");
    expect(rows[0].team[0]?.employeeName).toBe("主辦乙");
    expect(rows[0].team).toHaveLength(4);
    expect(rows[0].support).toBeNull();
  });

  it("keeps members beyond the six reference slots visible as overflow", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      ...base, employeeId: `e${index}`, employeeName: `組員${index + 1}`, roleInProject: "member", sharePct: 10, amount: 100,
    }));
    const [row] = buildBonusRegisterRows(items);
    expect(row.team.filter(Boolean)).toHaveLength(4);
    expect(row.overflowMembers.map((item) => item.employeeName)).toEqual(["組員5", "組員6"]);
  });
});
