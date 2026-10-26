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
 * 權限：廠商、客戶名冊都是會計以上可寫（2026-10-27 起廠商也收窄）、刪除都限 HR。0076 沒套時：帶非空新欄位回 409。
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
    const res = await as(ACCOUNTANT_TOKEN, request(app).post("/vendors")).send({
      name: "測試送審單位丙", rosterKind: "review_unit", seq: 7, category: "電力", subCategory: "  測試細目丙 ", code: "", fax: "(00)1111-1111", paymentTerms: "現金",
    })
    expect(res.status).toBe(201)
    expect(res.body.vendor).toMatchObject({ rosterKind: "review_unit", seq: 7, subCategory: "測試細目丙", code: null, fax: "(00)1111-1111", paymentTerms: "現金" })
    expect(writes("vendors", "insert")[0]?.payload).toMatchObject({
      roster_kind: "review_unit", seq: 7, category: "電力", sub_category: "測試細目丙", code: null, fax: "(00)1111-1111", payment_terms: "現金",
    })
  })

  it("PATCH 只改新欄位：update 只帶那幾欄（與 updated_at）", async () => {
    const res = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_B}`)).send({ rosterKind: "engineer", seq: 12, subCategory: "測試技師細目" })
    expect(res.status).toBe(200)
    expect(Object.keys(writes("vendors", "update")[0]?.payload as object).sort()).toEqual(["roster_kind", "seq", "sub_category", "updated_at"])
    expect(res.body.vendor).toMatchObject({ rosterKind: "engineer", seq: 12, subCategory: "測試技師細目" })
  })

  it("承辦窗口 300 字、TEL／FAX／Mobil 200 字可存（Excel 原格整段文字）；超過回 400", async () => {
    const ok = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({
      contactName: "窗".repeat(300), phone: "1".repeat(200), fax: "2".repeat(200), mobile: "3".repeat(200), email: "e".repeat(500),
    })
    expect(ok.status).toBe(200)
    for (const body of [{ contactName: "窗".repeat(301) }, { phone: "1".repeat(201) }, { fax: "2".repeat(201) }, { mobile: "3".repeat(201) }, { email: "e".repeat(501) }]) {
      const bad = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send(body)
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
    const res = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send(body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
    expect(writes("vendors", "update")).toHaveLength(0)
  })

  it("權限（2026-10-27 業主決定）：新增／修改／名片辨識限會計與 HR，一般員工只能讀（403、不寫入）", async () => {
    const list = await as(STAFF_TOKEN, request(app).get("/vendors"))
    expect(list.status).toBe(200)
    const post = await as(STAFF_TOKEN, request(app).post("/vendors")).send({ name: "測試廠商員工建" })
    expect(post.status).toBe(403)
    const patch = await as(STAFF_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({ phone: "(00)6666-6666" })
    expect(patch.status).toBe(403)
    const scan = await as(STAFF_TOKEN, request(app).post("/vendors/card-scan")).send({ fileName: "a.png", contentType: "image/png", dataBase64: "AA==" })
    expect(scan.status).toBe(403)
    expect(writes("vendors", "insert")).toHaveLength(0)
    expect(writes("vendors", "update")).toHaveLength(0)
  })

  it.each([["會計", ACCOUNTANT_TOKEN], ["HR", HR_TOKEN]])("%s可新增與修改廠商（201／200）", async (_label, token) => {
    const post = await as(token, request(app).post("/vendors")).send({ name: `測試廠商${_label}建`, rosterKind: "engineer" })
    expect(post.status).toBe(201)
    const patch = await as(token, request(app).patch(`/vendors/${VENDOR_A}`)).send({ paymentTerms: "現金" })
    expect(patch.status).toBe(200)
  })

  it("刪除限 HR：會計 403、HR 200", async () => {
    const accDel = await as(ACCOUNTANT_TOKEN, request(app).delete(`/vendors/${VENDOR_A}`))
    expect(accDel.status).toBe(403)
    const staffDel = await as(STAFF_TOKEN, request(app).delete(`/vendors/${VENDOR_A}`))
    expect(staffDel.status).toBe(403)
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

describe("廠商收款帳戶只給會計與 HR（2026-10-27 業主決定）", () => {
  const bank = { bank_name: "測試銀行", bank_code: "000", bank_account: "0000-0000-0000", account_holder: "測試戶名" }
  beforeEach(() => {
    fake.db.vendors = fake.db.vendors.map((v) => (v.id === VENDOR_A ? { ...v, ...bank } : v))
  })
  const bankOf = (res: request.Response) => {
    const v = (res.body.vendors as Array<Record<string, unknown>>).find((x) => x.id === VENDOR_A)!
    return { bankName: v.bankName, bankCode: v.bankCode, bankAccount: v.bankAccount, accountHolder: v.accountHolder }
  }

  it("一般員工讀列表：銀行四欄為 null，其他欄位照常", async () => {
    const res = await as(STAFF_TOKEN, request(app).get("/vendors"))
    expect(res.status).toBe(200)
    expect(bankOf(res)).toEqual({ bankName: null, bankCode: null, bankAccount: null, accountHolder: null })
    expect((res.body.vendors as Array<{ id: string; name: string }>).find((x) => x.id === VENDOR_A)?.name).toBe("測試廠商甲")
    expect(JSON.stringify(res.body)).not.toContain("0000-0000-0000")
  })

  it("沒有員工列（查無此人）也遮", async () => {
    const res = await as("nobody-user", request(app).get("/vendors"))
    expect(res.status).toBe(200)
    expect(bankOf(res).bankAccount).toBeNull()
  })

  it.each([["會計", ACCOUNTANT_TOKEN], ["HR", HR_TOKEN]])("%s讀列表：銀行四欄有值", async (_label, token) => {
    const res = await as(token, request(app).get("/vendors"))
    expect(bankOf(res)).toEqual({ bankName: "測試銀行", bankCode: "000", bankAccount: "0000-0000-0000", accountHolder: "測試戶名" })
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
    const res = await as(ACCOUNTANT_TOKEN, request(app).post("/vendors")).send({ name: "測試廠商丁", seq: 1, fax: "(00)2222-2222" })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "migration_required", columns: ["seq", "fax"] })
    expect(writes("vendors", "insert")).toHaveLength(0)
  })

  it("表單永遠帶 rosterKind：等於預設 supplier 視為沒帶（照常建立）；技師等非預設值才 409", async () => {
    fake.injectError({ table: "vendors", action: "select", error: missing })
    await as(STAFF_TOKEN, request(app).get("/vendors"))
    const ok = await as(ACCOUNTANT_TOKEN, request(app).post("/vendors")).send({ name: "測試廠商己", rosterKind: "supplier", seq: null })
    expect(ok.status).toBe(201)
    expect(writes("vendors", "insert")[0]?.payload).not.toHaveProperty("roster_kind")
    const patched = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({ rosterKind: "supplier", phone: "(00)5555-5555" })
    expect(patched.status).toBe(200)
    const blocked = await as(ACCOUNTANT_TOKEN, request(app).post("/vendors")).send({ name: "測試技師庚", rosterKind: "engineer" })
    expect(blocked.status).toBe(409)
    expect(blocked.body.columns).toEqual(["roster_kind"])
  })

  it("POST 新欄位全空 → 照常建立，寫入不帶新欄位", async () => {
    fake.injectError({ table: "vendors", action: "insert", error: { code: "PGRST204", message: "Could not find the 'roster_kind' column" } })
    const res = await as(ACCOUNTANT_TOKEN, request(app).post("/vendors")).send({ name: "測試廠商戊", seq: null, subCategory: "", code: null })
    expect(res.status).toBe(201)
    const payload = writes("vendors", "insert")[0]?.payload as Record<string, unknown>
    for (const col of ["roster_kind", "seq", "sub_category", "code", "fax", "payment_terms"]) expect(payload).not.toHaveProperty(col)
  })

  it("記住沒套之後，PATCH 帶非空新欄位直接 409（不打 DB），只改舊欄位照常", async () => {
    fake.injectError({ table: "vendors", action: "select", error: missing })
    await as(STAFF_TOKEN, request(app).get("/vendors"))
    const blocked = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({ paymentTerms: "月結" })
    expect(blocked.status).toBe(409)
    expect(writes("vendors", "update")).toHaveLength(0)
    const ok = await as(ACCOUNTANT_TOKEN, request(app).patch(`/vendors/${VENDOR_A}`)).send({ phone: "(00)3333-3333", paymentTerms: null })
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

describe("客戶統編允許重複（migration 0078）：存檔照常、回應附提示", () => {
  const TAX = "12345675"
  beforeEach(() => {
    fake.db.clients.push({ id: "aaaaaaaa-0000-4000-8000-0000000000b1", tenant_id: TENANT_ID, name: "測試成甲企業股份有限公司", short_name: null, tax_id: TAX, is_affiliate: false, deleted_at: null })
    fake.db.clients.push({ id: "aaaaaaaa-0000-4000-8000-0000000000b2", tenant_id: TENANT_ID, name: "已刪的同統編客戶", short_name: null, tax_id: TAX, is_affiliate: false, deleted_at: "2026-10-01T00:00:00Z" })
  })

  it("POST 同統編 → 201、統編照存，warnings 列出同統編的其他客戶（不含已軟刪）", async () => {
    const res = await as(ACCOUNTANT_TOKEN, request(app).post("/clients")).send({ name: "測試成甲室內設計", taxId: TAX })
    expect(res.status).toBe(201)
    expect(res.body.client.taxId).toBe(TAX)
    expect(writes("clients", "insert")[0]?.payload).toMatchObject({ tax_id: TAX })
    expect(res.body.warnings).toEqual([{ code: "tax_id_shared", taxId: TAX, clients: [{ id: "aaaaaaaa-0000-4000-8000-0000000000b1", name: "測試成甲企業股份有限公司" }] }])
  })

  it("PATCH 改成同統編 → 200 帶提示；只改別的欄位不提示；統編不重複也不提示", async () => {
    const res = await as(HR_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send({ taxId: TAX })
    expect(res.status).toBe(200)
    expect(res.body.warnings?.[0]?.clients.map((c: { name: string }) => c.name)).toEqual(["測試成甲企業股份有限公司"])
    const other = await as(HR_TOKEN, request(app).patch(`/clients/${CLIENT_A}`)).send({ region: "測試區" })
    expect(other.status).toBe(200)
    expect(other.body).not.toHaveProperty("warnings")
    const unique = await as(HR_TOKEN, request(app).post("/clients")).send({ name: "測試獨立客戶", taxId: "04595257" })
    expect(unique.status).toBe(201)
    expect(unique.body).not.toHaveProperty("warnings")
  })

  it("0078 還沒套（DB 唯一索引仍在，撞 23505）→ 照舊 409 tax_id_taken", async () => {
    fake.injectError({ table: "clients", action: "insert", error: { code: "23505", message: "duplicate key value violates unique constraint \"clients_tenant_tax_id_uq\"" } })
    const res = await as(HR_TOKEN, request(app).post("/clients")).send({ name: "測試成甲室內設計", taxId: TAX })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("tax_id_taken")
  })
})

