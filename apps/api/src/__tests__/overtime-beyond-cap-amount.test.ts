import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { LEGACY_RULE_CONFIG_2026_09 as RULES } from "../lib/default-rule-config.js"
import { weekdayOfKey } from "../lib/tz.js"
import {
  __internal,
  allocateBeyondCap,
  beyondCapSettlementAmount,
  BEYOND_CAP_MISSING_SALARY_HINT,
  buildPayrollDays,
  type SheetDayRow,
  type SheetRow,
} from "../services/attendance-sheets.js"
import type { SheetTotals } from "../services/attendance-sheet-types.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 另計表自動算金額（2026-10-17 驗收修正）：月加班超過上限（settle_separately）移到 overtime_settlements 的分鐘，
 * 金額＝這些分鐘若留在薪資單上應付的加班費。月薪 36,000 → 時薪 150。⚠️ 識別碼都是假值。
 */
const EMP = "e0000000-0000-4000-8000-0000000000b1"
const HR = "e0000000-0000-4000-8000-0000000000b2"
const PERIOD = "2026-06"
const SALARY = { method: "monthly" as const, baseSalary: 36000 }

/** 2026-06 的 22 個平日。 */
const WEEKDAYS = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`).filter((d) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
  return wd !== 0 && wd !== 6
})

function dayRow(date: string, overtime: number): SheetDayRow {
  return {
    sheet_id: "s1",
    work_date: date,
    weekday: weekdayOfKey(date),
    day_type: "workday",
    first_in: null,
    last_out: null,
    worked_minutes: 480 + overtime,
    late_minutes: 0,
    early_leave_minutes: 0,
    overtime_minutes_computed: overtime,
    ot_tier1_minutes: 0,
    ot_tier2_minutes: 0,
    ot_tier3_minutes: 0,
    outing_minutes: 0,
    leave_minutes_computed: 0,
    leave_summary: null,
    wfh: false,
    anomalies: [],
    overtime_minutes_override: null,
    override_reason: null,
    content: null,
    outing_note: null,
    project_id: null,
    note: null,
    anomaly_ack: null,
  } as SheetDayRow
}

function scenario() {
  const sheetDays = WEEKDAYS.map((d) => dayRow(d, 120))
  const attendance = WEEKDAYS.map((d) => ({
    employee_id: EMP,
    work_date: d,
    worked_minutes: 600,
    late_minutes: 0,
    overtime_minutes: 120,
    night_minutes: 0,
    day_type: "workday",
  }))
  const beyond = allocateBeyondCap(WEEKDAYS.map((d) => ({ date: d, effective: 120 })), 40 * 60)
  const capped = buildPayrollDays(sheetDays, attendance, new Map(), beyond)
  const uncapped = buildPayrollDays(sheetDays, attendance, new Map())
  return { beyond, capped, uncapped }
}

describe("beyondCapSettlementAmount（純函式）", () => {
  it("平日每天 2h × 22 天、月上限 40h → 另計 240 分、金額 800.40", () => {
    expect(WEEKDAYS).toHaveLength(22)
    const { beyond, capped, uncapped } = scenario()
    expect([...beyond.values()].reduce((a, b) => a + b, 0)).toBe(240)
    // 最後兩天各 120 分超額；這兩天的 2h 本來都落在 ≤2h 段（×1.334）→ 4h × 150 × 1.334
    expect([...beyond.entries()]).toEqual([
      [WEEKDAYS[20], 120],
      [WEEKDAYS[21], 120],
    ])
    expect(beyondCapSettlementAmount({ salary: SALARY, rules: RULES, features: null }, capped, uncapped)).toEqual({ amount: 800.4 })
  })

  it("超額落在當日高倍率段：一天 10h 加班、上限 9h → 移出的 1h 以 ×2.666667 計 = 400", () => {
    const d = "2026-06-01"
    const sheetDays = [dayRow(d, 600)]
    const attendance = [{ employee_id: EMP, work_date: d, worked_minutes: 1080, late_minutes: 0, overtime_minutes: 600, night_minutes: 0, day_type: "workday" }]
    const beyond = allocateBeyondCap([{ date: d, effective: 600 }], 540)
    const capped = buildPayrollDays(sheetDays, attendance, new Map(), beyond)
    const uncapped = buildPayrollDays(sheetDays, attendance, new Map())
    expect(beyondCapSettlementAmount({ salary: SALARY, rules: RULES, features: null }, capped, uncapped).amount).toBe(400)
  })

  it("沒有薪資資料 → amount null、reason missing_salary", () => {
    const { capped, uncapped } = scenario()
    expect(beyondCapSettlementAmount({ salary: null, rules: RULES, features: null }, capped, uncapped)).toEqual({
      amount: null,
      reason: "missing_salary",
    })
    expect(beyondCapSettlementAmount(null, capped, uncapped).reason).toBe("missing_salary")
  })
})

describe("upsertBeyondCapSettlement — 寫入金額", () => {
  const sheet = { id: "a0000000-0000-4000-8000-0000000000c1", tenant_id: TENANT_ID, employee_id: EMP, period: PERIOD } as unknown as SheetRow
  const totals = { overtimeBeyondCapMinutes: 240 } as SheetTotals
  const rows = () => (fake.db.overtime_settlements ?? []).filter((r) => r.employee_id === EMP)

  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    fake.db.overtime_settlements = []
  })

  it("新建 draft：minutes 240、amount 800.4，沒有提示", async () => {
    const warnings = await __internal.upsertBeyondCapSettlement(TENANT_ID, sheet, totals, HR, { amount: 800.4 })
    expect(warnings).toEqual([])
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ minutes: 240, amount: 800.4, status: "draft", source: "beyond_cap" })
  })

  it("缺薪資資料：amount 留空、備註與回傳都提示「缺薪資資料，金額未計」", async () => {
    const warnings = await __internal.upsertBeyondCapSettlement(TENANT_ID, sheet, totals, HR, { amount: null, reason: "missing_salary" })
    expect(rows()[0].amount).toBeNull()
    expect(String(rows()[0].note)).toContain(BEYOND_CAP_MISSING_SALARY_HINT)
    expect(warnings.join("")).toContain(BEYOND_CAP_MISSING_SALARY_HINT)
  })

  it("已有 draft、分鐘沒變 → 不動（HR 改過的金額保留）；分鐘變了 → 更新分鐘與金額", async () => {
    fake.db.overtime_settlements = [
      { id: "b0000000-0000-4000-8000-0000000000d1", tenant_id: TENANT_ID, employee_id: EMP, period: PERIOD, source: "beyond_cap", minutes: 240, amount: 999, status: "draft" },
    ]
    await __internal.upsertBeyondCapSettlement(TENANT_ID, sheet, totals, HR, { amount: 800.4 })
    expect(rows()[0].amount).toBe(999)
    await __internal.upsertBeyondCapSettlement(TENANT_ID, sheet, { overtimeBeyondCapMinutes: 120 } as SheetTotals, HR, { amount: 400.2 })
    expect(rows()[0]).toMatchObject({ minutes: 120, amount: 400.2 })
  })

  it("已付款列不動（分鐘、金額都不改），回傳提示補差額", async () => {
    fake.db.overtime_settlements = [
      { id: "b0000000-0000-4000-8000-0000000000d2", tenant_id: TENANT_ID, employee_id: EMP, period: PERIOD, source: "beyond_cap", minutes: 120, amount: 400.2, status: "paid" },
    ]
    const warnings = await __internal.upsertBeyondCapSettlement(TENANT_ID, sheet, totals, HR, { amount: 800.4 })
    expect(rows()[0]).toMatchObject({ minutes: 120, amount: 400.2, status: "paid" })
    expect(warnings.join("")).toContain("已付款")
  })
})
