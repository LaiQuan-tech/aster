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

    // 第 1 張：給人看／列印，請假時數是「N 天 N 時」文字（2026-10-11）。
    const sheet = workbook.worksheets[0]
    expect(sheet.name).toBe("114年請假表")
    expect(sheet.getCell("A1").value).toBe("114年度 王小明 請假表")
    expect(sheet.getCell("A2").value).toBe("到職日：109.7.1　1日 = 8小時")
    expect(sheet.getCell("A3").value).toBe("月份")
    expect(sheet.getCell("B3").value).toBe("特休")
    expect(sheet.getCell("C3").value).toBe("合計")
    expect(sheet.getCell("D3").value).toBeNull() // 沒有 合計(hr)／合計(日) 欄了——它們在第 2 張
    expect(sheet.getCell("A4").value).toBe("1月")
    expect(sheet.getCell("B4").value).toBe("2 時")
    expect(sheet.getCell("C4").value).toBe("2 時")
    expect(sheet.getCell("B5").value).toBe("0 天")
    expect(sheet.getCell("A16").value).toBe("總計")
    expect(sheet.getCell("B16").value).toBe("2 時")
    expect(sheet.getCell("C16").value).toBe("2 時")
    expect(sheet.getCell("A3").border.bottom).toMatchObject({ style: "thin", color: { argb: "FF000000" } })

    // 第 2 張：給人算，維持原本的數字版（小時、合計(hr)、合計(日)），一格不動——要加總的人用這張。
    const numbers = workbook.worksheets[1]
    expect(workbook.worksheets).toHaveLength(2)
    expect(numbers.name).toBe("114年請假表(時數)")
    expect(numbers.getCell("A1").value).toContain("114年度 王小明 請假表")
    expect(numbers.getCell("B3").value).toBe("特休")
    expect(numbers.getCell("C3").value).toBe("合計(hr)")
    expect(numbers.getCell("D3").value).toBe("合計(日)")
    expect(numbers.getCell("A4").value).toBe("1月")
    expect(numbers.getCell("B4").value).toBe(2)
    expect(numbers.getCell("C4").value).toBe(2)
    expect(numbers.getCell("D4").value).toBe(0.25)
    expect(numbers.getCell("B16").value).toBe(2)
    expect(numbers.getCell("D16").value).toBe(0.25)
    expect(numbers.getCell("B4").numFmt).toBe("0.##")
  })

  it("兩張工作表由同一份資料產生：多假別、跨天、每日工時不是 8 時，文字版逐格等於數字版換算", async () => {
    const result = buildLeaveRegister({
      year: 2025,
      dailyRegularHours: 7.5,
      leaveTypes: [
        { id: "annual", code: "annual", name: "特休" },
        { id: "personal", code: "personal", name: "事假" },
      ],
      requests: [
        { leave_type_id: "annual", start_at: "2025-03-03T01:00:00.000Z", end_at: "2025-03-05T09:00:00.000Z", hours: 22.5, segments: [{ date: "2025-03-03", hours: 7.5 }, { date: "2025-03-04", hours: 7.5 }, { date: "2025-03-05", hours: 7.5 }] },
        { leave_type_id: "personal", start_at: "2025-03-10T01:00:00.000Z", end_at: "2025-03-10T04:00:00.000Z", hours: 3, segments: null },
        { leave_type_id: "personal", start_at: "2025-12-31T01:00:00.000Z", end_at: "2025-12-31T09:00:00.000Z", hours: 8, segments: null },
      ],
    })
    const workbook = await buildLeaveRegisterWorkbook({ employeeName: "陳大文", hireDate: null, register: result })
    const text = workbook.worksheets[0]
    const numbers = workbook.worksheets[1]

    expect(text.getCell("A2").value).toBe("到職日：未填　1日 = 7.5小時")
    expect([text.getCell("B3").value, text.getCell("C3").value, text.getCell("D3").value]).toEqual(["特休", "事假", "合計"])
    // 3 月：特休 22.5 時 ＝ 3 天（每日 7.5 時）；事假 3 時；合計 25.5 時 ＝ 3 天 3 時
    expect(text.getCell("A6").value).toBe("3月")
    expect(text.getCell("B6").value).toBe("3 天")
    expect(text.getCell("C6").value).toBe("3 時")
    expect(text.getCell("D6").value).toBe("3 天 3 時")
    // 12 月：事假 8 時 ＝ 1 天 30 分
    expect(text.getCell("C15").value).toBe("1 天 30 分")
    // 總計：特休 3 天；事假 11 時 ＝ 1 天 3 時 30 分；合計 33.5 時 ＝ 4 天 3 時 30 分
    expect(text.getCell("B16").value).toBe("3 天")
    expect(text.getCell("C16").value).toBe("1 天 3 時 30 分")
    expect(text.getCell("D16").value).toBe("4 天 3 時 30 分")
    // 沒有請假的月份是「0 天」，不是空白
    expect(text.getCell("B4").value).toBe("0 天")

    // 數字版同一格仍是小時，且總計列 ＝ 各月加總（可加總性沒破壞）
    expect(numbers.getCell("B6").value).toBe(22.5)
    expect(numbers.getCell("C6").value).toBe(3)
    expect(numbers.getCell("D6").value).toBe(25.5)
    expect(numbers.getCell("C16").value).toBe(11)
    expect(numbers.getCell("D16").value).toBe(33.5)
    expect(numbers.getCell("E16").value).toBe(4.47) // 33.5 ÷ 7.5
  })
})
