import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * P0 attendance — live contract tests for the pieces that need the API + DB:
 *   • /calendar routes (validation, HR-only, and the 503 `calendar_not_migrated`
 *     contract while packages/db migration 0038 is not applied — the same
 *     assertions pass once it is, taking the 200 branch)
 *   • fix_punch approval → punch_records materialised (in + out, source
 *     'manual'), then settled into attendance_days on the tenant's clock.
 * Same bootstrap as the other integration suites (test tenant, cleaned up).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let hrEmpId: string
let empId: string
let empToken: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run p0-attendance test")
  }
  const adminEmail = `p0-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const t = await provisionTenant({ name: `P0 ${stamp}`, adminEmail, adminPassword })
  tenantId = t.tenantId
  createdTenantIds.push(t.tenantId)
  createdUserIds.push(t.userId)
  adminToken = await signIn(adminEmail, adminPassword)
  const { data: hr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", t.userId)
    .single()
  hrEmpId = hr!.id as string

  const email = `p0-${stamp}-emp@example.com`
  const password = `Pw-${stamp}-Bb2!`
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, name: "P0 Employee", password, role: "employee" })
  if (res.status !== 201) throw new Error(`createEmployee failed (${res.status}): ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  empId = res.body.employeeId
  empToken = await signIn(email, password)
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid) // 送單／簽核通知（FK → employees）
    await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("punch_records").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("approval_steps").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("leave_requests").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenant_calendar_days").delete().eq("tenant_id", tid) // no-op pre-0038
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 60_000)

/** True when tenant_calendar_days exists on the live DB (migration 0038). */
async function calendarMigrated(): Promise<boolean> {
  const { error } = await supabaseAdmin.from("tenant_calendar_days").select("id").limit(1)
  return !error
}

describe("P0 /calendar", () => {
  it("PUT /calendar/days rejects an unknown dayType (400) before touching the DB", async () => {
    const res = await request(app)
      .put("/calendar/days")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ days: [{ date: "2026-06-19", dayType: "holiday" }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })

  it("a plain employee cannot PUT / POST / DELETE (403), but can GET", async () => {
    const put = await request(app)
      .put("/calendar/days")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ days: [{ date: "2026-06-19", dayType: "fixed_holiday" }] })
    expect(put.status).toBe(403)
    const gen = await request(app)
      .post("/calendar/generate")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ year: 2026 })
    expect(gen.status).toBe(403)
    const del = await request(app).delete("/calendar/days/2026-06-19").set("Authorization", `Bearer ${empToken}`)
    expect(del.status).toBe(403)
    const get = await request(app).get("/calendar?year=2026").set("Authorization", `Bearer ${empToken}`)
    expect([200, 503]).toContain(get.status)
  })

  it("GET / PUT / generate / DELETE honour the migration state (200 family, or 503 calendar_not_migrated)", async () => {
    const migrated = await calendarMigrated()

    const put = await request(app)
      .put("/calendar/days")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ days: [{ date: "2026-06-19", dayType: "fixed_holiday", label: "端午節" }, { date: "2026-06-20", dayType: "workday", label: null }] })
    const gen = await request(app)
      .post("/calendar/generate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ year: 2026 })
    const get = await request(app).get("/calendar?year=2026").set("Authorization", `Bearer ${adminToken}`)
    const del = await request(app).delete("/calendar/days/2026-06-20").set("Authorization", `Bearer ${adminToken}`)

    if (!migrated) {
      for (const r of [put, gen, get, del]) {
        expect(r.status).toBe(503)
        expect(r.body.error).toBe("calendar_not_migrated")
      }
      return
    }

    expect(put.status).toBe(200)
    expect(put.body.upserted).toBe(2)
    expect(gen.status).toBe(200)
    // 2026 has 104 weekend days; 6/20 (Sat) was set manually → skipped; 6/19 is
    // both manual and a built-in holiday → skipped by the import step.
    expect(gen.body.generated).toBe(103)
    expect(gen.body.imported).toBe(20)
    expect(gen.body.skipped).toBe(2)
    expect(get.status).toBe(200)
    const days = get.body.days as Array<{ date: string; day_type: string; source: string; label: string | null }>
    expect(days.find((d) => d.date === "2026-06-19")).toMatchObject({ day_type: "fixed_holiday", source: "manual", label: "端午節" })
    expect(days.find((d) => d.date === "2026-06-20")).toMatchObject({ day_type: "workday", source: "manual" })
    expect(days.find((d) => d.date === "2026-01-01")).toMatchObject({ day_type: "fixed_holiday", source: "import" })
    expect(days.find((d) => d.date === "2026-06-06")).toMatchObject({ day_type: "rest_day", source: "generated" })
    expect(del.status).toBe(200)
    const again = await request(app).delete("/calendar/days/2026-06-20").set("Authorization", `Bearer ${adminToken}`)
    expect(again.status).toBe(404)
  })
})

describe("P0 fix_punch approval → punch_records → settlement", () => {
  const WORK_DATE = "2026-08-10"
  // 09:00 / 18:00 Asia/Taipei.
  const IN_AT = `${WORK_DATE}T01:00:00.000Z`
  const OUT_AT = `${WORK_DATE}T10:00:00.000Z`
  let reqId: string

  it("employee files a fix_punch with start/end; HR (fallback single step) approves", async () => {
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ kind: "fix_punch", startAt: IN_AT, endAt: OUT_AT, reason: "forgot both" })
    expect(filed.status).toBe(201)
    reqId = filed.body.requestId
    expect(filed.body.steps?.[0]?.approverEmpId).toBe(hrEmpId)

    const approved = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ comment: "ok" })
    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe("approved")
  })

  it("materialises exactly one 'in' and one 'out' (source manual) at the requested instants", async () => {
    const { data, error } = await supabaseAdmin
      .from("punch_records")
      .select("type, punch_at, source")
      .eq("tenant_id", tenantId)
      .eq("employee_id", empId)
      .order("punch_at", { ascending: true })
    expect(error).toBeNull()
    const rows = (data ?? []) as Array<{ type: string; punch_at: string; source: string }>
    expect(rows.map((r) => r.type)).toEqual(["in", "out"])
    expect(rows.every((r) => r.source === "manual")).toBe(true)
    expect(new Date(rows[0].punch_at).toISOString()).toBe(IN_AT)
    expect(new Date(rows[1].punch_at).toISOString()).toBe(OUT_AT)
  })

  it("settlement pairs them on the Taipei work_date (worked 540, no anomaly)", async () => {
    const settle = await request(app)
      .post("/attendance/settle")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: empId, from: WORK_DATE, to: WORK_DATE })
    expect(settle.status).toBe(200)
    expect(settle.body.settled).toBe(1)

    const { data } = await supabaseAdmin
      .from("attendance_days")
      .select("work_date, worked_minutes, late_minutes, overtime_minutes, day_type, anomaly")
      .eq("tenant_id", tenantId)
      .eq("employee_id", empId)
    expect(data?.length).toBe(1)
    const day = data![0] as { work_date: string; worked_minutes: number; late_minutes: number; overtime_minutes: number; day_type: string; anomaly: unknown }
    expect(day.work_date).toBe(WORK_DATE)
    // No schedule → default shift, no break: 09:00–18:00 = 540 worked, late 0,
    // OT raw 60 → 60 (floor 30, ≥ 30). 2026-08-10 is a Monday → workday.
    expect(day.day_type).toBe("workday")
    expect(day.worked_minutes).toBe(540)
    expect(day.late_minutes).toBe(0)
    expect(day.overtime_minutes).toBe(60)
    expect(day.anomaly).toBeNull()
  })

  it("re-running settlement is idempotent and a second fix_punch for the same instants adds nothing", async () => {
    // Same instants again → the same-minute dedupe keeps punch_records at 2.
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ kind: "fix_punch", startAt: IN_AT, endAt: OUT_AT, reason: "dup" })
    expect(filed.status).toBe(201)
    const approved = await request(app)
      .post(`/requests/${filed.body.requestId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
    expect(approved.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("punch_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("employee_id", empId)
    expect(data?.length).toBe(2)

    const settle = await request(app)
      .post("/attendance/settle")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: empId, from: WORK_DATE, to: WORK_DATE })
    expect(settle.status).toBe(200)
    const { data: days } = await supabaseAdmin
      .from("attendance_days")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("employee_id", empId)
    expect(days?.length).toBe(1)
  })
})
