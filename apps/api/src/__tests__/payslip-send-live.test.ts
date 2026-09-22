import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * M3 薪資條 Email 一鍵寄送 — live 合約測試（throwaway 租戶）。
 *
 * **不會真的寄信**：整組測試在 `RESEND_API_KEY` 未設的狀態下跑，驗的是守門：
 *   ① 草稿薪資單 → 409 `not_finalized`（定稿前寄出去就收不回來）
 *   ② 已定稿但 Resend 未設 → 409 `mail_not_configured`（不能假裝寄成功）
 *   ③ 批次同樣 409 `mail_not_configured`，一張都不會寄
 *   ④ 查無／跨租戶 → 404；非 HR → 403
 *   ⑤ `GET /payslips` 回 `sent_at`／`sent_to`（未寄送＝null）
 * 真的寄出去那一段要等正式站設好 `RESEND_API_KEY`／`NOTIFICATION_EMAIL_FROM`
 * 後在正式租戶用【測試】員工驗（§3.6 步驟 4）。
 *
 * 正式庫尚未套 migration 0050（payslips.sent_at）時整組 describe.skipIf 跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("payslips").select("sent_at, sent_to").limit(1)
  return !error
}
const ready = await migrated()
if (ready && process.env.RESEND_API_KEY) {
  console.warn("[payslip-send-live] RESEND_API_KEY 已設——本測試會暫時移除它以免真的寄信")
}

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []
const PERIOD = "2027-08"

let tenantId: string
let adminToken: string
let empId: string
let empToken: string
let draftId: string
let finalizedId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}

/** 直接插一列薪資單（本測試只驗寄送守門，不驗引擎試算）。 */
async function insertPayslip(employeeId: string, period: string, status: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .insert({
      tenant_id: tenantId,
      employee_id: employeeId,
      period,
      base: 40000,
      overtime_pay: 0,
      night_pay: 0,
      attendance_bonus: 0,
      gross: 40000,
      breakdown: { net: 40000, totalDeductions: 0, hourlyWage: 200 },
      status,
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`insertPayslip: ${error?.message}`)
  return data.id as string
}

describe.skipIf(!ready)("薪資條 Email 寄送 — live", () => {
  let savedResendKey: string | undefined

  beforeAll(async () => {
    savedResendKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY // 本測試一律在「未設定」狀態下跑，避免真的寄信

    const adminEmail = `payslipsend-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `SENDTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const email = `payslipsend-${stamp}-emp@example.com`
    const password = `Pw-${stamp}-emp-Aa1!`
    const created = await as(adminToken, request(app).post("/employees")).send({
      email,
      name: `emp-${stamp}`,
      password,
      role: "employee",
      empNo: "S-emp",
    })
    if (created.status !== 201) throw new Error(`createEmployee ${created.status}: ${JSON.stringify(created.body)}`)
    createdUserIds.push(created.body.userId)
    empId = created.body.employeeId
    empToken = await signIn(email, password)

    draftId = await insertPayslip(empId, PERIOD, "draft")
    finalizedId = await insertPayslip(empId, "2027-07", "finalized")
  }, 120_000)

  afterAll(async () => {
    if (savedResendKey !== undefined) process.env.RESEND_API_KEY = savedResendKey
    for (const tid of createdTenantIds) {
      try {
        await purgeTestTenant(tid)
      } catch (err) {
        console.warn(`[payslip-send-live] purge ${tid} 失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  it("草稿薪資單 → 409 not_finalized（定稿前不可寄）", async () => {
    const res = await as(adminToken, request(app).post(`/payslips/${draftId}/send`))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("not_finalized")
  })

  it("已定稿但 RESEND_API_KEY 未設 → 409 mail_not_configured", async () => {
    const res = await as(adminToken, request(app).post(`/payslips/${finalizedId}/send`))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("mail_not_configured")
  })

  it("批次同樣 409 mail_not_configured，一張都不會寄出", async () => {
    const res = await as(adminToken, request(app).post("/payslips/send-batch")).send({ period: "2027-07" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("mail_not_configured")

    const { data } = await supabaseAdmin
      .from("payslips")
      .select("id, sent_at")
      .eq("tenant_id", tenantId)
    expect((data ?? []).every((r) => r.sent_at === null)).toBe(true)
  })

  it("查無／跨租戶 id → 404；period 格式錯 → 400", async () => {
    const missing = await as(adminToken, request(app).post("/payslips/00000000-0000-4000-8000-000000000999/send"))
    expect(missing.status).toBe(404)
    const bad = await as(adminToken, request(app).post("/payslips/send-batch")).send({ period: "2027/07" })
    expect(bad.status).toBe(400)
  })

  it("非 HR 不得寄送（員工本人也不行）→ 403", async () => {
    const res = await as(empToken, request(app).post(`/payslips/${finalizedId}/send`))
    expect(res.status).toBe(403)
    const batch = await as(empToken, request(app).post("/payslips/send-batch")).send({ period: "2027-07" })
    expect(batch.status).toBe(403)
  })

  it("GET /payslips 回 sent_at／sent_to（未寄送＝null），員工看得到自己的", async () => {
    const hr = await as(adminToken, request(app).get(`/payslips?period=${PERIOD}`))
    expect(hr.status).toBe(200)
    const row = (hr.body.payslips as Array<Record<string, unknown>>).find((p) => p.id === draftId)!
    expect(row).toBeTruthy()
    expect(row.sent_at).toBeNull()
    expect(row.sent_to).toBeNull()

    const mine = await as(empToken, request(app).get("/payslips"))
    expect(mine.status).toBe(200)
    expect((mine.body.payslips as Array<Record<string, unknown>>).some((p) => p.id === finalizedId)).toBe(true)
    expect((mine.body.payslips as Array<Record<string, unknown>>)[0]).toHaveProperty("sent_at")
  })
})
