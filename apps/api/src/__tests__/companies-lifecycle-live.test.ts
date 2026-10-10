import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * 公司主體生命週期 — live 合約測試（throwaway 租戶，打真的 DB）。
 *
 * 規則（2026-10-10 業主拍板）：從沒被用過的公司可以刪除；用過的不能刪、改成「停用」；
 * 停用後新專案／新放款／新下包付款不能再選它，舊紀錄照常顯示原公司名稱；預設公司不能停用也不能刪。
 *
 * 流程：建四間公司（A 預設、B、C、D）→ 刪沒被用過的 B → 預設 A 不能刪／不能停用 →
 * C 被專案與（之後作廢的）放款單用過：刪除 409、DB 外鍵也擋 → 停用 C →
 * 停用後新建專案／新建放款單選 C 都是 400 company_inactive → 舊專案照常讀到 C 的名稱、
 * 沿用 C 也能存 → 重新啟用 → 同一批「預設改到 D、停用 A」（對真的 CHECK 驗寫入順序）。
 *
 * 正式庫尚未套 `companies.is_active`（migration 0057／sql/0047）時整組 describe.skipIf 跳過。
 * 只在自建的 throwaway 租戶裡動資料，結束時 purge_test_tenant 清掉。
 * ⚠️ 公司名稱都是明顯的假值（repo 是公開的）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("companies").select("is_active").limit(1)
  return !error
}
async function disbursementsReady(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("disbursements").select("id").limit(1)
  return !error
}
const ready = await migrated()
const hasDisbursements = ready && (await disbursementsReady())

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string

type CompanyBody = {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  usage: { projects: number; disbursements: number; subcontractPayments: number; total: number }
}

const NAME_A = `測試公司甲 ${stamp}`
const NAME_B = `測試公司乙 ${stamp}`
const NAME_C = `測試公司丙 ${stamp}`
const NAME_D = `測試公司丁 ${stamp}`

let companyA: CompanyBody
let companyB: CompanyBody
let companyC: CompanyBody
let companyD: CompanyBody
let oldProjectId: string
let voidedDisbursementId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}
async function listCompanies(): Promise<CompanyBody[]> {
  const res = await asAdmin(request(app).get("/companies"))
  expect(res.status).toBe(200)
  return res.body.companies as CompanyBody[]
}
async function companyById(id: string): Promise<CompanyBody | undefined> {
  return (await listCompanies()).find((c) => c.id === id)
}
/** 整批存檔：只列要動的公司（沒列的不會被刪、也不會被動到）。 */
function putCompanies(companies: Array<Record<string, unknown>>) {
  return asAdmin(request(app).put("/companies")).send({ companies })
}

describe.skipIf(!ready)("公司主體生命週期 — live", () => {
  beforeAll(async () => {
    const adminEmail = `company-life-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const provisioned = await provisionTenant({ name: `COMPANYLIFETEST ${stamp}`, adminEmail, adminPassword })
    tenantId = provisioned.tenantId
    createdTenantIds.push(provisioned.tenantId)
    createdUserIds.push(provisioned.userId)
    adminToken = await signIn(adminEmail, adminPassword)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) await purgeTestTenant(tid)
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  it("建四間公司：A 預設，其餘一般公司；全部啟用、使用量都是 0", async () => {
    const res = await putCompanies([{ name: NAME_A, isDefault: true }, { name: NAME_B }, { name: NAME_C }, { name: NAME_D }])
    expect(res.status).toBe(200)

    const byName = (name: string) => (res.body.companies as CompanyBody[]).find((c) => c.name === name)!
    companyA = byName(NAME_A)
    companyB = byName(NAME_B)
    companyC = byName(NAME_C)
    companyD = byName(NAME_D)
    expect(companyA).toMatchObject({ isDefault: true, isActive: true })
    for (const c of [companyB, companyC, companyD]) expect(c).toMatchObject({ isDefault: false, isActive: true })
    for (const c of [companyA, companyB, companyC, companyD]) {
      expect(c.usage).toEqual({ projects: 0, disbursements: 0, subcontractPayments: 0, total: 0 })
    }
  })

  it("刪除從沒被用過的 B：200，名冊少一間；再刪一次 404", async () => {
    const res = await asAdmin(request(app).delete(`/companies/${companyB.id}`))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: companyB.id })

    expect((await listCompanies()).map((c) => c.id).sort()).toEqual([companyA.id, companyC.id, companyD.id].sort())

    const again = await asAdmin(request(app).delete(`/companies/${companyB.id}`))
    expect(again.status).toBe(404)
  })

  it("預設公司 A 不能刪（409 company_is_default）、不能停用（400 default_company_inactive）", async () => {
    const del = await asAdmin(request(app).delete(`/companies/${companyA.id}`))
    expect(del.status).toBe(409)
    expect(del.body.error).toBe("company_is_default")

    const off = await putCompanies([{ id: companyA.id, name: NAME_A, isDefault: true, isActive: false }])
    expect(off.status).toBe(400)
    expect(off.body.error).toBe("default_company_inactive")

    expect(await companyById(companyA.id)).toMatchObject({ isDefault: true, isActive: true })
  })

  it("C 被專案承接：使用量 projects=1；刪除 409 company_in_use（附明細）；DB 外鍵也擋（23503）", async () => {
    const created = await asAdmin(request(app).post("/projects")).send({ name: `公司停用測試案 ${stamp}`, companyId: companyC.id })
    expect(created.status).toBe(201)
    oldProjectId = created.body.id

    expect((await companyById(companyC.id))!.usage).toMatchObject({ projects: 1, total: 1 })

    const del = await asAdmin(request(app).delete(`/companies/${companyC.id}`))
    expect(del.status).toBe(409)
    expect(del.body.error).toBe("company_in_use")
    expect(del.body.usage).toMatchObject({ projects: 1, total: 1 })

    // API 競態防護（23503 → 409）靠的就是這條外鍵：直接用 service role 刪也要被 DB 擋下。
    const direct = await supabaseAdmin.from("companies").delete().eq("tenant_id", tenantId).eq("id", companyC.id)
    expect(direct.error?.code).toBe("23503")
    expect(await companyById(companyC.id)).toBeTruthy()
  })

  it.skipIf(!hasDisbursements)("C 也是一張放款單的收據抬頭：使用量 disbursements=1；單子作廢後照算，仍然刪不掉", async () => {
    const created = await asAdmin(request(app).post("/disbursements")).send({
      payeeKind: "other",
      payeeName: "測試印刷行",
      payingCompanyId: companyA.id,
      receiptIssuerCompanyId: companyC.id,
      method: "transfer",
      amount: 1000,
      status: "draft",
      allocations: [],
    })
    expect(created.status).toBe(201)
    voidedDisbursementId = created.body.disbursement.id

    expect((await companyById(companyC.id))!.usage).toMatchObject({ projects: 1, disbursements: 1, total: 2 })
    expect((await companyById(companyA.id))!.usage).toMatchObject({ disbursements: 1 })

    const voided = await asAdmin(request(app).post(`/disbursements/${voidedDisbursementId}/void`)).send({ reason: "測試作廢" })
    expect(voided.status).toBe(200)
    expect(voided.body.disbursement.status).toBe("void")

    // 作廢的單照樣讓外鍵擋刪除，所以使用量不能把它排除。
    expect((await companyById(companyC.id))!.usage).toMatchObject({ projects: 1, disbursements: 1, total: 2 })
    const del = await asAdmin(request(app).delete(`/companies/${companyC.id}`))
    expect(del.status).toBe(409)
    expect(del.body.usage).toMatchObject({ projects: 1, disbursements: 1, total: 2 })
  })

  it("停用 C：200；名冊顯示已停用，使用量還在", async () => {
    const res = await putCompanies([{ id: companyC.id, name: NAME_C, isActive: false }])
    expect(res.status).toBe(200)

    const c = await companyById(companyC.id)
    expect(c).toMatchObject({ isActive: false, isDefault: false })
    expect(c!.usage.projects).toBe(1)
    // 預設公司沒被動到
    expect(await companyById(companyA.id)).toMatchObject({ isDefault: true, isActive: true })
  })

  it("停用後新建專案帶 C：400 company_inactive，專案沒建出來", async () => {
    const before = await asAdmin(request(app).get("/projects"))
    expect(before.status).toBe(200)

    const res = await asAdmin(request(app).post("/projects")).send({ name: `停用後新案 ${stamp}`, companyId: companyC.id })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "company_inactive", companyId: companyC.id })

    const after = await asAdmin(request(app).get("/projects"))
    expect(after.body.projects).toHaveLength(before.body.projects.length)
  })

  it.skipIf(!hasDisbursements)("停用後新建放款單的付款公司／收據抬頭選 C：400 company_inactive", async () => {
    const asPayer = await asAdmin(request(app).post("/disbursements")).send({
      payeeKind: "other",
      payeeName: "測試印刷行",
      payingCompanyId: companyC.id,
      method: "transfer",
      amount: 500,
      status: "draft",
      allocations: [],
    })
    expect(asPayer.status).toBe(400)
    expect(asPayer.body).toMatchObject({ error: "company_inactive", companyId: companyC.id })

    const asIssuer = await asAdmin(request(app).post("/disbursements")).send({
      payeeKind: "other",
      payeeName: "測試印刷行",
      payingCompanyId: companyA.id,
      receiptIssuerCompanyId: companyC.id,
      method: "transfer",
      amount: 500,
      status: "draft",
      allocations: [],
    })
    expect(asIssuer.status).toBe(400)
    expect(asIssuer.body).toMatchObject({ error: "company_inactive", companyId: companyC.id })
  })

  it("舊專案照常讀到 C 的名稱；沿用 C 的更新照樣能存，改選到停用公司則不行", async () => {
    const detail = await asAdmin(request(app).get(`/projects/${oldProjectId}`))
    expect(detail.status).toBe(200)
    expect(detail.body.project).toMatchObject({ companyId: companyC.id, companyName: NAME_C })

    const list = await asAdmin(request(app).get("/projects"))
    const row = (list.body.projects as Array<{ id: string; companyName: string | null }>).find((p) => p.id === oldProjectId)
    expect(row?.companyName).toBe(NAME_C)

    // 專案頁每次存檔都會把目前的承接公司整份送回來。
    const keep = await asAdmin(request(app).patch(`/projects/${oldProjectId}`)).send({ companyId: companyC.id, description: "沿用停用的公司" })
    expect(keep.status).toBe(200)

    // 先改成 A，再想改回停用的 C：新選到停用公司，擋。
    const toA = await asAdmin(request(app).patch(`/projects/${oldProjectId}`)).send({ companyId: companyA.id })
    expect(toA.status).toBe(200)
    const back = await asAdmin(request(app).patch(`/projects/${oldProjectId}`)).send({ companyId: companyC.id })
    expect(back.status).toBe(400)
    expect(back.body).toMatchObject({ error: "company_inactive", companyId: companyC.id })

    const final = await asAdmin(request(app).get(`/projects/${oldProjectId}`))
    expect(final.body.project.companyId).toBe(companyA.id)
  })

  it("重新啟用 C 之後又能選了", async () => {
    const on = await putCompanies([{ id: companyC.id, name: NAME_C, isActive: true }])
    expect(on.status).toBe(200)
    expect(await companyById(companyC.id)).toMatchObject({ isActive: true })

    const res = await asAdmin(request(app).post("/projects")).send({ name: `重新啟用後新案 ${stamp}`, companyId: companyC.id })
    expect(res.status).toBe(201)
  })

  it("同一批「預設改到 D、停用原預設 A」：成功（先清掉 A 的預設旗標，才不會在中途撞 CHECK）", async () => {
    const res = await putCompanies([
      { id: companyA.id, name: NAME_A, isDefault: false, isActive: false },
      { id: companyD.id, name: NAME_D, isDefault: true },
    ])
    expect(res.status).toBe(200)

    const companies = res.body.companies as CompanyBody[]
    expect(companies.find((c) => c.id === companyA.id)).toMatchObject({ isDefault: false, isActive: false })
    expect(companies.find((c) => c.id === companyD.id)).toMatchObject({ isDefault: true, isActive: true })
    expect(companies.filter((c) => c.isDefault)).toHaveLength(1)
  })

  it("停用的 A 不能再被設成預設；DB 的 CHECK 也真的擋住「預設＋停用」（23514）", async () => {
    const res = await putCompanies([{ id: companyA.id, name: NAME_A, isDefault: true }])
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("default_company_inactive")

    const direct = await supabaseAdmin.from("companies").update({ is_active: false }).eq("tenant_id", tenantId).eq("id", companyD.id)
    expect(direct.error?.code).toBe("23514")
    expect(await companyById(companyD.id)).toMatchObject({ isDefault: true, isActive: true })
  })
})
