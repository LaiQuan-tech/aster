import ExcelJS from "exceljs"
import { describe, expect, it } from "vitest"
import {
  leaveSettlementWorkbookBuffer,
  type LeaveSettlementItem,
  type LeaveSettlementListResult,
} from "../services/leave-settlement.js"

/**
 * 假單核銷 xlsx（2026-10-11 請假時數顯示成天＋時）：「時數」欄維持數字（HR 會加總／篩選），
 * 緊接著多一欄「時數(天時)」文字。純函式測試，不連 DB。
 */

function item(id: string, hours: number, extra: Partial<LeaveSettlementItem> = {}): LeaveSettlementItem {
  return {
    id,
    employee: { id: `emp-${id}`, name: `員工${id}`, employeeNo: `E${id}`, departmentName: "營運部" },
    leaveType: { id: "lt-annual", name: "特休", deductRate: 0 },
    startDate: "2026-09-29",
    endDate: "2026-10-02",
    hours,
    requiresAttachment: false,
    attachmentCount: 0,
    settledAt: null,
    settledBy: null,
    settledPeriod: null,
    crossMonth: true,
    ...extra,
  }
}

function resultOf(items: LeaveSettlementItem[]): LeaveSettlementListResult {
  return {
    period: "2026-09",
    summary: { totalCount: items.length, settledCount: 0, unsettledCount: items.length, hoursByLeaveType: [] },
    items,
  }
}

async function load(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(new Uint8Array(buffer) as unknown as ExcelJS.Buffer)
  return wb.getWorksheet("假單核銷")!
}

describe("leaveSettlementWorkbookBuffer — 時數欄維持數字，旁邊多一欄天＋時文字", () => {
  it("表頭：時數(第 7 欄)之後緊接「時數(天時)」，其餘欄位順延一欄", async () => {
    const ws = await load(await leaveSettlementWorkbookBuffer(resultOf([item("1", 24)])))
    const header = Array.from({ length: 15 }, (_, i) => ws.getRow(1).getCell(i + 1).value)
    expect(header).toEqual([
      "員工姓名", "工號", "部門", "假別", "起日", "迄日", "時數", "時數(天時)",
      "需附件", "附件數", "核銷狀態", "核銷時間", "核銷人", "跨月", "核銷月份",
    ])
  })

  it("時數仍是數字、可加總；天時是文字；列數＝items 筆數（沒有合計列）", async () => {
    const items = [item("1", 24), item("2", 108), item("3", 2.5), item("4", 0), item("5", 8.5)]
    const ws = await load(await leaveSettlementWorkbookBuffer(resultOf(items)))
    expect(ws.rowCount - 1).toBe(items.length)

    const hours = [2, 3, 4, 5, 6].map((r) => ws.getRow(r).getCell(7).value)
    expect(hours).toEqual([24, 108, 2.5, 0, 8.5])
    expect(hours.every((v) => typeof v === "number")).toBe(true)
    expect(hours.reduce<number>((sum, v) => sum + (v as number), 0)).toBe(143)

    const texts = [2, 3, 4, 5, 6].map((r) => ws.getRow(r).getCell(8).value)
    expect(texts).toEqual(["3 天", "13 天 4 時", "2 時 30 分", "0 天", "1 天 30 分"])
  })

  it("後面的欄位跟著順延一欄、內容不變", async () => {
    const ws = await load(
      await leaveSettlementWorkbookBuffer(
        resultOf([
          item("1", 8, {
            requiresAttachment: true,
            attachmentCount: 2,
            settledAt: "2026-09-30T08:00:00.000Z",
            settledBy: { id: "hr", name: "人資" },
            settledPeriod: "2026-09",
            crossMonth: false,
          }),
        ]),
      ),
    )
    const row = ws.getRow(2)
    expect([9, 10, 11, 13, 14, 15].map((c) => row.getCell(c).value)).toEqual(["是", 2, "已核銷", "人資", "否", "2026-09"])
  })

  it("每日工時不是 8 時（規則 payroll.dailyRegularHours）照傳入值換算；沒傳＝8", async () => {
    const result = resultOf([item("1", 15)])
    const seven = await load(await leaveSettlementWorkbookBuffer(result, { hoursPerDay: 7.5 }))
    expect(seven.getRow(2).getCell(8).value).toBe("2 天")
    const dflt = await load(await leaveSettlementWorkbookBuffer(result))
    expect(dflt.getRow(2).getCell(8).value).toBe("1 天 7 時")
  })
})
