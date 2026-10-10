import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { companiesRouter } from "../routes/companies.js"
import {
  findInactiveDefault,
  firstNewlyPickedInactive,
  loadCompanyUsage,
  resolveFinalFlags,
} from "../services/company-lifecycle.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 公司主體生命週期（2026-10-10）：沒被用過的可以刪除、用過的改停用、預設公司不能停用。
 * 路由層（GET／PUT／DELETE /companies）＋純函式；寫入端擋停用公司在 companies-inactive-guard.test.ts。
 * ⚠️ 公司名、統編都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(companiesRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const ACCOUNTANT_TOKEN = "accountant-user"
const STAFF_TOKEN = "staff-user"

const C_DEFAULT = "cccccccc-0000-4000-8000-000000000001"
const C_SECOND = "cccccccc-0000-4000-8000-000000000002"
const C_USED = "cccccccc-0000-4000-8000-000000000003"
const C_INACTIVE = "cccccccc-0000-4000-8000-000000000004"
const C_OTHER_TENANT = "cccccccc-0000-4000-8000-000000000099"

const NAME_DEFAULT = "測試設計顧問公司"
const NAME_SECOND = "測試工程公司"
const NAME_USED = "測試營造公司"
const NAME_INACTIVE = "測試停用公司"

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function company(over: Row): Row {
  return {
    tenant_id: TENANT_ID,
    tax_id: null,
    bank_name: null,
    bank_account: null,
    is_default: false,
    is_active: true,
    note: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  }
}

const stored = (id: string) => fake.db.companies?.find((row) => row.id === id)
const companyWrites = () => fake.writes.filter((write) => write.table === "companies")
const companyDeletes = () => companyWrites().filter((write) => write.action === "delete")
const auditRows = () => fake.writes.filter((write) => write.table === "audit_logs").map((write) => write.payload as Row)

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000003", tenant_id: TENANT_ID, user_id: ACCOUNTANT_TOKEN, role: "accountant", dept_id: null },
  ]
  fake.db.companies = [
    company({ id: C_DEFAULT, name: NAME_DEFAULT, is_default: true }),
    company({ id: C_SECOND, name: NAME_SECOND }),
    company({ id: C_USED, name: NAME_USED }),
    company({ id: C_INACTIVE, name: NAME_INACTIVE, is_active: false }),
    company({ id: C_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true }),
  ]
  fake.db.projects = []
  fake.db.disbursements = []
  fake.db.project_subcontract_payments = []
  // 仿 DB 的 CHECK companies_default_active_chk（is_active OR NOT is_default）：
  // 寫入順序不對、中途讓某列同時「預設＋停用」時，整句失敗（23514），測試就會抓到。
  fake.checks.companies = (row) =>
    row.is_active === false && row.is_default === true ? 'violates check constraint "companies_default_active_chk"' : null
})

/** 把 C_USED 掛上各式各樣的引用（含已封存／軟刪／作廢、同一列兩個欄位都指到它）。 */
function seedUsageOfC_USED() {
  fake.db.projects = [
    { id: "dddddddd-0000-4000-8000-000000000001", tenant_id: TENANT_ID, company_id: C_USED },
    // 已封存＋已軟刪的專案：外鍵照樣擋，使用量要算。
    { id: "dddddddd-0000-4000-8000-000000000002", tenant_id: TENANT_ID, company_id: C_USED, archived_at: "2026-09-01T00:00:00.000Z", deleted_at: "2026-09-02T00:00:00.000Z" },
    { id: "dddddddd-0000-4000-8000-000000000003", tenant_id: TENANT_ID, company_id: null },
  ]
  fake.db.disbursements = [
    // 付款公司與收據抬頭都是 C_USED：同一張單只算一筆。
    { id: "eeeeeeee-0000-4000-8000-000000000001", tenant_id: TENANT_ID, status: "paid", paying_company_id: C_USED, receipt_issuer_company_id: C_USED },
    // 作廢的單，只有收據抬頭指到 C_USED：照算。
    { id: "eeeeeeee-0000-4000-8000-000000000002", tenant_id: TENANT_ID, status: "void", paying_company_id: C_DEFAULT, receipt_issuer_company_id: C_USED },
    { id: "eeeeeeee-0000-4000-8000-000000000003", tenant_id: TENANT_ID, status: "draft", paying_company_id: C_USED, receipt_issuer_company_id: null },
  ]
  fake.db.project_subcontract_payments = [
    { id: "ffffffff-0000-4000-8000-000000000001", tenant_id: TENANT_ID, paying_company_id: C_USED, receipt_issuer_company_id: null },
    { id: "ffffffff-0000-4000-8000-000000000002", tenant_id: TENANT_ID, paying_company_id: null, receipt_issuer_company_id: C_USED },
    { id: "ffffffff-0000-4000-8000-000000000003", tenant_id: TENANT_ID, paying_company_id: C_USED, receipt_issuer_company_id: C_USED },
  ]
}

describe("GET /companies — isActive 與使用量", () => {
  it("每筆帶 isActive 與 usage：已封存／軟刪／作廢的列照算，同一列兩個欄位指到同一間只算一筆", async () => {
    seedUsageOfC_USED()

    const res = await as(STAFF_TOKEN, request(app).get("/companies"))

    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.companies as Row[]).map((c) => [c.id, c]))
    expect(Object.keys(byId).sort()).toEqual([C_DEFAULT, C_SECOND, C_USED, C_INACTIVE].sort()) // 別租戶的不出現
    expect(byId[C_USED].usage).toEqual({ projects: 2, disbursements: 3, subcontractPayments: 3, total: 8 })
    expect(byId[C_DEFAULT].usage).toEqual({ projects: 0, disbursements: 1, subcontractPayments: 0, total: 1 })
    expect(byId[C_SECOND].usage).toEqual({ projects: 0, disbursements: 0, subcontractPayments: 0, total: 0 })
    expect(byId[C_DEFAULT]).toMatchObject({ isDefault: true, isActive: true })
    expect(byId[C_INACTIVE]).toMatchObject({ isDefault: false, isActive: false })
  })

  it("使用量是批次查：每個外鍵欄位一組查詢，不隨公司數增加（不是每間公司各打 5 次）", async () => {
    seedUsageOfC_USED()

    const res = await as(STAFF_TOKEN, request(app).get("/companies"))

    expect(res.status).toBe(200)
    expect(res.body.companies).toHaveLength(4)
    const reads = (table: string) => fake.reads.filter((name) => name === table).length
    expect(reads("companies")).toBe(1)
    expect(reads("projects")).toBe(1) // company_id
    expect(reads("disbursements")).toBe(2) // paying_company_id／receipt_issuer_company_id
    expect(reads("project_subcontract_payments")).toBe(2)
  })

  it("超過 PostgREST 單頁 1000 列也數得準：後面頁的公司不會被誤判成沒被用過", async () => {
    // C_USED 佔滿第一頁（id 排序在前）；C_SECOND 只有一筆，排在第二頁。
    const pad = (n: number) => String(n).padStart(12, "0")
    fake.db.projects = [
      ...Array.from({ length: 1000 }, (_, i) => ({ id: `aaaaaaaa-0000-4000-8000-${pad(i)}`, tenant_id: TENANT_ID, company_id: C_USED })),
      { id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, company_id: C_SECOND },
    ]

    const usage = await loadCompanyUsage(TENANT_ID, [C_USED, C_SECOND, C_DEFAULT])

    expect(usage.get(C_USED)).toMatchObject({ projects: 1000, total: 1000 })
    expect(usage.get(C_SECOND)).toMatchObject({ projects: 1, total: 1 })
    expect(usage.get(C_DEFAULT)).toMatchObject({ projects: 0, total: 0 })
    expect(fake.reads.filter((name) => name === "projects")).toHaveLength(2)
  })

  it("某張來源表還沒套用（PGRST205）：那個來源算 0，名冊照樣讀得出來；其他錯誤不吞（500）", async () => {
    seedUsageOfC_USED()
    const missing = { code: "PGRST205", message: "Could not find the table 'public.disbursements' in the schema cache" }
    fake.injectError({ table: "disbursements", action: "select", error: missing })
    fake.injectError({ table: "disbursements", action: "select", error: missing })

    const res = await as(STAFF_TOKEN, request(app).get("/companies"))

    expect(res.status).toBe(200)
    const used = (res.body.companies as Row[]).find((c) => c.id === C_USED)
    expect(used?.usage).toEqual({ projects: 2, disbursements: 0, subcontractPayments: 3, total: 5 })

    fake.injectError({ table: "projects", action: "select", error: { code: "XX000", message: "boom" } })
    const broken = await as(STAFF_TOKEN, request(app).get("/companies"))
    expect(broken.status).toBe(500)
  })

  it("沒有任何公司時不打使用量查詢", async () => {
    fake.db.companies = []

    const res = await as(STAFF_TOKEN, request(app).get("/companies"))

    expect(res.status).toBe(200)
    expect(res.body.companies).toEqual([])
    expect(fake.reads.filter((name) => name !== "companies")).toEqual([])
  })
})

describe("fake 的 CHECK 仿真（確認下面的順序測試不是空轉）", () => {
  it("直接把預設公司停用會被 23514 擋下", async () => {
    const result = await fake.from("companies").update({ is_active: false }).eq("id", C_DEFAULT)

    expect(result.error?.code).toBe("23514")
    expect(stored(C_DEFAULT)?.is_active).toBe(true)
  })
})

describe("PUT /companies — 停用", () => {
  it("停用預設公司：400 default_company_inactive，一筆都沒寫", async () => {
    const res = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_DEFAULT, name: NAME_DEFAULT, isDefault: true, isActive: false }],
    })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "default_company_inactive", id: C_DEFAULT, name: NAME_DEFAULT })
    expect(companyWrites()).toHaveLength(0)
    expect(stored(C_DEFAULT)).toMatchObject({ is_default: true, is_active: true })
  })

  it("只帶 isActive:false、沒提 isDefault 的停用預設公司也一樣擋（預設旗標沒被移走）", async () => {
    const res = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_DEFAULT, name: NAME_DEFAULT, isActive: false }],
    })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("default_company_inactive")
    expect(companyWrites()).toHaveLength(0)
  })

  it("停用非預設公司：成功，回應帶 isActive:false，預設公司不受影響", async () => {
    const res = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [
        { id: C_DEFAULT, name: NAME_DEFAULT, isDefault: true },
        { id: C_SECOND, name: NAME_SECOND, isDefault: false, isActive: false },
      ],
    })

    expect(res.status).toBe(200)
    expect(stored(C_SECOND)).toMatchObject({ is_active: false, is_default: false })
    expect(stored(C_DEFAULT)).toMatchObject({ is_active: true, is_default: true })
    const byId = Object.fromEntries((res.body.companies as Row[]).map((c) => [c.id, c]))
    expect(byId[C_SECOND]).toMatchObject({ isActive: false, isDefault: false })
    expect(byId[C_SECOND].usage).toEqual({ projects: 0, disbursements: 0, subcontractPayments: 0, total: 0 })
    expect(byId[C_DEFAULT]).toMatchObject({ isActive: true, isDefault: true })
  })

  it("可以重新啟用已停用的公司", async () => {
    const res = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_INACTIVE, name: NAME_INACTIVE, isActive: true }],
    })

    expect(res.status).toBe(200)
    expect(stored(C_INACTIVE)?.is_active).toBe(true)
  })

  it("同一批「預設改到 B、停用原預設 A」要成功，而且先清掉 A 的預設旗標再停用（不會中途違反 CHECK）", async () => {
    for (const order of ["old-first", "new-first"] as const) {
      fake.reset()
      fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
      fake.db.companies = [company({ id: C_DEFAULT, name: NAME_DEFAULT, is_default: true }), company({ id: C_SECOND, name: NAME_SECOND })]
      fake.checks.companies = (row) =>
        row.is_active === false && row.is_default === true ? 'violates check constraint "companies_default_active_chk"' : null
      const oldDefault = { id: C_DEFAULT, name: NAME_DEFAULT, isDefault: false, isActive: false }
      const newDefault = { id: C_SECOND, name: NAME_SECOND, isDefault: true }

      const res = await as(HR_TOKEN, request(app).put("/companies")).send({
        companies: order === "old-first" ? [oldDefault, newDefault] : [newDefault, oldDefault],
      })

      expect(res.status, order).toBe(200)
      expect(stored(C_DEFAULT), order).toMatchObject({ is_default: false, is_active: false })
      expect(stored(C_SECOND), order).toMatchObject({ is_default: true })
      expect(stored(C_SECOND)?.is_active, order).not.toBe(false)
      // 第一個寫入一定是「清掉其他預設」，之後才有任何停用。
      expect(companyWrites()[0]?.payload, order).toMatchObject({ is_default: false })
      expect(companyWrites()[0]?.payload, order).not.toHaveProperty("is_active")
      const body = res.body.companies as Row[]
      expect(body.find((c) => c.isDefault)?.id, order).toBe(C_SECOND)
    }
  })

  it("同一批「預設改到 B」但沒提 A 的 isDefault、只停用 A：同樣成功（A 的預設旗標被清掉）", async () => {
    const res = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [
        { id: C_DEFAULT, name: NAME_DEFAULT, isActive: false },
        { id: C_SECOND, name: NAME_SECOND, isDefault: true },
      ],
    })

    expect(res.status).toBe(200)
    expect(stored(C_DEFAULT)).toMatchObject({ is_default: false, is_active: false })
    expect(stored(C_SECOND)?.is_default).toBe(true)
  })

  it("停用的公司不能被設成預設：400；同一筆一起重新啟用就可以", async () => {
    const blocked = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_INACTIVE, name: NAME_INACTIVE, isDefault: true }],
    })
    expect(blocked.status).toBe(400)
    expect(blocked.body).toMatchObject({ error: "default_company_inactive", id: C_INACTIVE })
    expect(companyWrites()).toHaveLength(0)

    const blockedExplicit = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_INACTIVE, name: NAME_INACTIVE, isDefault: true, isActive: false }],
    })
    expect(blockedExplicit.status).toBe(400)

    const ok = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_INACTIVE, name: NAME_INACTIVE, isDefault: true, isActive: true }],
    })
    expect(ok.status).toBe(200)
    expect(stored(C_INACTIVE)).toMatchObject({ is_default: true, is_active: true })
    expect(stored(C_DEFAULT)?.is_default).toBe(false)
  })

  it("新增一間停用的預設公司也擋；新增列沒帶 isActive 就是啟用", async () => {
    const blocked = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ name: "測試新公司", isDefault: true, isActive: false }],
    })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toBe("default_company_inactive")
    expect(companyWrites()).toHaveLength(0)

    const ok = await as(HR_TOKEN, request(app).put("/companies")).send({ companies: [{ name: "測試新公司" }] })
    expect(ok.status).toBe(200)
    const created = (ok.body.companies as Row[]).find((c) => c.name === "測試新公司")
    expect(created).toMatchObject({ isActive: true, isDefault: false })
  })

  it("名冊只剩一間、而且是停用的：不會硬把它設成預設（不會撞 CHECK 變成 500）", async () => {
    fake.db.companies = [company({ id: C_DEFAULT, name: NAME_DEFAULT, is_default: true })]

    const res = await as(HR_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_DEFAULT, name: NAME_DEFAULT, isDefault: false, isActive: false }],
    })

    expect(res.status).toBe(200)
    expect(stored(C_DEFAULT)).toMatchObject({ is_default: false, is_active: false })
    // 回應也不能謊稱它是預設（沒有寫成功的旗標不能只在記憶體裡翻成 true）。
    expect(res.body.companies).toHaveLength(1)
    expect(res.body.companies[0]).toMatchObject({ id: C_DEFAULT, isDefault: false, isActive: false })
  })

  it("沒有 finance 權限的一般員工不能存（403）", async () => {
    const res = await as(STAFF_TOKEN, request(app).put("/companies")).send({
      companies: [{ id: C_SECOND, name: NAME_SECOND, isActive: false }],
    })

    expect(res.status).toBe(403)
    expect(companyWrites()).toHaveLength(0)
  })
})

describe("DELETE /companies/:id", () => {
  it("從沒被用過的非預設公司：刪除成功，稽核留下舊資料", async () => {
    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: C_SECOND })
    expect(stored(C_SECOND)).toBeUndefined()
    expect(companyDeletes()).toHaveLength(1)
    expect(companyDeletes()[0]?.matched).toBe(1)
    const audit = auditRows().find((row) => row.table_name === "companies" && row.action === "DELETE")
    expect(audit).toMatchObject({ record_id: C_SECOND, context: "DELETE /companies/:id" })
    expect((audit?.old_row as Row).name).toBe(NAME_SECOND)
    // 其他公司不受影響
    expect(stored(C_DEFAULT)).toBeTruthy()
    expect(stored(C_USED)).toBeTruthy()
  })

  it("停用中、但從沒被用過的公司同樣可以刪", async () => {
    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_INACTIVE}`))

    expect(res.status).toBe(200)
    expect(stored(C_INACTIVE)).toBeUndefined()
  })

  it("會計（finance 角色）也可以刪", async () => {
    const res = await as(ACCOUNTANT_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(200)
    expect(stored(C_SECOND)).toBeUndefined()
  })

  it("已被使用：409 company_in_use 附使用量明細，不刪", async () => {
    seedUsageOfC_USED()

    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_USED}`))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: "company_in_use",
      usage: { projects: 2, disbursements: 3, subcontractPayments: 3, total: 8 },
    })
    expect(companyDeletes()).toHaveLength(0)
    expect(stored(C_USED)).toBeTruthy()
  })

  it("只被一張已作廢放款單的收據抬頭引用也算使用中（外鍵對所有列生效，不排除 void）", async () => {
    fake.db.disbursements = [
      { id: "eeeeeeee-0000-4000-8000-000000000009", tenant_id: TENANT_ID, status: "void", paying_company_id: C_DEFAULT, receipt_issuer_company_id: C_SECOND },
    ]

    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "company_in_use", usage: { disbursements: 1, total: 1 } })
    expect(stored(C_SECOND)).toBeTruthy()
  })

  it("只被一期下包款的付款公司引用也算使用中", async () => {
    fake.db.project_subcontract_payments = [
      { id: "ffffffff-0000-4000-8000-000000000009", tenant_id: TENANT_ID, paying_company_id: C_SECOND, receipt_issuer_company_id: null },
    ]

    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "company_in_use", usage: { subcontractPayments: 1, total: 1 } })
  })

  it("預設公司：409 company_is_default（就算沒被用過）", async () => {
    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_DEFAULT}`))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "company_is_default" })
    expect(companyDeletes()).toHaveLength(0)
    expect(stored(C_DEFAULT)).toBeTruthy()
  })

  it("別租戶的公司：404，原封不動", async () => {
    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_OTHER_TENANT}`))

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: "not_found" })
    expect(companyDeletes()).toHaveLength(0)
    expect(stored(C_OTHER_TENANT)).toBeTruthy()
  })

  it("不存在的 id、不是 uuid 的 id：404（不會變成 500）", async () => {
    const unknown = await as(HR_TOKEN, request(app).delete("/companies/cccccccc-0000-4000-8000-0000000000ff"))
    expect(unknown.status).toBe(404)

    const malformed = await as(HR_TOKEN, request(app).delete("/companies/not-a-uuid"))
    expect(malformed.status).toBe(404)
    expect(companyDeletes()).toHaveLength(0)
  })

  it("檢查之後、刪除之前被別人用了（DB 外鍵 23503）：409 company_in_use，不是 500", async () => {
    fake.injectError({
      table: "companies",
      action: "delete",
      error: {
        code: "23503",
        message: 'update or delete on table "companies" violates foreign key constraint "projects_company_id_companies_id_fk" on table "projects"',
      },
    })

    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(409)
    expect(res.body.error).toBe("company_in_use")
    expect(res.body.usage).toBeTruthy()
    expect(stored(C_SECOND)).toBeTruthy()
    expect(auditRows().filter((row) => row.action === "DELETE")).toHaveLength(0)
  })

  it("其他 DB 錯誤照常 500，不會被當成使用中", async () => {
    fake.injectError({ table: "companies", action: "delete", error: { code: "XX000", message: "boom" } })

    const res = await as(HR_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(500)
    expect(stored(C_SECOND)).toBeTruthy()
  })

  it("沒有 finance 權限的一般員工不能刪（403），公司還在", async () => {
    const res = await as(STAFF_TOKEN, request(app).delete(`/companies/${C_SECOND}`))

    expect(res.status).toBe(403)
    expect(companyDeletes()).toHaveLength(0)
    expect(stored(C_SECOND)).toBeTruthy()
  })

  it("沒帶登入憑證：401", async () => {
    const res = await request(app).delete(`/companies/${C_SECOND}`)

    expect(res.status).toBe(401)
    expect(stored(C_SECOND)).toBeTruthy()
  })
})

describe("company-lifecycle 純函式", () => {
  const existing = [
    { id: "a", name: "甲", is_default: true, is_active: true },
    { id: "b", name: "乙", is_default: false, is_active: true },
    { id: "c", name: "丙", is_default: false, is_active: false },
  ]

  it("resolveFinalFlags：新預設會清掉其他公司的預設旗標，payload 沒提的欄位維持現狀", () => {
    const flags = resolveFinalFlags(existing, [
      { id: "a", name: "甲", isActive: false },
      { id: "b", name: "乙", isDefault: true },
    ])
    const by = Object.fromEntries(flags.map((f) => [f.id, f]))
    expect(by.a).toMatchObject({ isDefault: false, isActive: false })
    expect(by.b).toMatchObject({ isDefault: true, isActive: true })
    expect(by.c).toMatchObject({ isDefault: false, isActive: false })
    expect(findInactiveDefault(flags)).toBeNull()
  })

  it("findInactiveDefault：停用預設、把停用的設成預設，都找得到；新增列也算", () => {
    expect(findInactiveDefault(resolveFinalFlags(existing, [{ id: "a", name: "甲", isActive: false }]))).toMatchObject({ id: "a" })
    expect(findInactiveDefault(resolveFinalFlags(existing, [{ id: "c", name: "丙", isDefault: true }]))).toMatchObject({ id: "c" })
    expect(findInactiveDefault(resolveFinalFlags(existing, [{ id: "c", name: "丙", isDefault: true, isActive: true }]))).toBeNull()
    expect(findInactiveDefault(resolveFinalFlags(existing, [{ name: "新", isDefault: true, isActive: false }]))).toMatchObject({ id: null, name: "新" })
    expect(findInactiveDefault(resolveFinalFlags(existing, []))).toBeNull()
  })

  it("firstNewlyPickedInactive：只擋新選／改選；沿用已存值、沒選、啟用的都放行；各欄位各自比對", () => {
    const inactive = new Set(["x"])
    expect(firstNewlyPickedInactive([{ companyId: "x" }], inactive)).toBe("x")
    expect(firstNewlyPickedInactive([{ companyId: "x", storedCompanyId: null }], inactive)).toBe("x")
    expect(firstNewlyPickedInactive([{ companyId: "x", storedCompanyId: "x" }], inactive)).toBeNull()
    expect(firstNewlyPickedInactive([{ companyId: "x", storedCompanyId: "y" }], inactive)).toBe("x")
    expect(firstNewlyPickedInactive([{ companyId: null }, { companyId: undefined }], inactive)).toBeNull()
    expect(firstNewlyPickedInactive([{ companyId: "y" }], inactive)).toBeNull()
    // 付款公司沿用已存的 x，但把 x 搬到收據抬頭＝新選，要擋
    expect(
      firstNewlyPickedInactive(
        [
          { companyId: "x", storedCompanyId: "x" },
          { companyId: "x", storedCompanyId: null },
        ],
        inactive,
      ),
    ).toBe("x")
  })
})
