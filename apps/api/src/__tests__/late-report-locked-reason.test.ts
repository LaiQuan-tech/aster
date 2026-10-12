import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import {
  lateReportLockedReason,
  listLateReports,
  sheetLockKey,
  type LateReportRow,
} from "../services/late-reports.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 遲到說明列表的 lockedReason（2026-10-12）：月份已結算或該員月表已核准／鎖定的，API 拒絕決定
 * （decideLateReport：409 period_closed／sheet_frozen），列表每列標出來，員工端簽核頁不給按鈕、
 * 老闆的簽核紅點也不算——不然這些永遠未決定的會讓紅點卡住。⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const EMP_A = "e2000000-0000-4000-8000-000000000001"
const EMP_B = "e2000000-0000-4000-8000-000000000002"

describe("lateReportLockedReason（純函式，判斷順序同 decideLateReport）", () => {
  const row = { employee_id: EMP_A, work_date: "2026-10-12" }
  const none = new Map<string, string>()

  it("都沒鎖 → null（可以決定）", () => {
    expect(lateReportLockedReason(row, new Set(), none)).toBeNull()
  })

  it("那個月已結算 → period_closed；同時月表也核准了仍回 period_closed（結算優先）", () => {
    expect(lateReportLockedReason(row, new Set(["2026-10"]), none)).toBe("period_closed")
    const approved = new Map([[sheetLockKey(EMP_A, "2026-10"), "approved"]])
    expect(lateReportLockedReason(row, new Set(["2026-10"]), approved)).toBe("period_closed")
  })

  it("該員該月月表 approved／locked → sheet_frozen", () => {
    expect(lateReportLockedReason(row, new Set(), new Map([[sheetLockKey(EMP_A, "2026-10"), "approved"]]))).toBe("sheet_frozen")
    expect(lateReportLockedReason(row, new Set(), new Map([[sheetLockKey(EMP_A, "2026-10"), "locked"]]))).toBe("sheet_frozen")
  })

  it("月表還是草稿／已送出 → null；別人的月表、別的月份、別的月份結算都不影響", () => {
    expect(lateReportLockedReason(row, new Set(), new Map([[sheetLockKey(EMP_A, "2026-10"), "draft"]]))).toBeNull()
    expect(lateReportLockedReason(row, new Set(), new Map([[sheetLockKey(EMP_A, "2026-10"), "submitted"]]))).toBeNull()
    expect(lateReportLockedReason(row, new Set(), new Map([[sheetLockKey(EMP_B, "2026-10"), "approved"]]))).toBeNull()
    expect(lateReportLockedReason(row, new Set(), new Map([[sheetLockKey(EMP_A, "2026-09"), "locked"]]))).toBeNull()
    expect(lateReportLockedReason(row, new Set(["2026-09"]), none)).toBeNull()
  })

  it("月份取 work_date 的前 7 碼（月底那天歸當月）", () => {
    expect(lateReportLockedReason({ employee_id: EMP_A, work_date: "2026-09-30" }, new Set(["2026-09"]), none)).toBe(
      "period_closed",
    )
    expect(sheetLockKey(EMP_A, "2026-09")).toBe(`${EMP_A}|2026-09`)
  })
})

function report(id: string, employeeId: string, workDate: string, decision: string | null = null): LateReportRow {
  return {
    id,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    work_date: workDate,
    punch_record_id: null,
    punch_at: `${workDate}T02:30:00.000Z`,
    late_minutes: 30,
    reason: "測試用理由",
    attendance_decision: decision,
    decided_by_emp_id: null,
    decided_at: null,
    decision_note: null,
    created_at: `${workDate}T02:30:00.000Z`,
    updated_at: `${workDate}T02:30:00.000Z`,
  }
}

describe("listLateReports 每列帶 lockedReason（批次查、查失敗不壞列表）", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.employees = [
      { id: EMP_A, tenant_id: TENANT_ID, name: "員工甲" },
      { id: EMP_B, tenant_id: TENANT_ID, name: "員工乙" },
    ]
    fake.db.late_reports = [
      report("a1", EMP_A, "2026-10-12"), // 10 月：甲的月表已核准 → sheet_frozen
      report("a2", EMP_B, "2026-10-13"), // 10 月：乙的月表還是草稿 → null
      report("a3", EMP_A, "2026-09-30"), // 9 月已結算 → period_closed
      report("a4", EMP_B, "2026-08-05", "affects"), // 8 月沒鎖、已決定 → null（可改判）
    ]
    fake.db.period_closes = [
      { tenant_id: TENANT_ID, period: "2026-09", status: "closed" },
      { tenant_id: TENANT_ID, period: "2026-08", status: "reopened" },
    ]
    fake.db.attendance_sheets = [
      { tenant_id: TENANT_ID, employee_id: EMP_A, period: "2026-10", status: "approved" },
      { tenant_id: TENANT_ID, employee_id: EMP_B, period: "2026-10", status: "draft" },
      // 已結算月份的月表：period_closed 優先，不用再看
      { tenant_id: TENANT_ID, employee_id: EMP_A, period: "2026-09", status: "locked" },
    ]
  })

  const reasons = (list: Array<{ id: string; lockedReason?: string | null }>) =>
    Object.fromEntries(list.map((r) => [r.id, r.lockedReason]))

  it("period_closed／sheet_frozen／null 照月份與月表狀態標出；其他欄位不變", async () => {
    const list = await listLateReports(TENANT_ID, {})
    expect(reasons(list)).toEqual({ a1: "sheet_frozen", a2: null, a3: "period_closed", a4: null })
    expect(list.find((r) => r.id === "a1")).toMatchObject({ employeeName: "員工甲", decision: null, lateMinutes: 30 })
    expect(list.find((r) => r.id === "a4")).toMatchObject({ employeeName: "員工乙", decision: "affects" })
  })

  it("批次查：period_closes 與 attendance_sheets 各只查一次（不逐列查）", async () => {
    await listLateReports(TENANT_ID, {})
    expect(fake.reads.filter((t) => t === "period_closes")).toHaveLength(1)
    expect(fake.reads.filter((t) => t === "attendance_sheets")).toHaveLength(1)
  })

  it("篩選未決定也一樣帶（老闆的紅點只算 lockedReason 為 null 的）", async () => {
    const list = await listLateReports(TENANT_ID, { decision: "undecided" })
    expect(reasons(list)).toEqual({ a1: "sheet_frozen", a2: null, a3: "period_closed" })
  })

  it("全部月份都已結算 → 不必再查月表", async () => {
    fake.db.late_reports = [report("a3", EMP_A, "2026-09-30")]
    const list = await listLateReports(TENANT_ID, {})
    expect(reasons(list)).toEqual({ a3: "period_closed" })
    expect(fake.reads).not.toContain("attendance_sheets")
  })

  it("沒有任何列 → 不查鎖定狀態", async () => {
    fake.db.late_reports = []
    expect(await listLateReports(TENANT_ID, {})).toEqual([])
    expect(fake.reads).not.toContain("period_closes")
    expect(fake.reads).not.toContain("attendance_sheets")
  })

  it("period_closes 查失敗 → 當作沒結算（不丟錯），月表照查", async () => {
    fake.injectError({ table: "period_closes", action: "select", error: { message: "boom", code: "XX000" } })
    const list = await listLateReports(TENANT_ID, {})
    expect(reasons(list)).toEqual({ a1: "sheet_frozen", a2: null, a3: "sheet_frozen", a4: null })
  })

  it("attendance_sheets 查失敗 → 月表那部分當作沒鎖（不丟錯），結算照算", async () => {
    fake.injectError({ table: "attendance_sheets", action: "select", error: { message: "boom", code: "XX000" } })
    const list = await listLateReports(TENANT_ID, {})
    expect(reasons(list)).toEqual({ a1: null, a2: null, a3: "period_closed", a4: null })
  })

  it("表不存在（舊庫沒套遷移：PGRST205）→ 兩邊都當作沒鎖，列表照常回", async () => {
    fake.injectError({ table: "period_closes", action: "select", error: { message: "missing", code: "PGRST205" } })
    fake.injectError({ table: "attendance_sheets", action: "select", error: { message: "missing", code: "42P01" } })
    const list = await listLateReports(TENANT_ID, {})
    expect(reasons(list)).toEqual({ a1: null, a2: null, a3: null, a4: null })
  })
})
