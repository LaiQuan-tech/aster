import type { OvertimeSegment } from "@hr/rules"
import type { SheetView } from "../../services/attendance-sheet-types.js"

/**
 * 兩張表（出勤統計表／薪資明細表）的輸入資料：由 services/employee-statements.ts 從系統各處讀來、
 * 正規化成這個形狀，再交給純函式 builder 排版。任何子資料讀不到都是 null（畫面顯示空白／「—」），不丟錯。
 */

export interface StatementCompany {
  name: string
  address: string
  /** 電話傳真整行（例「T:02-xxxx F:02-xxxx」）；沒有設定＝""。 */
  phone: string
}

export interface StatementEmployee {
  id: string
  name: string
  empNo: string | null
  title: string | null
  hireDate: string | null
}

/**
 * 金額：優先取已產生的薪資單（payslips.breakdown，引擎的完整輸出）；沒有薪資單時退回月表的試算
 * （SheetView.money），試算沒有逐段加班費（segments＝null）與逐假別扣款（leaveByCode＝null）。
 */
export interface StatementMoney {
  source: "payslip" | "preview"
  /** 薪資單狀態（draft／finalized）；試算＝null。 */
  payslipStatus: string | null
  base: number
  hourlyWage: number
  overtimePay: number
  nightPay: number
  /** 全勤獎金實發（基準−扣款）。 */
  attendanceBonus: number
  /** 全勤被扣的金額（正值）。 */
  attendanceDeduction: number
  allowances: number
  adjustmentEarnings: number
  adjustmentDeductions: number
  adjustmentNonTaxable: number
  laborInsurance: number
  healthInsurance: number
  pensionVoluntary: number
  advance: number
  leaveDeduction: number
  /** 假別 code → 扣款金額（正值）；試算＝null。 */
  leaveByCode: Record<string, number> | null
  lateEarlyDeduction: number
  gross: number
  totalDeductions: number
  /** 薪資單上的代墊支出（不進 gross）。 */
  expenses: number
  /** 引擎的實發（含代墊支出與不課稅補發）。 */
  netWithExpenses: number
  /** 逐段加班費（when × 倍率）；試算＝null。 */
  segments: OvertimeSegment[] | null
}

export interface StatementExpense {
  date: string
  amount: number
  description: string
  project: string | null
}

export interface StatementSalaryInfo {
  laborInsuredSalary: number | null
  nhiDependents: number | null
}

export interface StatementData {
  period: string
  tz: string
  employee: StatementEmployee
  company: StatementCompany | null
  attendance: SheetView | null
  money: StatementMoney | null
  expenses: StatementExpense[] | null
  salary: StatementSalaryInfo | null
  /** 假別 code → 名稱（缺勤區「事假／病假」對應用）。 */
  leaveNames: Record<string, string>
  /** 備註列（晚餐規則）；由規則產生。 */
  mealNote: string
  /** 給付日期（系統目前沒有來源＝null）。 */
  payDate: string | null
  /** 加保日（系統目前沒有來源＝null）。 */
  insuredSince: string | null
}
