import ExcelJS from "exceljs"
import { applyHeaderStyle, workbookToBuffer } from "../../lib/xlsx/index.js"
import { IMPORT_KIND_DEFS, type ImportColumn, type ImportKind } from "./kinds.js"
import { DATA_SHEET_NAME } from "./parse.js"
import { loadDepartments, loadShifts, resolveEmployees, type DepartmentRef, type EmployeeRef, type ShiftRef } from "./resolve.js"

/**
 * 批次匯入的 Excel 範本（GET /imports/:kind/template）。
 *
 *   • 「資料」：第 1 列表頭（粗體灰底，沿用 lib/xlsx 的 applyHeaderStyle）、第 2 列起
 *     範例列（灰字斜體）；每一欄都設成文字格式（@），日期／工號輸入後不會被 Excel
 *     自動轉成日期或數字（真的被轉了 parse.ts 也接得住）；有允許值的欄加下拉選單。
 *   • 「說明」：每欄意義／必填／格式／範例＋注意事項。
 *   • 視 kind 附「員工清單」（只列在職）、「班別清單」、「部門清單」，資料從 DB 撈。
 */

const EXAMPLE_FONT: Partial<ExcelJS.Font> = { color: { argb: "FF9E9E9E" }, italic: true }
const VALIDATION_ROWS = 1000

function addTable(ws: ExcelJS.Worksheet, headers: string[], rows: string[][], widths: number[]): void {
  const headerRow = ws.addRow(headers)
  applyHeaderStyle(headerRow)
  for (const r of rows) ws.addRow(r)
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })
  ws.views = [{ state: "frozen", ySplit: 1 }]
}

function buildDataSheet(wb: ExcelJS.Workbook, columns: ImportColumn[], examples: string[][]): void {
  const ws = wb.addWorksheet(DATA_SHEET_NAME)
  const headerRow = ws.addRow(columns.map((c) => c.header))
  applyHeaderStyle(headerRow)
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    col.width = c.width ?? 14
    col.numFmt = "@"
  })
  for (const ex of examples) {
    const row = ws.addRow(columns.map((_, i) => ex[i] ?? ""))
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = EXAMPLE_FONT
      cell.numFmt = "@"
    })
  }
  // 允許值下拉：第 2 列起 VALIDATION_ROWS 列，用範圍一次設（逐格 getCell 會把空格寫進檔案，
  // 讓 Excel 的使用範圍撐到第 1001 列）。
  columns.forEach((c, i) => {
    if (!c.options || c.options.length === 0) return
    const colLetter = ws.getColumn(i + 1).letter
    // worksheet.dataValidations 是 exceljs 4.x 的執行期 API，但 index.d.ts 沒宣告（該行被註解掉），所以轉型。
    const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations
    validations.add(`${colLetter}2:${colLetter}${VALIDATION_ROWS + 1}`, {
      type: "list",
      allowBlank: true,
      formulae: [`"${c.options.join(",")}"`],
      showErrorMessage: true,
      errorTitle: "不在允許值內",
      error: `請選擇：${c.options.join("／")}`,
    })
  })
  ws.views = [{ state: "frozen", ySplit: 1 }]
}

function buildGuideSheet(wb: ExcelJS.Workbook, kind: ImportKind): void {
  const def = IMPORT_KIND_DEFS[kind]
  const ws = wb.addWorksheet("說明")
  ws.getColumn(1).width = 14
  ws.getColumn(2).width = 8
  ws.getColumn(3).width = 70
  ws.getColumn(4).width = 20

  const title = ws.addRow([`${def.label}——填寫說明`])
  title.getCell(1).font = { bold: true, size: 14 }
  ws.addRow([def.description])
  const warn = ws.addRow([`上傳前請刪除「${DATA_SHEET_NAME}」工作表裡的灰字範例列（沒刪也不會匯入，但會被回報）。`])
  warn.getCell(1).font = { bold: true, color: { argb: "FFC00000" } }
  ws.addRow([`表頭請保持原樣（順序可調、可多出不用的欄）；第一列是表頭，第二列起是資料。`])
  ws.addRow([])

  const header = ws.addRow(["欄位", "必填", "說明", "範例"])
  applyHeaderStyle(header)
  for (const c of def.columns) {
    const row = ws.addRow([c.header, c.required ? "是" : "否", c.hint, c.example])
    row.getCell(3).alignment = { wrapText: true, vertical: "top" }
    row.getCell(1).alignment = { vertical: "top" }
    row.getCell(2).alignment = { vertical: "top", horizontal: "center" }
    row.getCell(4).alignment = { vertical: "top" }
  }
  ws.addRow([])
  const notesTitle = ws.addRow(["注意事項"])
  notesTitle.getCell(1).font = { bold: true }
  for (const n of def.notes) ws.addRow([`• ${n}`])
  ws.addRow([`• 日期以文字格式 YYYY-MM-DD 填寫最保險；Excel 自動轉成日期格式也能讀。`])
  ws.addRow([`• 上傳後系統會先檢查，列出每一列的問題（列號＝Excel 的列號）；有錯的列會被略過，其餘照常匯入。`])
}

function buildEmployeesSheet(wb: ExcelJS.Workbook, employees: EmployeeRef[], departments: DepartmentRef[]): void {
  const ws = wb.addWorksheet("員工清單")
  const deptName = new Map(departments.map((d) => [d.id, d.name]))
  const rows = employees
    .filter((e) => e.status === "active")
    .sort((a, b) => (a.empNo ?? "").localeCompare(b.empNo ?? "") || a.name.localeCompare(b.name))
    .map((e) => [e.empNo ?? "", e.name, e.deptId ? (deptName.get(e.deptId) ?? "") : ""])
  addTable(ws, ["工號", "姓名", "部門"], rows, [12, 16, 16])
  ws.getColumn(1).numFmt = "@"
}

function buildShiftsSheet(wb: ExcelJS.Workbook, shifts: ShiftRef[]): void {
  const ws = wb.addWorksheet("班別清單")
  addTable(
    ws,
    ["名稱", "上班時間", "下班時間"],
    shifts.map((s) => [s.name, s.startTime, s.endTime]),
    [16, 12, 12],
  )
}

function buildDepartmentsSheet(wb: ExcelJS.Workbook, departments: DepartmentRef[]): void {
  const ws = wb.addWorksheet("部門清單")
  addTable(
    ws,
    ["名稱"],
    departments.map((d) => [d.name]),
    [20],
  )
}

/** 附表要用的參考資料（從 DB 撈；測試可直接餵 fixture）。 */
export interface TemplateRefs {
  employees: EmployeeRef[]
  shifts: ShiftRef[]
  departments: DepartmentRef[]
}

/** 純函式：kind 定義＋參考資料 → Workbook（不連 DB）。 */
export function buildImportWorkbook(kind: ImportKind, refs: TemplateRefs): ExcelJS.Workbook {
  const def = IMPORT_KIND_DEFS[kind]
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster"
  wb.created = new Date()

  buildDataSheet(wb, def.columns, def.examples)
  buildGuideSheet(wb, kind)
  // 附表順序照 def.extraSheets。
  for (const sheet of def.extraSheets) {
    if (sheet === "employees") buildEmployeesSheet(wb, refs.employees, refs.departments)
    else if (sheet === "shifts") buildShiftsSheet(wb, refs.shifts)
    else if (sheet === "departments") buildDepartmentsSheet(wb, refs.departments)
  }
  return wb
}

/** 只撈這個 kind 用得到的參考資料（員工清單要顯示部門名，所以連帶撈部門）。 */
export async function loadTemplateRefs(kind: ImportKind, tenantId: string): Promise<TemplateRefs> {
  const def = IMPORT_KIND_DEFS[kind]
  const needEmployees = def.extraSheets.includes("employees")
  const needShifts = def.extraSheets.includes("shifts")
  const needDepartments = def.extraSheets.includes("departments") || needEmployees
  const [employees, shifts, departments] = await Promise.all([
    needEmployees ? resolveEmployees(tenantId).then((r) => r.all) : Promise.resolve([] as EmployeeRef[]),
    needShifts ? loadShifts(tenantId) : Promise.resolve([] as ShiftRef[]),
    needDepartments ? loadDepartments(tenantId) : Promise.resolve([] as DepartmentRef[]),
  ])
  return { employees, shifts, departments }
}

export async function buildImportTemplate(kind: ImportKind, tenantId: string): Promise<Buffer> {
  const refs = await loadTemplateRefs(kind, tenantId)
  return workbookToBuffer(buildImportWorkbook(kind, refs))
}
