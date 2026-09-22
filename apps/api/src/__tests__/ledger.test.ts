import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

/**
 * 特休週年制（W1，migration 0050）：`leave_balances` 加了 period_start／period_end／
 * source／note，唯一鍵改成 (tenant, employee, leave_type, period_start)。正式庫還沒套
 * 之前 API 會退回曆年語意，所以期間斷言用探測結果分支——套完自動改跑週年斷言。
 */
async function leaveBalancePeriodReady(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const r = await supabaseAdmin.from("leave_balances").select("period_start, period_end, source").limit(1)
  return !r.error
}
const PERIOD_READY = await leaveBalancePeriodReady()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

interface Tenant {
  name: string
  tenantId: string
  adminEmail: string
  adminPassword: string
  adminToken: string
  hrEmpId: string
}

let A: Tenant
let B: Tenant

// Tenant A cast:
//   emp1 — files leave/ot requests (role 'employee').
//   mgr  — the approver (role 'manager').
let emp1Id: string
let emp1Token: string
let mgrId: string
let mgrToken: string

// Tenant A's '特休' leave type + the year under test.
let annualTypeId: string
const YEAR = new Date().getUTCFullYear()

// A rule-config DSL where weekday overtime converts to comp-time (compTime:true)
// — exactly the path the OT approval must detect to post an earned ledger row.
const COMP_DSL = {
  attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
  overtime: {
    rules: [
      { when: "weekday_ot", multiplier: 1.34, compTime: true },
      { when: "rest_day", multiplier: 1.67 },
      { when: "fixed_holiday", multiplier: 2 },
    ],
  },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly", dailyRegularHours: 8 },
}

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) {
    throw new Error(`signIn(${email}) failed: ${error?.message}`)
  }
  return data.session.access_token
}

async function buildTenant(label: string): Promise<Tenant> {
  const name = `LEDGER ${label} ${stamp}`
  const adminEmail = `ledger-${stamp}-${label}-admin@example.com`
  const adminPassword = `Pw-${stamp}-${label}-Aa1!`

  const { tenantId, userId } = await provisionTenant({ name, adminEmail, adminPassword })
  createdTenantIds.push(tenantId)
  createdUserIds.push(userId)

  const adminToken = await signIn(adminEmail, adminPassword)

  const { data: hrEmp, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single()
  if (hrErr || !hrEmp) {
    throw new Error(`buildTenant(${label}): resolve hr employee failed: ${hrErr?.message}`)
  }

  return { name, tenantId, adminEmail, adminPassword, adminToken, hrEmpId: hrEmp.id as string }
}

async function createEmployee(
  adminToken: string,
  email: string,
  password: string,
  name: string,
  role: string,
): Promise<{ employeeId: string; token: string }> {
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, name, password, role })
  if (res.status !== 201) {
    throw new Error(`createEmployee(${email}) failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  createdUserIds.push(res.body.userId)
  const token = await signIn(email, password)
  return { employeeId: res.body.employeeId, token }
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run ledger test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  const e1 = await createEmployee(
    A.adminToken,
    `ledger-${stamp}-a-emp1@example.com`,
    `Pw-${stamp}-emp1-Bb2!`,
    "Alice One",
    "employee",
  )
  emp1Id = e1.employeeId
  emp1Token = e1.token

  const m = await createEmployee(
    A.adminToken,
    `ledger-${stamp}-a-mgr@example.com`,
    `Pw-${stamp}-mgr-Cc3!`,
    "Mona Manager",
    "manager",
  )
  mgrId = m.employeeId
  mgrToken = m.token

  // HR creates the '特休' leave type.
  const lt = await request(app)
    .post("/leave-types")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({ code: "annual", name: "特休", paid: true })
  if (lt.status !== 201) throw new Error(`beforeAll: create leave type (${lt.status})`)
  annualTypeId = lt.body.id

  // HR routes both leave and ot approvals to mgr (single step).
  for (const kind of ["leave", "ot"]) {
    const flow = await request(app)
      .put(`/approval-flows/${kind}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })
    if (flow.status !== 200) throw new Error(`beforeAll: PUT approval-flows/${kind} (${flow.status})`)
  }

  // HR saves the comp-time rule config (weekday_ot → compTime).
  // C4：ledger.ts 現在依「加班發生的那個月」選版，這批 OT 請求固定寫死在 YEAR
  // 年7月（見下方 startAt），不是「今天」——effectiveFrom 要對齊 7/1，不能用
  // "now"，否則今天（測試實跑當下的月份）生效的版本蓋不到 7 月的請求，會落回
  // DEFAULT_RULE_CONFIG（沒有 compTime），comp-time 判斷就失準。
  const rules = await request(app)
    .put("/rule-config")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({ ...COMP_DSL, effectiveFrom: `${YEAR}-07-01` })
  if (rules.status !== 200) throw new Error(`beforeAll: PUT rule-config (${rules.status})`)
}, 90_000)

afterAll(async () => {
  // comp_time_ledger → leave_balances → approval_steps → leave_requests →
  // approval_flows → leave_types → rule_configs → employees → tenants → auth users.
  // 送單／簽核會寫 notifications（FK → employees），要先於 employees 清掉。
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("comp_time_ledger").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("leave_balances").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("approval_steps").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("leave_requests").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("approval_flows").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("leave_types").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("rule_configs").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }
}, 90_000)

describe("F4 leave_balances — HR sets entitlement", () => {
  it("HR PUT /leave-balances sets emp1 entitled=80; GET reads back used=0", async () => {
    const put = await request(app)
      .put("/leave-balances")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: emp1Id, leaveTypeId: annualTypeId, year: YEAR, entitled: 80 })
    expect(put.status).toBe(200)

    const get = await request(app)
      .get(`/leave-balances?employeeId=${emp1Id}&year=${YEAR}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    const balances = get.body.balances as Array<{
      leave_type_id: string
      year: number
      entitled: string
      used: string
      period_start?: string
      period_end?: string
      source?: string
    }>
    const annual = balances.find((b) => b.leave_type_id === annualTypeId && b.year === YEAR)
    expect(annual).toBeTruthy()
    expect(Number(annual!.entitled)).toBe(80)
    expect(Number(annual!.used)).toBe(0)
    if (PERIOD_READY) {
      // PUT 沒帶 periodStart → 沿用曆年桶，且來源是 HR 手動（年度給假才是 auto）。
      expect(annual!.period_start).toBe(`${YEAR}-01-01`)
      expect(annual!.period_end).toBe(`${YEAR}-12-31`)
      expect(annual!.source).toBe("manual")
    }
  }, 15_000)

  it("a normal employee cannot set balances → 403", async () => {
    const res = await request(app)
      .put("/leave-balances")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ employeeId: emp1Id, leaveTypeId: annualTypeId, year: YEAR, entitled: 5 })
    expect(res.status).toBe(403)
  })
})

describe("F4 approve leave → debits leave_balances.used", () => {
  it("emp1 files 8h leave; mgr approves → used becomes 8 (remainder 72)", async () => {
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: `${YEAR}-07-01T01:00:00.000Z`,
        endAt: `${YEAR}-07-01T09:00:00.000Z`,
        hours: 8,
        reason: "family",
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId as string

    const approve = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "ok" })
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe("approved")

    const get = await request(app)
      .get(`/leave-balances?employeeId=${emp1Id}&year=${YEAR}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    const rows = get.body.balances as Array<{
      leave_type_id: string
      used: string
      entitled: string
      period_start?: string
      period_end?: string
    }>
    // 週年制下用期間找桶：假單起日（7/1）落在哪一列的 period_start..period_end 就扣哪一列。
    const annual = rows.find(
      (b) =>
        b.leave_type_id === annualTypeId &&
        (!PERIOD_READY ||
          (b.period_start! <= `${YEAR}-07-01` && b.period_end! >= `${YEAR}-07-01`)),
    )
    expect(annual).toBeTruthy()
    expect(Number(annual!.used)).toBe(8)
    expect(Number(annual!.entitled) - Number(annual!.used)).toBe(72)
    // 扣在既有的桶上，不會另開一列。
    expect(rows.filter((b) => b.leave_type_id === annualTypeId)).toHaveLength(1)
  }, 20_000)
})

describe("F4 approve OT (compTime) → credits comp_time_ledger", () => {
  it("emp1 files 2h OT; mgr approves → comp-time balance is 2 (hours_earned 2)", async () => {
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "ot",
        startAt: `${YEAR}-07-02T10:00:00.000Z`,
        endAt: `${YEAR}-07-02T12:00:00.000Z`,
        hours: 2,
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId as string

    const approve = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe("approved")

    const get = await request(app)
      .get(`/comp-time?employeeId=${emp1Id}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    expect(Number(get.body.balance)).toBe(2)
    const entries = get.body.entries as Array<{ hours_earned: string; source_request_id: string }>
    const earned = entries.find((e) => e.source_request_id === reqId)
    expect(earned).toBeTruthy()
    expect(Number(earned!.hours_earned)).toBe(2)
  }, 20_000)
})

describe("F4 comp-time manual adjustment", () => {
  it("HR POST /comp-time/adjust uses 1h → balance drops to 1", async () => {
    const adj = await request(app)
      .post("/comp-time/adjust")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: emp1Id, hoursUsed: 1, note: "took an hour off" })
    expect(adj.status).toBe(201)

    const get = await request(app)
      .get(`/comp-time?employeeId=${emp1Id}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    expect(Number(get.body.balance)).toBe(1)
  }, 15_000)

  it("a normal employee cannot adjust comp-time → 403", async () => {
    const res = await request(app)
      .post("/comp-time/adjust")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ employeeId: emp1Id, hoursEarned: 99 })
    expect(res.status).toBe(403)
  })
})

describe("F4 ledger visibility & cross-tenant isolation", () => {
  it("emp1 GET /comp-time sees only their own balance", async () => {
    const res = await request(app)
      .get("/comp-time")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(res.status).toBe(200)
    // emp1 earned 2 then used 1 → balance 1; all entries are their own.
    expect(Number(res.body.balance)).toBe(1)
    const entries = res.body.entries as Array<{ employee_id: string }>
    expect(entries.every((e) => e.employee_id === emp1Id)).toBe(true)
  }, 15_000)

  it("emp1 GET /leave-balances sees only their own rows", async () => {
    const res = await request(app)
      .get("/leave-balances")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(res.status).toBe(200)
    const balances = res.body.balances as Array<{ employee_id: string }>
    expect(balances.every((b) => b.employee_id === emp1Id)).toBe(true)
  }, 15_000)

  it("A's HR cannot see B's leave_balances", async () => {
    // Seed a balance row in tenant B directly.
    const ltB = await request(app)
      .post("/leave-types")
      .set("Authorization", `Bearer ${B.adminToken}`)
      .send({ code: "annual", name: "特休", paid: true })
    expect(ltB.status).toBe(201)
    const { error: balErr } = await supabaseAdmin.from("leave_balances").insert({
      tenant_id: B.tenantId,
      employee_id: B.hrEmpId,
      leave_type_id: ltB.body.id,
      year: YEAR,
      // 0050 起 period_start/period_end NOT NULL（曆年桶＝整年）
      period_start: `${YEAR}-01-01`,
      period_end: `${YEAR}-12-31`,
      entitled: 50,
    })
    if (balErr) throw new Error(`seed B balance failed: ${balErr.message}`)

    const res = await request(app)
      .get("/leave-balances")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const balances = res.body.balances as Array<{ tenant_id: string; employee_id: string }>
    expect(balances.some((b) => b.employee_id === B.hrEmpId)).toBe(false)
  }, 20_000)

  it("A's HR cannot see B's comp_time_ledger", async () => {
    const { error: ctErr } = await supabaseAdmin.from("comp_time_ledger").insert({
      tenant_id: B.tenantId,
      employee_id: B.hrEmpId,
      hours_earned: 9,
    })
    if (ctErr) throw new Error(`seed B comp-time failed: ${ctErr.message}`)

    const res = await request(app)
      .get(`/comp-time?employeeId=${B.hrEmpId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    // employeeId from another tenant resolves to nothing in A → empty + balance 0.
    expect(Number(res.body.balance)).toBe(0)
    const entries = res.body.entries as Array<{ employee_id: string }>
    expect(entries.some((e) => e.employee_id === B.hrEmpId)).toBe(false)
  }, 20_000)
})
