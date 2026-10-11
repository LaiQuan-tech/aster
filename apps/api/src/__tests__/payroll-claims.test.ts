import { describe, expect, it } from "vitest"
import { paysViaMonthlyPayroll, sumClaimsForPayroll, type PayrollClaimRow } from "../services/payroll-claims"

/**
 * 月薪報銷的付款路徑（2026-10-11）：一筆花費只能有一條路徑，否則公司付兩次或永遠不付。
 *   • 綁了預支（advance_id）→ 走預支差額結算，**不**隨月薪報銷給付（否則預支付一次、憑證再付一次）。
 *   • 沒綁預支 → 月報銷照常給付，包括**自行墊付的出差憑證**（只綁出差單、沒有預支可沖抵）。
 *     舊判準是 `trip_request_id` 為 null 才付——會讓這類憑證永遠不付。
 * 查詢層（loadPayrollInputs 真的讀到哪些列）見 payroll-inputs-claims.test.ts。
 * ⚠️ 識別碼都是明顯的假值（repo 是公開的）。
 */

const EMP_A = "bbbbbbbb-0000-4000-8000-00000000000a"
const EMP_B = "bbbbbbbb-0000-4000-8000-00000000000b"
const ADV = "ffffffff-0000-4000-8000-000000000001"

const row = (over: Partial<PayrollClaimRow> = {}): PayrollClaimRow => ({
  employee_id: EMP_A,
  nature: "reimbursement",
  amount: "100",
  advance_id: null,
  ...over,
})

describe("paysViaMonthlyPayroll — 這筆要不要隨月薪給付", () => {
  it("沒綁預支 → 要（一般日常報銷）", () => {
    expect(paysViaMonthlyPayroll({ advance_id: null })).toBe(true)
  })

  it("綁了預支 → 不要（走預支差額結算，避免公司付兩次）", () => {
    expect(paysViaMonthlyPayroll({ advance_id: ADV })).toBe(false)
  })

  it("空字串視同沒綁（保守：不因為髒資料把單永遠排除）", () => {
    expect(paysViaMonthlyPayroll({ advance_id: "" })).toBe(true)
  })
})

describe("sumClaimsForPayroll — 月薪報銷加總", () => {
  it("一般報銷照常加總；實報實銷與定額補貼分開（不可混算）", () => {
    const t = sumClaimsForPayroll([
      row({ amount: "100" }),
      row({ amount: 250.5 }),
      row({ nature: "allowance", amount: "1000" }),
    ])
    expect(t.expensesByEmployee.get(EMP_A)).toBe(350.5)
    expect(t.allowancesByEmployee.get(EMP_A)).toBe(1000)
  })

  it("綁了預支的憑證不重複計入月報銷（無論實報實銷或補貼）", () => {
    const t = sumClaimsForPayroll([
      row({ amount: "100" }), // 一般報銷：付
      row({ amount: "3000", advance_id: ADV }), // 預支沖抵的憑證：不付（差額在預支核銷結算）
      row({ nature: "allowance", amount: "500", advance_id: ADV }),
    ])
    expect(t.expensesByEmployee.get(EMP_A)).toBe(100)
    expect(t.allowancesByEmployee.has(EMP_A)).toBe(false)
  })

  it("自行墊付的出差憑證（只綁出差單、沒綁預支）會進月報銷——舊的 trip_request_id 判準會讓它永遠不付", () => {
    const selfPaidTrip = { ...row({ amount: "4200" }), trip_request_id: "aaaaaaaa-0000-4000-8000-000000000001" }
    const t = sumClaimsForPayroll([selfPaidTrip])
    expect(t.expensesByEmployee.get(EMP_A)).toBe(4200)
  })

  it("多位員工各算各的；全是預支憑證的員工不出現在 Map 裡", () => {
    const t = sumClaimsForPayroll([
      row({ employee_id: EMP_A, amount: "100" }),
      row({ employee_id: EMP_B, amount: "900", advance_id: ADV }),
      row({ employee_id: EMP_B, nature: "allowance", amount: "50" }),
    ])
    expect(t.expensesByEmployee.get(EMP_A)).toBe(100)
    expect(t.expensesByEmployee.has(EMP_B)).toBe(false)
    expect(t.allowancesByEmployee.get(EMP_B)).toBe(50)
  })

  it("沒有任何憑證 → 兩個 Map 都是空的", () => {
    const t = sumClaimsForPayroll([])
    expect(t.expensesByEmployee.size).toBe(0)
    expect(t.allowancesByEmployee.size).toBe(0)
  })
})
