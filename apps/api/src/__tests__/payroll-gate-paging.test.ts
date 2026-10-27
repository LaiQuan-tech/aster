import { describe, expect, it, vi } from "vitest"
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
import { unacknowledgedErrorsForPeriod } from "../services/attendance-sheets.js"
import { loadLateReportsForPeriod } from "../services/late-reports.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/** 薪資閘門（未說明的 error 級異常）與全勤豁免（遲到說明）超過 PostgREST max-rows 也要一列不漏（2026-10-27）。 */
const N = 45
const empId = (i: number) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`
const days = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`)

function seed() {
  fake.reset()
  const sheets: Row[] = []
  const sheetDays: Row[] = []
  const reports: Row[] = []
  let n = 0
  for (let i = 0; i < N; i++) {
    const sid = `s-${String(i).padStart(6, "0")}`
    sheets.push({ id: sid, tenant_id: TENANT_ID, employee_id: empId(i), period: "2026-10" })
    for (const d of days) {
      sheetDays.push({ id: `d-${String(++n).padStart(6, "0")}`, tenant_id: TENANT_ID, sheet_id: sid, work_date: d, anomaly_ack: null, anomalies: d === "2026-10-31" ? [{ code: "x", severity: "error", message: "月底異常" }] : [] })
      reports.push({ id: `l-${String(++n).padStart(6, "0")}`, tenant_id: TENANT_ID, employee_id: empId(i), work_date: d, late_minutes: 5, attendance_decision: "exempt" })
    }
  }
  fake.db.attendance_sheets = sheets
  fake.db.attendance_sheet_days = sheetDays
  fake.db.late_reports = reports
}

describe("薪資閘門／遲到說明分頁", () => {
  for (const maxRows of [1000, 500]) {
    it(`max-rows=${maxRows}：月底異常與每筆遲到說明都讀得到`, async () => {
      seed()
      fake.limits.maxRows = maxRows
      const errs = await unacknowledgedErrorsForPeriod(TENANT_ID, "2026-10", Array.from({ length: N }, (_, i) => empId(i)))
      const late = await loadLateReportsForPeriod(TENANT_ID, "2026-10")
      fake.limits.maxRows = null
      expect(errs).toHaveLength(N)
      expect(Array.from(late.values()).reduce((s, l) => s + l.length, 0)).toBe(N * 31)
    })
  }
})
