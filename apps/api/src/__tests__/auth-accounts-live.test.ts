import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { recoveryLinkFor, requestPasswordReset } from "../services/auth-invite"
import { app } from "../app"

/**
 * A1 帳號與邀請信 — live 合約測試（仿 disbursements-live.test.ts）。
 *
 * 全程 dryRun：本機沒有 RESEND_API_KEY，且 body 也帶 dryRun:true，絕不真寄；
 * email 一律 `invite-${stamp}-*@example.com`（example.com 不會投遞）。
 *
 * 流程：throwaway 租戶 → bulk-invite 三行（新建／綁到預建的 user_id null 員工／
 * 同名兩列 → ambiguous_name）→ 對已有帳號者 invite 回 recovery 連結 →
 * send-reset 對沒帳號者 409 → 再貼同一份 CSV 全部 email_already_bound（冪等）
 * → POST /employees 建帳號者 must_change_password=true → /me/password 舊密碼錯 401、
 * 對 200、新密碼可登入、旗標清掉 → /me/password-done → forgot-password 一律 200
 * → intern 的 /me essTabs 預設清單。
 * 另一組「不可被接管」案例：無 tenant_id 的既有帳號／另一租戶的帳號／
 * PLATFORM_ADMIN_EMAILS 白名單 email → invite／bulk-invite／send-reset 一律 409
 * email_in_other_tenant 且對方 app_metadata 不被改寫；forgot-password 只對
 * 「有 tenant_id 且該租戶 employees 綁著」的帳號進寄信流程。
 *
 * 正式庫尚未套 0042（employees.must_change_password 不存在）時整組跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

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
let adminEmpId: string
let bindEmpId: string // 王小明：預建、user_id null，CSV 第二行要綁到它
let ambEmpIds: string[] = [] // 李大同 ×2：同名兩列 → ambiguous_name

const NEW_EMAIL = `invite-${stamp}-new@example.com`
const BIND_EMAIL = `invite-${stamp}-bind@example.com`
const AMB_EMAIL = `invite-${stamp}-amb@example.com`

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}
async function insertEmployee(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .insert({ tenant_id: tenantId, name, role: "employee", employment_type: "regular", status: "active", ...extra })
    .select("id")
    .single()
  if (error || !data) throw new Error(`insertEmployee(${name}): ${error?.message}`)
  return data.id as string
}
async function createWithPassword(name: string, email: string, password: string, extra: Record<string, unknown> = {}) {
  const res = await asAdmin(request(app).post("/employees")).send({ email, name, password, role: "employee", ...extra })
  if (res.status !== 201) throw new Error(`POST /employees failed (${res.status}): ${JSON.stringify(res.body)}`)
  createdUserIds.add(res.body.userId as string)
  return { employeeId: res.body.employeeId as string, userId: res.body.userId as string }
}

describe.skipIf(!ready)("A1 帳號與邀請信 — live", () => {
  beforeAll(async () => {
    const adminEmail = `invite-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const provisioned = await provisionTenant({ name: `INVITETEST ${stamp}`, adminEmail, adminPassword })
    tenantId = provisioned.tenantId
    createdTenantIds.push(tenantId)
    createdUserIds.add(provisioned.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", provisioned.userId).single()
    adminEmpId = hr!.id as string

    bindEmpId = await insertEmployee("王小明", { emp_no: "E001" })
    ambEmpIds = [await insertEmployee("李大同"), await insertEmployee("李大同")]
  })

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      // bulk-invite 建的 auth user 沒經過我們的手，從 employees.user_id 撈回來一起刪。
      const { data: emps } = await supabaseAdmin.from("employees").select("user_id").eq("tenant_id", tid)
      for (const e of emps ?? []) if (e.user_id) createdUserIds.add(e.user_id as string)
      await supabaseAdmin.from("employee_profiles").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      // audit_logs 放在 employees 之後、tenants 之前：刪員工會再觸發 audit trigger 寫新列（employees 掛 audit_all），
      // 先刪 audit_logs 會留孤兒；tenants 刪掉後 is_disposable_tenant 回 false，append-only trigger 就不放行了。
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("批次邀請（CSV）", () => {
    it("3 行：1 新建、1 綁到預建列、1 同名兩列 → ambiguous；counts 正確、user_id 已綁、must_change_password=false", async () => {
      const csv = [
        "﻿name,email,empNo,deptName,employmentType,hireDate,role",
        `"陳, 新人",${NEW_EMAIL},E100,不存在的部門,regular,2026-09-15,employee`,
        `王小明,${BIND_EMAIL},,,,,`,
        `李大同,${AMB_EMAIL},,,,,`,
      ].join("\r\n")
      const res = await asAdmin(request(app).post("/employees/bulk-invite")).send({ csv, dryRun: true })
      expect(res.status).toBe(200)
      expect(res.body.dryRun).toBe(true)
      expect(res.body.created).toBe(1)
      expect(res.body.bound).toBe(1)
      expect(res.body.invited).toBe(2)
      expect(res.body.sent).toBe(0)
      expect(res.body.skipped).toBe(1)
      expect(res.body.errors).toHaveLength(1)
      expect(res.body.errors[0].line).toBe(4)
      expect(res.body.errors[0].error).toMatch(/^ambiguous_name/)

      const rows = res.body.rows as Array<Record<string, unknown>>
      const created = rows.find((r) => r.email === NEW_EMAIL)!
      expect(created.action).toBe("created")
      expect(created.type).toBe("invite")
      expect(created.name).toBe("陳, 新人") // 引號包住的逗號要保留
      expect(String(created.link)).toContain("/auth/set-password?token_hash=")
      expect(String(created.link)).toContain("type=invite")
      expect(String(created.warning)).toMatch(/^dept_not_found/)
      const bound = rows.find((r) => r.email === BIND_EMAIL)!
      expect(bound.action).toBe("bound")
      expect(bound.type).toBe("invite")
      expect(String(bound.link)).toContain("type=invite")

      // DB：綁定列 user_id 已填、旗標 false；新建列欄位齊全。
      const { data: bindRow } = await supabaseAdmin
        .from("employees")
        .select("user_id, must_change_password, emp_no")
        .eq("id", bindEmpId)
        .single()
      expect(bindRow!.user_id).toBeTruthy()
      expect(bindRow!.must_change_password).toBe(false)
      expect(bindRow!.emp_no).toBe("E001") // 既有工號不被覆蓋
      const { data: newRow } = await supabaseAdmin
        .from("employees")
        .select("user_id, must_change_password, emp_no, hire_date, dept_id, role, employment_type, status")
        .eq("tenant_id", tenantId)
        .eq("name", "陳, 新人")
        .single()
      expect(newRow!.user_id).toBeTruthy()
      expect(newRow!.must_change_password).toBe(false)
      expect(newRow!.emp_no).toBe("E100")
      expect(newRow!.hire_date).toBe("2026-09-15")
      expect(newRow!.dept_id).toBeNull()
      expect(newRow!.status).toBe("active")
      // 同名兩列都還沒綁。
      const { data: amb } = await supabaseAdmin.from("employees").select("user_id").in("id", ambEmpIds)
      expect(amb!.every((r) => r.user_id === null)).toBe(true)

      // auth user 的 app_metadata.tenant_id 與 POST /employees 一致。
      const { data: au } = await supabaseAdmin.auth.admin.getUserById(bindRow!.user_id as string)
      expect(au.user?.app_metadata?.tenant_id).toBe(tenantId)
      expect(au.user?.email).toBe(BIND_EMAIL)
    })

    it("同一份 CSV 再貼一次 → 兩行皆 email_already_bound 跳過（冪等，不重複建列）", async () => {
      const csv = ["name,email", `陳新人,${NEW_EMAIL}`, `王小明,${BIND_EMAIL}`].join("\n")
      const res = await asAdmin(request(app).post("/employees/bulk-invite")).send({ csv, dryRun: true })
      expect(res.status).toBe(200)
      expect(res.body.created).toBe(0)
      expect(res.body.bound).toBe(0)
      expect(res.body.skipped).toBe(2)
      expect(res.body.errors.map((e: { error: string }) => e.error.split(":")[0])).toEqual([
        "email_already_bound",
        "email_already_bound",
      ])
      const { count } = await supabaseAdmin
        .from("employees")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
      expect(count).toBe(5) // admin + 王小明 + 李大同×2 + 陳, 新人
    })

    it("表頭缺 email → 400 invalid_header；壞行不拖累好行", async () => {
      const bad = await asAdmin(request(app).post("/employees/bulk-invite")).send({ csv: "name\n某人", dryRun: true })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("invalid_header")

      const mixed = ["name,email,hireDate", `壞日期,invite-${stamp}-baddate@example.com,2026/09/15`, `,invite-${stamp}-noname@example.com,`].join("\n")
      const res = await asAdmin(request(app).post("/employees/bulk-invite")).send({ csv: mixed, dryRun: true })
      expect(res.status).toBe(200)
      expect(res.body.skipped).toBe(2)
      expect(res.body.errors[0]).toEqual({ line: 2, error: "hireDate 須為 YYYY-MM-DD" })
      expect(res.body.errors[1]).toEqual({ line: 3, error: "name 必填" })
    })

    it("非 HR → 403", async () => {
      const empEmail = `invite-${stamp}-plain@example.com`
      const empPassword = `Pw-${stamp}-Cc3!`
      await createWithPassword("一般員工", empEmail, empPassword)
      const token = await signIn(empEmail, empPassword)
      const res = await request(app)
        .post("/employees/bulk-invite")
        .set("Authorization", `Bearer ${token}`)
        .send({ csv: "name,email\nx,x@example.com", dryRun: true })
      expect(res.status).toBe(403)
    })
  })

  describe("單筆邀請 / 重設密碼信", () => {
    it("對已有帳號者 invite → recovery 類型連結（dryRun link 含 type=recovery）", async () => {
      const res = await asAdmin(request(app).post(`/employees/${adminEmpId}/invite`)).send({ dryRun: true })
      expect(res.status).toBe(200)
      expect(res.body.sent).toBe(false)
      expect(res.body.dryRun).toBe(true)
      expect(res.body.type).toBe("recovery")
      expect(res.body.action).toBe("existing")
      expect(res.body.email).toBe(`invite-${stamp}-admin@example.com`)
      expect(String(res.body.link)).toContain("type=recovery")
      expect(String(res.body.link)).toMatch(/^https?:\/\/.+\/auth\/set-password\?token_hash=[0-9a-f]+&type=recovery$/)
    })

    it("send-reset 對沒帳號者 409 no_account；invite 對沒 email 者 409 no_email；404 找不到", async () => {
      const noAccount = await asAdmin(request(app).post(`/employees/${ambEmpIds[0]}/send-reset`)).send({ dryRun: true })
      expect(noAccount.status).toBe(409)
      expect(noAccount.body.error).toBe("no_account")

      const noEmail = await asAdmin(request(app).post(`/employees/${ambEmpIds[0]}/invite`)).send({ dryRun: true })
      expect(noEmail.status).toBe(409)
      expect(noEmail.body.error).toBe("no_email")

      const missing = await asAdmin(request(app).post(`/employees/00000000-0000-0000-0000-000000000000/invite`)).send({ dryRun: true })
      expect(missing.status).toBe(404)
    })

    it("invite 帶 email 指定信箱 → 綁到該列（invite）；之後 send-reset 走 recovery", async () => {
      const email = `invite-${stamp}-spec@example.com`
      const first = await asAdmin(request(app).post(`/employees/${ambEmpIds[1]}/invite`)).send({ dryRun: true, email })
      expect(first.status).toBe(200)
      expect(first.body.action).toBe("bound")
      expect(first.body.type).toBe("invite")
      expect(String(first.body.link)).toContain("type=invite")
      const reset = await asAdmin(request(app).post(`/employees/${ambEmpIds[1]}/send-reset`)).send({ dryRun: true })
      expect(reset.status).toBe(200)
      expect(reset.body.type).toBe("recovery")
      expect(reset.body.email).toBe(email)
    })
  })

  describe("跨租戶／無 tenant_id 帳號不可被接管（invite／bulk-invite／send-reset／forgot-password）", () => {
    // 無 tenant_id 的既有 auth user：平台操作員的形狀（白名單只認 email、沒 employees 列）。
    const ORPHAN_EMAIL = `invite-${stamp}-orphan@example.com`
    // 另一個 throwaway 租戶的 HR。
    const OTHER_EMAIL = `invite-${stamp}-other-admin@example.com`
    const OTHER_PASSWORD = `Pw-${stamp}-Bb2!`
    // 在白名單裡、但還沒有帳號：租戶 HR 不能「順手」建出這個帳號。
    const PLATFORM_NEW_EMAIL = `invite-${stamp}-platform-new@example.com`
    // 有 tenant_id（本租戶）但沒有任何 employees 列綁著。
    const STRAY_EMAIL = `invite-${stamp}-stray@example.com`
    const ORIGINAL_PLATFORM_ADMIN_EMAILS = process.env.PLATFORM_ADMIN_EMAILS
    let orphanUserId: string
    let otherTenantId: string
    let otherUserId: string
    let otherAdminEmpId: string
    let targetEmpId: string // 本租戶、user_id null：每個案例都拿它當「要綁的那一列」

    beforeAll(async () => {
      const { data: orphan, error: orphanErr } = await supabaseAdmin.auth.admin.createUser({
        email: ORPHAN_EMAIL,
        password: `Pw-${stamp}-Oo0!`,
        email_confirm: true,
      })
      if (orphanErr || !orphan.user) throw new Error(`createUser(orphan): ${orphanErr?.message}`)
      orphanUserId = orphan.user.id
      createdUserIds.add(orphanUserId)

      const other = await provisionTenant({ name: `INVITETEST-OTHER ${stamp}`, adminEmail: OTHER_EMAIL, adminPassword: OTHER_PASSWORD })
      otherTenantId = other.tenantId
      otherUserId = other.userId
      createdTenantIds.push(otherTenantId)
      createdUserIds.add(otherUserId)
      const { data: otherHr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", otherTenantId).eq("user_id", otherUserId).single()
      otherAdminEmpId = otherHr!.id as string

      const { data: stray, error: strayErr } = await supabaseAdmin.auth.admin.createUser({
        email: STRAY_EMAIL,
        password: `Pw-${stamp}-Ss7!`,
        email_confirm: true,
        app_metadata: { tenant_id: tenantId },
      })
      if (strayErr || !stray.user) throw new Error(`createUser(stray): ${strayErr?.message}`)
      createdUserIds.add(stray.user.id)

      targetEmpId = await insertEmployee("接管目標")
    })

    afterAll(() => {
      if (ORIGINAL_PLATFORM_ADMIN_EMAILS === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
      else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_PLATFORM_ADMIN_EMAILS
    })

    async function orphanTenantId(): Promise<unknown> {
      const { data } = await supabaseAdmin.auth.admin.getUserById(orphanUserId)
      return data.user?.app_metadata?.tenant_id
    }
    async function targetUserId(): Promise<string | null> {
      const { data } = await supabaseAdmin.from("employees").select("user_id").eq("id", targetEmpId).single()
      return (data!.user_id as string | null) ?? null
    }

    it("(i) 無 tenant_id 的既有帳號：invite → 409 email_in_other_tenant，app_metadata 未被改寫、員工列仍未綁；bulk-invite 同 email 也跳過", async () => {
      expect(await orphanTenantId()).toBeUndefined()
      const res = await asAdmin(request(app).post(`/employees/${targetEmpId}/invite`)).send({ dryRun: true, email: ORPHAN_EMAIL })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("email_in_other_tenant")
      expect(res.body.link).toBeUndefined()
      expect(res.body.type).toBeUndefined()
      expect(await orphanTenantId()).toBeUndefined() // 不能被「認領」成本租戶
      expect(await targetUserId()).toBeNull()

      const bulk = await asAdmin(request(app).post("/employees/bulk-invite")).send({
        csv: ["name,email", `接管目標,${ORPHAN_EMAIL}`].join("\n"),
        dryRun: true,
      })
      expect(bulk.status).toBe(200)
      expect(bulk.body.invited).toBe(0)
      expect(bulk.body.bound).toBe(0)
      expect(bulk.body.created).toBe(0)
      expect(bulk.body.skipped).toBe(1)
      expect(bulk.body.errors[0].error).toMatch(/^email_in_other_tenant/)
      expect(bulk.body.rows[0].link).toBeUndefined()
      expect(await orphanTenantId()).toBeUndefined()
      expect(await targetUserId()).toBeNull()
    })

    it("(ii) 另一租戶的帳號：invite／bulk-invite → 409 email_in_other_tenant，對方 tenant_id 不變、回應不洩漏對方租戶；對方 HR 自己仍可 send-reset", async () => {
      const res = await asAdmin(request(app).post(`/employees/${targetEmpId}/invite`)).send({ dryRun: true, email: OTHER_EMAIL })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("email_in_other_tenant")
      expect(res.body.link).toBeUndefined()
      expect(JSON.stringify(res.body)).not.toContain(otherTenantId)
      const { data: au } = await supabaseAdmin.auth.admin.getUserById(otherUserId)
      expect(au.user?.app_metadata?.tenant_id).toBe(otherTenantId)
      expect(await targetUserId()).toBeNull()

      const bulk = await asAdmin(request(app).post("/employees/bulk-invite")).send({
        csv: ["name,email", `接管目標,${OTHER_EMAIL}`].join("\n"),
        dryRun: true,
      })
      expect(bulk.status).toBe(200)
      expect(bulk.body.skipped).toBe(1)
      expect(bulk.body.errors[0].error).toMatch(/^email_in_other_tenant/)
      expect(await targetUserId()).toBeNull()

      // 對方租戶的 HR 對自己（已綁、tenant_id 相符）寄重設信：既有行為不受影響。
      const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
      const own = await request(app)
        .post(`/employees/${otherAdminEmpId}/send-reset`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ dryRun: true })
      expect(own.status).toBe(200)
      expect(own.body.type).toBe("recovery")
      expect(own.body.email).toBe(OTHER_EMAIL)
    })

    it("(iii) 本租戶已綁員工 send-reset → 200 recovery（既有行為不變）；列的 user_id 若指向無 tenant_id 的帳號 → send-reset／invite 皆 409", async () => {
      const ok = await asAdmin(request(app).post(`/employees/${adminEmpId}/send-reset`)).send({ dryRun: true })
      expect(ok.status).toBe(200)
      expect(ok.body.type).toBe("recovery")
      expect(ok.body.action).toBe("existing")
      expect(String(ok.body.link)).toContain("type=recovery")

      // 資料層被動過手腳（employees.user_id 直接指到別人的帳號）：「列在本租戶」不夠，
      // app_metadata.tenant_id 也要相符才發連結。
      const hijacked = await insertEmployee("被綁錯的列", { user_id: orphanUserId })
      const reset = await asAdmin(request(app).post(`/employees/${hijacked}/send-reset`)).send({ dryRun: true })
      expect(reset.status).toBe(409)
      expect(reset.body.error).toBe("email_in_other_tenant")
      expect(reset.body.link).toBeUndefined()
      const invite = await asAdmin(request(app).post(`/employees/${hijacked}/invite`)).send({ dryRun: true })
      expect(invite.status).toBe(409)
      expect(invite.body.error).toBe("email_in_other_tenant")
      expect(await orphanTenantId()).toBeUndefined()
    })

    it("(iv) email 在 PLATFORM_ADMIN_EMAILS（大小寫不敏感）→ invite／bulk-invite 409；連尚無帳號的白名單 email 也不會被建出來", async () => {
      process.env.PLATFORM_ADMIN_EMAILS = ` boss@saas.example ,${ORPHAN_EMAIL.toUpperCase()}, ${PLATFORM_NEW_EMAIL.toUpperCase()} `

      const existing = await asAdmin(request(app).post(`/employees/${targetEmpId}/invite`)).send({ dryRun: true, email: ORPHAN_EMAIL })
      expect(existing.status).toBe(409)
      expect(existing.body.error).toBe("email_in_other_tenant")
      expect(await orphanTenantId()).toBeUndefined()

      const fresh = await asAdmin(request(app).post(`/employees/${targetEmpId}/invite`)).send({ dryRun: true, email: PLATFORM_NEW_EMAIL })
      expect(fresh.status).toBe(409)
      expect(fresh.body.error).toBe("email_in_other_tenant")
      expect(fresh.body.link).toBeUndefined()
      expect(await recoveryLinkFor(PLATFORM_NEW_EMAIL)).toBeNull() // 沒有偷建 auth user
      expect(await targetUserId()).toBeNull()

      const bulk = await asAdmin(request(app).post("/employees/bulk-invite")).send({
        csv: ["name,email", `接管目標,${PLATFORM_NEW_EMAIL}`, `平台新人,${PLATFORM_NEW_EMAIL}`].join("\n"),
        dryRun: true,
      })
      expect(bulk.status).toBe(200)
      expect(bulk.body.created).toBe(0)
      expect(bulk.body.bound).toBe(0)
      expect(bulk.body.skipped).toBe(2)
      expect(bulk.body.errors.every((e: { error: string }) => e.error.startsWith("email_in_other_tenant"))).toBe(true)
      expect(await recoveryLinkFor(PLATFORM_NEW_EMAIL)).toBeNull()
      const { count } = await supabaseAdmin
        .from("employees")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("name", "平台新人")
      expect(count).toBe(0)
    })

    it("forgot-password：無 tenant_id／有 tenant_id 但租戶沒綁／白名單 → 不寄（端點仍 200）；本租戶已綁 → 進寄信流程", async () => {
      process.env.PLATFORM_ADMIN_EMAILS = `invite-${stamp}-SPEC@example.com` // 已綁到本租戶（上一組案例），但在白名單

      const orphan = await requestPasswordReset(ORPHAN_EMAIL)
      expect(orphan).toEqual({ sent: false, found: true, throttled: false, eligible: false })
      const stray = await requestPasswordReset(STRAY_EMAIL)
      expect(stray).toEqual({ sent: false, found: true, throttled: false, eligible: false })
      const platform = await requestPasswordReset(`invite-${stamp}-spec@example.com`)
      expect(platform).toEqual({ sent: false, found: false, throttled: false, eligible: false })
      const bound = await requestPasswordReset(BIND_EMAIL) // 王小明：bulk-invite 綁的本租戶帳號
      expect(bound).toMatchObject({ found: true, throttled: false, eligible: true })

      const endpoint = await request(app).post("/auth/forgot-password").send({ email: OTHER_EMAIL })
      expect(endpoint.status).toBe(200)
      expect(endpoint.body).toEqual({ ok: true })
    })
  })

  describe("員工自行改密碼 / 首次登入旗標", () => {
    const email = `invite-${stamp}-chg@example.com`
    const oldPassword = `Pw-${stamp}-Dd4!`
    const newPassword = `Pw-${stamp}-Ee5!New`
    let token: string

    it("POST /employees 建帳號帶密碼 → /me mustChangePassword=true", async () => {
      await createWithPassword("改密碼員工", email, oldPassword)
      token = await signIn(email, oldPassword)
      const me = await request(app).get("/me").set("Authorization", `Bearer ${token}`)
      expect(me.status).toBe(200)
      expect(me.body.mustChangePassword).toBe(true)
      expect(me.body.employmentType).toBe("regular")
      expect(me.body.essTabs).toBeNull()
    })

    it("舊密碼錯 → 401 invalid_current_password；太短 → 400", async () => {
      const wrong = await request(app)
        .post("/me/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: "not-the-password", newPassword })
      expect(wrong.status).toBe(401)
      expect(wrong.body.error).toBe("invalid_current_password")
      const short = await request(app)
        .post("/me/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: oldPassword, newPassword: "short" })
      expect(short.status).toBe(400)
    })

    it("舊密碼對 → 200；新密碼可登入、舊密碼失效、旗標清掉", async () => {
      const ok = await request(app)
        .post("/me/password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword: oldPassword, newPassword })
      expect(ok.status).toBe(200)
      expect(ok.body).toEqual({ ok: true })

      const fresh = await signIn(email, newPassword)
      const me = await request(app).get("/me").set("Authorization", `Bearer ${fresh}`)
      expect(me.status).toBe(200)
      expect(me.body.mustChangePassword).toBe(false)
      await expect(signIn(email, oldPassword)).rejects.toThrow()
    })

    it("reset-password（備援）配暫時密碼 → 旗標回到 true；/me/password-done 清掉", async () => {
      const { data: emp } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("name", "改密碼員工").single()
      const reset = await asAdmin(request(app).post(`/employees/${emp!.id}/reset-password`)).send({})
      expect(reset.status).toBe(200)
      expect(String(reset.body.password)).toMatch(/^Aster-/)
      const tempToken = await signIn(email, reset.body.password as string)
      const before = await request(app).get("/me").set("Authorization", `Bearer ${tempToken}`)
      expect(before.body.mustChangePassword).toBe(true)

      const done = await request(app).post("/me/password-done").set("Authorization", `Bearer ${tempToken}`).send({})
      expect(done.status).toBe(200)
      expect(done.body).toEqual({ ok: true, cleared: true })
      const after = await request(app).get("/me").set("Authorization", `Bearer ${tempToken}`)
      expect(after.body.mustChangePassword).toBe(false)
      const again = await request(app).post("/me/password-done").set("Authorization", `Bearer ${tempToken}`).send({})
      expect(again.body).toEqual({ ok: true, cleared: false })
    })

    it("intern 的 /me essTabs 用預設清單", async () => {
      const iEmail = `invite-${stamp}-intern@example.com`
      const iPassword = `Pw-${stamp}-Ff6!`
      await createWithPassword("實習生", iEmail, iPassword, { employmentType: "intern" })
      const iToken = await signIn(iEmail, iPassword)
      const me = await request(app).get("/me").set("Authorization", `Bearer ${iToken}`)
      expect(me.status).toBe(200)
      expect(me.body.employmentType).toBe("intern")
      expect(me.body.essTabs).toEqual(["home", "schedule", "punches", "requests", "notifications", "mydata"])
    })
  })

  describe("忘記密碼（免登入）", () => {
    it("不存在的 email 也 200 { ok: true }；存在的也 200；格式錯 400", async () => {
      const nobody = await request(app).post("/auth/forgot-password").send({ email: `nobody-${stamp}@example.com` })
      expect(nobody.status).toBe(200)
      expect(nobody.body).toEqual({ ok: true })
      const exists = await request(app).post("/auth/forgot-password").send({ email: `invite-${stamp}-admin@example.com` })
      expect(exists.status).toBe(200)
      expect(exists.body).toEqual({ ok: true })
      const bad = await request(app).post("/auth/forgot-password").send({ email: "not-an-email" })
      expect(bad.status).toBe(400)
    })
  })
})
