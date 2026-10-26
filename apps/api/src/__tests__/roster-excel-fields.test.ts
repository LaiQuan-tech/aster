import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clientsRouter, resetClientSchemaCompatForTests } from "../routes/clients.js"
import { vendorsRouter, resetVendorSchemaCompatForTests } from "../routes/vendors.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 2026-10-27 名冊欄位對齊 Excel「客供商基本資料」（packages/db 0076）：
 *   廠商：名冊類別 rosterKind（工作表）、序 seq、細目 subCategory、編號 code、FAX fax、付款方式 paymentTerms；
 *   客戶：序 seq、區域 region、編號 code；承辦窗口／電話類欄位放寬長度（Excel 原格是整段文字）。
 * 權限沿用：廠商名冊全租戶可寫、客戶名冊會計以上可寫、刪除都限 HR。0076 沒套時：帶非空新欄位回 409。
 * ⚠️ 全部是明顯的假資料。
 */
const app = express()
app.use(express.json())
app.use(clientsRouter)
app.use(vendorsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const ACCOUNTANT_TOKEN = "accountant-user"
const STAFF_TOKEN = "staff-user"
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const VENDOR_A = "bbbbbbbb-0000-4000-8000-00000000000a"
const VENDOR_B = "bbbbbbbb-0000-4000-8000-00000000000b"

beforeEach(() => {
  fake.reset()
  resetVendorSchemaCompatForTests()
  resetClientSchemaCompatForTests()
  fake.db.employees = [
    { id: "cccccccc-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000003", tenant_id: TENANT_ID, user_id: ACCOUNTANT_TOKEN, role: "accountant", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000004", tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.clients = [
    { id: CLIENT_A, tenant_id: TENANT_ID, name: "測試客戶甲", short_name: null, tax_id: null, is_affiliate: false, seq: null, region: null, code: null, deleted_at: null },
  ]
  fake.db.vendors = [
    {
      id: VENDOR_A, tenant_id: TENANT_ID, name: "測試廠商甲", short_name: "甲", source: "manual", is_affiliate: false,
      roster_kind: "engineer", seq: 3, category: "空調", sub_category: "測試細目", code: "X1", fax: "(00)0000-0000", payment_terms: "月結", deleted_at: null,
    },
    // 0076 剛套、資料搬遷前的舊列：roster_kind 不是合法值時一律當 supplier
    { id: VENDOR_B, tenant_id: TENANT_ID, name: "測試廠商乙", short_name: null, source: "manual", is_affiliate: false, roster_kind: null, deleted_at: null },
  ]
})

const writes = (table: string, action: "insert" | "update") => fake.writes.filter((w) => w.table === table && w.action === action)

describe("廠商名冊：Excel 新欄位讀寫", () => {
  it("GET 回新欄位；roster_kind 缺值／非法值當 supplier", async () => {
    const res = await as(STAFF_TOKEN, request(app).get("/vendors"))
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.vendors as Array<{ id: string }>).map((v) => [v.id, v]))
    expect(byId[VENDOR_A]).toMatchObject({ rosterKind: "engineer", seq: 3, category: "空調", subCategory: "測試細目", code: "X1", fax: "(00)0000-0000", paymentTerms: "月結" })
    expect(byId[VENDOR_B]).toMatchObject({ rosterKind: "supplier", seq: null, subCategory: null, code: null, fax: null, paymentTerms: null })
  })

  it("POST 存新欄位（trim、空字串視為清除），回應帶回", async () => {
    const res = await as(STAFF_TOKEN, request(app).post("/vendors")).send({
      name: "測試送審單位丙", rosterKind: "review_unit", seq: 7, category: "電力", subCategory: "  測試細目丙 ", code: "", fax: "(00)1111-1111", paymentTerms: "現金",
    })
    expect(res.status).toBe(201)
    expect(res.body.vendor).toMatchObject({ rosterKind: "review_unit", seq: 7, subCategory: "測試細目丙", code: null, fax: "(00)1111-1111", paymentTerms: "現金" })
    expect(writes("vendors", "insert")[0]?.payload).toMatchObject({
      roster_kind: "review_unit", seq: 7, category: "電力", sub_category: "測試細目丙", code: null, fax: "(00)1111-1111", payment_terms: "現金",
    })
  })

  it("PATCH 只改新欄位：update 只帶那幾欄（與 updated_at）", async () => {
    const res = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_B}`)).send({ rosterKind: "engineer", seq: 12, subCategory: "測試技師細目" })
    expect(res.status).toBe(200)
    expect(Object.keys(writes("vendors", "update")[0]?.payload as object).sort()).toEqual(["roster_kind", "seq", "sub_category", "updated_at"])
    expect(res.body.vendor).toMatchObject({ rosterKind: "engineer", seq: 12, subCategory: "測試技師細目" })
  })

  it("承辦窗口 300 字、TEL／FAX／Mobil 200 字可存（Excel 原格整段文字）；超過回 400", async () => {
    const ok = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({
      contactName: "窗".repeat(300), phone: "1".repeat(200), fax: "2".repeat(200), mobile: "3".repeat(200), email: "e".repeat(500),
    })
    expect(ok.status).toBe(200)
    for (const body of [{ contactName: "窗".repeat(301) }, { phone: "1".repeat(201) }, { fax: "2".repeat(201) }, { mobile: "3".repeat(201) }, { email: "e".repeat(501) }]) {
      const bad = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send(body)
      expect(bad.status).toBe(400)
    }
  })

  it.each([
    ["名冊類別不在清單", { rosterKind: "client" }],
    ["名冊類別給 null（DB NOT NULL）", { rosterKind: null }],
    ["序是小數", { seq: 1.5 }],
    ["序是負數", { seq: -1 }],
    ["序是字串", { seq: "3" }],
    ["細目超過 60 字", { subCategory: "細".repeat(61) }],
    ["編號超過 40 字", { code: "X".repeat(41) }],
    ["付款方式超過 100 字", { paymentTerms: "付".repeat(101) }],
  ])("%s → 400 invalid_body，不寫入", async (_label, body) => {
    const res = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
    expect(writes("vendors", "update")).toHaveLength(0)
  })

  it("權限沿用：一般員工可改名冊欄位，但刪除限 HR", async () => {
    const del = await as(STAFF_TOKEN, request(app).delete(`/vendors/${VENDOR_A}`))
    expect(del.status).toBe(403)
    const hrDel = await as(HR_TOKEN, request(app).delete(`/vendors/${VENDOR_A}`))
    expect(hrDel.status).toBe(200)
  })

  it("搜尋多比對細目 sub_category", async () => {
    const res = await as(STAFF_TOKEN, request(app).get("/vendors")).query({ q: "測試細目" })
    expect(res.status).toBe(200)
    expect(fake.orFilters.at(-1)).toContain("sub_category.ilike.%測試細目%")
    expect((res.body.vendors as Array<{ id: string }>).map((v) => v.id)).toEqual([VENDOR_A])
  })
})

describe("廠商名冊：0076 沒套", () => {
  const missing = { code: "42703", message: "column vendors.roster_kind does not exist" }

  it("GET：第一次撞 42703 退回舊欄位集，列表照常（新欄位為預設值）", async () => {
    fake.injectError({ table: "vendors", action: "select", error: missing })
    const res = await as(STAFF_TOKEN, request(app).get("/vendors"))
    expect(res.status).toBe(200)
    expect(res.body.vendors).toHaveLength(2)
    for (const v of res.body.vendors as Array<{ rosterKind: string; seq: unknown }>) {
      expect(v.rosterKind).toBe("supplier")
      expect(v.seq).toBeNull()
    }
  })

  it("POST 帶非空新欄位 → 409 migration_required，不寫入", async () => {
    fake.injectError({ table: "vendors", action: "insert", error: { code: "PGRST204", message: "Could not find the 'roster_kind' column" } })
    const res = await as(STAFF_TOKEN, request(app).post("/vendors")).send({ name: "測試廠商丁", seq: 1, fax: "(00)2222-2222" })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "migration_required", columns: ["seq", "fax"] })
    expect(writes("vendors", "insert")).toHaveLength(0)
  })

  it("POST 新欄位全空 → 照常建立，寫入不帶新欄位", async () => {
    fake.injectError({ table: "vendors", action: "insert", error: { code: "PGRST204", message: "Could not find the 'roster_kind' column" } })
    const res = await as(STAFF_TOKEN, request(app).post("/vendors")).send({ name: "測試廠商戊", seq: null, subCategory: "", code: null })
    expect(res.status).toBe(201)
    const payload = writes("vendors", "insert")[0]?.payload as Record<string, unknown>
    for (const col of ["roster_kind", "seq", "sub_category", "code", "fax", "payment_terms"]) expect(payload).not.toHaveProperty(col)
  })

  it("記住沒套之後，PATCH 帶非空新欄位直接 409（不打 DB），只改舊欄位照常", async () => {
    fake.injectError({ table: "vendors", action: "select", error: missing })
    await as(STAFF_TOKEN, request(app).get("/vendors"))
    const blocked = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({ paymentTerms: "月結" })
    expect(blocked.status).toBe(409)
    expect(writes("vendors", "update")).toHaveLength(0)
    const ok = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({ phone: "(00)3333-3333", paymentTerms: null })
    expect(ok.status).toBe(200)
    expect(Object.keys(writes("vendors", "update")[0]?.payload as object).sort()).toEqual(["phone", "updated_at"])
  })
})

describe("客戶名冊：Excel 新欄位讀寫", () => {
  it("會計可新增／修改序、區域、編號，回應與列表帶回", async () => {
    const created = await as(ACCOUNTANT_TOKEN, request(app).post("/clients")).send({
      name: "測試客戶乙", seq: 5, region: "測試區", code: "T0001", contactName: "窗".repeat(300), contactPhone: "9".repeat(200), fax: "8".repeat(200),
    })
    expect(created.status).toBe(201)
    expect(created.body.client).toMatchObject({ seq: 5, region: "測試區", code: "T0001" })
    expect(writes("clients", "insert")[0]?.payload).toMatchObject({ seq: 5, region: "測試區", code: "T0001" })

    const patched = await as(ACCOUNTANT_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send({ region: " 測試市 ", code: "" })
    expect(patched.status).toBe(200)
    expect(Object.keys(writes("clients", "update")[0]?.payload as object).sort()).toEqual(["code", "region", "updated_at"])
    expect(patched.body.client).toMatchObject({ region: "測試市", code: null })

    const list = await as(STAFF_TOKEN, request(app).get("/clients"))
    expect(list.status).toBe(200)
    expect(list.body.clients).toEqual(expect.arrayContaining([expect.objectContaining({ id: CLIENT_A, region: "測試市", code: null, seq: null })]))
  })

  it("一般員工不能改客戶名冊（403）；會計不能刪（限 HR）", async () => {
    const staff = await as(STAFF_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send({ region: "測試區" })
    expect(staff.status).toBe(403)
    const accDel = await as(ACCOUNTANT_TOKEN, request(app).delete(`/clients/${CLIENT_A}`))
    expect(accDel.status).toBe(403)
    expect(writes("clients", "update")).toHaveLength(0)
  })

  it.each([
    ["序是小數", { seq: 2.5 }],
    ["區域超過 40 字", { region: "區".repeat(41) }],
    ["承辦窗口超過 300 字", { contactName: "窗".repeat(301) }],
    ["Mobil 超過 200 字", { contactPhone: "9".repeat(201) }],
  ])("%s → 400", async (_label, body) => {
    const res = await as(HR_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send(body)
    expect(res.status).toBe(400)
    expect(writes("clients", "update")).toHaveLength(0)
  })

  it("0076 沒套：列表退回舊欄位集；帶非空新欄位 409，不寫入", async () => {
    fake.injectError({ table: "clients", action: "select", error: { code: "42703", message: "column clients.region does not exist" } })
    const list = await as(STAFF_TOKEN, request(app).get("/clients"))
    expect(list.status).toBe(200)
    expect(list.body.clients[0]).toMatchObject({ id: CLIENT_A, seq: null, region: null, code: null })

    const blocked = await as(HR_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send({ region: "測試區" })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ error: "migration_required", columns: ["region"] })
    expect(writes("clients", "update")).toHaveLength(0)

    const ok = await as(HR_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send({ phone: "(00)4444-4444", region: null })
    expect(ok.status).toBe(200)
    expect(Object.keys(writes("clients", "update")[0]?.payload as object).sort()).toEqual(["phone", "updated_at"])
  })
})
