import { GridBuilder, STATEMENT_FONT, rocPeriodTitle, type StatementGrid } from "./grid.js"
import { letterheadRows } from "./attendance-statement.js"
import { expenseTotals, type StatementData } from "./types.js"

/**
 * 支出表（客戶 Excel「115-10 出勤統計表」工作表「支出表」）的格線。純函式。
 *
 * 抬頭三行（合併 A:F）；列 5「10月｜姓名｜支出表」；列 6 表頭：日期｜內容(單價含稅)｜金額｜說明｜專案名稱｜備註；
 * 列 7–42 明細（36 列；該月隨薪資給付的報銷——已核銷＋已送出待核銷（備註欄標「待核銷」），依日期排序，
 * 超過 36 筆就往下長）；小計（含待核銷）；有待核銷時下一列「其中待核銷 X 元」；「製表：姓名」。
 * 報銷金額不是薪資金額（會計本來就看得到報銷），不遮。
 */

export const EXPENSE_SHEET_COLUMN_WIDTHS = [11.5, 40.25, 9.875, 38, 20.125, 11.375]
const MIN_ROWS = 36
const HEADER_FILL = "#D6E3BC"

export function buildExpenseSheetGrid(data: StatementData): StatementGrid {
  const g = new GridBuilder()
  const center = { align: "center" as const }
  const LAST = 5
  const mm = Number(data.period.split("-")[1])
  letterheadRows(g, data, LAST)
  g.set(4, 1, { value: mm, format: "monthZh", size: 14, ...center })
  g.set(4, 2, { value: data.employee.name, size: 14, ...center })
  g.set(4, 3, { value: "支出表", size: 14, ...center })
  for (let c = 0; c <= LAST; c += 1) g.border(4, c, { bottom: "thin" })
  ;["日期", "內容(單價含稅)", "金額", "說明", "專案名稱", "備註"].forEach((label, c) =>
    g.set(5, c, { value: label, bold: true, fill: HEADER_FILL, ...center }),
  )
  const items = data.expenses ?? []
  const rows = Math.max(MIN_ROWS, items.length)
  for (let i = 0; i < rows; i += 1) {
    const r = 6 + i
    const item = items[i]
    g.set(r, 0, { value: item?.date ?? null, format: "mdZh", ...center })
    g.set(r, 1, { value: item?.description ?? "", align: "left" })
    g.set(r, 2, { value: item ? item.amount : null, format: "intSp", align: "right" })
    g.set(r, 3, { value: "", align: "left" })
    g.set(r, 4, { value: item?.project ?? "", ...center })
    g.set(r, 5, { value: item?.pending ? "待核銷" : "", ...center, ...(item?.pending ? { color: "#C00000" } : {}) })
  }
  const T = 6 + rows
  g.set(T, 1, { value: "小計", align: "right" })
  const totals = expenseTotals(items)
  g.set(T, 2, { value: data.expenses ? totals.total : null, text: data.expenses ? undefined : "—", format: "intSp", bold: true, align: "right" })
  g.thinGrid(5, 0, T, LAST)
  let next = T + 1
  if (data.expenses && totals.pending > 0) {
    g.set(next, 1, { value: `其中待核銷 ${totals.pending.toLocaleString("en-US")} 元`, colSpan: 2, align: "right", color: "#C00000" })
    next += 1
  }
  g.set(next, 0, { value: `製表：${data.employee.name}`, colSpan: 2, align: "left" })
  const rowCount = next + 1

  const rowHeights = Array.from({ length: rowCount }, () => 22.35)
  return {
    kind: "expenseSheet",
    title: `${rocPeriodTitle(data.period)}支出表-${data.employee.name}`,
    columns: EXPENSE_SHEET_COLUMN_WIDTHS,
    rowHeights,
    font: STATEMENT_FONT,
    cells: g.build(),
    page: {
      orientation: "portrait",
      paperSize: 9,
      fit: "width",
      margins: { left: 0.51, right: 0.31, top: 0.35, bottom: 0.35 },
      printArea: `A1:F${rowCount}`,
    },
  }
}
