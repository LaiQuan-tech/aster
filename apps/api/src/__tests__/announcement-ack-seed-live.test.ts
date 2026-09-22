import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * 公告簽收分母補齊（W5）— live 合約測試（throwaway 租戶）。
 *
 * 客戶原文是「20 個人 5 個沒簽」：要看得出分母，待簽列就得在**發佈／進版當下**
 * 對全體在職員工建出來。改動前只有「報到完成／員工自己開過／HR 登錄」三條路會
 * 產生列，所以沒開過 App 的人根本不在名單裡。
 *
 * 流程：3 位在職員工 ＋ 1 位離職 → 發佈需簽收公告 → pending 應為 3（含 HR？見下）
 * → 新建一位員工 → 自動多一列 accept_on_hire → PATCH 進版 → 新版再 seed 一輪。
 *
 * 本檔**不需要** migration 0050（只寫既有的 announcement_acknowledgements），
 * 套不套遷移都能跑；表不存在時仍以 skipIf 保護。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function probe(): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false
  const { error } = await supabaseAdmin
    .from("announcement_acknowledgements")
    .select("id, kind, signed_at")
    .limit(1)
  return !error
}
const ready = await probe()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let adminEmpId: string
const staff: Array<{ id: string; label: string }> = []
let leaverId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}

async function createEmployee(label: string): Promise<string> {
  const email = `ackseed-${stamp}-${label}@example.com`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${label}-${stamp}`,
    password: `Pw-${stamp}-${label}-Aa1!`,
    role: "employee",
  })
  if (res.status !== 201) throw new Error(`createEmployee(${label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return res.body.employeeId as string
}

beforeAll(async () => {
  if (!ready) return
  const adminEmail = `ackseed-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const prov = await provisionTenant({ name: `ACKSEED ${stamp}`, adminEmail, adminPassword })
  tenantId = prov.tenantId
  createdTenantIds.push(prov.tenantId)
  createdUserIds.push(prov.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  const { data: admin } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", prov.userId)
    .maybeSingle()
  adminEmpId = admin?.id as string

  for (const label of ["a", "b"]) staff.push({ id: await createEmployee(label), label })
  leaverId = await createEmployee("gone")
  const res = await as(adminToken, request(app).patch(`/employees/${leaverId}`)).send({
    status: "terminated",
  })
  expect(res.status).toBe(200)
}, 90_000)

afterAll(async () => {
  for (const id of createdTenantIds) {
    try {
      await purgeTestTenant(id)
    } catch (err) {
      console.warn(`purge ${id} failed:`, err)
    }
  }
  for (const uid of createdUserIds) {
    try {
      await supabaseAdmin.auth.admin.deleteUser(uid)
    } catch {
      /* best effort */
    }
  }
}, 90_000)

describe.skipIf(!ready)("公告簽收分母（W5）— live", () => {
  let announcementId: string
  let versionId: string

  it("發佈需簽收公告 → 全體在職員工（含 HR 自己）都進待簽名單，離職者不進", async () => {
    const res = await as(adminToken, request(app).post("/announcements")).send({
      title: `工作規則 ${stamp}`,
      body: "全文…",
      requiresSignature: true,
      isAdverseChange: false,
    })
    expect(res.status).toBe(201)
    announcementId = res.body.id
    versionId = res.body.versionId
    // 在職＝HR 管理員 + a + b＝3（離職那位不算）。
    expect(res.body.seeded).toBe(3)

    const acks = await as(
      adminToken,
      request(app).get(`/announcements/${announcementId}/acknowledgements`),
    )
    expect(acks.status).toBe(200)
    expect(acks.body.activeEmployeeCount).toBe(3)
    expect(acks.body.pending).toHaveLength(3)
    expect(acks.body.signed).toHaveLength(0)
    expect(acks.body.consentRate).toEqual({ signed: 0, total: 3 })
    expect(acks.body.pending.map((p: { employee_id: string }) => p.employee_id).sort()).toEqual(
      [adminEmpId, staff[0].id, staff[1].id].sort(),
    )
    expect(acks.body.pending.every((p: { kind: string }) => p.kind === "consent_to_change")).toBe(true)
  })

  it("HR 登錄一位紙本簽署 → 已簽 1／尚未簽 2", async () => {
    const res = await as(
      adminToken,
      request(app).post(`/announcement-versions/${versionId}/acknowledge`),
    ).send({ employeeId: staff[0].id, signedAt: new Date().toISOString() })
    expect(res.status).toBe(200)

    const acks = await as(
      adminToken,
      request(app).get(`/announcements/${announcementId}/acknowledgements`),
    )
    expect(acks.body.signed).toHaveLength(1)
    expect(acks.body.pending).toHaveLength(2)
    expect(acks.body.consentRate).toEqual({ signed: 1, total: 3 })
  })

  it("之後才報到的新人 → POST /employees 自動補一列 accept_on_hire（不進同意率分母）", async () => {
    const newbieId = await createEmployee("newbie")
    staff.push({ id: newbieId, label: "newbie" })

    const { data, error } = await supabaseAdmin
      .from("announcement_acknowledgements")
      .select("kind, signed_at")
      .eq("tenant_id", tenantId)
      .eq("version_id", versionId)
      .eq("employee_id", newbieId)
      .maybeSingle()
    expect(error).toBeNull()
    expect(data?.kind).toBe("accept_on_hire")
    expect(data?.signed_at).toBeNull()

    const acks = await as(
      adminToken,
      request(app).get(`/announcements/${announcementId}/acknowledgements`),
    )
    expect(acks.body.activeEmployeeCount).toBe(4)
    expect(acks.body.pending).toHaveLength(3) // 新人也還沒簽
    // 同意率分母仍是 3：新人的 accept_on_hire 不進分母也不進分子。
    expect(acks.body.consentRate).toEqual({ signed: 1, total: 3 })
  })

  it("PATCH 進版（需簽收）→ 新版對全體在職員工重建待簽列", async () => {
    const res = await as(adminToken, request(app).patch(`/announcements/${announcementId}`)).send({
      body: "全文…（第二版）",
      changeType: "amendment",
    })
    expect(res.status).toBe(200)
    expect(res.body.seeded).toBe(4) // HR + a + b + newbie

    const acks = await as(
      adminToken,
      request(app).get(`/announcements/${announcementId}/acknowledgements`),
    )
    expect(acks.body.versionId).toBe(res.body.versionId)
    expect(acks.body.pending).toHaveLength(4)
    expect(acks.body.consentRate).toEqual({ signed: 0, total: 4 })
  })

  it("既有版本可用 seed 端點補建（重跑冪等，已簽的不被覆蓋）", async () => {
    const first = await as(
      adminToken,
      request(app).post(`/announcements/${announcementId}/acknowledgements/seed`),
    ).send({ versionId })
    expect(first.status).toBe(200)
    expect(first.body.seeded).toBe(0) // 這一版四個人都已經有列了
    expect(first.body.activeEmployeeCount).toBe(4)

    // 手動刪掉一列再補 → 只補回那一列。
    await supabaseAdmin
      .from("announcement_acknowledgements")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("version_id", versionId)
      .eq("employee_id", staff[1].id)
    const again = await as(
      adminToken,
      request(app).post(`/announcements/${announcementId}/acknowledgements/seed`),
    ).send({ versionId })
    expect(again.body.seeded).toBe(1)
  })

  it("不需簽收的公告不 seed，補建端點回 409", async () => {
    const res = await as(adminToken, request(app).post("/announcements")).send({
      title: `一般佈告 ${stamp}`,
      body: "中秋節提早下班",
    })
    expect(res.status).toBe(201)
    expect(res.body.seeded).toBe(0)

    const seed = await as(
      adminToken,
      request(app).post(`/announcements/${res.body.id}/acknowledgements/seed`),
    ).send({})
    expect(seed.status).toBe(409)
    expect(seed.body.error).toBe("signature_not_required")
  })

  it("年度篩選：?year= 只回該年、/announcements/years 列出有公告的年度", async () => {
    const year = new Date().getFullYear()
    const thisYear = await as(adminToken, request(app).get(`/announcements?year=${year}`))
    expect(thisYear.status).toBe(200)
    expect(thisYear.body.announcements.length).toBeGreaterThanOrEqual(2)

    const otherYear = await as(adminToken, request(app).get("/announcements?year=2001"))
    expect(otherYear.body.announcements).toHaveLength(0)

    const years = await as(adminToken, request(app).get("/announcements/years"))
    expect(years.status).toBe(200)
    expect(years.body.years).toContain(year)
  })
})
