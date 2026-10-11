import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { loadPayrollInputs } from "../services/payroll-inputs.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * loadPayrollInputs 讀報銷的實際查詢（2026-10-11）：本期**已核銷（settled）**的憑證裡——
 *   • 綁了預支（advance_id）的**不**重複計入月報銷（它們走預支差額結算，見下面的差額列）；
 *   • 沒綁預支的照常計入，包括自行墊付的出差憑證（只綁出差單 trip_request_id、沒有預支）；
 *   • 預支核銷的差額（balance_handling='payroll'、recovery_period＝本期）：正的＝公司補給員工 → 併入
 *     實報實銷加項；負的＝員工應退 → 薪資扣回（advanceRecoveryByEmployee）。
 * 所以一筆花費不會同時走「預支差額」與「月報銷」兩條路徑（公司付兩次），也不會哪條都不走（永遠不付）。
 * 純函式（判準與加總）見 payroll-claims.test.ts。⚠️ 識別碼都是明顯的假值（repo 是公開的）。
 */

const EMP = "bbbbbbbb-0000-4000-8000-00000000000a"
const EMP_OTHER = "bbbbbbbb-0000-4000-8000-00000000000b"
const ADV_SETTLED = "ffffffff-0000-4000-8000-000000000001"
const ADV_PAID = "ffffffff-0000-4000-8000-000000000002"
const TRIP_WITH_ADV = "aaaaaaaa-0000-4000-8000-000000000001"
const TRIP_SELF_PAID = "aaaaaaaa-0000-4000-8000-000000000002"
const PERIOD = "2026-10"

const claim = (id: string, over: Row = {}): Row => ({
  id,
  tenant_id: TENANT_ID,
  employee_id: EMP,
  nature: "reimbursement",
  amount: 100,
  period: PERIOD,
  status: "settled",
  advance_id: null,
  trip_request_id: null,
  ...over,
})

beforeEach(() => {
  fake.reset()
  fake.db.salary_structures = [
    { tenant_id: TENANT_ID, employee_id: EMP, method: "monthly", base_salary: "40000" },
    { tenant_id: TENANT_ID, employee_id: EMP_OTHER, method: "monthly", base_salary: "40000" },
  ]
})

describe("loadPayrollInputs — 報銷不重複、不漏付", () => {
  it("綁了預支的憑證不計入月報銷；一般報銷、自行墊付的出差憑證照常計入", async () => {
    fake.db.expense_claims = [
      claim("plain", { amount: 100 }), // 一般報銷
      claim("trip-self-paid", { amount: 4200, trip_request_id: TRIP_SELF_PAID }), // 墊付：只綁出差單
      claim("trip-with-advance", { amount: 3000, trip_request_id: TRIP_WITH_ADV, advance_id: ADV_PAID }), // 預支沖抵：不重複付
      claim("advance-only", { amount: 900, advance_id: ADV_PAID }), // 零用金預支沖抵（沒有出差單）：不重複付
      claim("advance-allowance", { amount: 50, nature: "allowance", advance_id: ADV_PAID }),
    ]

    const inputs = await loadPayrollInputs(TENANT_ID, PERIOD, [EMP])

    expect(inputs.expensesByEmployee.get(EMP)).toBe(4300) // 100 + 4200，**不含** 3000 與 900
    expect(inputs.allowancesByEmployee.has(EMP)).toBe(false)
    expect(inputs.advanceRecoveryByEmployee.size).toBe(0)
  })

  it("只取本期、已核銷（settled）的憑證：待核銷、已撤回、退件、別的期別都不進", async () => {
    fake.db.expense_claims = [
      claim("in", { amount: 100 }),
      claim("submitted", { amount: 200, status: "submitted" }),
      claim("cancelled", { amount: 400, status: "cancelled" }),
      claim("rejected", { amount: 800, status: "rejected" }),
      claim("last-month", { amount: 1600, period: "2026-09" }),
      claim("allowance", { amount: 500, nature: "allowance" }),
    ]

    const inputs = await loadPayrollInputs(TENANT_ID, PERIOD, [EMP])

    expect(inputs.expensesByEmployee.get(EMP)).toBe(100)
    expect(inputs.allowancesByEmployee.get(EMP)).toBe(500)
  })

  it("預支核銷的差額走另一條：公司補員工（balance>0）併入加項、員工應退（balance<0）薪資扣回；憑證本身不再重複計入", async () => {
    fake.db.expense_claims = [
      claim("with-advance-1", { amount: 1500, advance_id: ADV_SETTLED }),
      claim("plain", { amount: 100 }),
    ]
    fake.db.advances = [
      // 預支 1000、綁定憑證 1500 → balance +500，從 2026-10 薪資補給員工
      { id: ADV_SETTLED, tenant_id: TENANT_ID, employee_id: EMP, status: "settled", balance: 500, balance_handling: "payroll", recovery_period: PERIOD },
      // 另一位員工預支有餘 → 應退 300，從 2026-10 薪資扣回
      { id: "adv-other", tenant_id: TENANT_ID, employee_id: EMP_OTHER, status: "settled", balance: -300, balance_handling: "payroll", recovery_period: PERIOD },
      // 現金找補、或指到別期的差額，不進本期
      { id: "adv-cash", tenant_id: TENANT_ID, employee_id: EMP, status: "settled", balance: 999, balance_handling: "cash", recovery_period: null },
      { id: "adv-next", tenant_id: TENANT_ID, employee_id: EMP, status: "settled", balance: 777, balance_handling: "payroll", recovery_period: "2026-11" },
    ]

    const inputs = await loadPayrollInputs(TENANT_ID, PERIOD, [EMP, EMP_OTHER])

    // EMP：一般報銷 100 ＋ 預支差額 500（憑證 1500 本身不再計入）= 600，而不是 100 + 1500 + 500
    expect(inputs.expensesByEmployee.get(EMP)).toBe(600)
    expect(inputs.advanceRecoveryByEmployee.has(EMP)).toBe(false)
    // EMP_OTHER：員工應退 300
    expect(inputs.advanceRecoveryByEmployee.get(EMP_OTHER)).toBe(300)
    expect(inputs.expensesByEmployee.has(EMP_OTHER)).toBe(false)
  })

  it("只算 scope 內的員工（employeeIds）；沒有任何報銷 → 空 Map", async () => {
    fake.db.expense_claims = [claim("other", { employee_id: EMP_OTHER, amount: 700 })]

    const inputs = await loadPayrollInputs(TENANT_ID, PERIOD, [EMP])

    expect(inputs.expensesByEmployee.size).toBe(0)
    expect(inputs.allowancesByEmployee.size).toBe(0)
  })
})
