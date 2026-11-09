import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：記憶體版 supabase（不連 DB）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { loadMonthFacts, rebuildSheet, type SheetRow } from "../services/attendance-sheets.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/** 2026-11-09 rebuildSheet 狀態條件：讀到月表後才被送出／核准的，不覆寫（回 false、不動逐日列）。假資料。 */
const EMP = "cccccccc-0000-4000-8000-0000000000f1"
const SHEET = "dddddddd-0000-4000-8000-0000000000f1"

function sheetRow(status: string): SheetRow {
  return {
    id: SHEET, tenant_id: TENANT_ID, employee_id: EMP, period: "2026-06", status, manager_emp_id: null, submitted_at: null,
    submitted_by: null, manager_reviewed_at: null, manager_reviewed_by: null, approved_at: null, approved_by: null, locked_at: null,
    returned_at: null, returned_by: null, return_reason: null, reopen_reason: null, rule_config_version: 1, computed_at: null,
    month_anomalies: [], snapshot: null, version: 1,
  } as unknown as SheetRow
}

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試", branding: {}, timezone: "Asia/Taipei", features: {} }]
  fake.db.employees = [{ id: EMP, tenant_id: TENANT_ID, user_id: null, name: "測試員工", role: "employee", status: "active", hire_date: "2021-01-01", emp_no: "T9" }]
  fake.db.attendance_sheet_days = []
})

describe("rebuildSheet 狀態條件", () => {
  it("DB 裡已是 submitted（呼叫端拿到的是舊的 draft）→ 回 false、computed_at 不變、不寫逐日列", async () => {
    fake.db.attendance_sheets = [{ ...sheetRow("submitted") }]
    const facts = await loadMonthFacts(TENANT_ID, "2026-06", [EMP])
    expect(await rebuildSheet(TENANT_ID, sheetRow("draft"), facts)).toBe(false)
    expect(fake.db.attendance_sheets[0].computed_at).toBeNull()
    expect(fake.db.attendance_sheet_days).toHaveLength(0)
  })

  it.each(["draft", "returned"])("DB 裡是 %s → 重算（true）、寫 computed_at 與逐日列", async (status) => {
    fake.db.attendance_sheets = [{ ...sheetRow(status) }]
    const facts = await loadMonthFacts(TENANT_ID, "2026-06", [EMP])
    expect(await rebuildSheet(TENANT_ID, sheetRow(status), facts)).toBe(true)
    expect(fake.db.attendance_sheets[0].computed_at).not.toBeNull()
    expect(fake.db.attendance_sheet_days.length).toBeGreaterThan(0)
  })
})

describe("generateSheets：兩位 HR 同時開、建月表撞唯一索引", () => {
  it("insert 回 23505 → 改讀現有月表、不丟錯", async () => {
    const { generateSheets } = await import("../services/attendance-sheets.js")
    fake.db.attendance_sheets = []
    fake.injectError({ table: "attendance_sheets", action: "insert", error: { code: "23505", message: "duplicate key" } })
    const reads = fake.reads.length
    const result = await generateSheets({ tenantId: TENANT_ID, period: "2026-06", employeeId: EMP })
    expect(result.generated).toBe(0)
    expect(fake.reads.slice(reads).filter((t) => t === "attendance_sheets").length).toBeGreaterThanOrEqual(2)
  })
})
