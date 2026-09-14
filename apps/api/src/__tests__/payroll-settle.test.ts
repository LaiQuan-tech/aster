import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { computeAttendanceDay, type RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

interface Tenant {
  name: string
  tenantId: string
  adminEmail: string
  adminPassword: string
  adminToken: string
}

let A: Tenant
let B: Tenant

// A plain employee under tenant A (role='employee') with their own auth token —
// proves salary/attendance reads are self-scoped and that settle is HR-only.
let aEmployeeEmail: string
let aEmployeePassword: string
let aEmployeeToken: string
let aEmployeeId: string
let aEmployeeUserId: string

// A valid rule-config DSL the HR admin will PUT. night window 00:00–08:30 ×2,
// dailyRegularHours 8 — matches what the engine reads during settlement.
const VALID_DSL: RuleConfig = {
  attendance_bonus: {
    base: 2000,
    tiers: [
      { lateMinutesUpTo: 5, deduct: 0 },
      { lateMinutesUpTo: null, deduct: 600 },
    ],
  },
  overtime: {
    rules: [
      { when: "weekday_ot", multiplier: 1.34 },
      { when: "rest_day", multiplier: 1.67 },
      { when: "fixed_holiday", multiplier: 2 },
    ],
  },
  night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
  payroll: { method: "monthly", overtimeFlatHourly: undefined, dailyRegularHours: 8 },
}

async function buildTenant(label: string): Promise<Tenant> {
  const name = `PAYTEST ${label} ${stamp}`
  const adminEmail = `pay-${stamp}-${label}-admin@example.com`
  const adminPassword = `Pw-${stamp}-${label}-Aa1!`

  const { tenantId, userId } = await provisionTenant({ name, adminEmail, adminPassword })
  createdTenantIds.push(tenantId)
  createdUserIds.push(userId)

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data: signIn, error } = await anon.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  })
  if (error || !signIn.session) {
    throw new Error(`buildTenant(${label}): admin sign-in failed: ${error?.message}`)
  }
  expect(signIn.user?.app_metadata?.tenant_id).toBe(tenantId)

  return { name, tenantId, adminEmail, adminPassword, adminToken: signIn.session.access_token }
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

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run payroll-settle test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  // A real employee (own auth user + token) under A.
  aEmployeeEmail = `pay-${stamp}-a-emp@example.com`
  aEmployeePassword = `Pw-${stamp}-emp-Bb2!`
  const empRes = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({
      email: aEmployeeEmail,
      name: "Alice Payroll",
      password: aEmployeePassword,
      role: "employee",
    })
  if (empRes.status !== 201) {
    throw new Error(`beforeAll: create A employee failed (${empRes.status})`)
  }
  aEmployeeId = empRes.body.employeeId
  aEmployeeUserId = empRes.body.userId
  createdUserIds.push(aEmployeeUserId)
  aEmployeeToken = await signIn(aEmployeeEmail, aEmployeePassword)
}, 60_000)

afterAll(async () => {
  // attendance_days → salary_structures → rule_configs → punch_records →
  // schedules → shifts → employees → tenants → auth users (FK-safe order).
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("salary_structures").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("rule_configs").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("punch_records").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("schedules").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("shifts").delete().eq("tenant_id", tid)
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
}, 60_000)

describe("F2 rule-config — validate via @hr/rules + upsert active", () => {
  it("GET /rule-config (no config yet) returns a default template", async () => {
    const res = await request(app)
      .get("/rule-config")
      .set("Authorization", `Bearer ${A.adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.config).toBeTruthy()
    // The default template must itself be a valid DSL (parseable shape).
    expect(res.body.config.payroll).toBeTruthy()
    expect(res.body.config.night?.window).toBeTruthy()
  })

  it("PUT /rule-config with a valid DSL → 200, then GET returns it", async () => {
    const put = await request(app)
      .put("/rule-config")
      .set("Authorization", `Bearer ${A.adminToken}`)
      // C4：不給 effectiveFrom 現在預設下個月1號生效，這裡要驗「馬上 GET 回剛存的」，
      // 必須明講 now，否則 GET 會落回 DEFAULT_RULE_CONFIG（這版還沒生效）。
      .send({ ...VALID_DSL, effectiveFrom: "now" })
    expect(put.status).toBe(200)

    const get = await request(app)
      .get("/rule-config")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    expect(get.body.config.night.window.from).toBe("00:00")
    expect(get.body.config.night.window.to).toBe("08:30")
    expect(get.body.config.payroll.dailyRegularHours).toBe(8)

    // Exactly one active row for the tenant.
    const { data } = await supabaseAdmin
      .from("rule_configs")
      .select("id, active")
      .eq("tenant_id", A.tenantId)
      .eq("active", true)
    expect(data?.length).toBe(1)
  })

  it("PUT /rule-config a second time still keeps exactly one active row", async () => {
    const put = await request(app)
      .put("/rule-config")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ ...VALID_DSL, night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 } })
    expect(put.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("rule_configs")
      .select("id")
      .eq("tenant_id", A.tenantId)
      .eq("active", true)
    expect(data?.length).toBe(1)
  })

  it("PUT /rule-config with an INVALID DSL → 400", async () => {
    const res = await request(app)
      .put("/rule-config")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ night: { window: { from: "nope", to: "08:30" } }, payroll: { method: "weird" } })
    expect(res.status).toBe(400)
  })

  it("PUT /rule-config as a plain employee → 403", async () => {
    const res = await request(app)
      .put("/rule-config")
      .set("Authorization", `Bearer ${aEmployeeToken}`)
      .send(VALID_DSL)
    expect(res.status).toBe(403)
  })
})

describe("F2 salary structures — HR upsert + read", () => {
  it("PUT /salary/:employeeId sets the structure → 200, GET returns it", async () => {
    const put = await request(app)
      .put(`/salary/${aEmployeeId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        method: "monthly",
        baseSalary: 36000,
        hourlyWage: 200,
        allowances: { meal: 2400 },
      })
    expect(put.status).toBe(200)

    const get = await request(app)
      .get(`/salary/${aEmployeeId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    // The API returns the raw row (snake_case), consistent with the other routes.
    expect(Number(get.body.salary.hourly_wage)).toBe(200)
    expect(Number(get.body.salary.base_salary)).toBe(36000)
    expect(get.body.salary.method).toBe("monthly")
    expect(get.body.salary.allowances.meal).toBe(2400)
  })

  it("PUT /salary/:employeeId again upserts (no duplicate row)", async () => {
    const put = await request(app)
      .put(`/salary/${aEmployeeId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ hourlyWage: 220 })
    expect(put.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("salary_structures")
      .select("id, hourly_wage")
      .eq("tenant_id", A.tenantId)
      .eq("employee_id", aEmployeeId)
    expect(data?.length).toBe(1)
    expect(Number(data?.[0].hourly_wage)).toBe(220)

    // Reset to 200 for the settlement section that follows.
    await request(app)
      .put(`/salary/${aEmployeeId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ hourlyWage: 200 })
  })

  it("PUT /salary/:employeeId as a plain employee → 403", async () => {
    const res = await request(app)
      .put(`/salary/${aEmployeeId}`)
      .set("Authorization", `Bearer ${aEmployeeToken}`)
      .send({ hourlyWage: 999 })
    expect(res.status).toBe(403)
  })
})

describe("F2 worktime settlement — wired @hr/rules engine", () => {
  const workDate = "2026-08-03"
  let shiftId: string

  it("settles a punched day into attendance_days with engine-computed minutes", async () => {
    // 1) shift 09:00 start, break 60.
    const shiftRes = await request(app)
      .post("/shifts")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ name: `Pay Shift ${stamp}`, startTime: "09:00", endTime: "18:00", breakMinutes: 60 })
    expect(shiftRes.status).toBe(201)
    shiftId = shiftRes.body.id

    // 2) schedule that shift for the employee on workDate.
    const schedRes = await request(app)
      .post("/schedules")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: aEmployeeId, workDate, shiftId })
    expect(schedRes.status).toBe(201)

    // 3) punches: in 09:10, out 19:00 on the tenant's clock (Asia/Taipei =
    //    UTC+8 → 01:10Z / 11:00Z). Insert directly so we control exact
    //    timestamps (the punch API would stamp 'now').
    const { error: pErr } = await supabaseAdmin.from("punch_records").insert([
      {
        tenant_id: A.tenantId,
        employee_id: aEmployeeId,
        type: "in",
        source: "web",
        punch_at: `${workDate}T01:10:00.000Z`,
      },
      {
        tenant_id: A.tenantId,
        employee_id: aEmployeeId,
        type: "out",
        source: "web",
        punch_at: `${workDate}T11:00:00.000Z`,
      },
    ])
    expect(pErr).toBeNull()

    // 4) settle the window.
    const settleRes = await request(app)
      .post("/attendance/settle")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ from: workDate, to: workDate })
    expect(settleRes.status).toBe(200)
    expect(settleRes.body.settled).toBeGreaterThanOrEqual(1)

    // 5) GET the settled day.
    const get = await request(app)
      .get(`/attendance-days?employeeId=${aEmployeeId}&from=${workDate}&to=${workDate}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(get.status).toBe(200)
    const rows = get.body.attendanceDays as Array<{
      work_date: string
      worked_minutes: number
      late_minutes: number
      overtime_minutes: number
      night_minutes: number
    }>
    const day = rows.find((r) => r.work_date === workDate)
    expect(day).toBeTruthy()

    // 6) Cross-check against the engine itself (single source of truth). The
    //    settlement projects the stored UTC instants onto the tenant's clock
    //    (Asia/Taipei), so we feed the engine the matching naive wall-clock
    //    times (no 'Z' → 09:10 / 19:00 on the engine's local clock).
    const expected = computeAttendanceDay(
      { inAt: `${workDate}T09:10:00`, outAt: `${workDate}T19:00:00` },
      { start: "09:00", end: "18:00", breakMinutes: 60 },
      VALID_DSL,
      { date: workDate, dayType: "workday" },
    )
    expect(day!.late_minutes).toBe(10)
    expect(day!.late_minutes).toBe(expected.lateMinutes)
    expect(day!.worked_minutes).toBe(expected.workedMinutes)
    expect(day!.overtime_minutes).toBe(expected.overtimeMinutes)
    expect(day!.night_minutes).toBe(expected.nightMinutes)
  })

  it("re-settling the same window is idempotent (updates, no duplicate row)", async () => {
    const settleRes = await request(app)
      .post("/attendance/settle")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: aEmployeeId, from: workDate, to: workDate })
    expect(settleRes.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("attendance_days")
      .select("id")
      .eq("tenant_id", A.tenantId)
      .eq("employee_id", aEmployeeId)
      .eq("work_date", workDate)
    expect(data?.length).toBe(1)
  })

  it("GET /attendance-days (employee) returns ONLY their own rows", async () => {
    const res = await request(app)
      .get(`/attendance-days?from=${workDate}&to=${workDate}`)
      .set("Authorization", `Bearer ${aEmployeeToken}`)
    expect(res.status).toBe(200)
    const rows = res.body.attendanceDays as Array<{ employee_id: string }>
    expect(rows.every((r) => r.employee_id === aEmployeeId)).toBe(true)
  })
})

describe("F2 authorization & cross-tenant isolation", () => {
  it("POST /attendance/settle as a plain employee → 403", async () => {
    const res = await request(app)
      .post("/attendance/settle")
      .set("Authorization", `Bearer ${aEmployeeToken}`)
      .send({ from: "2026-08-01", to: "2026-08-31" })
    expect(res.status).toBe(403)
  })

  it("A's HR GET /attendance-days never sees tenant B's rows", async () => {
    // Seed a B attendance row directly.
    const { data: bEmp, error: bErr } = await supabaseAdmin
      .from("employees")
      .insert({ tenant_id: B.tenantId, name: `B Emp ${stamp}`, role: "employee" })
      .select("id")
      .single()
    expect(bErr).toBeNull()
    const bEmployeeId = bEmp!.id as string

    const { error: adErr } = await supabaseAdmin.from("attendance_days").insert({
      tenant_id: B.tenantId,
      employee_id: bEmployeeId,
      work_date: "2026-08-03",
      worked_minutes: 480,
      day_type: "workday",
    })
    expect(adErr).toBeNull()

    const res = await request(app)
      .get(`/attendance-days?from=2026-08-01&to=2026-08-31`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const rows = res.body.attendanceDays as Array<{ tenant_id: string; employee_id: string }>
    expect(rows.every((r) => r.tenant_id === A.tenantId)).toBe(true)
    expect(rows.some((r) => r.employee_id === bEmployeeId)).toBe(false)
  })

  it("GET /salary/:employeeId for tenant B's employee returns 404 to A's HR", async () => {
    // A's HR cannot read a B employee's salary (cross-tenant) — 404 not found.
    const { data: bEmp } = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("tenant_id", B.tenantId)
      .limit(1)
      .maybeSingle()
    if (bEmp?.id) {
      const res = await request(app)
        .get(`/salary/${bEmp.id}`)
        .set("Authorization", `Bearer ${A.adminToken}`)
      expect(res.status).toBe(404)
    }
  })
})
