import { describe, expect, it } from "vitest"
import ExcelJS from "exceljs"
import { workbookToBuffer } from "../lib/xlsx/index.js"
import { IMPORT_KINDS, IMPORT_KIND_DEFS, templateFileName } from "../services/imports/kinds.js"
import { cellText, parseImportWorkbook } from "../services/imports/parse.js"
import { buildImportWorkbook, type TemplateRefs } from "../services/imports/template.js"

/**
 * services/imports/kinds.ts ＋ template.ts——6 種 kind 的定義一致性，以及範本
 * write → reload 後：「資料」表頭＝columns.header、範例列灰字、每個 kind 都有
 * 「說明」、附表照 extraSheets、範本自己丟回 parse 會把範例列當範例跳過。
 * 附表資料用 fixture（不連 DB）。
 */

const refs: TemplateRefs = {
  employees: [
    { id: "e1", empNo: "A001", name: "王小明", status: "active", deptId: "d1", hasUser: true },
    { id: "e2", empNo: "B002", name: "李小華", status: "active", deptId: null, hasUser: false },
    { id: "e3", empNo: "C003", name: "已離職", status: "inactive", deptId: "d1", hasUser: false },
  ],
  shifts: [{ id: "s1", name: "早班", startTime: "09:00", endTime: "18:00" }],
  departments: [{ id: "d1", name: "業務部" }],
}

const SHEET_LABEL = { employees: "員工清單", shifts: "班別清單", departments: "部門清單" } as const

async function reload(kind: (typeof IMPORT_KINDS)[number]): Promise<ExcelJS.Workbook> {
  const buf = await workbookToBuffer(buildImportWorkbook(kind, refs))
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb
}

function rowTexts(ws: ExcelJS.Worksheet, n: number): string[] {
  const out: string[] = []
  ws.getRow(n).eachCell({ includeEmpty: true }, (cell) => out.push(cellText(cell.value)))
  return out
}

describe("IMPORT_KIND_DEFS 一致性", () => {
  it.each(IMPORT_KINDS)("%s：key／header 唯一、範例列欄數＝欄數、column.example＝第一筆範例、檔名", (kind) => {
    const def = IMPORT_KIND_DEFS[kind]
    expect(def.kind).toBe(kind)
    expect(def.columns.length).toBeGreaterThan(0)
    expect(new Set(def.columns.map((c) => c.key)).size).toBe(def.columns.length)
    expect(new Set(def.columns.map((c) => c.header)).size).toBe(def.columns.length)
    expect(def.examples.length).toBeGreaterThanOrEqual(1)
    expect(def.examples.length).toBeLessThanOrEqual(2)
    for (const ex of def.examples) expect(ex).toHaveLength(def.columns.length)
    def.columns.forEach((c, i) => expect(c.example).toBe(def.examples[0][i]))
    for (const c of def.columns) {
      if (c.options) expect(c.options).toContain(c.example)
    }
    expect(templateFileName(kind)).toBe(`匯入範本-${def.label}.xlsx`)
  })

  it("表頭與契約一致", () => {
    const headers = (k: (typeof IMPORT_KINDS)[number]) => IMPORT_KIND_DEFS[k].columns.map((c) => c.header)
    expect(headers("punches")).toEqual(["工號", "姓名", "日期", "時間", "類型"])
    expect(headers("schedules")).toEqual(["工號", "姓名", "日期", "班別", "狀態"])
    expect(headers("salary-adjustments")).toEqual(["工號", "姓名", "生效日", "新薪資", "原因"])
    expect(headers("onboardings")).toEqual(["姓名", "報到日", "身分別", "地區", "僱用類型", "部門", "主管工號"])
    expect(headers("employees")).toEqual(["姓名", "Email", "工號", "部門", "僱用類型", "到職日", "角色"])
    expect(headers("holidays")).toEqual(["日期", "名稱"])
  })
})

describe("buildImportWorkbook（write → reload）", () => {
  it.each(IMPORT_KINDS)("%s：「資料」表頭＝columns.header、範例列灰字、有「說明」、附表照 extraSheets", async (kind) => {
    const def = IMPORT_KIND_DEFS[kind]
    const wb = await reload(kind)
    const names = wb.worksheets.map((w) => w.name)
    expect(names[0]).toBe("資料")
    expect(names).toContain("說明")
    for (const extra of def.extraSheets) expect(names).toContain(SHEET_LABEL[extra])
    for (const extra of ["employees", "shifts", "departments"] as const) {
      if (!def.extraSheets.includes(extra)) expect(names).not.toContain(SHEET_LABEL[extra])
    }

    const data = wb.getWorksheet("資料")!
    expect(rowTexts(data, 1)).toEqual(def.columns.map((c) => c.header))
    expect(data.getRow(1).getCell(1).font?.bold).toBe(true)
    def.examples.forEach((ex, i) => {
      const row = data.getRow(i + 2)
      expect(rowTexts(row.worksheet, i + 2).slice(0, ex.length)).toEqual(ex)
      expect(row.getCell(1).font?.color?.argb).toBe("FF9E9E9E")
    })
    // 每一欄都是文字格式，Excel 不會把 2026-09-15 或 0001 自動轉型。
    def.columns.forEach((_, i) => expect(data.getColumn(i + 1).numFmt).toBe("@"))

    const guide = wb.getWorksheet("說明")!
    const guideText: string[] = []
    guide.eachRow((row) => row.eachCell((cell) => guideText.push(cellText(cell.value))))
    expect(guideText.join("\n")).toContain("上傳前請刪除")
    for (const c of def.columns) {
      expect(guideText).toContain(c.header)
      expect(guideText).toContain(c.hint)
    }
  })

  it("範本自己丟回 parseImportWorkbook：表頭吻合、範例列被當範例跳過、沒有資料列", async () => {
    for (const kind of IMPORT_KINDS) {
      const buf = await workbookToBuffer(buildImportWorkbook(kind, refs))
      const r = await parseImportWorkbook(buf, kind)
      expect(r.headerErrors, kind).toEqual([])
      expect(r.rows, kind).toEqual([])
      expect(r.warnings.map((w) => w.line), kind).toEqual(IMPORT_KIND_DEFS[kind].examples.map((_, i) => i + 2))
    }
  })

  it("員工清單只列在職、含部門名；班別清單有時間；部門清單有名稱", async () => {
    const sched = await reload("schedules")
    const emps = sched.getWorksheet("員工清單")!
    expect(rowTexts(emps, 1)).toEqual(["工號", "姓名", "部門"])
    expect(rowTexts(emps, 2)).toEqual(["A001", "王小明", "業務部"])
    expect(rowTexts(emps, 3)).toEqual(["B002", "李小華", ""])
    expect(emps.rowCount).toBe(3) // 已離職的不列
    const shifts = sched.getWorksheet("班別清單")!
    expect(rowTexts(shifts, 2)).toEqual(["早班", "09:00", "18:00"])

    const ob = await reload("onboardings")
    expect(rowTexts(ob.getWorksheet("部門清單")!, 2)).toEqual(["業務部"])
  })

  it("有允許值的欄在範例列以下有下拉驗證", async () => {
    const wb = await reload("punches")
    const data = wb.getWorksheet("資料")!
    const typeCol = IMPORT_KIND_DEFS.punches.columns.findIndex((c) => c.key === "type") + 1
    const dv = data.getCell(4, typeCol).dataValidation
    expect(dv?.type).toBe("list")
    expect(dv?.formulae?.[0]).toContain("上班")
  })
})
