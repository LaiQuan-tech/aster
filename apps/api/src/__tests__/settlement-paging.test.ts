import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
import { fetchAllPages, MAX_PAGES, selectAllPages } from "../lib/select-all-pages.js"
import { computeAttendanceRows, settleAttendance } from "../services/settlement.js"
import { loadShiftResolver } from "../services/employee-shifts.js"
import { zonedTimeToUtc } from "../lib/tz.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 出勤結算分頁：PostgREST 每次最多回 max-rows 列、多的靜默截斷。
 *   • 超過 1000 列（max-rows=1000）與伺服器 max-rows=500（小於 PAGE_SIZE）兩種情境都要一列不漏。
 *   • 對照組：maxRows=null（不截斷）的結果必須與兩種情境完全一致。
 */

const TPE = "Asia/Taipei"
const at = (d: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(d, h, m, TPE).toISOString()
}
const OFFICE = "cccccccc-0000-4000-8000-000000000003"
const LT_ANNUAL = "l0000000-0000-4000-8000-0000000000a1"
const N_EMP = 45 // 45 人 × 30 天 ＝ 1350 筆排班、2700 張卡
const empId = (i: number) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`
const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`)

function seed() {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, timezone: TPE, features: {} }]
  fake.db.shifts = [{ id: OFFICE, tenant_id: TENANT_ID, name: "辦公", start_time: "09:00", end_time: "18:00", break_minutes: 60, break_start: "12:00" }]
  fake.db.leave_types = [{ id: LT_ANNUAL, tenant_id: TENANT_ID, code: "annual", name: "特休", paid: true, deduct_rate: null }]
  const employees: Row[] = []
  const schedules: Row[] = []
  const punches: Row[] = []
  const leaves: Row[] = []
  let n = 0
  for (let i = 0; i < N_EMP; i++) {
    const id = empId(i)
    employees.push({ id, tenant_id: TENANT_ID, user_id: null, name: `員${i}`, role: "employee", status: "active", hire_date: null, terminated_at: null, default_shift_id: null, features: {} })
    for (const d of days) {
      schedules.push({ id: `s-${String(++n).padStart(6, "0")}`, tenant_id: TENANT_ID, employee_id: id, work_date: d, shift_id: OFFICE })
      // 每天 09:10 上班（排班 09:00 → 遲到 10 分鐘；沒讀到排班就會變彈性上班、遲到 0）
      punches.push({ id: `p-${String(++n).padStart(6, "0")}`, tenant_id: TENANT_ID, employee_id: id, type: "in", punch_at: at(d, "09:10"), source: "web" })
      punches.push({ id: `p-${String(++n).padStart(6, "0")}`, tenant_id: TENANT_ID, employee_id: id, type: "out", punch_at: at(d, "19:00"), source: "web" })
    }
  }
  // 假單 1200 張（每人每天 1 小時特休，前 27 天 → 45×27＝1215 張；超過 1000 也要全部算到）
  for (let i = 0; i < N_EMP; i++) {
    for (const d of days.slice(0, 27)) {
      leaves.push({ id: `r-${String(++n).padStart(6, "0")}`, tenant_id: TENANT_ID, employee_id: empId(i), kind: "leave", status: "approved", deleted_at: null, leave_type_id: LT_ANNUAL, hours: "1", start_at: at(d, "17:00"), end_at: at(d, "18:00"), segments: null })
    }
  }
  fake.db.employees = employees
  fake.db.schedules = schedules
  fake.db.punch_records = punches
  fake.db.leave_requests = leaves
  fake.db.attendance_days = []
}

const key = (r: Row) => `${r.employee_id}|${r.work_date}`
const sortRows = (rows: Row[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)))

describe("lib/select-all-pages", () => {
  const makeBuild = (total: number, maxRows: number | null, calls: Array<[number, number]>) => (from: number, to: number) => {
    calls.push([from, to])
    const all = Array.from({ length: total }, (_, i) => ({ i }))
    let rows = all.slice(from, to + 1)
    if (maxRows !== null) rows = rows.slice(0, maxRows)
    return Promise.resolve({ data: rows, error: null })
  }

  it("超過 1000 列（max-rows=1000）：全部讀到，讀到空頁才停", async () => {
    const calls: Array<[number, number]> = []
    const rows = await selectAllPages<{ i: number }>(makeBuild(2500, 1000, calls), "t")
    expect(rows.map((r) => r.i)).toEqual(Array.from({ length: 2500 }, (_, i) => i))
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2500, 3499]])
  })

  it("伺服器 max-rows=500（小於 PAGE_SIZE）：依實際列數推進 offset，不提早停", async () => {
    const calls: Array<[number, number]> = []
    const rows = await selectAllPages<{ i: number }>(makeBuild(1750, 500, calls), "t")
    expect(rows.map((r) => r.i)).toEqual(Array.from({ length: 1750 }, (_, i) => i))
    expect(calls.map((c) => c[0])).toEqual([0, 500, 1000, 1500, 1750])
  })

  it("剛好 1000 列：多讀一次空頁後停", async () => {
    const calls: Array<[number, number]> = []
    const rows = await selectAllPages<{ i: number }>(makeBuild(1000, 1000, calls), "t")
    expect(rows).toHaveLength(1000)
    expect(calls).toHaveLength(2)
  })

  it("錯誤：selectAllPages 丟錯、fetchAllPages 原樣交回", async () => {
    const build = () => Promise.resolve({ data: null, error: { message: "boom", code: "42P01" } })
    await expect(selectAllPages(build, "lbl")).rejects.toThrow("lbl: boom")
    const res = await fetchAllPages(build, "lbl")
    expect(res.error).toEqual({ message: "boom", code: "42P01" })
  })

  it("超過分頁上限：丟錯（不無限迴圈、不靜默截斷）", async () => {
    let calls = 0
    const build = () => (calls++, Promise.resolve({ data: [{ x: 1 }], error: null }))
    await expect(selectAllPages(build, "loop")).rejects.toThrow(/超過分頁上限/)
    expect(calls).toBe(MAX_PAGES)
  })
})

describe("出勤結算分頁（fake max-rows）", () => {
  beforeEach(seed)

  async function settleWith(maxRows: number | null) {
    seed()
    fake.limits.maxRows = maxRows
    const res = await settleAttendance({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-30" })
    fake.limits.maxRows = null
    return { res, rows: sortRows(fake.db.attendance_days ?? []) }
  }

  it("loadShiftResolver：1350 筆排班在 max-rows=1000 與 500 下一筆不漏", async () => {
    for (const maxRows of [1000, 500]) {
      fake.limits.maxRows = maxRows
      const resolver = await loadShiftResolver({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-30" })
      expect(resolver.scheduledKeys(), `maxRows=${maxRows}`).toHaveLength(N_EMP * 30)
      expect(resolver.scheduleOf(empId(N_EMP - 1), "2026-09-30")).toBeTruthy()
    }
  })

  it("computeAttendanceRows：最後一位員工的月底仍讀到排班（遲到 10 分）與假單（60 分）", async () => {
    for (const maxRows of [1000, 500]) {
      seed()
      fake.limits.maxRows = maxRows
      const { rows } = await computeAttendanceRows({ tenantId: TENANT_ID, from: "2026-09-01", to: "2026-09-30" })
      expect(rows, `maxRows=${maxRows}`).toHaveLength(N_EMP * 30)
      const last = rows.find((r) => r.employee_id === empId(N_EMP - 1) && r.work_date === "2026-09-27")
      expect(last?.late_minutes, `maxRows=${maxRows}`).toBe(10)
      expect(last?.leave_minutes, `maxRows=${maxRows}`).toBe(60)
    }
  })

  it("settleAttendance：max-rows=1000 / 500 寫入的 attendance_days 與不截斷時完全一致", async () => {
    const base = await settleWith(null)
    expect(base.res.settled).toBe(N_EMP * 30)
    expect(base.rows.every((r) => r.late_minutes === 10)).toBe(true)
    const r1000 = await settleWith(1000)
    const r500 = await settleWith(500)
    expect(r1000.res).toEqual(base.res)
    expect(r500.res).toEqual(base.res)
    expect(JSON.stringify(r1000.rows)).toBe(JSON.stringify(base.rows))
    expect(JSON.stringify(r500.rows)).toBe(JSON.stringify(base.rows))
  })
})
