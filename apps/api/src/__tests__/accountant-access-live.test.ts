import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * W4 會計角色（業主決策 3，2026-09-23）— live 合約測試（throwaway 租戶）。
 *
 * 會計（`employees.role='accountant'`）**可以**：專案與金流（建案／請款／開票／入帳／
 * 複委託）、報銷、預支、人員基本資料（讀）、出勤月表的 HR 操作。
 * 會計**不可以**：薪資作業、他人薪資單、獎金批次、專案分潤（趴數／獎金池／分潤異動史）、
 * 規則參數、租戶設定。
 *
 * 這組測試不依賴 migration 0050——只用既有欄位。專案設定的四角色預設趴數在
 * projects.test.ts 另測（那邊有 describe.skipIf）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let adminEmpId: string
let acctToken: string
let acctEmpId: string
let workerEmpId: string
let projectId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
async function createEmployee(label: string, role: string) {
  const email = `acct-${stamp}-${label}@example.com`
  const password = `Pw-${stamp}-${label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${label}-${stamp}`,
    password,
    role,
    empNo: `A-${label}`,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}

beforeAll(async () => {
  const adminEmail = `acct-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Admin-Aa1!`
  const p = await provisionTenant({ name: `ACCTTEST ${stamp}`, adminEmail, adminPassword })
  tenantId = p.tenantId
  createdTenantIds.push(p.tenantId)
  createdUserIds.push(p.userId)
  adminToken = await signIn(adminEmail, adminPassword)
  const { data: hr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", p.userId)
    .single()
  adminEmpId = hr!.id as string

  const acct = await createEmployee("acct", "accountant")
  acctEmpId = acct.id
  acctToken = acct.token
  const worker = await createEmployee("worker", "employee")
  workerEmpId = worker.id
  // 月表的 money 是薪資試算，沒有薪資結構就算不出來（連 HR 也是 null）——
  // 這裡給 worker 一份月薪結構，「HR 看得到、會計看不到」的對照才成立。
  const salary = await as(adminToken, request(app).put(`/salary/${workerEmpId}`)).send({
    method: "monthly",
    baseSalary: 40_000,
  })
  expect(salary.status, JSON.stringify(salary.body)).toBe(200)

  // HR 開一個有獎金池與成員分潤的案子，讓「會計看不到分潤」有東西可以看不到。
  const proj = await as(adminToken, request(app).post("/projects")).send({
    name: `會計權限測試案 ${stamp}`,
    shareMode: "pool_pct",
    bonusPool: 1_000_000,
  })
  expect(proj.status, JSON.stringify(proj.body)).toBe(201)
  projectId = proj.body.id
  const member = await as(adminToken, request(app).post(`/projects/${projectId}/members`)).send({
    employeeId: workerEmpId,
    roleInProject: "lead",
    sharePct: 25,
  })
  expect(member.status, JSON.stringify(member.body)).toBe(201)
}, 120_000)

afterAll(async () => {
  for (const tid of createdTenantIds) await purgeTestTenant(tid)
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 120_000)

describe("W4 會計可以用的：專案金流、名冊、人員基本資料", () => {
  it("GET /employees → 200（人員基本資料是財務作業的必需品）", async () => {
    const res = await as(acctToken, request(app).get("/employees"))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.employees.length).toBeGreaterThan(0)
  })

  it("GET /projects/:id → access {finance:true, bonus:false}，而且 project.bonusPool 是 null", async () => {
    const res = await as(acctToken, request(app).get(`/projects/${projectId}`))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.access).toEqual({ finance: true, bonus: false })
    expect(res.body.project.bonusPool).toBeNull()
    // finance 段照樣拿得到
    expect(res.body.money).not.toBeNull()
  })

  it("可以建客戶、建案、開請款期程（金流是他的工作）", async () => {
    const client = await as(acctToken, request(app).post("/clients")).send({ name: `會計建的客戶 ${stamp}` })
    expect(client.status, JSON.stringify(client.body)).toBe(201)

    const proj = await as(acctToken, request(app).post("/projects")).send({ name: `會計建的案 ${stamp}` })
    expect(proj.status, JSON.stringify(proj.body)).toBe(201)

    const contract = await as(acctToken, request(app).post(`/projects/${proj.body.id}/contracts`)).send({
      docType: "contract",
      ourRole: "contractor",
      title: "設計監造",
      amount: 1_000_000,
      signedOn: "2026-01-05",
    })
    expect(contract.status, JSON.stringify(contract.body)).toBe(201)

    const sched = await as(acctToken, request(app).put(`/projects/${proj.body.id}/billings`)).send({
      installments: [{ installmentNo: 1, percentage: 100, milestone: "全額" }],
    })
    expect(sched.status, JSON.stringify(sched.body)).toBe(200)
  })

  it("GET /projects/annual → 200（年度總表是會計的報表分頁）", async () => {
    const res = await as(acctToken, request(app).get(`/projects/annual?year=${new Date().getFullYear()}`))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("GET /advances/outstanding、GET /expense-settlements → 200（預支與報銷核銷）", async () => {
    const adv = await as(acctToken, request(app).get("/advances/outstanding"))
    expect(adv.status, JSON.stringify(adv.body)).toBe(200)
    const settle = await as(acctToken, request(app).get("/expense-settlements"))
    expect(settle.status, JSON.stringify(settle.body)).toBe(200)
  })
})

describe("W4 會計看不到分潤（獎金區）", () => {
  it("GET /projects/:id/members → 有名單、沒有 sharePct／shareAmount／computedAmount，bonusPool 為 null", async () => {
    const res = await as(acctToken, request(app).get(`/projects/${projectId}/members`))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.canManage).toBe(true)
    expect(res.body.canSeeBonus).toBe(false)
    expect(res.body.bonusPool).toBeNull()
    expect(res.body.members).toHaveLength(1)
    const m = res.body.members[0]
    expect(m.employeeId).toBe(workerEmpId)
    expect(m.roleInProject).toBe("lead")
    expect(m).not.toHaveProperty("sharePct")
    expect(m).not.toHaveProperty("shareAmount")
    expect(m).not.toHaveProperty("computedAmount")
  })

  it("HR 同一個端點看得到完整分潤（對照組）", async () => {
    const res = await as(adminToken, request(app).get(`/projects/${projectId}/members`))
    expect(res.body.canSeeBonus).toBe(true)
    expect(res.body.bonusPool).toBe(1_000_000)
    expect(res.body.members[0].sharePct).toBe(25)
    expect(res.body.members[0].computedAmount).toBe(250_000)
  })

  it("GET /projects/:id/adjustments → 分潤異動史只剩與自己相關的（會計不是成員 → 空）", async () => {
    const res = await as(acctToken, request(app).get(`/projects/${projectId}/adjustments`))
    expect(res.status).toBe(200)
    expect(res.body.adjustments).toEqual([])
    // HR 看得到那筆初始分潤
    const hr = await as(adminToken, request(app).get(`/projects/${projectId}/adjustments`))
    expect(hr.body.adjustments.length).toBeGreaterThan(0)
  })

  it("PATCH /projects/:id {bonusPool} → 403 forbidden_bonus", async () => {
    const res = await as(acctToken, request(app).patch(`/projects/${projectId}`)).send({ bonusPool: 5 })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("forbidden_bonus")
  })

  it("POST /projects/:id/members → 403（成員與分潤是獎金區）", async () => {
    const res = await as(acctToken, request(app).post(`/projects/${projectId}/members`)).send({
      employeeId: acctEmpId,
      roleInProject: "member",
    })
    expect(res.status).toBe(403)
  })

  it("GET /bonus-runs → 403（獎金批次維持 HR）", async () => {
    const res = await as(acctToken, request(app).get("/bonus-runs"))
    expect(res.status).toBe(403)
  })

  it("GET /projects 列表：對誰都不回獎金池", async () => {
    const res = await as(acctToken, request(app).get("/projects"))
    expect(res.status).toBe(200)
    for (const p of res.body.projects) expect(p.bonusPool).toBeNull()
  })
})

describe("W4 會計看不到薪資", () => {
  it("POST /payroll/run → 403", async () => {
    const res = await as(acctToken, request(app).post("/payroll/run")).send({ period: "2026-01" })
    expect(res.status).toBe(403)
  })

  it("GET /payslips?employeeId=<別人> → 拿不到別人的薪資單（非 HR 一律鎖定本人）", async () => {
    const res = await as(acctToken, request(app).get(`/payslips?employeeId=${workerEmpId}`))
    expect(res.status).toBe(200)
    for (const slip of res.body.payslips ?? []) expect(slip.employeeId).toBe(acctEmpId)
  })

  it("PUT /rule-config → 403（規則參數維持 HR）", async () => {
    const res = await as(acctToken, request(app).put("/rule-config")).send({ effectiveFrom: "now", config: {} })
    expect(res.status).toBe(403)
  })

  it("PUT /api/tenant/settings → 403（租戶設定維持 HR）", async () => {
    const res = await as(acctToken, request(app).put("/api/tenant/settings")).send({ features: {} })
    expect(res.status).toBe(403)
  })
})

describe("§3.0 E 會計拿得到月表的 HR 操作，但拿不到金額", () => {
  const period = "2026-01"
  let sheetId: string

  it("POST /attendance-sheets/generate → 200（會計可以產月表）", async () => {
    const res = await as(acctToken, request(app).post("/attendance-sheets/generate")).send({ period })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it("GET /attendance-sheets?period= → 列得到全員（不是只有自己）", async () => {
    const res = await as(acctToken, request(app).get(`/attendance-sheets?period=${period}`))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const ids = (res.body.sheets as Array<{ id: string; employeeId: string }>).map((s) => s.employeeId)
    expect(ids).toContain(workerEmpId)
    expect(ids).toContain(adminEmpId)
    sheetId = (res.body.sheets as Array<{ id: string; employeeId: string }>).find((s) => s.employeeId === workerEmpId)!.id
  })

  it("GET /attendance-sheets/:id → money 是 null（HR 同一張看得到金額）", async () => {
    const acct = await as(acctToken, request(app).get(`/attendance-sheets/${sheetId}`))
    expect(acct.status, JSON.stringify(acct.body)).toBe(200)
    expect(acct.body.sheet.money).toBeNull()

    const hr = await as(adminToken, request(app).get(`/attendance-sheets/${sheetId}`))
    expect(hr.status).toBe(200)
    expect(hr.body.sheet.money).not.toBeNull()
  })
})
