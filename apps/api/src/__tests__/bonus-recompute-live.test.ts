import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * M22（2026-09-23）入帳後自動重算 draft 獎金批次 — live 合約測試。
 *
 * 獎金是「依請款入帳進度同比例拆發」，所以入帳一動，draft 批次的金額就過期了。
 * 之前只能手動 `PATCH /bonus-runs/:id?recompute=1`，忘了按就會照舊資料發錢。
 *
 * 流程：建案（合約 100 萬、池 10 萬、成員 10%）→ 第 1 期入帳 40 萬 → 建 draft 批次
 * （item 4,000）→ 第 2 期入帳 30 萬 → 回應帶 bonusRunsRecomputed，draft 自動變 7,000
 * → 撤銷第 2 期入帳 → draft 自動退回 4,000 → 批次 pay 之後入帳不再改動它（凍結）。
 *
 * 正式庫尚未套 0045／sql/0034（bonus_runs 不存在）時整組跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function bonusRunsMigrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("bonus_runs").select("id").limit(1)
  return !error
}
const migrated = await bonusRunsMigrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let empId: string
let projectId: string
let installments: Array<{ id: string; installmentNo: number }>
let runId: string

const TODAY = taipeiToday()
const YEAR = Number(TODAY.slice(0, 4))

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}

/** 目前 draft 批次裡那位成員的金額。 */
async function itemAmount(id: string): Promise<number> {
  const res = await asAdmin(request(app).get(`/bonus-runs/${id}`))
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const item = (res.body.items as Array<{ employeeId: string; amount: number }>).find((i) => i.employeeId === empId)
  if (!item) throw new Error(`no bonus item for ${empId}`)
  return item.amount
}

describe.skipIf(!migrated)("M22 入帳自動重算 draft 獎金批次 — live", () => {
  beforeAll(async () => {
    const adminEmail = `recompute-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const p = await provisionTenant({ name: `RECOMPUTETEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const { data: row, error } = await supabaseAdmin
      .from("employees")
      .insert({ tenant_id: tenantId, name: "分潤成員", emp_no: "R001", role: "employee", employment_type: "regular", status: "active" })
      .select("id")
      .single()
    if (error || !row) throw new Error(`employee row: ${error?.message}`)
    empId = row.id as string

    const proj = await asAdmin(request(app).post("/projects")).send({
      name: `入帳重算測試案 ${stamp}`,
      shareMode: "pool_pct",
      bonusPool: 100_000,
    })
    expect(proj.status, JSON.stringify(proj.body)).toBe(201)
    projectId = proj.body.id
    const member = await asAdmin(request(app).post(`/projects/${projectId}/members`)).send({ employeeId: empId, sharePct: 10 })
    expect(member.status, JSON.stringify(member.body)).toBe(201)

    const contract = await asAdmin(request(app).post(`/projects/${projectId}/contracts`)).send({
      docType: "contract",
      title: "承攬契約",
      amount: 1_000_000,
      signedOn: `${YEAR}-01-10`,
    })
    expect(contract.status, JSON.stringify(contract.body)).toBe(201)

    const sched = await asAdmin(request(app).put(`/projects/${projectId}/billings`)).send({
      installments: [
        { installmentNo: 1, percentage: 40, milestone: "簽約款" },
        { installmentNo: 2, percentage: 30, milestone: "送審款" },
        { installmentNo: 3, percentage: 30, milestone: "驗收款" },
      ],
    })
    expect(sched.status, JSON.stringify(sched.body)).toBe(200)
    installments = sched.body.installments

    const first = await asAdmin(request(app).post(`/billings/${installments[0].id}/receive`)).send({ receivedOn: TODAY })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) await purgeTestTenant(tid)
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  it("入帳 40% 後建 draft 批次 → 成員金額 4,000", async () => {
    const res = await asAdmin(request(app).post("/bonus-runs")).send({ label: `重算測試 ${stamp}`, asOf: TODAY })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    runId = res.body.run.id
    expect(res.body.run.status).toBe("draft")
    expect(await itemAmount(runId)).toBe(4_000)
  })

  it("第 2 期入帳（累計 70%）→ 回應帶 bonusRunsRecomputed，draft 自動變 7,000", async () => {
    const res = await asAdmin(request(app).post(`/billings/${installments[1].id}/receive`)).send({ receivedOn: TODAY })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.summary.receivedTotal).toBe(700_000)
    expect(res.body.bonusRunsRecomputed).toContain(runId)
    // 沒有人按過「重算」，金額就跟上了
    expect(await itemAmount(runId)).toBe(7_000)
  })

  it("撤銷第 2 期入帳 → draft 自動退回 4,000", async () => {
    const res = await asAdmin(request(app).post(`/billings/${installments[1].id}/unreceive`)).send({ reason: "支票退票" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.bonusRunsRecomputed).toContain(runId)
    expect(await itemAmount(runId)).toBe(4_000)
  })

  it("批次發放後就凍結：再入帳不會改到 paid 批次，也不會讓入帳失敗", async () => {
    const paid = await asAdmin(request(app).post(`/bonus-runs/${runId}/pay`)).send({ paidOn: TODAY })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    expect(paid.body.run.status).toBe("paid")

    const res = await asAdmin(request(app).post(`/billings/${installments[1].id}/receive`)).send({ receivedOn: TODAY })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // paid 批次不在重算名單裡
    expect(res.body.bonusRunsRecomputed).not.toContain(runId)
    // 金額仍是發放當下的 4,000
    expect(await itemAmount(runId)).toBe(4_000)
  })
})
