import { describe, expect, it } from "vitest"
import { buildBonusRunWorkbook } from "../lib/xlsx/bonus-runs.js"

const RUN = {
  id: "run-1",
  label: "115 7-9",
  asOf: "2026-09-30",
  status: "draft",
  kind: "regular",
  reversesRunId: null,
  reversedByRunId: null,
  reversedByStatus: null,
  paidOn: null,
  totals: { total: 9_000, itemCount: 2, employeeCount: 2, projectCount: 1, overpaidCount: 0, skipped: [] },
  note: "第三季",
  createdByEmpId: null,
  paidByEmpId: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
} as never

const ITEMS = [
  {
    id: "item-1",
    runId: "run-1",
    projectId: "project-1",
    projectCode: "AT-115-010",
    projectName: "凌霄好室電力變更",
    employeeId: "employee-1",
    employeeName: "子葶",
    empNo: "A001",
    roleInProject: "manager",
    shareMode: "pool_pct",
    sharePct: 30,
    shareAmount: null,
    bonusRatePct: 5,
    bonusPool: 50_000,
    contractTotal: 1_000_000,
    previousReceived: 400_000,
    previousReceivedPct: 0.4,
    currentReceived: 200_000,
    currentReceivedPct: 0.2,
    receivedTotal: 600_000,
    receivedPct: 0.6,
    entitledCumulative: 9_000,
    paidBefore: 6_000,
    amount: 3_000,
    unallocatedPct: 0.1,
    projectNote: "機電設計服務費",
    overpaid: false,
    overpaidBy: 0,
  },
  {
    id: "item-2",
    runId: "run-1",
    projectId: "project-1",
    projectCode: "AT-115-010",
    projectName: "凌霄好室電力變更",
    employeeId: "employee-2",
    employeeName: "amber",
    empNo: "A002",
    roleInProject: "lead",
    shareMode: "pool_pct",
    sharePct: 60,
    shareAmount: null,
    bonusRatePct: 5,
    bonusPool: 50_000,
    contractTotal: 1_000_000,
    previousReceived: 400_000,
    previousReceivedPct: 0.4,
    currentReceived: 200_000,
    currentReceivedPct: 0.2,
    receivedTotal: 600_000,
    receivedPct: 0.6,
    entitledCumulative: 18_000,
    paidBefore: 12_000,
    amount: 6_000,
    unallocatedPct: 0.1,
    projectNote: "機電設計服務費",
    overpaid: false,
    overpaidBy: 0,
  },
] as never

describe("bonus run xlsx", () => {
  it("matches the 115 7-9 two-row, 27-column project payout register", async () => {
    const wb = await buildBonusRunWorkbook(RUN, ITEMS)
    const ws = wb.getWorksheet("115 7-9")!

    expect(ws.columnCount).toBe(27)
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 2 })
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 16, 18, 20, 22, 24, 26, 27].map((c) => ws.getRow(1).getCell(c).value)).toEqual([
      "序號", "115 7-9", "專案單號", "工程名稱", "含稅", "之前請領", "之前請領%",
      "本次請款", "本次款%", "累積 %", "獎金比例", "經理", "組員1", "組員2", "組員3",
      "組員4", "支援", "尚未分配", "備註",
    ])
    expect(ws.getRow(2).getCell(11).value).toBe("%")
    expect(ws.getRow(2).getCell(12).value).toBe("總獎金")
    expect(ws.getRow(2).getCell(13).value).toBe("本次獎金")

    // One project, not one row per employee. Role shares occupy the same paired columns as the source workbook.
    expect(ws.rowCount).toBe(4)
    const row = ws.getRow(3)
    expect(row.getCell(3).value).toBe("AT-115-010")
    expect(row.getCell(5).value).toBe(1_000_000)
    expect(row.getCell(6).value).toBe(400_000)
    expect(row.getCell(8).value).toBe(200_000)
    expect(row.getCell(10).value).toBe(0.6)
    expect(row.getCell(11).value).toBe(0.05)
    expect(row.getCell(12).value).toBe(50_000)
    expect(row.getCell(13).value).toBe(9_000)
    expect([row.getCell(14).value, row.getCell(16).value]).toEqual(["子葶", "amber"])
    expect([row.getCell(15).value, row.getCell(17).value]).toEqual([0.3, 0.6])
    expect(row.getCell(26).value).toBeCloseTo(0.1)
    expect(row.getCell(27).value).toBe("機電設計服務費")
    expect(ws.getRow(4).getCell(13).value).toBe(9_000)
  })
})
