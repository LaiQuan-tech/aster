import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * 後台「設定密碼」（POST /employees/:id/reset-password 帶 password）— live 合約測試。
 *
 * 前提：Supabase 專案開著 password_hibp_enabled（外洩密碼名單），GoTrue admin updateUserById
 * 帶像 password123 這種常見密碼會回 422 weak_password。本檔驗兩條路：
 *   (a) 租戶開關（features.accounts.allowWeakInitialPassword）**關**：
 *       - 帶常見密碼 → 422 weak_password＋hint=allow_weak_initial_password（與建帳號一致），密碼沒變
 *       - 帶強密碼 → 200（走 GoTrue）、不回傳密碼；新密碼 password grant 200、舊密碼 400；
 *         must_change_password=true；舊 session 的 refresh token 失效；稽核 reason=hr_set_password/method=gotrue
 *   (b) 開關**開**：帶同一組常見密碼 → 200（走 sql/0038 auth_set_user_password，繞過 GoTrue）；
 *       登入 200、舊密碼 400、must_change_password=true、舊 session 失效、稽核 method=auth_set_user_password
 *   另：password 不足 8 碼 → 400 invalid_body（zod，與建帳號一致）。
 *
 * 正式庫尚未套 must_change_password 欄位時整組跳過。email 一律 `setpw-${stamp}-*@example.com`
 * （example.com 不會投遞）；結束時清掉租戶與 auth user（仿 employees-weak-password-live.test.ts）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

/** 常見密碼：在 HIBP 名單上。長度 ≥ 8 才過得了 zod。 */
const WEAK_PASSWORD = "password123"
/** 建帳號用的強密碼（要過 GoTrue 檢查）。 */
const STRONG_PASSWORD_1 = `Pw-${Date.now()}-Emp-Aa1!`
/** 開關關著時 HR 指定的第二組強密碼。 */
const STRONG_PASSWORD_2 = `Pw-${Date.now()}-Set-Bb2!`

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("employees").select("must_change_password").limit(1)
  return !error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds = new Set<string>()
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
const EMP_EMAIL = `setpw-${stamp}-emp@example.com`
let empId: string
let empUserId: string

interface GrantResult {
  /** 200＝登入成功；否則是 GoTrue 回的 HTTP 狀態（錯密碼是 400）。 */
  status: number
  refreshToken: string | null
}

/** Supabase password grant，回實際狀態碼（供案例逐條記錄）與 refresh token（供驗 session 是否被清）。 */
async function passwordGrant(email: string, password: string): Promise<GrantResult> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) return { status: (error as { status?: number } | null)?.status ?? -1, refreshToken: null }
  return { status: 200, refreshToken: data.session.refresh_token }
}

/** 拿舊 session 的 refresh token 換新 token：session 被清掉後應失敗。回 true＝換到了。 */
async function refreshWorks(refreshToken: string): Promise<boolean> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken })
  return !error && Boolean(data.session)
}

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed`)
  return data.session.access_token
}
function withToken(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
function resetPassword(body: Record<string, unknown>) {
  return withToken(adminToken, request(app).post(`/employees/${empId}/reset-password`)).send(body)
}
async function setAllowWeak(enabled: boolean) {
  const res = await withToken(adminToken, request(app).put("/api/tenant/settings")).send({
    features: { accounts: { allowWeakInitialPassword: enabled } },
  })
  expect(res.status).toBe(200)
}
async function mustChangePasswordOf(id: string): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin.from("employees").select("must_change_password").eq("id", id).single()
  if (error) throw new Error(`employees.must_change_password: ${error.message}`)
  return (data?.must_change_password as boolean | null) ?? null
}
/** 該員工列最近一筆 reset-password 的應用層稽核（new_row 帶 reason／method）。 */
async function latestResetAudit(): Promise<{ must_change_password?: boolean; reason?: string; method?: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("audit_logs")
    .select("new_row, context, at")
    .eq("tenant_id", tenantId)
    .eq("table_name", "employees")
    .eq("record_id", empId)
    .like("context", "POST /employees/:id/reset-password%")
    .order("at", { ascending: false })
    .limit(1)
  if (error) throw new Error(`audit_logs: ${error.message}`)
  const row = data?.[0]
  return row ? ((row.new_row as { must_change_password?: boolean; reason?: string; method?: string } | null) ?? null) : null
}

describe.skipIf(!ready)("後台「設定密碼」（reset-password 帶 password）— live", () => {
  beforeAll(async () => {
    const adminEmail = `setpw-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `SETPW ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.add(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    // 開關預設關：用強密碼建員工（走 GoTrue 明文 password）。
    const res = await withToken(adminToken, request(app).post("/employees")).send({
      email: EMP_EMAIL,
      name: `setpw-${stamp}`,
      password: STRONG_PASSWORD_1,
      role: "employee",
    })
    if (res.status !== 201) throw new Error(`建員工失敗：${res.status} ${JSON.stringify(res.body)}`)
    empId = res.body.employeeId
    empUserId = res.body.userId
    createdUserIds.add(empUserId)
    // 清掉建帳號時設的旗標，後面才驗得出「reset 有把它設回 true」。
    await supabaseAdmin.from("employees").update({ must_change_password: false }).eq("id", empId)
  }, 60_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      const { data: emps } = await supabaseAdmin.from("employees").select("user_id").eq("tenant_id", tid)
      for (const e of emps ?? []) if (e.user_id) createdUserIds.add(e.user_id as string)
      await supabaseAdmin.from("employee_profiles").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      // audit_logs 放在 employees 之後、tenants 之前（刪員工會再觸發 audit trigger）。
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 60_000)

  it("password 不足 8 碼 → 400 invalid_body（zod，與建帳號一致），密碼沒變", async () => {
    const res = await resetPassword({ password: "short" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
    expect((await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_1)).status).toBe(200)
  })

  it("(a) 開關關：帶常見密碼 → 422 weak_password＋hint=allow_weak_initial_password，密碼沒變", async () => {
    const res = await resetPassword({ password: WEAK_PASSWORD })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe("weak_password")
    expect(res.body.hint).toBe("allow_weak_initial_password")
    expect(typeof res.body.message).toBe("string")

    expect((await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_1)).status).toBe(200)
    expect((await passwordGrant(EMP_EMAIL, WEAK_PASSWORD)).status).toBe(400)
    await expect(mustChangePasswordOf(empId)).resolves.toBe(false)
  })

  it("(a) 開關關：帶強密碼 → 200 不回傳密碼；新密碼登入 200、舊密碼 400、must_change_password=true、舊 session 失效、稽核 gotrue", async () => {
    // 先留一個「舊裝置」的 session，驗重設後 refresh 失效。
    const before = await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_1)
    expect(before.status).toBe(200)

    const res = await resetPassword({ password: STRONG_PASSWORD_2 })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(empId)
    expect(res.body.password).toBeUndefined()

    expect((await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_2)).status).toBe(200)
    expect((await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_1)).status).toBe(400)
    await expect(mustChangePasswordOf(empId)).resolves.toBe(true)
    expect(await refreshWorks(before.refreshToken as string)).toBe(false)

    await expect(latestResetAudit()).resolves.toEqual({ must_change_password: true, reason: "hr_set_password", method: "gotrue" })
  })

  it("(b) 開關開：帶常見密碼 → 200（走 auth_set_user_password）；登入 200、舊密碼 400、must_change_password=true、舊 session 失效、稽核 auth_set_user_password", async () => {
    await setAllowWeak(true)
    await supabaseAdmin.from("employees").update({ must_change_password: false }).eq("id", empId)
    const before = await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_2)
    expect(before.status).toBe(200)

    const res = await resetPassword({ password: WEAK_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(empId)
    expect(res.body.password).toBeUndefined()

    expect((await passwordGrant(EMP_EMAIL, WEAK_PASSWORD)).status).toBe(200)
    expect((await passwordGrant(EMP_EMAIL, STRONG_PASSWORD_2)).status).toBe(400)
    await expect(mustChangePasswordOf(empId)).resolves.toBe(true)
    expect(await refreshWorks(before.refreshToken as string)).toBe(false)

    await expect(latestResetAudit()).resolves.toEqual({
      must_change_password: true,
      reason: "hr_set_password",
      method: "auth_set_user_password",
    })
  })

  it("(b) 開關開：不帶 body 仍回一組後端產生的密碼且可登入（暫時密碼那條路不受開關影響），稽核 reason=hr_temp_password", async () => {
    const res = await resetPassword({})
    expect(res.status).toBe(200)
    expect(typeof res.body.password).toBe("string")
    expect(res.body.password).toMatch(/^Aster-/)
    expect((await passwordGrant(EMP_EMAIL, res.body.password)).status).toBe(200)
    expect((await passwordGrant(EMP_EMAIL, WEAK_PASSWORD)).status).toBe(400)
    await expect(latestResetAudit()).resolves.toEqual({ must_change_password: true, reason: "hr_temp_password", method: "gotrue" })
  })

  it("查無此員工 → 404；別租戶看不到（用不存在的 id 模擬）", async () => {
    const res = await withToken(adminToken, request(app).post(`/employees/00000000-0000-0000-0000-000000000000/reset-password`)).send({
      password: WEAK_PASSWORD,
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("not_found")
  })
})
