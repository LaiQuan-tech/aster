import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { computePayslip, type RuleConfig, type AttendanceDay, type SalaryStructure } from "@hr/rules"
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
// proves payslip reads are self-scoped and that payroll-run is HR-only.
let aEmployeeEmail: string
let aEmployeePassword: string
let aEmployeeToken: string
let aEmployeeId: string
let aEmployeeUserId: string

const PERIOD = "2026-09"

// A valid rule-config DSL the HR admin will PUT. attendance_bonus base 2000 with
// a 5-minute grace tier then a 600 deduction; night 22:00–06:00 ×1.34;
// dailyRegularHours 8 — exactly what computePayslip reads.
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
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly", dailyRegularHours: 8 },
}

// Salary the HR admin will PUT for the employee.
const SALARY = { method: "monthly" as const, baseSalary: 36000, hourlyWage: 200 }

// The settled attendance_days we seed directly for the employee in PERIOD. Two
// in-month days plus one OUT-of-month day (2026-08-31) that the run must ignore.
const SEED_DAYS = [
  // in-month: 2h overtime on a workday + 10min late → triggers the 600 deduction.
  {
    work_date: `${PERIOD}-01`,
    worked_minutes: 600,
    late_minutes: 10,
    overtime_minutes: 120,
    night_minutes: 0,
    day_type: "workday",
  },
  // in-month: 60min night, no overtime, no late.
  {
    work_date: `${PERIOD}-02`,
    worked_minutes: 480,
    late_minutes: 0,
    overtime_minutes: 0,
    night_minutes: 60,
    day_type: "workday",
  },
  // OUT of month — must NOT be picked up by the run for PERIOD.
  {
    work_date: "2026-08-31",
    worked_minutes: 480,
    late_minutes: 999,
    overtime_minutes: 480,
    night_minutes: 480,
    day_type: "workday",
  },
]

/** What we expect the engine to produce from SALARY + VALID_DSL + the two
 * in-month SEED_DAYS. Computed by calling computePayslip directly (single source
 * of truth) so the API result is checked against the engine, not magic numbers. */
function expectedBreakdown() {
  const days: AttendanceDay[] = SEED_DAYS.filter((d) => d.work_date.startsWith(`${PERIOD}-`)).map(
    (d) => ({
      date: d.work_date,
      workedMinutes: d.worked_minutes,
      lateMinutes: d.late_minutes,
      overtimeMinutes: d.overtime_minutes,
      nightMinutes: d.night_minutes,
      dayType: d.day_type as AttendanceDay["dayType"],
    }),
  )
  const salary: SalaryStructure = {
    method: SALARY.method,
    baseSalary: SALARY.baseSalary,
    hourlyWage: SALARY.hourlyWage,
  }
  return computePayslip(days, salary, VALID_DSL)
}

async function buildTenant(label: string): Promise<Tenant> {
  const name = `PAYRUN ${label} ${stamp}`
  const adminEmail = `payrun-${stamp}-${label}-admin@example.com`
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
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run payroll-run test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  // A real employee (own auth user + token) under A.
  aEmployeeEmail = `payrun-${stamp}-a-emp@example.com`
  aEmployeePassword = `Pw-${stamp}-emp-Bb2!`
  const empRes = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({
      email: aEmployeeEmail,
      name: "Alice Payrun",
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

  // Seed rule_config (HR PUT) + salary (HR PUT) + attendance_days (direct insert).
  const putRules = await request(app)
    .put("/rule-config")
    .set("Authorization", `Bearer ${A.adminToken}`)
    // C4：PUT 預設下個月1號生效，這裡要馬上算薪資，必須明講 now，否則會撈到
    // DEFAULT_RULE_CONFIG（這版還沒生效）。
    .send({ ...VALID_DSL, effectiveFrom: "now" })
  if (putRules.status !== 200) throw new Error(`beforeAll: PUT rule-config (${putRules.status})`)

  const putSalary = await request(app)
    .put(`/salary/${aEmployeeId}`)
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send(SALARY)
  if (putSalary.status !== 200) throw new Error(`beforeAll: PUT salary (${putSalary.status})`)

  const { error: adErr } = await supabaseAdmin.from("attendance_days").insert(
    SEED_DAYS.map((d) => ({
      tenant_id: A.tenantId,
      employee_id: aEmployeeId,
      ...d,
    })),
  )
  if (adErr) throw new Error(`beforeAll: seed attendance_days: ${adErr.message}`)
}, 60_000)

afterAll(async () => {
  // payslips → attendance_days → salary_structures → rule_configs → employees →
  // tenants → auth users (FK-safe order).
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("payslips").delete().eq("tenant_id", tid)
  }
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
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }
}, 60_000)

describe("F3 payroll run → payslips (wired payroll-engine)", () => {
  let payslipId: string

  it("HR POST /payroll/run generates a draft payslip matching computePayslip", async () => {
    const run = await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: aEmployeeId, period: PERIOD })
    expect([200, 201]).toContain(run.status)
    expect(run.body.generated).toBe(1)
    expect(run.body.skipped).toEqual([])

    // Locate the produced payslip.
    const list = await request(app)
      .get(`/payslips?employeeId=${aEmployeeId}&period=${PERIOD}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(list.status).toBe(200)
    const slips = list.body.payslips as Array<{ id: string; period: string; status: string }>
    expect(slips.length).toBe(1)
    expect(slips[0].period).toBe(PERIOD)
    expect(slips[0].status).toBe("draft")
    payslipId = slips[0].id

    // Detail with breakdown, checked against the engine (single source of truth).
    const exp = expectedBreakdown()
    const detail = await request(app)
      .get(`/payslips/${payslipId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(detail.status).toBe(200)
    const ps = detail.body.payslip
    expect(Number(ps.base)).toBe(exp.base)
    expect(Number(ps.overtime_pay)).toBe(exp.overtimePay)
    expect(Number(ps.night_pay)).toBe(exp.nightPay)
    expect(Number(ps.attendance_bonus)).toBe(exp.attendanceBonus)
    expect(Number(ps.gross)).toBe(exp.gross)

    // And pin the concrete expected numbers so a coercion/wiring bug can't hide
    // behind the engine cross-check (base 36000, OT 2h×200×1.34=536,
    // night 1h×200×1.34=268, bonus 2000−600=1400, gross 38204).
    expect(exp.base).toBe(36000)
    expect(exp.overtimePay).toBe(536)
    expect(exp.nightPay).toBe(268)
    expect(exp.attendanceBonus).toBe(1400)
    expect(exp.gross).toBe(38204)

    // breakdown jsonb carries the engine's lines for audit/rendering.
    expect(Array.isArray(ps.breakdown.lines)).toBe(true)
    expect(ps.breakdown.lines.length).toBe(exp.lines.length)
  })

  it("re-running the same period updates in place (no duplicate row)", async () => {
    const run = await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: aEmployeeId, period: PERIOD })
    expect([200, 201]).toContain(run.status)
    expect(run.body.generated).toBe(1)

    const { data } = await supabaseAdmin
      .from("payslips")
      .select("id")
      .eq("tenant_id", A.tenantId)
      .eq("employee_id", aEmployeeId)
      .eq("period", PERIOD)
    expect(data?.length).toBe(1)
  })

  it("finalize locks the payslip; a later run skips it; re-finalize is 409", async () => {
    const fin = await request(app)
      .post(`/payslips/${payslipId}/finalize`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(fin.status).toBe(200)
    expect(fin.body.status).toBe("finalized")

    // A run over the same period must NOT overwrite the finalized slip.
    const run = await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: aEmployeeId, period: PERIOD })
    expect([200, 201]).toContain(run.status)
    expect(run.body.generated).toBe(0)
    expect(run.body.skipped).toContain(aEmployeeId)

    // Still finalized, still version-stable (not bumped by the skipped run).
    const detail = await request(app)
      .get(`/payslips/${payslipId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(detail.body.payslip.status).toBe("finalized")

    // Finalizing again → 409 conflict.
    const again = await request(app)
      .post(`/payslips/${payslipId}/finalize`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(again.status).toBe(409)
  })

  it("running for the whole tenant (no employeeId) also produces the slip", async () => {
    // Reset to a clean draft first so we can prove the all-tenant path writes.
    await supabaseAdmin
      .from("payslips")
      .delete()
      .eq("tenant_id", A.tenantId)
      .eq("employee_id", aEmployeeId)
      .eq("period", PERIOD)

    const run = await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ period: PERIOD })
    expect([200, 201]).toContain(run.status)
    // Tenant A has exactly one employee with a salary structure → generated 1.
    expect(run.body.generated).toBe(1)

    const { data } = await supabaseAdmin
      .from("payslips")
      .select("id")
      .eq("tenant_id", A.tenantId)
      .eq("employee_id", aEmployeeId)
      .eq("period", PERIOD)
    expect(data?.length).toBe(1)
  })
})

describe("F3 authorization & cross-tenant isolation", () => {
  it("POST /payroll/run as a plain employee → 403", async () => {
    const res = await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${aEmployeeToken}`)
      .send({ period: PERIOD })
    expect(res.status).toBe(403)
  })

  it("employee can GET their own payslip (200) but not someone else's (404)", async () => {
    // Ensure a slip exists for the employee.
    await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: aEmployeeId, period: PERIOD })
    const list = await request(app)
      .get(`/payslips?period=${PERIOD}`)
      .set("Authorization", `Bearer ${aEmployeeToken}`)
    expect(list.status).toBe(200)
    const slips = list.body.payslips as Array<{ id: string; employee_id: string }>
    // Employee only ever sees their own rows.
    expect(slips.length).toBeGreaterThanOrEqual(1)
    expect(slips.every((s) => s.employee_id === aEmployeeId)).toBe(true)
    const myId = slips[0].id

    const mine = await request(app)
      .get(`/payslips/${myId}`)
      .set("Authorization", `Bearer ${aEmployeeToken}`)
    expect(mine.status).toBe(200)

    // Seed a B payslip directly and prove A's employee cannot read it.
    const { data: bEmp, error: bErr } = await supabaseAdmin
      .from("employees")
      .insert({ tenant_id: B.tenantId, name: `B Emp ${stamp}`, role: "employee" })
      .select("id")
      .single()
    expect(bErr).toBeNull()
    const { data: bSlip, error: bsErr } = await supabaseAdmin
      .from("payslips")
      .insert({
        tenant_id: B.tenantId,
        employee_id: bEmp!.id,
        period: PERIOD,
        base: 1,
        gross: 1,
      })
      .select("id")
      .single()
    expect(bsErr).toBeNull()

    const other = await request(app)
      .get(`/payslips/${bSlip!.id}`)
      .set("Authorization", `Bearer ${aEmployeeToken}`)
    expect(other.status).toBe(404)
  })

  it("A's HR GET /payslips never sees tenant B's rows", async () => {
    const res = await request(app)
      .get(`/payslips?period=${PERIOD}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const rows = res.body.payslips as Array<{ tenant_id: string }>
    expect(rows.every((r) => r.tenant_id === A.tenantId)).toBe(true)
  })
})
