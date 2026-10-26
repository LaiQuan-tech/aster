import type { AnnualRow } from "./project-application-store.js"

/**
 * 「所有專案」列表的總表欄位（業主 2026-10-27：列表欄位要跟「專案申請單總表」Excel 一模一樣）。
 *
 * 算法與年度總表完全相同（buildAnnualRows），這裡只負責**遮罩**：
 *   • 金額類欄位（金額／稅金／含稅／已收帳款／應收帳款／已開發票／發包／各科別發包）＋備註
 *     （備註裡有累計請款%與「應付技師 xx 元」）只給對該案有 finance 權限的人
 *     ——HR／會計全部；其他人只有自己是負責人、案子所屬部門主管、或專案主持角色的案
 *     （services/project-scope.ts financeProjectIds，與未收款清單同一條規則）。
 *   • 項次／單號／日期／客戶／工程名稱／合約（已簽約與否）／簽證（技師姓名）／業務（負責人）
 *     本來就是 GET /projects 全員可見的基本資料，不遮。
 *   • 獎金池、分潤比例、毛利不在總表欄位裡，列表一律不回（W4／集團財務規則不變）。
 */
export type RegisterRow = {
  projectId: string
  /** 民國 'yyy.m.d'：開案日，缺值退回建立日（同年度總表「日期」欄）。 */
  dateRoc: string | null
  contractStatus: AnnualRow["contractStatus"]
  engineerSignature: string
  leadName: string | null
  /** false＝這一列的金額與備註被遮掉（無權限），前端顯示「—」而不是 0。 */
  moneyVisible: boolean
  amountUntaxed: number | null
  taxAmount: number | null
  amountTotal: number | null
  receivedTotal: number | null
  unreceived: number | null
  invoicedTotal: number | null
  subcontractTotal: number | null
  subcontractByDiscipline: Record<string, number>
  note: string
}

/** 純函式：年度總表的一列 → 列表用的總表欄位，`canSeeMoney=false` 時金額與備註一律清空。 */
export function maskRegisterRow(row: AnnualRow, canSeeMoney: boolean): RegisterRow {
  const base = {
    projectId: row.projectId,
    dateRoc: row.dateRoc,
    contractStatus: row.contractStatus,
    engineerSignature: row.engineerSignature,
    leadName: row.leadName,
  }
  if (!canSeeMoney) {
    return {
      ...base,
      moneyVisible: false,
      amountUntaxed: null,
      taxAmount: null,
      amountTotal: null,
      receivedTotal: null,
      unreceived: null,
      invoicedTotal: null,
      subcontractTotal: null,
      subcontractByDiscipline: {},
      note: "",
    }
  }
  return {
    ...base,
    moneyVisible: true,
    amountUntaxed: row.amountUntaxed,
    taxAmount: row.taxAmount,
    amountTotal: row.amountTotal,
    receivedTotal: row.receivedTotal,
    unreceived: row.unreceived,
    invoicedTotal: row.invoicedTotal,
    subcontractTotal: row.subcontractTotal,
    subcontractByDiscipline: { ...row.subcontractByDiscipline },
    note: row.note,
  }
}

/**
 * 純函式：整份列表的遮罩。`moneyProjectIds=null`＝全部看得到（HR／會計）；
 * 否則只有集合內的案帶金額。
 */
export function maskRegisterRows(rows: AnnualRow[], moneyProjectIds: Set<string> | null): RegisterRow[] {
  return rows.map((row) => maskRegisterRow(row, moneyProjectIds === null || moneyProjectIds.has(row.projectId)))
}
