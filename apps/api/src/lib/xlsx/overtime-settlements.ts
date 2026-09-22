import ExcelJS from "exceljs"
import { applyHeaderStyle, minutesToHours, toRocYear, workbookToBuffer } from "./index.js"
import type { SerializedSettlement } from "../../routes/overtime-settlements.js"

/**
 * xlsx「加班超額另行給付清單」（M1）——一列一位員工一個期別（純函式，不連 DB）。
 *
 * 用途：業主決策 1 的合法替代版。出勤月表與薪資單維持合規版（加班費只算到月上限
 * 為止），超過的分鐘集中在這張表上，由老闆／HR 以現金、補休或併薪資另行給付。
 * 只有老闆與 HR 看得到（路由層 requireHrAdmin）。
 *
 * 列的形狀是路由層的 `SerializedSettlement`（DB 欄位 snake_case ＋ employee_name／emp_no）。
 * 版面：列 1 標題、列 2 期別／筆數／合計、列 3 表頭、列 4 起明細、最後一列合計
 * → `rowCount = 3 + rows + 1`。時數寫數字＋`0.0`、金額寫數字＋`#,##0`（老闆會在
 * 旁邊拉公式），日期寫 'YYYY-MM-DD' 字串（避免 Excel 時區把日期往前推一天）。
 */

const STATUS_LABEL: Record<string, string> = { draft: "未付", paid: "已付" }
const CHANNEL_LABEL: Record<string, string> = { cash: "現金", comp_time: "補休", payroll: "併入薪資" }
const SOURCE_LABEL: Record<string, string> = { beyond_cap: "月表超額", manual: "人工新增" }

const MONEY_FMT = "#,##0"
const HOURS_FMT = "0.0"

const HEADERS = ["工號", "員工", "期別", "來源", "超額時數", "金額", "給付方式", "狀態", "給付日", "備註"] as const

/** period 'YYYY-MM' → '115年6月'（民國）。 */
function rocPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number)
  if (!y || !m) return period
  return `${toRocYear(y)}年${m}月`
}

export function buildOvertimeSettlementsWorkbook(
  period: string | undefined,
  rows: SerializedSettlement[],
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet(period ?? "全部期別", { views: [{ state: "frozen", ySplit: 3 }] })

  const totalMinutes = rows.reduce((acc, r) => acc + (r.minutes ?? 0), 0)
  const totalAmount = rows.reduce((acc, r) => acc + (r.amount ?? 0), 0)

  ws.getCell("A1").value = period
    ? `加班超額另行給付清單　${rocPeriod(period)}（${period}）`
    : "加班超額另行給付清單　全部期別"
  ws.getCell("A1").font = { bold: true, size: 16 }
  ws.mergeCells(1, 1, 1, HEADERS.length)
  ws.getCell("A2").value =
    `筆數：${rows.length}　超額合計：${minutesToHours(totalMinutes)} 小時　金額合計：${Math.round(totalAmount).toLocaleString("zh-TW")}`
  ws.mergeCells(2, 1, 2, HEADERS.length)

  const headerRow = ws.getRow(3)
  HEADERS.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  ws.columns = [12, 14, 10, 12, 11, 12, 11, 8, 12, 28].map((width) => ({ width }))

  rows.forEach((row, idx) => {
    const r = ws.getRow(4 + idx)
    r.getCell(1).value = row.emp_no ?? ""
    r.getCell(2).value = row.employee_name ?? ""
    r.getCell(3).value = row.period
    r.getCell(4).value = SOURCE_LABEL[row.source] ?? row.source
    const hoursCell = r.getCell(5)
    hoursCell.value = minutesToHours(row.minutes)
    hoursCell.numFmt = HOURS_FMT
    const amountCell = r.getCell(6)
    amountCell.value = row.amount ?? 0
    amountCell.numFmt = MONEY_FMT
    r.getCell(7).value = CHANNEL_LABEL[row.channel] ?? row.channel
    r.getCell(8).value = STATUS_LABEL[row.status] ?? row.status
    r.getCell(9).value = row.paid_on ?? ""
    r.getCell(10).value = row.note ?? ""
  })

  const totalRow = ws.getRow(4 + rows.length)
  totalRow.getCell(4).value = "合計"
  totalRow.getCell(4).font = { bold: true }
  const totalHours = totalRow.getCell(5)
  totalHours.value = minutesToHours(totalMinutes)
  totalHours.numFmt = HOURS_FMT
  totalHours.font = { bold: true }
  const totalMoney = totalRow.getCell(6)
  totalMoney.value = totalAmount
  totalMoney.numFmt = MONEY_FMT
  totalMoney.font = { bold: true }

  return wb
}

export function overtimeSettlementsFilename(period?: string): string {
  return `加班超額另計-${period ?? "全部期別"}.xlsx`
}

export async function overtimeSettlementsWorkbookBuffer(
  period: string | undefined,
  rows: SerializedSettlement[],
): Promise<Buffer> {
  return workbookToBuffer(buildOvertimeSettlementsWorkbook(period, rows))
}
