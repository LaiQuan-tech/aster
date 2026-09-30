import { describe, expect, it } from "vitest"
import { buildLeaveRegister } from "../services/leave-register.js"
import { buildLeaveRegisterWorkbook } from "../lib/xlsx/leave-register.js"

describe("buildLeaveRegister", () => {
  it("creates all 12 months and rolls approved hours up by leave type", () => {
    const result = buildLeaveRegister({
      year: 2025,
      dailyRegularHours: 8,
      leaveTypes: [
        { id: "annual", code: "annual", name: "特休" },
        { id: "personal", code: "personal", name: "事假" },
        { id: "sick", code: "sick", name: "病假" },
      ],
      requests: [
        { leave_type_id: "annual", start_at: "2025-01-09T01:00:00.000Z", end_at: "2025-01-09T03:00:00.000Z", hours: 2, segments: null },
        { leave_type_id: "personal", start_at: "2025-02-12T01:00:00.000Z", end_at: "2025-02-12T09:00:00.000Z", hours: 8, segments: null },
        { leave_type_id: "sick", start_at: "2025-02-13T01:00:00.000Z", end_at: "2025-02-13T03:00:00.000Z", hours: 2, segments: null },
      ],
    })

    expect(result.months).toHaveLength(12)
    expect(result.months[0]).toMatchObject({ month: 1, hoursByType: { annual: 2 }, totalHours: 2, totalDays: 0.25 })
    expect(result.months[1]).toMatchObject({ month: 2, hoursByType: { personal: 8, sick: 2 }, totalHours: 10, totalDays: 1.25 })
    expect(result.totals).toMatchObject({ hoursByType: { annual: 2, personal: 8, sick: 2 }, totalHours: 12, totalDays: 1.5 })
  })

  it("uses dated segments to allocate a request across month boundaries", () => {
    const result = buildLeaveRegister({
      year: 2025,
      dailyRegularHours: 8,
      leaveTypes: [{ id: "annual", code: "annual", name: "特休" }],
      requests: [{
        leave_type_id: "annual",
        start_at: "2025-01-31T01:00:00.000Z",
        end_at: "2025-02-01T09:00:00.000Z",
        hours: 8,
        segments: [{ date: "2025-01-31", hours: 3 }, { date: "2025-02-01", hours: 5 }],
      }],
    })

    expect(result.months[0].hoursByType.annual).toBe(3)
    expect(result.months[1].hoursByType.annual).toBe(5)
    expect(result.totals.totalHours).toBe(8)
  })

  it("distributes legacy multi-day requests by calendar day when no segments exist", () => {
    const result = buildLeaveRegister({
      year: 2025,
      dailyRegularHours: 8,
      leaveTypes: [{ id: "sick", code: "sick", name: "病假" }],
      requests: [{
        leave_type_id: "sick",
        start_at: "2025-01-31T01:00:00.000Z",
        end_at: "2025-02-01T09:00:00.000Z",
        hours: 8,
        segments: null,
      }],
    })

    expect(result.months[0].hoursByType.sick).toBe(4)
    expect(result.months[1].hoursByType.sick).toBe(4)
    expect(result.totals.totalHours).toBe(8)
  })

  it("exports a ROC-year black-grid worksheet with monthly and annual totals", async () => {
    const result = buildLeaveRegister({
      year: 2025,
      dailyRegularHours: 8,
      leaveTypes: [{ id: "annual", code: "annual", name: "特休" }],
      requests: [{ leave_type_id: "annual", start_at: "2025-01-09T01:00:00.000Z", end_at: "2025-01-09T03:00:00.000Z", hours: 2, segments: null }],
    })
    const workbook = await buildLeaveRegisterWorkbook({
      employeeName: "王小明",
      hireDate: "2020-07-01",
      register: result,
    })
    const sheet = workbook.worksheets[0]

    expect(sheet.getCell("A1").value).toBe("114年度 王小明 請假表")
    expect(sheet.getCell("A3").value).toBe("月份")
    expect(sheet.getCell("B3").value).toBe("特休")
    expect(sheet.getCell("A4").value).toBe("1月")
    expect(sheet.getCell("B4").value).toBe(2)
    expect(sheet.getCell("D4").value).toBe(0.25)
    expect(sheet.getCell("B16").value).toBe(2)
    expect(sheet.getCell("D16").value).toBe(0.25)
    expect(sheet.getCell("A3").border.bottom).toMatchObject({ style: "thin", color: { argb: "FF000000" } })
  })
})
