import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * 租戶「允許 HR 配發簡單初始密碼」— live 合約測試（仿 auth-accounts-live.test.ts）。
 *
 * 前提：Supabase 專案開著 password_hibp_enabled（外洩密碼名單），GoTrue 連 admin API 的
 * createUser／updateUserById 帶明文 password 都會回 422 weak_password。本檔用 asterbest
 * 這種常見密碼驗證：
 *   預設（未開）→ POST /employees 帶弱密碼 422 weak_password＋hint=allow_weak_initial_password
 *   → PUT /api/tenant/settings 開 features.accounts.allowWeakInitialPassword（既有 features 鍵保留）
 *   → 再建 201（走 password_hash）、用該弱密碼走 password grant 登入 200、must_change_password=true
 *   → reset-password 自填弱密碼：即使開關開著也 422＋hint=use_generated_password、密碼沒變
 *     （GoTrue updateUserById 不吃 password_hash，沒有略過 HIBP 的重設路徑；見 services/password-policy.ts）
 *   → 員工自己走 /me/password 改成弱密碼仍被 GoTrue 擋（自設路徑不受此開關影響）
 *   → reset-password 不帶 body 仍回一組後端產生的密碼且可登入
 *   → 關掉開關後 POST /employees 弱密碼又回 422＋hint=allow_weak_initial_password。
 *
 * 正式庫尚未套 0042（employees.must_change_password 不存在）時整組跳過。
 * email 一律 `weakpw-${stamp}-*@example.com`（example.com 不會投遞）；結束時清掉租戶與 auth user。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

/** 常見密碼：在 HIBP 名單上（業主實際踩到的那組）。長度 ≥ 8 才過得了 zod。 */
const WEAK_PASSWORD = "asterbest"
/** 第二組常見密碼，reset／自設用（要跟上一組不同才證明「沒被改掉」）。 */
const WEAK_PASSWORD_2 = "qwerty123456"

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
const EMP_EMAIL = `weakpw-${stamp}-emp@example.com`
const EMP2_EMAIL = `weakpw-${stamp}-emp2@example.com`
let empId: string
/** 該員工目前的密碼（每個案例改完就更新，給下一個案例登入用）。 */
let empPassword: string

/** Supabase password grant；成功回 access_token，失敗回 null（讓案例自己 expect）。 */
async function passwordGrant(email: string, password: string): Promise<string | null> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) return null
  return data.session.access_token
}
async function signIn(email: string, password: string): Promise<string> {
  const token = await passwordGrant(email, password)
  if (!token) throw new Error(`signIn(${email}) failed`)
  return token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
function createWeak(email: string) {
  return as(adminToken, request(app).post("/employees")).send({
    email,
    name: `weakpw-${stamp}`,
    password: WEAK_PASSWORD,
    role: "employee",
  })
}
async function setAllowWeak(enabled: boolean) {
  const res = await as(adminToken, request(app).put("/api/tenant/settings")).send({
    features: { accounts: { allowWeakInitialPassword: enabled } },
  })
  expect(res.status).toBe(200)
  return res.body as { features: Record<string, unknown> }
}
async function mustChangePasswordOf(id: string): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin.from("employees").select("must_change_password").eq("id", id).single()
  if (error) throw new Error(`employees.must_change_password: ${error.message}`)
  return (data?.must_change_password as boolean | null) ?? null
}

describe.skipIf(!ready)("租戶允許 HR 配發簡單初始密碼 — live", () => {
  beforeAll(async () => {
    const adminEmail = `weakpw-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `WEAKPW ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.add(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)
  }, 60_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      const { data: emps } = await supabaseAdmin.from("employees").select("user_id").eq("tenant_id", tid)
      for (const e of emps ?? []) if (e.user_id) createdUserIds.add(e.user_id as string)
      await supabaseAdmin.from("employee_profiles").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      // audit_logs 放在 employees 之後、tenants 之前（同 auth-accounts-live：刪員工會再觸發 audit trigger）。
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 60_000)

  it("預設（未開）：POST /employees 帶常見密碼 → 422 weak_password＋hint，message 保留 GoTrue 原文", async () => {
    const res = await createWeak(EMP_EMAIL)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe("weak_password")
    expect(res.body.hint).toBe("allow_weak_initial_password")
    expect(typeof res.body.message).toBe("string")
    expect(res.body.message.length).toBeGreaterThan(0)
    // 沒建出半個員工列
    const { data } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("name", `weakpw-${stamp}`)
    expect(data ?? []).toHaveLength(0)
  })

  it("PUT /api/tenant/settings 開 accounts.allowWeakInitialPassword → 200，既有 features 鍵保留", async () => {
    const body = await setAllowWeak(true)
    expect(body.features.accounts).toEqual({ allowWeakInitialPassword: true })
    // provisionTenant 種的預設鍵（payroll/kpi/ai_assistant）淺層合併後還在
    expect(body.features.payroll).toBe(true)
  })

  it("開啟後：同一組常見密碼 POST /employees → 201，password grant 登入 200，must_change_password=true", async () => {
    const res = await createWeak(EMP_EMAIL)
    expect(res.status).toBe(201)
    expect(typeof res.body.employeeId).toBe("string")
    expect(typeof res.body.userId).toBe("string")
    empId = res.body.employeeId
    createdUserIds.add(res.body.userId)
    empPassword = WEAK_PASSWORD

    expect(await passwordGrant(EMP_EMAIL, WEAK_PASSWORD)).not.toBeNull()
    await expect(mustChangePasswordOf(empId)).resolves.toBe(true)
  })

  it("開啟後：reset-password 自填常見密碼 → 仍 422 weak_password＋hint=use_generated_password，密碼沒變", async () => {
    const res = await as(adminToken, request(app).post(`/employees/${empId}/reset-password`)).send({
      password: WEAK_PASSWORD_2,
    })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe("weak_password")
    expect(res.body.hint).toBe("use_generated_password")
    expect(typeof res.body.message).toBe("string")

    expect(await passwordGrant(EMP_EMAIL, empPassword)).not.toBeNull()
    expect(await passwordGrant(EMP_EMAIL, WEAK_PASSWORD_2)).toBeNull()
    await expect(mustChangePasswordOf(empId)).resolves.toBe(true)
  })

  it("員工自設密碼（POST /me/password）改成常見密碼仍被 GoTrue 擋：非 200，舊密碼仍可登入、新的不行", async () => {
    const empToken = await signIn(EMP_EMAIL, empPassword)
    const res = await as(empToken, request(app).post("/me/password")).send({
      currentPassword: empPassword,
      newPassword: WEAK_PASSWORD_2,
    })
    expect(res.status).not.toBe(200)
    // 密碼沒被換掉、旗標沒被清
    expect(await passwordGrant(EMP_EMAIL, empPassword)).not.toBeNull()
    expect(await passwordGrant(EMP_EMAIL, WEAK_PASSWORD_2)).toBeNull()
    await expect(mustChangePasswordOf(empId)).resolves.toBe(true)
  })

  it("開啟後：reset-password 不帶 body → 200 回後端產生的密碼且可登入，舊密碼失效", async () => {
    const res = await as(adminToken, request(app).post(`/employees/${empId}/reset-password`)).send({})
    expect(res.status).toBe(200)
    expect(typeof res.body.password).toBe("string")
    expect(res.body.password).toMatch(/^Aster-/)
    expect(await passwordGrant(EMP_EMAIL, res.body.password)).not.toBeNull()
    expect(await passwordGrant(EMP_EMAIL, empPassword)).toBeNull()
    empPassword = res.body.password
    await expect(mustChangePasswordOf(empId)).resolves.toBe(true)
  })

  it("關掉開關後：POST /employees 帶常見密碼又回 422 weak_password＋hint=allow_weak_initial_password", async () => {
    const body = await setAllowWeak(false)
    expect(body.features.accounts).toEqual({ allowWeakInitialPassword: false })

    const res = await createWeak(EMP2_EMAIL)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe("weak_password")
    expect(res.body.hint).toBe("allow_weak_initial_password")
  })
})
