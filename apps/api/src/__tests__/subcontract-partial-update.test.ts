import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../lib/schema-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/schema-compat.js")>()
  return {
    ...actual,
    columnsExist: async (table: string, columns: string) =>
      table === "project_subcontracts" && columns.includes("invoice_no") ? true : actual.columnsExist(table, columns),
  }
})

import { subcontractsRouter } from "../routes/subcontracts.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 整批 PUT /projects/:id/subcontracts 的「部分更新」語意（2026-11-16）：
 * - 更新既有列：沒帶（undefined）的欄位不送、保留 DB 原值；帶 null＝清空。
 *   （代扣率／起扣門檻例外：null 也視為沒帶，見 subcontract-withholding-default.test.ts）
 * - kind 沒帶不改類型；0089 欄位（代扣日期／發票）依 DB 現有 kind 決定寫哪組。
 * - kind 有變：照舊清掉不相關的那組。
 * - 新建、前端完整 payload：寫入內容與改前完全一致。
 * ⚠️ 名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(subcontractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const HR_EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const PROJECT_ID = "dddddddd-0000-4000-8000-000000000001"
const VENDOR_ID = "dddddddd-0000-4000-8000-0000000000f1"
const VENDOR_ID_2 = "dddddddd-0000-4000-8000-0000000000f2"
const CONTRACT_ID = "dddddddd-0000-4000-8000-0000000000c1"
const SUB_FIRM = "dddddddd-0000-4000-8000-0000000000b1"
const SUB_PLAIN = "dddddddd-0000-4000-8000-0000000000b2"

const firmRow = (): Row => ({
  id: SUB_FIRM, tenant_id: TENANT_ID, project_id: PROJECT_ID, kind: "firm", discipline: "測試專業別",
  vendor_id: VENDOR_ID, vendor_name: "測試事務所", contact: "測試聯絡人", item: "測試項目", amount: 100000,
  billing_basis: "測試計費依據", order_type: "contract", contract_id: CONTRACT_ID,
  withholding_rate: "0.1", withholding_threshold: 20000,
  withholding_date: "2026-11-01", invoice_no: null, invoice_date: null,
  sort_order: 0, note: "測試備註", deleted_at: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
})
const plainRow = (): Row => ({
  id: SUB_PLAIN, tenant_id: TENANT_ID, project_id: PROJECT_ID, kind: "subcontract", discipline: null,
  vendor_id: null, vendor_name: "測試廠商", contact: null, item: null, amount: 30000,
  billing_basis: null, order_type: null, contract_id: null,
  withholding_rate: "0", withholding_threshold: 20000,
  withholding_date: null, invoice_no: "TEST-0001", invoice_date: "2026-10-15",
  sort_order: 1, note: "測試備註二", deleted_at: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
})

const rowOf = (id: string) => fake.db.project_subcontracts?.find((r) => r.id === id) as Row
const put = (items: Row[]) =>
  request(app).put(`/projects/${PROJECT_ID}/subcontracts`).set("Authorization", `Bearer ${HR_TOKEN}`).send({ subcontracts: items })
const updatePayloadFor = (id: string) =>
  // 依 fake 記下的命中 id 對回（不靠寫入順序）。
  fake.writes.find(
    (x) => x.table === "project_subcontracts" && x.action === "update" && (x.payload as Row).amount != null && x.ids?.includes(id),
  )?.payload as Row
const subWrites = () => fake.writes.filter((x) => x.table === "project_subcontracts")

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: HR_EMP_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
  fake.db.projects = [{ id: PROJECT_ID, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null }]
  fake.db.project_members = []
  fake.db.vendors = [{ id: VENDOR_ID, tenant_id: TENANT_ID, name: "測試事務所", deleted_at: null }]
  fake.db.contracts = [{ id: CONTRACT_ID, tenant_id: TENANT_ID, project_id: PROJECT_ID, deleted_at: null }]
  fake.db.companies = []
  fake.db.project_subcontract_payments = []
  fake.db.project_subcontracts = [firmRow(), plainRow()]
})

describe("副委託整批 PUT：更新既有列只寫有帶的欄位", () => {
  it("只送 {id, amount} → kind、代扣日期、代扣率、專業別、備註、合約、廠商等全部保留", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 120000 },
      { id: SUB_PLAIN, amount: 35000 },
    ])
    expect(res.status).toBe(200)
    const { updated_at: _u1, amount: _a1, ...firmRest } = firmRow()
    expect(rowOf(SUB_FIRM)).toMatchObject({ ...firmRest, amount: 120000 })
    const { updated_at: _u2, amount: _a2, ...plainRest } = plainRow()
    expect(rowOf(SUB_PLAIN)).toMatchObject({ ...plainRest, amount: 35000 })
    // 沒帶的欄不出現在 update 裡（不是「送原值」，是根本不送）；只剩 amount、updated_at，
    // 以及依 DB 現有 kind「另一組」0089 欄位的 null（事務所→發票、其他→代扣日期；與 kind 不變時的現行行為相同）。
    expect(Object.keys(updatePayloadFor(SUB_FIRM)).sort()).toEqual(["amount", "invoice_date", "invoice_no", "updated_at"])
    expect(Object.keys(updatePayloadFor(SUB_PLAIN)).sort()).toEqual(["amount", "updated_at", "withholding_date"])
  })

  it("明確送 null → 清空（備註、專業別、合約、代扣日期、聯絡人），kind 仍是事務所", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, note: null, discipline: null, contractId: null, withholdingDate: null, contact: null },
      { id: SUB_PLAIN, amount: 30000, invoiceNo: null },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({
      kind: "firm", note: null, discipline: null, contract_id: null, withholding_date: null, contact: null,
      item: "測試項目", vendor_name: "測試事務所", withholding_rate: "0.1",
    })
    expect(rowOf(SUB_PLAIN)).toMatchObject({ kind: "subcontract", invoice_no: null, invoice_date: "2026-10-15", note: "測試備註二" })
  })

  it("kind 改變 → 照現行清理：事務所→下包清代扣日期、下包→事務所清發票；其他沒帶的仍保留", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, kind: "subcontract" },
      { id: SUB_PLAIN, amount: 30000, kind: "firm", withholdingDate: "2026-12-01" },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({
      kind: "subcontract", withholding_date: null, invoice_no: null, invoice_date: null,
      discipline: "測試專業別", note: "測試備註", contract_id: CONTRACT_ID, withholding_rate: "0.1",
    })
    expect(rowOf(SUB_PLAIN)).toMatchObject({
      kind: "firm", withholding_date: "2026-12-01", invoice_no: null, invoice_date: null, note: "測試備註二",
    })
  })

  it("kind 沒帶時依 DB 現有 kind 決定 0089 欄位：事務所列送代扣日期、下包列送發票都會寫入", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, withholdingDate: "2026-11-20" },
      { id: SUB_PLAIN, amount: 30000, invoiceNo: "TEST-0002" },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ kind: "firm", withholding_date: "2026-11-20", invoice_no: null })
    expect(rowOf(SUB_PLAIN)).toMatchObject({ kind: "subcontract", invoice_no: "TEST-0002", withholding_date: null })
  })

  it("事務所列送 invoiceNo 但沒帶 kind → 400 field_not_applicable，DB 不變", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, invoiceNo: "TEST-9999" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "field_not_applicable", id: SUB_FIRM })
    expect(subWrites()).toHaveLength(0)
    expect(rowOf(SUB_FIRM)).toEqual(firmRow())
  })

  it("非事務所列送 withholdingDate 但沒帶 kind → 400 field_not_applicable，DB 不變", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000, withholdingDate: "2026-11-20" },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "field_not_applicable", id: SUB_PLAIN, field: "withholdingDate" })
    expect(subWrites()).toHaveLength(0)
    expect(rowOf(SUB_PLAIN)).toEqual(plainRow())
  })

  it("只送不同的 vendorName、沒送 vendorId → 400 vendor_id_required，DB 完全不變", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorName: "測試另一家事務所" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "vendor_id_required", id: SUB_FIRM })
    expect(res.body.message).toContain("vendorId")
    expect(subWrites()).toHaveLength(0)
    expect(rowOf(SUB_FIRM)).toEqual(firmRow())
    expect(rowOf(SUB_PLAIN)).toEqual(plainRow())
  })

  it("只送相同的 vendorName（前後空白不計）→ 成功，vendor_id／vendor_name 都不寫", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorName: "  測試事務所 " },
      { id: SUB_PLAIN, amount: 30000, vendorName: "測試廠商" },
    ])
    expect(res.status).toBe(200)
    expect(updatePayloadFor(SUB_FIRM)).not.toHaveProperty("vendor_name")
    expect(updatePayloadFor(SUB_FIRM)).not.toHaveProperty("vendor_id")
    expect(updatePayloadFor(SUB_PLAIN)).not.toHaveProperty("vendor_name")
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID, vendor_name: "測試事務所" })
  })

  it("只送不同的 vendorId、沒送 vendorName → 400 vendor_name_required（避免顯示舊名、匯給新廠商）", async () => {
    fake.db.vendors!.push({ id: VENDOR_ID_2, tenant_id: TENANT_ID, name: "測試另一家事務所", deleted_at: null })
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID_2 },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "vendor_name_required", id: SUB_FIRM })
    expect(subWrites()).toHaveLength(0)
    expect(rowOf(SUB_FIRM)).toEqual(firmRow())
  })

  it("同時送 vendorId＋vendorName → 兩欄一起改", async () => {
    fake.db.vendors!.push({ id: VENDOR_ID_2, tenant_id: TENANT_ID, name: "測試另一家事務所", deleted_at: null })
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID_2, vendorName: "測試另一家事務所", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID_2, vendor_name: "測試另一家事務所", kind: "firm" })
  })

  it("送 vendorId: null＋新 vendorName → 清掉 vendor_id、改名（非登錄廠商）", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: null, vendorName: "測試臨時廠商", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: null, vendor_name: "測試臨時廠商" })
  })

  it("前端副委託卡的完整 payload → update 內容與改前完全相同", async () => {
    // SubcontractsCard.saveSubcontracts 的形狀（含 0089 那組、另一組送 null）。
    const res = await put([
      {
        id: SUB_FIRM, kind: "firm", discipline: "測試專業別", vendorId: VENDOR_ID, vendorName: "測試事務所",
        contact: "測試聯絡人", item: "測試項目", amount: 110000, billingBasis: "測試計費依據", orderType: "contract",
        contractId: CONTRACT_ID, sortOrder: 0, withholdingRate: 0.1, withholdingThreshold: 20000,
        withholdingDate: "2026-11-01", invoiceNo: null, invoiceDate: null, note: "測試備註",
      },
      {
        id: SUB_PLAIN, kind: "subcontract", discipline: null, vendorId: null, vendorName: "測試廠商",
        contact: null, item: null, amount: 30000, billingBasis: null, orderType: null,
        contractId: null, sortOrder: 1, withholdingRate: 0, withholdingThreshold: 20000,
        withholdingDate: null, invoiceNo: "TEST-0001", invoiceDate: "2026-10-15", note: null,
      },
    ])
    expect(res.status).toBe(200)
    const { updated_at: u1, ...firmSent } = updatePayloadFor(SUB_FIRM)
    expect(typeof u1).toBe("string")
    expect(firmSent).toEqual({
      kind: "firm", discipline: "測試專業別", vendor_id: VENDOR_ID, vendor_name: "測試事務所", contact: "測試聯絡人",
      item: "測試項目", amount: 110000, billing_basis: "測試計費依據", order_type: "contract", contract_id: CONTRACT_ID,
      withholding_rate: 0.1, withholding_threshold: 20000, sort_order: 0, note: "測試備註",
      withholding_date: "2026-11-01", invoice_no: null, invoice_date: null,
    })
    const { updated_at: _u2, ...plainSent } = updatePayloadFor(SUB_PLAIN)
    expect(plainSent).toEqual({
      kind: "subcontract", discipline: null, vendor_id: null, vendor_name: "測試廠商", contact: null,
      item: null, amount: 30000, billing_basis: null, order_type: null, contract_id: null,
      withholding_rate: 0, withholding_threshold: 20000, sort_order: 1, note: null,
      withholding_date: null, invoice_no: "TEST-0001", invoice_date: "2026-10-15",
    })
  })

  it("申請單整張表的 payload（不帶 0089 三欄）→ update 內容與改前相同、代扣日期與發票保留", async () => {
    // project-application-sheet-save.ts subPayloadOf 的形狀。
    const res = await put([
      {
        id: SUB_FIRM, kind: "firm", discipline: "測試專業別", vendorId: VENDOR_ID, vendorName: "測試事務所",
        contact: "測試聯絡人", item: "測試項目", amount: 100000, billingBasis: "測試計費依據", orderType: "contract",
        contractId: CONTRACT_ID, withholdingRate: 0.1, withholdingThreshold: 20000, sortOrder: 0, note: "測試備註",
      },
      {
        id: SUB_PLAIN, kind: "subcontract", discipline: null, vendorId: null, vendorName: "測試廠商",
        contact: null, item: null, amount: 30000, billingBasis: null, orderType: null,
        contractId: null, withholdingRate: 0, withholdingThreshold: 20000, sortOrder: 1, note: "測試備註二",
      },
    ])
    expect(res.status).toBe(200)
    const { updated_at: _u1, ...firmSent } = updatePayloadFor(SUB_FIRM)
    expect(firmSent).toEqual({
      kind: "firm", discipline: "測試專業別", vendor_id: VENDOR_ID, vendor_name: "測試事務所", contact: "測試聯絡人",
      item: "測試項目", amount: 100000, billing_basis: "測試計費依據", order_type: "contract", contract_id: CONTRACT_ID,
      withholding_rate: 0.1, withholding_threshold: 20000, sort_order: 0, note: "測試備註",
      invoice_no: null, invoice_date: null,
    })
    const { updated_at: _u2, ...plainSent } = updatePayloadFor(SUB_PLAIN)
    expect(plainSent).toEqual({
      kind: "subcontract", discipline: null, vendor_id: null, vendor_name: "測試廠商", contact: null,
      item: null, amount: 30000, billing_basis: null, order_type: null, contract_id: null,
      withholding_rate: 0, withholding_threshold: 20000, sort_order: 1, note: "測試備註二",
      withholding_date: null,
    })
    expect(rowOf(SUB_FIRM)).toMatchObject({ withholding_date: "2026-11-01" })
    expect(rowOf(SUB_PLAIN)).toMatchObject({ invoice_no: "TEST-0001", invoice_date: "2026-10-15" })
  })

  it("新建列沒帶的欄位照舊補預設（kind→subcontract、其他→null、sort_order→位置）", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000 },
      { amount: 5000 },
    ])
    expect(res.status).toBe(200)
    const ins = fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "insert")
    expect(ins).toHaveLength(1)
    const { updated_at: _u, tenant_id: _t, project_id: _p, created_by_emp_id: _c, ...sent } = ins[0].payload as Row
    expect(sent).toEqual({
      kind: "subcontract", discipline: null, vendor_id: null, vendor_name: null, contact: null, item: null,
      amount: 5000, billing_basis: null, order_type: null, contract_id: null,
      withholding_rate: 0, withholding_threshold: 20000, sort_order: 2, note: null,
      withholding_date: null,
    })
  })
})

describe("副委託整批 PUT：vendorId 與 vendorName 必須是名冊上同一家（2026-11-16）", () => {
  const addVendor2 = () =>
    fake.db.vendors!.push({ id: VENDOR_ID_2, tenant_id: TENANT_ID, name: "測試乙廠商", deleted_at: null })

  it("vendorId 不變、改成別的名稱 → 400 vendor_name_mismatch，0 寫入", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID, vendorName: "測試乙廠商" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "vendor_name_mismatch", id: SUB_FIRM, vendorId: VENDOR_ID })
    expect(res.body.message).toBe("廠商名稱與登錄廠商不符，請使用名冊上的名稱或改為非登錄廠商（vendorId: null）")
    expect(fake.writes).toHaveLength(0)
    expect(rowOf(SUB_FIRM)).toEqual(firmRow())
  })

  it("換 vendorId 但配舊名 → 400 vendor_name_mismatch", async () => {
    addVendor2()
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID_2, vendorName: "測試事務所", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "vendor_name_mismatch", id: SUB_FIRM })
    expect(fake.writes).toHaveLength(0)
  })

  it("換 vendorId 配名冊名稱（前後空白不計）→ 200", async () => {
    addVendor2()
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID_2, vendorName: " 測試乙廠商  ", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID_2, vendor_name: "測試乙廠商" })
  })

  it("新建列 vendorId＋錯名 → 400；vendorId＋正確名 → 200", async () => {
    addVendor2()
    const bad = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000 },
      { amount: 5000, vendorId: VENDOR_ID_2, vendorName: "測試事務所" },
    ])
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: "vendor_name_mismatch", id: null, vendorId: VENDOR_ID_2 })
    expect(fake.writes).toHaveLength(0)

    const ok = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000 },
      { amount: 5000, vendorId: VENDOR_ID_2, vendorName: "測試乙廠商" },
    ])
    expect(ok.status).toBe(200)
    const ins = fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "insert")
    expect(ins[0].payload).toMatchObject({ vendor_id: VENDOR_ID_2, vendor_name: "測試乙廠商" })
  })

  it("新建列 vendorId 但沒帶 vendorName → 400 vendor_name_mismatch", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000 },
      { amount: 5000, vendorId: VENDOR_ID },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "vendor_name_mismatch" })
    expect(fake.writes).toHaveLength(0)
  })

  it("vendorId: null＋任意名稱（既有列與新建列）→ 200", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: null, vendorName: "測試隨便一家", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000, vendorId: null, vendorName: "測試另一個名字" },
      { amount: 5000, vendorId: null, vendorName: "測試新的臨時廠商" },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: null, vendor_name: "測試隨便一家" })
    expect(rowOf(SUB_PLAIN)).toMatchObject({ vendor_id: null, vendor_name: "測試另一個名字" })
  })

  it("vendorId 不在本租戶名冊（或已刪除）→ 400 invalid_vendor", async () => {
    fake.db.vendors!.push({ id: VENDOR_ID_2, tenant_id: TENANT_ID, name: "測試乙廠商", deleted_at: "2026-11-01T00:00:00.000Z" })
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID_2, vendorName: "測試乙廠商", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "invalid_vendor", vendorId: VENDOR_ID_2 })
    expect(fake.writes).toHaveLength(0)
  })

  it("廠商後來在名冊改名、整列原樣重存（副委託卡完整 payload）→ 200，不比對", async () => {
    fake.db.vendors![0].name = "測試事務所（新名）"
    const res = await put([
      {
        id: SUB_FIRM, kind: "firm", discipline: "測試專業別", vendorId: VENDOR_ID, vendorName: "測試事務所",
        contact: "測試聯絡人", item: "測試項目", amount: 110000, billingBasis: "測試計費依據", orderType: "contract",
        contractId: CONTRACT_ID, sortOrder: 0, withholdingRate: 0.1, withholdingThreshold: 20000,
        withholdingDate: "2026-11-01", invoiceNo: null, invoiceDate: null, note: "測試備註",
      },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID, vendor_name: "測試事務所", amount: 110000 })
  })

  it("大寫 uuid 視為同一家：不誤判為換廠商、寫入轉小寫", async () => {
    fake.db.vendors![0].name = "測試事務所（新名）"
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID.toUpperCase(), vendorName: "測試事務所" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID, vendor_name: "測試事務所" })
  })

  it("大寫 uuid 換廠商配名冊名 → 200；只送大寫 vendorId 不送名稱且未換 → 不擋", async () => {
    addVendor2()
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID.toUpperCase() },
      { id: SUB_PLAIN, amount: 30000, vendorId: VENDOR_ID_2.toUpperCase(), vendorName: "測試乙廠商" },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID })
    expect(rowOf(SUB_PLAIN)).toMatchObject({ vendor_id: VENDOR_ID_2, vendor_name: "測試乙廠商" })
  })

  it("整批第二列被擋 → 第一列未更新、未列出的列未軟刪、期款未重算（0 寫入）", async () => {
    const SUB_EXTRA = "dddddddd-0000-4000-8000-0000000000b3"
    fake.db.project_subcontracts!.push({ ...plainRow(), id: SUB_EXTRA, vendor_name: "測試丙廠商", sort_order: 2 })
    fake.db.project_subcontract_payments = [
      {
        id: "dddddddd-0000-4000-8000-0000000000e1", tenant_id: TENANT_ID, subcontract_id: SUB_PLAIN, installment_no: 1,
        percentage: 100, amount: 30000, withheld_amount: 0, paid_on: null, paid_amount: null, deleted_at: null,
      },
    ]
    const res = await request(app)
      .put(`/projects/${PROJECT_ID}/subcontracts`)
      .set("Authorization", `Bearer ${HR_TOKEN}`)
      .send({
        deleteReason: "測試移除理由",
        subcontracts: [
          { id: SUB_PLAIN, amount: 45000 },
          { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID, vendorName: "測試乙廠商" },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "vendor_name_mismatch", id: SUB_FIRM })
    expect(fake.writes).toHaveLength(0)
    expect(rowOf(SUB_PLAIN)).toEqual(plainRow())
    expect(rowOf(SUB_EXTRA)).toMatchObject({ deleted_at: null })
    expect(fake.db.project_subcontract_payments[0]).toMatchObject({ amount: 30000 })
  })

  it("申請單整張表：發包單位改成名冊上的名稱（前端依名稱配到 vendorId）→ 200", async () => {
    addVendor2()
    // project-application-sheet-save.ts：vendorName 經 textOrNull（trim）後與 ctx.vendors 的 name 完全相同才配 vendorId。
    const res = await put([
      {
        id: SUB_FIRM, kind: "firm", discipline: "測試專業別", vendorId: VENDOR_ID_2, vendorName: "測試乙廠商",
        contact: "測試聯絡人", item: "測試項目", amount: 100000, billingBasis: "測試計費依據", orderType: "contract",
        contractId: CONTRACT_ID, withholdingRate: 0.1, withholdingThreshold: 20000, sortOrder: 0, note: "測試備註",
        rebindReason: "測試：改由乙施作",
      },
      {
        id: SUB_PLAIN, kind: "subcontract", discipline: null, vendorId: null, vendorName: "測試名冊外廠商",
        contact: null, item: null, amount: 30000, billingBasis: null, orderType: null,
        contractId: null, withholdingRate: 0, withholdingThreshold: 20000, sortOrder: 1, note: "測試備註二",
      },
    ])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID_2, vendor_name: "測試乙廠商" })
    expect(rowOf(SUB_PLAIN)).toMatchObject({ vendor_id: null, vendor_name: "測試名冊外廠商" })
  })

  it("新建列沒帶 kind 送代扣日期 → 400 field_not_applicable（業主接受的現狀）", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000 },
      { amount: 5000, withholdingDate: "2026-11-20" },
    ])
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "field_not_applicable", id: null, field: "withholdingDate" })
    expect(fake.writes).toHaveLength(0)
  })
})

describe("R1a：副委託已有放款單分攤時不可換廠商（2026-11-16）", () => {
  const DISB_ID = "eeeeeeee-0000-4000-8000-000000000001"
  const PAY_ID = "dddddddd-0000-4000-8000-0000000000e1"
  const seed = (status: string) => {
    fake.db.vendors!.push({ id: VENDOR_ID_2, tenant_id: TENANT_ID, name: "測試另一家事務所", deleted_at: null })
    fake.db.disbursements = [{ id: DISB_ID, tenant_id: TENANT_ID, status }]
    fake.db.disbursement_allocations = [
      { id: "ffffffff-0000-4000-8000-000000000001", tenant_id: TENANT_ID, disbursement_id: DISB_ID, subcontract_id: SUB_FIRM, subcontract_payment_id: PAY_ID },
    ]
  }
  const changeVendor = () =>
    put([
      { id: SUB_FIRM, amount: 100000, vendorId: VENDOR_ID_2, vendorName: "測試另一家事務所", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])

  it("草稿／送簽中／已核准／已匯款的放款單分攤到這筆 → 換廠商 409 has_disbursement，DB 不變", async () => {
    for (const status of ["draft", "pending_approval", "approved", "paid"]) {
      fake.reset()
      fake.db.employees = [{ id: HR_EMP_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
      fake.db.projects = [{ id: PROJECT_ID, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null }]
      fake.db.project_members = []
      fake.db.vendors = [{ id: VENDOR_ID, tenant_id: TENANT_ID, name: "測試事務所", deleted_at: null }]
      fake.db.contracts = [{ id: CONTRACT_ID, tenant_id: TENANT_ID, project_id: PROJECT_ID, deleted_at: null }]
      fake.db.companies = []
      fake.db.project_subcontract_payments = []
      fake.db.project_subcontracts = [firmRow(), plainRow()]
      seed(status)
      const res = await changeVendor()
      expect(res.status, status).toBe(409)
      expect(res.body).toMatchObject({ error: "has_disbursement", subcontractId: SUB_FIRM, message: "此副委託已有放款單，請先作廢相關放款單再更換廠商" })
      expect(subWrites()).toHaveLength(0)
      expect(rowOf(SUB_FIRM)).toEqual(firmRow())
    }
  })

  it("改成非登錄廠商（vendorId: null）也擋", async () => {
    seed("draft")
    const res = await put([
      { id: SUB_FIRM, amount: 100000, vendorId: null, vendorName: "測試臨時廠商", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("has_disbursement")
  })

  it("放款單已作廢 → 可換廠商；廠商沒變（只改金額）→ 不擋", async () => {
    seed("void")
    expect((await changeVendor()).status).toBe(200)
    fake.db.disbursements = [{ id: DISB_ID, tenant_id: TENANT_ID, status: "draft" }]
    const same = await put([
      { id: SUB_FIRM, amount: 110000, vendorId: VENDOR_ID_2, vendorName: "測試另一家事務所", rebindReason: "測試原因" },
      { id: SUB_PLAIN, amount: 30000 },
    ])
    expect(same.status).toBe(200)
  })

  it("舊格式分攤列只有 subcontract_payment_id（subcontract_id 為 null）→ 透過期款找到副委託，換廠商也 409", async () => {
    seed("draft")
    fake.db.project_subcontract_payments = [{ id: PAY_ID, tenant_id: TENANT_ID, subcontract_id: SUB_FIRM, installment_no: 1, paid_on: null }]
    fake.db.disbursement_allocations = [
      { id: "ffffffff-0000-4000-8000-000000000002", tenant_id: TENANT_ID, disbursement_id: DISB_ID, subcontract_id: null, subcontract_payment_id: PAY_ID },
    ]
    const res = await changeVendor()
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "has_disbursement", subcontractId: SUB_FIRM })
    expect(subWrites()).toHaveLength(0)
    fake.db.disbursements = [{ id: DISB_ID, tenant_id: TENANT_ID, status: "void" }]
    expect((await changeVendor()).status).toBe(200)
  })
})

describe("第五輪 #4（2026-11-17）：非登錄副委託不可與名冊廠商同名", () => {
  const VENDOR_SAME = "dddddddd-0000-4000-8000-0000000000f9"
  beforeEach(() => {
    // 名冊有一家與既有非登錄列「測試廠商」同名（加公司後綴）的廠商；第六輪起簡稱（key≥3）也參與比對。
    fake.db.vendors!.push({ id: VENDOR_SAME, tenant_id: TENANT_ID, name: "測試廠商股份有限公司", short_name: "測試簡稱行", deleted_at: null })
  })
  const mustBind = { error: "must_bind_vendor" }

  it("新建非登錄列名稱＝名冊廠商名稱（含標點變體）→ 409 must_bind_vendor、0 寫入；差後綴 → 409 vendor_name_similar", async () => {
    for (const vendorName of ["(股)測試事務所", "測試廠商"]) {
      fake.writes.length = 0
      const res = await put([
        { id: SUB_FIRM, amount: 100000 },
        { id: SUB_PLAIN, amount: 30000 },
        { amount: 5000, vendorId: null, vendorName },
      ])
      expect(res.status, vendorName).toBe(409)
      expect(res.body, vendorName).toMatchObject({ error: "vendor_name_similar", id: null, index: 2, vendorName })
      expect(res.body.message).toContain("若是不同公司請填寫說明")
      expect(fake.writes).toHaveLength(0)
    }
    for (const vendorName of ["測試事務所", "測試事務所.", "測試-事務所", "測試 事務所"]) {
      fake.writes.length = 0
      const res = await put([
        { id: SUB_FIRM, amount: 100000 },
        { id: SUB_PLAIN, amount: 30000 },
        { amount: 5000, vendorId: null, vendorName },
      ])
      expect(res.status, vendorName).toBe(409)
      expect(res.body, vendorName).toMatchObject({ ...mustBind, id: null, index: 2, vendorName })
      expect(typeof res.body.matchedVendorName).toBe("string")
      expect(res.body.message).toBe(`「${vendorName}」與名冊廠商「${res.body.matchedVendorName}」名稱相同，請在下拉選擇該廠商`)
      expect(fake.writes).toHaveLength(0)
    }
    // 沒送 vendorId 的新建列一樣算非登錄
    const noId = await put([{ id: SUB_FIRM, amount: 100000 }, { id: SUB_PLAIN, amount: 30000 }, { amount: 5000, vendorName: "測試事務所" }])
    expect(noId.status).toBe(409)
  })

  it("既有非登錄列改名成名冊廠商名稱 → 409；既有登錄列解除綁定（名稱不變）→ 409", async () => {
    const rename = await put([{ id: SUB_FIRM, amount: 100000 }, { id: SUB_PLAIN, amount: 30000, vendorId: null, vendorName: "測試事務所" }])
    expect(rename.status).toBe(409)
    expect(rename.body).toMatchObject({ ...mustBind, id: SUB_PLAIN })
    const unbind = await put([{ id: SUB_FIRM, amount: 100000, vendorId: null, vendorName: "測試事務所", rebindReason: "測試原因" }, { id: SUB_PLAIN, amount: 30000 }])
    expect(unbind.status).toBe(409)
    expect(unbind.body).toMatchObject({ ...mustBind, id: SUB_FIRM })
    expect(rowOf(SUB_FIRM)).toMatchObject({ vendor_id: VENDOR_ID })
  })

  it("既有非登錄同名列未改名、原樣存檔（含完整 payload）→ 200", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 35000, vendorId: null, vendorName: "測試廠商" },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(SUB_PLAIN)).toMatchObject({ vendor_id: null, vendor_name: "測試廠商", amount: 35000 })
  })

  it("選名冊廠商（綁 vendorId）、不同名稱 → 200", async () => {
    const res = await put([
      { id: SUB_FIRM, amount: 100000 },
      { id: SUB_PLAIN, amount: 30000 },
      { amount: 5000, vendorId: VENDOR_SAME, vendorName: "測試廠商股份有限公司" },
      { amount: 6000, vendorId: null, vendorName: "測試全新臨時廠商" },
    ])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("第六輪第 2 項：比對範圍同放款端——簡稱（key≥3）、帳戶戶名也算；回 matchedVendorName", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_SAME ? { ...v, account_holder: "測試戶名王小明" } : v))
    for (const vendorName of ["測試簡稱行", "測試戶名王小明"]) {
      const res = await put([{ id: SUB_FIRM, amount: 100000 }, { id: SUB_PLAIN, amount: 30000 }, { amount: 7000, vendorId: null, vendorName }])
      expect(res.status, vendorName).toBe(409)
      expect(res.body).toMatchObject({ error: "must_bind_vendor", matchedVendorName: "測試廠商股份有限公司", vendorName, index: 2 })
    }
    // 簡稱 key < 3 字不比
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VENDOR_SAME ? { ...v, short_name: "測簡" } : v))
    const short = await put([{ id: SUB_FIRM, amount: 100000 }, { id: SUB_PLAIN, amount: 30000 }, { amount: 7000, vendorId: null, vendorName: "測簡" }])
    expect(short.status).toBe(200)
  })
})
