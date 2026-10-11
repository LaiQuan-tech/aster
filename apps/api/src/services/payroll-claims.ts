/**
 * 月薪報銷：哪些「已核銷（settled）」的報銷單隨月薪給付、怎麼加總（純函式，不碰 DB；
 * services/payroll-inputs.ts loadPayrollInputs 用它，單元測試 __tests__/payroll-claims.test.ts）。
 *
 * 一筆花費只能有**一條**付款路徑，否則公司付兩次或永遠不付：
 *
 *   • 綁了預支（`advance_id` 不為 null）→ 走**預支差額結算**：員工已經先拿到預支，回來報的憑證只是
 *     用來算 `actual_total`（POST /advances/:id/settle），差額（balance）才併進薪資。這些憑證
 *     若同時走月報銷，預支付一次、憑證再付一次。→ 排除。
 *   • 沒綁預支 → 月報銷照常給付。包括**自行墊付的出差憑證**（員工選「自行墊付，回來報銷」：
 *     只綁出差單 `trip_request_id`、沒有預支可沖抵）。舊版曾用 `trip_request_id` 排除，
 *     那會讓這類憑證永遠不付——排除的判準是「有沒有預支可沖抵」，不是「有沒有綁出差單」。
 *
 * 兩種性質走引擎的不同路徑，**不可混算**：reimbursement 實報實銷 → expenses（非所得，
 * 不進 gross、不影響保費）；allowance 定額補貼 → allowances（薪資所得，進 gross）。
 *
 * ⚠️ 已綁預支但該預支一直沒核銷的憑證，不會有任何給付——這是刻意的（預支沒結清，
 * 公司對員工還有一筆未結債權，不該先把憑證付掉），由後台「已撥款・尚未核銷」清單催辦。
 */

export interface PayrollClaimRow {
  employee_id: string
  nature: string
  amount: string | number
  /** 綁定的預支；必須由查詢帶回來（缺這欄就無從排除，型別上不給省略）。 */
  advance_id: string | null
}

/** 這筆報銷單要不要隨月薪給付：沒綁預支才要（見檔頭）。 */
export function paysViaMonthlyPayroll(row: Pick<PayrollClaimRow, "advance_id">): boolean {
  return row.advance_id == null || row.advance_id === ""
}

export interface PayrollClaimTotals {
  /** 本期實報實銷合計（非所得，進實發、不進 gross）。 */
  expensesByEmployee: Map<string, number>
  /** 本期定額補貼合計（薪資所得，進 gross）。 */
  allowancesByEmployee: Map<string, number>
}

/** 已核銷報銷單 → 每位員工本期的實報實銷／定額補貼合計（綁預支的排除，見檔頭）。 */
export function sumClaimsForPayroll(rows: readonly PayrollClaimRow[]): PayrollClaimTotals {
  const expensesByEmployee = new Map<string, number>()
  const allowancesByEmployee = new Map<string, number>()
  for (const row of rows) {
    if (!paysViaMonthlyPayroll(row)) continue
    const target = row.nature === "allowance" ? allowancesByEmployee : expensesByEmployee
    target.set(row.employee_id, (target.get(row.employee_id) ?? 0) + Number(row.amount))
  }
  return { expensesByEmployee, allowancesByEmployee }
}

export interface SettlementClaimRow {
  nature: string
  amount: string | number
  /** 綁定的預支；必須由查詢帶回來（缺這欄就分不出哪些走預支核銷）。 */
  advance_id: string | null
}

export interface SettlementTotals {
  /** 隨月薪給付的實報實銷合計（非所得，直接加在實發）。 */
  reimbursementTotal: number
  /** 隨月薪給付的定額補貼合計（薪資所得，進 gross）。 */
  allowanceTotal: number
  /** 綁了預支、走預支核銷的憑證筆數（不在上面兩個合計內）。 */
  advanceBoundCount: number
  /** 綁了預支的憑證金額合計（不在上面兩個合計內；差額由預支核銷結算）。 */
  advanceBoundTotal: number
}

/**
 * 月結（GET／POST /expense-settlements/:period/…）的合計：只把**真的會隨月薪給付**的憑證算進
 * 實報實銷／定額補貼合計，綁預支的另列（`advanceBound*`）。月結頁寫著「不進應發，直接加在實發」，
 * 這兩個合計又存進 `expense_settlements`——若把綁預支的憑證也算進去，財務看到的數字比月薪實付的多，
 * 有人照這個數字補付就是付兩次（loadPayrollInputs 用同一個判準 `paysViaMonthlyPayroll` 排除它們）。
 */
export function summariseClaimsForSettlement(rows: readonly SettlementClaimRow[]): SettlementTotals {
  let reimbursementTotal = 0
  let allowanceTotal = 0
  let advanceBoundCount = 0
  let advanceBoundTotal = 0
  for (const row of rows) {
    const amount = Number(row.amount)
    if (!paysViaMonthlyPayroll(row)) {
      advanceBoundCount += 1
      advanceBoundTotal += amount
    } else if (row.nature === "reimbursement") {
      reimbursementTotal += amount
    } else if (row.nature === "allowance") {
      allowanceTotal += amount
    }
  }
  return { reimbursementTotal, allowanceTotal, advanceBoundCount, advanceBoundTotal }
}
