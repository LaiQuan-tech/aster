import { describe, expect, it } from "vitest"
import ExcelJS from "exceljs"
import { cellText, normalizeToken, parseImportWorkbook } from "../services/imports/parse.js"
import { parseAmountInput, parseDateInput, parseTimeInput } from "../services/imports/run.js"
import { IMPORT_KIND_DEFS } from "../services/imports/kinds.js"

/**
 * services/imports/parse.ts（xlsx 解析）——純函式測試：用 exceljs 在記憶體組
 * workbook → workbookToBuffer → parseImportWorkbook。不連 DB。
 */

type CellInput = ExcelJS.CellValue

async function bufferOf(sheets: Array<{ name: string; rows: CellInput[][]; numFmt?: Record<number, string> }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name)
    for (const r of s.rows) {
      const row = ws.addRow(r)
      for (const [col, fmt] of Object.entries(s.numFmt ?? {})) row.getCell(Number(col)).numFmt = fmt
    }
  }
  const data = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
}

describe("parseImportWorkbook — 表頭", () => {
  it("中文表頭：依 columns.header 對到 key，空欄給空字串", async () => {
    const buf = await bufferOf([
      { name: "資料", rows: [["工號", "姓名", "日期", "時間", "類型"], ["A007", "王小明", "2026-09-17", "09:00", "上班"], ["", "李小華", "2026-09-16", "18:00", ""]] },
    ])
    const r = await parseImportWorkbook(buf, "punches")
    expect(r.headerErrors).toEqual([])
    expect(r.sheetName).toBe("資料")
    expect(r.rows).toEqual([
      { line: 2, values: { empNo: "A007", name: "王小明", date: "2026-09-17", time: "09:00", type: "上班" } },
      { line: 3, values: { empNo: "", name: "李小華", date: "2026-09-16", time: "18:00", type: "" } },
    ])
  })

  it("英文 key 當表頭也接受；順序可調、多餘的欄忽略", async () => {
    const buf = await bufferOf([
      { name: "資料", rows: [["type", "備註", "date", "time", "empNo"], ["in", "x", "2026-09-15", "09:00", "A001"]] },
    ])
    const r = await parseImportWorkbook(buf, "punches")
    expect(r.headerErrors).toEqual([])
    expect(r.rows[0].values).toEqual({ empNo: "A001", name: "", date: "2026-09-15", time: "09:00", type: "in" })
  })

  it("表頭去空白、全半形統一、尾端括號註解不影響比對", async () => {
    const buf = await bufferOf([
      { name: "資料", rows: [["工　號", " 姓名 ", "日期(必填)", "時間（HH:MM）", "類型"], ["A007", "王小明", "2026-09-17", "09:00", "上班"]] },
    ])
    const r = await parseImportWorkbook(buf, "punches")
    expect(r.headerErrors).toEqual([])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].values.date).toBe("2026-09-17")
    expect(r.rows[0].values.time).toBe("09:00")
  })

  it("缺必填欄 → headerErrors 說缺哪個（invalid_header）", async () => {
    const buf = await bufferOf([{ name: "資料", rows: [["工號", "姓名", "時間", "類型"], ["A001", "王小明", "09:00", "上班"]] }])
    const r = await parseImportWorkbook(buf, "punches")
    expect(r.headerErrors).toHaveLength(1)
    expect(r.headerErrors[0]).toContain("「日期」")
    expect(r.rows).toEqual([])
  })

  it("整份表頭都認不得 → headerErrors 列出應有的表頭", async () => {
    const buf = await bufferOf([{ name: "資料", rows: [["a", "b", "c"], ["1", "2", "3"]] }])
    const r = await parseImportWorkbook(buf, "holidays")
    expect(r.headerErrors[0]).toContain("日期、名稱")
  })

  it("沒有「資料」工作表 → 用第一張；有的話優先用「資料」", async () => {
    const first = await bufferOf([{ name: "Sheet1", rows: [["日期", "名稱"], ["2026-04-04", "兒童節"]] }])
    const r1 = await parseImportWorkbook(first, "holidays")
    expect(r1.sheetName).toBe("Sheet1")
    expect(r1.rows).toEqual([{ line: 2, values: { date: "2026-04-04", label: "兒童節" } }])

    const both = await bufferOf([
      { name: "說明", rows: [["這是說明"]] },
      { name: "資料", rows: [["日期", "名稱"], ["2026-06-19", "端午節"]] },
    ])
    const r2 = await parseImportWorkbook(both, "holidays")
    expect(r2.sheetName).toBe("資料")
    expect(r2.rows[0].values).toEqual({ date: "2026-06-19", label: "端午節" })
  })

  it("空工作表 → headerErrors", async () => {
    const buf = await bufferOf([{ name: "資料", rows: [] }])
    const r = await parseImportWorkbook(buf, "holidays")
    expect(r.headerErrors).toHaveLength(1)
  })
})

describe("parseImportWorkbook — 儲存格與列", () => {
  it("Excel 日期／時間儲存格（Date 物件）用 UTC 取值 → YYYY-MM-DD／HH:MM；數字、超連結、richText、公式都轉字串", async () => {
    const buf = await bufferOf([
      {
        name: "資料",
        rows: [
          ["工號", "姓名", "生效日", "新薪資", "原因"],
          [
            { richText: [{ text: "A" }, { text: "007" }] },
            { text: "王小明", hyperlink: "https://example.com" },
            new Date(Date.UTC(2026, 10, 1)),
            48000,
            { formula: "\"年度\"&\"調薪\"", result: "年度調薪" },
          ],
        ],
        numFmt: { 3: "yyyy-mm-dd" },
      },
    ])
    const r = await parseImportWorkbook(buf, "salary-adjustments")
    expect(r.headerErrors).toEqual([])
    expect(r.rows[0].values).toEqual({ empNo: "A007", name: "王小明", effectiveDate: "2026-11-01", newSalary: "48000", reason: "年度調薪" })
  })

  it("時間儲存格（Excel 紀元 1899-12-30 + 時分）→ HH:MM；日期時間儲存格 → 'YYYY-MM-DD HH:MM'", async () => {
    const buf = await bufferOf([
      {
        name: "資料",
        rows: [
          ["工號", "姓名", "日期", "時間", "類型"],
          ["A001", "王小明", new Date(Date.UTC(2026, 8, 15)), new Date(Date.UTC(1899, 11, 30, 9, 5)), "上班"],
          ["A001", "王小明", new Date(Date.UTC(2026, 8, 15, 18, 30)), "", "下班"],
        ],
        numFmt: { 3: "yyyy-mm-dd", 4: "h:mm" },
      },
    ])
    const r = await parseImportWorkbook(buf, "punches")
    expect(r.rows[0].values.date).toBe("2026-09-15")
    expect(r.rows[0].values.time).toBe("09:05")
    expect(r.rows[1].values.date).toBe("2026-09-15 18:30")
    expect(r.rows[1].values.time).toBe("")
  })

  it("空列與只有空白的列跳過；line 是 Excel 列號", async () => {
    const buf = await bufferOf([
      {
        name: "資料",
        rows: [["日期", "名稱"], ["2026-04-04", "兒童節"], [], ["  ", ""], [null, null], ["2026-06-19", "端午節"]],
      },
    ])
    const r = await parseImportWorkbook(buf, "holidays")
    expect(r.rows.map((x) => x.line)).toEqual([2, 6])
  })

  it("值與範例列完全相同的列跳過，回一則 warning（不算進 rows）", async () => {
    const def = IMPORT_KIND_DEFS.holidays
    const buf = await bufferOf([
      {
        name: "資料",
        rows: [def.columns.map((c) => c.header), [...def.examples[0]], [...def.examples[1]], ["2026-04-04", "兒童節"]],
      },
    ])
    const r = await parseImportWorkbook(buf, "holidays")
    expect(r.warnings.map((w) => w.line)).toEqual([2, 3])
    expect(r.warnings[0].message).toContain("範例列")
    expect(r.rows).toEqual([{ line: 4, values: { date: "2026-04-04", label: "兒童節" } }])
  })

  it("表頭列不在第 1 列（前面有空列）也找得到", async () => {
    const buf = await bufferOf([{ name: "資料", rows: [[], [], ["日期", "名稱"], ["2026-04-04", "兒童節"]] }])
    const r = await parseImportWorkbook(buf, "holidays")
    expect(r.headerErrors).toEqual([])
    expect(r.rows).toEqual([{ line: 4, values: { date: "2026-04-04", label: "兒童節" } }])
  })

  it("不是 xlsx 的位元組 → 丟錯（route 回 400 unsupported_file）", async () => {
    await expect(parseImportWorkbook(Buffer.from("name,email\nx,y", "utf8"), "employees")).rejects.toThrow()
  })
})

describe("cellText / normalizeToken", () => {
  it("cellText：各種型別", () => {
    expect(cellText(null)).toBe("")
    expect(cellText(undefined)).toBe("")
    expect(cellText("  x ")).toBe("x")
    expect(cellText(55000)).toBe("55000")
    expect(cellText(1.5)).toBe("1.5")
    expect(cellText(true)).toBe("TRUE")
    expect(cellText(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01-05")
    expect(cellText(new Date(Date.UTC(2026, 0, 5, 8, 0)))).toBe("2026-01-05 08:00")
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 18, 30)))).toBe("18:30")
    expect(cellText({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab")
    expect(cellText({ text: { richText: [{ text: "x@example.com" }] }, hyperlink: "mailto:x@example.com" } as unknown as ExcelJS.CellValue)).toBe("x@example.com")
    expect(cellText({ formula: "A1", result: 3 })).toBe("3")
    expect(cellText({ formula: "A1", result: { error: "#N/A" } } as ExcelJS.CellValue)).toBe("")
    expect(cellText({ error: "#REF!" } as ExcelJS.CellValue)).toBe("")
  })

  it("normalizeToken：全形→半形、去空白、去尾端括號、小寫", () => {
    expect(normalizeToken("Ｅｍａｉｌ")).toBe("email")
    expect(normalizeToken(" 工　號 ")).toBe("工號")
    expect(normalizeToken("日期(必填)")).toBe("日期")
    expect(normalizeToken("時間（HH:MM）")).toBe("時間")
    expect(normalizeToken("EmpNo")).toBe("empno")
  })
})

describe("run.ts 的欄位小工具", () => {
  it("parseDateInput：多種分隔、月日一位數、日期時間、不合法日期", () => {
    expect(parseDateInput("2026-09-15")).toEqual({ date: "2026-09-15" })
    expect(parseDateInput("2026/9/5")).toEqual({ date: "2026-09-05" })
    expect(parseDateInput("2026.09.15")).toEqual({ date: "2026-09-15" })
    expect(parseDateInput("2026年9月15日")).toEqual({ date: "2026-09-15" })
    expect(parseDateInput("2026-09-15 18:30")).toEqual({ date: "2026-09-15", time: "18:30" })
    expect(parseDateInput("2026-02-30")).toBeNull()
    expect(parseDateInput("15/09/2026")).toBeNull()
    expect(parseDateInput("")).toBeNull()
  })

  it("parseTimeInput：H:MM、HH:MM:SS、HHMM、全形冒號、超界", () => {
    expect(parseTimeInput("9:00")).toBe("09:00")
    expect(parseTimeInput("09:00:30")).toBe("09:00")
    expect(parseTimeInput("0930")).toBe("09:30")
    expect(parseTimeInput("18：30")).toBe("18:30")
    expect(parseTimeInput("24:00")).toBeNull()
    expect(parseTimeInput("abc")).toBeNull()
  })

  it("parseAmountInput：千分位、幣別符號、小數、負數／文字不合法", () => {
    expect(parseAmountInput("45,000")).toBe(45000)
    expect(parseAmountInput("NT$45000")).toBe(45000)
    expect(parseAmountInput("45000.5")).toBe(45000.5)
    expect(parseAmountInput("45000元")).toBe(45000)
    expect(parseAmountInput("-1")).toBeNull()
    expect(parseAmountInput("四萬五")).toBeNull()
  })
})
