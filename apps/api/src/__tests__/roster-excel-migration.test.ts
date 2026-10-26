import { describe, expect, it } from "vitest"
import {
  cellToString, headerKey, isCredentialText, looksLikeLoginUrl, normalizeTaxId, planRosterMigration, planToSql,
  rebuildNote, sheetToRows, summarizePlan,
  type DbClientRow, type DbVendorRow, type ExcelRosterRow,
} from "../services/roster-excel-migration.js"

/**
 * 客供商名冊搬遷（services/roster-excel-migration.ts）的對應邏輯。純函式、不碰 DB。
 * ⚠️ 全部是明顯的假資料（repo 是公開的）；統編用通過檢查碼的假號碼。
 */
const T = "11111111-1111-4111-8111-111111111111"
const MARK = "〔2026-10-12 由客供商基本資料匯入〕"
const MARK_OLD = "〔2026-10-12 由客供商基本資料匯入；舊版 2023-03-28〕"
const AT = "2026-10-12T04:10:00.000Z"
const LATER = "2026-10-20T09:00:00.000Z"

const VENDOR_HEADERS = ["簡稱", "序", "類別", "細目", "編號", "公司名稱", "tel", "fax", "承辦窗口", "mobil", "e-mail", "公司地址", "統編", "付款方式", "備註", "網址"]
const OLD_HEADERS = ["簡稱", "類別", "細目", "公司名稱", "tel", "fax", "承辦窗口", "mobil", "e-mail", "公司地址"]
const CLIENT_HEADERS = ["簡稱", "序", "區域", "編號", "公司名稱", "tel", "fax", "承辦窗口", "mobil", "e-mail", "公司地址", "統編", "收款方式", "備註"]

const row = (over: Partial<ExcelRosterRow> & { cells: Record<string, string> }): ExcelRosterRow => ({
  file: "new", sheet: "供應商資料", kind: "supplier", rowNumber: 3, headers: VENDOR_HEADERS, ...over,
})
const vendor = (over: Partial<DbVendorRow> & { id: string; name: string }): DbVendorRow => ({
  tenant_id: T, note: MARK, created_at: AT, updated_at: AT, deleted_at: null, ...over,
})
const client = (over: Partial<DbClientRow> & { id: string; name: string }): DbClientRow => ({
  tenant_id: T, note: MARK, created_at: AT, updated_at: AT, deleted_at: null, ...over,
})

describe("工具函式", () => {
  it("表頭正規化：拿掉對齊空白、E-mail／e-mail 同欄", () => {
    expect(headerKey("公　　　司　　　名　　　稱")).toBe("公司名稱")
    expect(headerKey("類    別")).toBe("類別")
    expect(headerKey("E-mail")).toBe(headerKey("e-mail"))
  })

  it("儲存格值：富文字、超連結、公式、整數", () => {
    expect(cellToString({ richText: [{ text: "測試" }, { text: "甲" }] })).toBe("測試甲")
    expect(cellToString({ text: "a@example.test", hyperlink: "mailto:a@example.test" })).toBe("a@example.test")
    expect(cellToString({ formula: "A1", result: 12 })).toBe("12")
    expect(cellToString(12)).toBe("12")
    expect(cellToString(null)).toBe("")
  })

  it("憑證格與登入網址判斷", () => {
    expect(isCredentialText("帳號 test 密碼 test")).toBe(true)
    expect(isCredentialText("id: test01")).toBe(true)
    expect(isCredentialText("測試 0900-000-000")).toBe(false)
    expect(looksLikeLoginUrl("http://10.0.0.1:8080/login")).toBe(true)
    expect(looksLikeLoginUrl("https://www.example.test")).toBe(false)
  })

  it("統編：7 碼補前導 0、其他形狀不收", () => {
    expect(normalizeTaxId("4595257")).toBe("04595257")
    expect(normalizeTaxId("12345675")).toBe("12345675")
    expect(normalizeTaxId("12345675／87654321")).toBeNull()
  })

  it("sheetToRows：找表頭列、跳過空列、不認得的工作表回空", () => {
    const grid = [[""], ["簡稱", "序", "類    別", "TEL"], ["測試甲", "1", "廠商", "(00)0000-0000"], ["", "", "", ""], ["測試乙", "", "", ""]]
    const rows = sheetToRows("new", "技師資料", grid)
    expect(rows.map((r) => [r.rowNumber, r.kind, r.cells["簡稱"]])).toEqual([[3, "engineer", "測試甲"], [5, "engineer", "測試乙"]])
    expect(rows[0].cells["類別"]).toBe("廠商")
    expect(sheetToRows("new", "Sheet1", grid)).toEqual([])
  })
})

describe("備註重組", () => {
  it("移除已確認搬進欄位的匯入行、保留說明行與標記行；Excel 備註放最前面", () => {
    const note = ["傳真：(00)0000-0001", "主要窗口補充：分機 12；手機 0900-000-000", "備註：測試備註", "網址（非官網，未放 website）：http://10.0.0.1:8080/x", "人工補充：下次改用匯款", MARK].join("\n")
    const cells = { fax: "(00)0000-0001", 承辦窗口: "測試窗口#12", mobil: "測試 0900-000-000", 備註: "測試備註" }
    const r = rebuildNote(note, cells, "測試備註")
    expect(r.note).toBe(["測試備註", "網址（非官網，未放 website）：http://10.0.0.1:8080/x", "人工補充：下次改用匯款", MARK].join("\n"))
    expect(r).toMatchObject({ removed: 3, kept: 2, remarkAdded: true })
  })

  it("對不上 Excel 原格的行不刪（可能是人工改過）", () => {
    const r = rebuildNote(["傳真：(00)9999-9999", MARK].join("\n"), { fax: "(00)0000-0001" }, null)
    expect(r.note).toBe(["傳真：(00)9999-9999", MARK].join("\n"))
    expect(r.removed).toBe(0)
  })
})

describe("planRosterMigration — 比對與欄位", () => {
  it("沒人改過的廠商：Excel 欄位全部照原格填、名冊類別＝工作表、職稱重複清掉、備註只留標記", () => {
    const db = vendor({
      id: "v1", name: "測試冷凍空調技師事務所", short_name: "測試技甲", category: "技師／空調", title: "測試技師/負責人",
      contact_name: "測試甲", phone: "(00)0000-0000", note: ["傳真：(00)0000-0001", MARK].join("\n"),
    })
    const plan = planRosterMigration({
      rows: [row({ sheet: "技師資料", kind: "engineer", cells: {
        簡稱: "測試技甲", 序: "1", 類別: "空調", 細目: "測試技師/負責人", 公司名稱: "測試冷凍空調技師事務所",
        tel: "(00)0000-0000", fax: "(00)0000-0001", 承辦窗口: "空調技師_測試甲", 統編: "4595257",
      } })],
      vendors: [db], clients: [],
    })
    expect(plan.matched).toEqual({ vendors: 1, clients: 0 })
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].set).toEqual({
      roster_kind: "engineer", seq: 1, category: "空調", sub_category: "測試技師/負責人", fax: "(00)0000-0001",
      contact_name: "空調技師_測試甲", tax_id: "04595257", title: null, note: MARK,
    })
  })

  it("匯入後有人改過：只補空欄位，值不同的欄位列衝突、不覆蓋", () => {
    const db = vendor({ id: "v2", name: "測試廠商乙", short_name: "測乙", category: "廠商／消防", phone: "(00)1234-5678", updated_at: LATER })
    const plan = planRosterMigration({
      rows: [row({ cells: { 簡稱: "測乙", 類別: "廠商", 細目: "消防", 公司名稱: "測試廠商乙", tel: "(00)0000-0000", fax: "(00)0000-0001" } })],
      vendors: [db], clients: [],
    })
    expect(plan.editedAfterImport).toEqual([{ table: "vendors", id: "v2" }])
    expect(plan.updates[0].set).toMatchObject({ sub_category: "消防", fax: "(00)0000-0001" })
    expect(plan.updates[0].set).not.toHaveProperty("phone")
    expect(plan.updates[0].set).not.toHaveProperty("category")
    expect(plan.conflicts.map((c) => c.column).sort()).toEqual(["category", "phone"])
  })

  it("憑證格不讀不寫（該欄維持原值）、登入網址不放進網址欄", () => {
    const db = vendor({ id: "v3", name: "測試廠商丙", mobile: "0900-000-000" })
    const plan = planRosterMigration({
      rows: [row({ cells: { 公司名稱: "測試廠商丙", mobil: "id: test01", 網址: "http://10.0.0.1:8080/x", 備註: "帳號 test 密碼 test" } })],
      vendors: [db], clients: [],
    })
    expect(plan.skippedCredentialCells).toBe(2)
    expect(plan.skippedLoginUrls).toBe(1)
    const set = plan.updates[0]?.set ?? {}
    expect(set).not.toHaveProperty("mobile")
    expect(set).not.toHaveProperty("website")
    expect(JSON.stringify(plan)).not.toContain("test01")
    expect(JSON.stringify(plan)).not.toContain("密碼")
  })

  it("舊版列只補舊版欄位（新版才有的欄位不清空）、只對「舊版匯入」的記錄", () => {
    const db = vendor({ id: "v4", name: "測試廠商丁", note: MARK_OLD, tax_id: "12345675", payment_terms: null })
    const plan = planRosterMigration({
      rows: [row({ file: "old", headers: OLD_HEADERS, cells: { 簡稱: "測丁", 類別: "廠商", 公司名稱: "測試廠商丁", fax: "(00)0000-0002" } })],
      vendors: [db], clients: [],
    })
    expect(plan.matched.vendors).toBe(1)
    expect(plan.updates[0].set).toEqual({ roster_kind: "supplier", short_name: "測丁", category: "廠商", fax: "(00)0000-0002" })
  })

  it("沒有匯入標記的記錄不碰；Excel 有、系統沒有的列另列；缺名稱的列略過；不新增記錄", () => {
    const manual = vendor({ id: "v5", name: "測試廠商戊", note: "人工建的" })
    const plan = planRosterMigration({
      rows: [row({ cells: { 公司名稱: "測試廠商戊" } }), row({ rowNumber: 9, cells: { 類別: "雜項" } })],
      vendors: [manual], clients: [],
    })
    expect(plan.updates).toEqual([])
    expect(plan.unmatchedExcel).toEqual([{ file: "new", sheet: "供應商資料", rowNumber: 3 }])
    expect(plan.namelessRows).toBe(1)
  })

  it("兩筆記錄同分（重複）→ 列入「需人工看」，兩筆都不動", () => {
    const plan = planRosterMigration({
      rows: [row({ cells: { 簡稱: "測重", 公司名稱: "測試重複廠商" } })],
      vendors: [vendor({ id: "a", name: "測試重複廠商", short_name: "測重" }), vendor({ id: "b", name: "測試重複廠商", short_name: "測重" })],
      clients: [],
    })
    expect(plan.ambiguousExcel).toHaveLength(1)
    expect(plan.updates).toEqual([])
    expect(plan.unmatchedDb.map((d) => d.id).sort()).toEqual(["a", "b"])
  })

  it("客戶：序／區域／編號／Mobil／公司地址；統編要過檢查碼且不重複，不合格維持現值", () => {
    const c1 = client({ id: "c1", name: "測試設計有限公司", short_name: "測設", note: ["區域：測試市", MARK].join("\n") })
    const c2 = client({ id: "c2", name: "測試建設股份有限公司", tax_id: null })
    const other = client({ id: "c3", name: "人工客戶", note: null, tax_id: "12345675" })
    const plan = planRosterMigration({
      rows: [
        row({ sheet: "客戶資料", kind: "client", headers: CLIENT_HEADERS, cells: { 簡稱: "測設", 序: "2", 區域: "測試市", 公司名稱: "測試設計有限公司", mobil: "0900-111-111", 公司地址: "測試市測試路 1 號", 統編: "12345678" } }),
        row({ sheet: "客戶資料", kind: "client", headers: CLIENT_HEADERS, rowNumber: 4, cells: { 公司名稱: "測試建設股份有限公司", 統編: "12345675", 收款方式: "支票" } }),
      ],
      vendors: [], clients: [c1, c2, other],
    })
    const byId = Object.fromEntries(plan.updates.map((u) => [u.id, u.set]))
    expect(byId.c1).toEqual({ seq: 2, region: "測試市", contact_phone: "0900-111-111", invoice_address: "測試市測試路 1 號", note: MARK })
    expect(byId.c2).toEqual({ payment_method: "check" })
    expect(plan.rejected).toEqual([
      { table: "clients", id: "c1", column: "tax_id", reason: "invalid_tax_id" },
      { table: "clients", id: "c2", column: "tax_id", reason: "tax_id_taken" },
    ])
  })

  it("摘要只有筆數與欄位名；SQL 計畫以 updated_at 做樂觀鎖、單引號跳脫", () => {
    const db = vendor({ id: "v6", name: "測試廠商己" })
    const plan = planRosterMigration({ rows: [row({ cells: { 公司名稱: "測試廠商己", 付款方式: "月結 O'Neil" } })], vendors: [db], clients: [] })
    const summary = summarizePlan(plan)
    expect(summary.fieldCounts).toEqual({ "vendors.payment_terms": 1, "vendors.roster_kind": 1 })
    expect(JSON.stringify(summary)).not.toContain("O'Neil")
    const sql = planToSql(plan)
    expect(sql).toContain("payment_terms = '月結 O''Neil'")
    expect(sql).toContain(`updated_at = '${AT}'::timestamptz`)
    expect(sql).toContain("GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION")
  })
})

describe("備註只在欄位最終值等於 Excel 原格時才刪", () => {
  it("匯入後改過、FAX 衝突沒覆蓋 → 「傳真」行保留", () => {
    const db = vendor({ id: "n1", name: "測試廠商庚", fax: "(00)9999-9999", updated_at: LATER, note: ["傳真：(00)0000-0001", MARK].join("\n") })
    const plan = planRosterMigration({ rows: [row({ cells: { 公司名稱: "測試廠商庚", fax: "(00)0000-0001" } })], vendors: [db], clients: [] })
    expect(plan.conflicts).toContainEqual({ table: "vendors", id: "n1", column: "fax" })
    expect(plan.updates[0]?.set ?? {}).not.toHaveProperty("note")
  })

  it("沒人改過、FAX 照寫 → 同一行就刪", () => {
    const db = vendor({ id: "n2", name: "測試廠商庚", note: ["傳真：(00)0000-0001", MARK].join("\n") })
    const plan = planRosterMigration({ rows: [row({ cells: { 公司名稱: "測試廠商庚", fax: "(00)0000-0001" } })], vendors: [db], clients: [] })
    expect(plan.updates[0].set).toMatchObject({ fax: "(00)0000-0001", note: MARK })
  })

  it("收款方式對應不到（不是匯款／支票）→ 被拒寫，「收款方式」行保留", () => {
    const c = client({ id: "n3", name: "測試客戶辛", note: ["收款方式：月結三十天", MARK].join("\n") })
    const plan = planRosterMigration({
      rows: [row({ sheet: "客戶資料", kind: "client", headers: CLIENT_HEADERS, cells: { 公司名稱: "測試客戶辛", 收款方式: "月結三十天" } })],
      vendors: [], clients: [c],
    })
    expect(plan.rejected).toContainEqual({ table: "clients", id: "n3", column: "payment_method", reason: "unknown_payment_method" })
    expect(plan.updates[0]?.set ?? {}).not.toHaveProperty("note")
  })

  it("付款方式超長 → 被拒寫，「付款方式」行保留", () => {
    const long = "月結".repeat(51)
    const db = vendor({ id: "n4", name: "測試廠商壬", note: [`付款方式：${long}`, MARK].join("\n") })
    const plan = planRosterMigration({ rows: [row({ cells: { 公司名稱: "測試廠商壬", 付款方式: long } })], vendors: [db], clients: [] })
    expect(plan.rejected).toContainEqual({ table: "vendors", id: "n4", column: "payment_terms", reason: "too_long" })
    expect(plan.updates[0]?.set ?? {}).not.toHaveProperty("note")
    expect(plan.updates[0]?.set ?? {}).not.toHaveProperty("payment_terms")
  })

  it("憑證格略過 → 依賴它的窗口行保留", () => {
    const db = vendor({ id: "n5", name: "測試廠商癸", note: ["Mobil原文（未能完整拆解）：0900-000-000", MARK].join("\n") })
    const plan = planRosterMigration({ rows: [row({ cells: { 公司名稱: "測試廠商癸", mobil: "0900-000-000 id: test01" } })], vendors: [db], clients: [] })
    expect(plan.skippedCredentialCells).toBe(1)
    expect(plan.updates[0]?.set ?? {}).not.toHaveProperty("note")
  })
})

describe("租戶範圍與補建新版列", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222"

  it("只處理指定租戶：別租戶同名記錄不比對、不更新", () => {
    const plan = planRosterMigration(
      { rows: [row({ cells: { 公司名稱: "測試廠商子" } })], vendors: [vendor({ id: "x1", name: "測試廠商子", tenant_id: OTHER })], clients: [] },
      { tenantId: T },
    )
    expect(plan.updates).toEqual([])
    expect(plan.unmatchedExcel).toHaveLength(1)
  })

  it("新版沒對到的列 → INSERT（帶匯入標記、拒寫原格進備註、憑證不寫）；舊版沒對到的列不新增", () => {
    const plan = planRosterMigration(
      {
        rows: [
          row({ cells: { 簡稱: "測丑", 類別: "廠商", 細目: "消防", 公司名稱: "測試廠商丑", fax: "(00)0000-0003", mobil: "id: test01", 備註: "測試新增備註" } }),
          row({ sheet: "客戶資料", kind: "client", headers: CLIENT_HEADERS, rowNumber: 5, cells: { 公司名稱: "測試客戶寅", 統編: "12345675／87654321", 區域: "測試市" } }),
          row({ file: "old", headers: OLD_HEADERS, rowNumber: 7, cells: { 公司名稱: "測試舊廠商卯" } }),
        ],
        vendors: [], clients: [],
      },
      { tenantId: T, insertUnmatchedNew: true, insertMarker: "〔測試補建〕" },
    )
    expect(plan.inserts).toHaveLength(2)
    const v = plan.inserts.find((i) => i.table === "vendors")!
    expect(v.values).toEqual({
      roster_kind: "supplier", short_name: "測丑", category: "廠商", sub_category: "消防", name: "測試廠商丑", fax: "(00)0000-0003",
      note: "測試新增備註\n〔測試補建〕", source: "manual",
    })
    const c = plan.inserts.find((i) => i.table === "clients")!
    expect(c.values).toEqual({ region: "測試市", name: "測試客戶寅", note: "統編（Excel 原格，未寫入欄位）：12345675／87654321\n〔測試補建〕" })
    expect(plan.unmatchedExcel.filter((r) => r.file === "old")).toHaveLength(1)
    const sql = planToSql(plan)
    expect(sql).toContain("INSERT INTO public.vendors (tenant_id, roster_kind")
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM public.clients WHERE tenant_id = '11111111-1111-4111-8111-111111111111' AND name = '測試客戶寅' AND deleted_at IS NULL)")
    expect(sql).toContain("RAISE EXCEPTION 'already_exists")
    expect(sql).not.toContain("test01")
    expect(summarizePlan(plan).toInsert).toEqual({ vendors: 1, clients: 1 })
  })

  it("要補建卻沒給租戶 → 直接報錯", () => {
    expect(() => planRosterMigration({ rows: [], vendors: [], clients: [] }, { insertUnmatchedNew: true })).toThrow()
  })
})
