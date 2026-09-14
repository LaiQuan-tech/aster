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

// Tenant A's two employees (own auth users + tokens) and B's one employee.
let emp1Id: string // Alice — punch-less on SCAN_DATE (no_in) + anomaly seeds
let emp2Id: string // Bob — complete in/out on SCAN_DATE
let emp1Token: string
let emp2Token: string

let bEmpId: string
let bEmpToken: string

let dayShiftId: string // A reusable 09:00–18:00 shift under A.

// The day we run the忘打卡 scan against. Punches are stored as UTC instants and
// the scan windows the TENANT's calendar day (Asia/Taipei by default) — emp2's
// 09:02Z in / 18:05Z out below are 17:02 / next-day 02:05 Taipei, a
// cross-midnight pair the scan must still recognise as complete.
const SCAN_DATE = "2026-03-10"
// Anomaly window — three consecutive late days + an excess-overtime month.
const ANOM_FROM = "2026-03-01"
const ANOM_TO = "2026-03-31"

async function buildTenant(label: string): Promise<Tenant> {
  const name = `DETECT ${label} ${stamp}`
  const adminEmail = `det-${stamp}-${label}-admin@example.com`
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

async function createEmployee(
  t: Tenant,
  email: string,
  name: string,
  password: string,
): Promise<{ employeeId: string; token: string }> {
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${t.adminToken}`)
    .send({ email, name, password, role: "employee" })
  if (res.status !== 201) throw new Error(`createEmployee(${name}) failed (${res.status})`)
  createdUserIds.push(res.body.userId)
  const token = await signIn(email, password)
  return { employeeId: res.body.employeeId, token }
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run detection test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  const e1 = await createEmployee(A, `det-${stamp}-a-emp1@example.com`, "Alice Detect", `Pw-${stamp}-e1-Bb2!`)
  emp1Id = e1.employeeId
  emp1Token = e1.token
  const e2 = await createEmployee(A, `det-${stamp}-a-emp2@example.com`, "Bob Detect", `Pw-${stamp}-e2-Cc3!`)
  emp2Id = e2.employeeId
  emp2Token = e2.token

  const be = await createEmployee(B, `det-${stamp}-b-emp@example.com`, "Bianca Detect", `Pw-${stamp}-be-Dd4!`)
  bEmpId = be.employeeId
  bEmpToken = be.token

  // A 09:00–18:00 day shift under A (referenced by SCAN_DATE schedules).
  const shiftRes = await request(app)
    .post("/shifts")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({ name: `Day ${stamp}`, startTime: "09:00", endTime: "18:00", breakMinutes: 60 })
  if (shiftRes.status !== 201) throw new Error(`beforeAll: create shift (${shiftRes.status})`)
  dayShiftId = shiftRes.body.id

  // --- 忘打卡 seed: both A employees are scheduled on SCAN_DATE -----------------
  const schRes = await request(app)
    .post("/schedules")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({
      assignments: [
        { employeeId: emp1Id, workDate: SCAN_DATE, shiftId: dayShiftId },
        { employeeId: emp2Id, workDate: SCAN_DATE, shiftId: dayShiftId },
      ],
    })
  if (schRes.status !== 201) throw new Error(`beforeAll: seed schedules (${schRes.status})`)

  // emp2 has a COMPLETE in/out on SCAN_DATE; emp1 has NONE (→ no_in).
  const { error: prErr } = await supabaseAdmin.from("punch_records").insert([
    { tenant_id: A.tenantId, employee_id: emp2Id, type: "in", punch_at: `${SCAN_DATE}T09:02:00.000Z`, source: "web" },
    { tenant_id: A.tenantId, employee_id: emp2Id, type: "out", punch_at: `${SCAN_DATE}T18:05:00.000Z`, source: "web" },
  ])
  if (prErr) throw new Error(`beforeAll: seed punches: ${prErr.message}`)

  // B is scheduled on SCAN_DATE with no punches too — proves cross-tenant
  // isolation (A's scan must never enqueue for B).
  await request(app)
    .post("/schedules")
    .set("Authorization", `Bearer ${B.adminToken}`)
    .send({ employeeId: bEmpId, workDate: SCAN_DATE })

  // --- anomaly seeds (attendance_days) ----------------------------------------
  // emp1: 3 consecutive late days (consecutive_late) AND a big OT month
  // (excess_overtime: monthly OT > 46h = 2760m). 3 days × 1000m = 3000m > 2760m.
  const emp1Days = [
    { work_date: "2026-03-02", worked_minutes: 480, late_minutes: 15, overtime_minutes: 1000, night_minutes: 0 },
    { work_date: "2026-03-03", worked_minutes: 480, late_minutes: 20, overtime_minutes: 1000, night_minutes: 0 },
    { work_date: "2026-03-04", worked_minutes: 480, late_minutes: 10, overtime_minutes: 1000, night_minutes: 0 },
    // a non-late day so the late streak is bounded at 3.
    { work_date: "2026-03-05", worked_minutes: 480, late_minutes: 0, overtime_minutes: 0, night_minutes: 0 },
  ]
  // emp2: only 2 late days (not consecutive enough) + modest OT → no anomaly.
  const emp2Days = [
    { work_date: "2026-03-02", worked_minutes: 480, late_minutes: 5, overtime_minutes: 60, night_minutes: 0 },
    { work_date: "2026-03-04", worked_minutes: 480, late_minutes: 5, overtime_minutes: 60, night_minutes: 0 },
  ]
  const adRows = [
    ...emp1Days.map((d) => ({ tenant_id: A.tenantId, employee_id: emp1Id, day_type: "workday", ...d })),
    ...emp2Days.map((d) => ({ tenant_id: A.tenantId, employee_id: emp2Id, day_type: "workday", ...d })),
  ]
  const { error: adErr } = await supabaseAdmin.from("attendance_days").insert(adRows)
  if (adErr) throw new Error(`beforeAll: seed attendance_days: ${adErr.message}`)

  // B attendance_days so anomaly scan isolation is provable (3 consecutive late).
  await supabaseAdmin.from("attendance_days").insert([
    { tenant_id: B.tenantId, employee_id: bEmpId, work_date: "2026-03-02", worked_minutes: 480, late_minutes: 30, overtime_minutes: 0, night_minutes: 0, day_type: "workday" },
    { tenant_id: B.tenantId, employee_id: bEmpId, work_date: "2026-03-03", worked_minutes: 480, late_minutes: 30, overtime_minutes: 0, night_minutes: 0, day_type: "workday" },
    { tenant_id: B.tenantId, employee_id: bEmpId, work_date: "2026-03-04", worked_minutes: 480, late_minutes: 30, overtime_minutes: 0, night_minutes: 0, day_type: "workday" },
  ])
}, 120_000)

afterAll(async () => {
  // notifications → attendance_days → punch_records → schedules → shifts →
  // employees → tenants → auth users (FK-safe order).
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
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
}, 120_000)

// --- 忘打卡偵測 ----------------------------------------------------------------

describe("F1 missing-punch scan", () => {
  interface MissingItem {
    employeeId: string
    issue: string
  }

  it("flags scheduled-but-unpunched employees and queues a notification for each", async () => {
    const res = await request(app)
      .post("/attendance/scan-missing-punch")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ date: SCAN_DATE })
    expect(res.status).toBe(200)

    const missing = res.body.missing as MissingItem[]
    expect(Array.isArray(missing)).toBe(true)
    const ids = missing.map((m) => m.employeeId)
    // emp1 (no punches) flagged as no_in; emp2 (complete in/out) not flagged.
    expect(ids).toContain(emp1Id)
    expect(ids).not.toContain(emp2Id)
    const e1 = missing.find((m) => m.employeeId === emp1Id)
    expect(e1?.issue).toBe("no_in")

    expect(res.body.queued).toBeGreaterThanOrEqual(1)
    // Cross-tenant: B's scheduled-unpunched employee must never be in A's result.
    expect(ids).not.toContain(bEmpId)
  })

  it("emp1 sees their own missing_punch notification in the inbox", async () => {
    const res = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(res.status).toBe(200)
    const items = res.body.notifications as Array<{
      id: string
      type: string
      employee_id: string
      status: string
    }>
    const mine = items.filter((n) => n.type === "missing_punch")
    expect(mine.length).toBeGreaterThanOrEqual(1)
    expect(mine.every((n) => n.employee_id === emp1Id)).toBe(true)
  })

  it("emp2 cannot see emp1's missing_punch notification", async () => {
    const res = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${emp2Token}`)
    expect(res.status).toBe(200)
    const items = res.body.notifications as Array<{ employee_id: string }>
    expect(items.every((n) => n.employee_id === emp2Id)).toBe(true)
    expect(items.some((n) => n.employee_id === emp1Id)).toBe(false)
  })

  it("a plain employee cannot run the scan (403)", async () => {
    const res = await request(app)
      .post("/attendance/scan-missing-punch")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ date: SCAN_DATE })
    expect(res.status).toBe(403)
  })

  it("re-running the scan is idempotent (no duplicate notifications)", async () => {
    const before = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${emp1Token}`)
    const beforeCount = (before.body.notifications as unknown[]).length

    const rescan = await request(app)
      .post("/attendance/scan-missing-punch")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ date: SCAN_DATE })
    expect(rescan.status).toBe(200)

    const after = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${emp1Token}`)
    const afterCount = (after.body.notifications as unknown[]).length
    expect(afterCount).toBe(beforeCount)
  })
})

// --- 異常出勤偵測 --------------------------------------------------------------

describe("F1 anomaly detection", () => {
  interface Anomaly {
    employeeId: string
    type: string
    detail?: unknown
  }

  it("flags consecutive_late and excess_overtime for emp1; nothing for emp2", async () => {
    const res = await request(app)
      .get(`/attendance/anomalies?from=${ANOM_FROM}&to=${ANOM_TO}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const anomalies = res.body.anomalies as Anomaly[]
    expect(Array.isArray(anomalies)).toBe(true)

    const e1 = anomalies.filter((a) => a.employeeId === emp1Id).map((a) => a.type)
    expect(e1).toContain("consecutive_late")
    expect(e1).toContain("excess_overtime")

    // emp2 has only scattered short late days + small OT → no anomaly.
    const e2 = anomalies.filter((a) => a.employeeId === emp2Id)
    expect(e2.length).toBe(0)
  })

  it("A's HR never sees tenant B's anomalies", async () => {
    const res = await request(app)
      .get(`/attendance/anomalies?from=${ANOM_FROM}&to=${ANOM_TO}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    const ids = (res.body.anomalies as Anomaly[]).map((a) => a.employeeId)
    expect(ids).not.toContain(bEmpId)
  })

  it("a plain employee cannot query anomalies (403)", async () => {
    const res = await request(app)
      .get(`/attendance/anomalies?from=${ANOM_FROM}&to=${ANOM_TO}`)
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(res.status).toBe(403)
  })
})

// --- 遲到統計 ------------------------------------------------------------------

describe("F1 late stats", () => {
  interface LateRow {
    employeeId: string
    lateDays: number
    lateMinutes: number
  }

  it("computes per-employee late counts and minutes over the window", async () => {
    const res = await request(app)
      .get(`/attendance/late-stats?from=${ANOM_FROM}&to=${ANOM_TO}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const rows = res.body.rows as LateRow[]
    const byId = new Map(rows.map((r) => [r.employeeId, r]))

    // emp1: 3 late days (15+20+10 = 45 minutes); the 0-late day doesn't count.
    const r1 = byId.get(emp1Id)
    expect(r1?.lateDays).toBe(3)
    expect(r1?.lateMinutes).toBe(45)

    // emp2: 2 late days (5+5 = 10 minutes).
    const r2 = byId.get(emp2Id)
    expect(r2?.lateDays).toBe(2)
    expect(r2?.lateMinutes).toBe(10)
  })

  it("A's HR late-stats never includes tenant B", async () => {
    const res = await request(app)
      .get(`/attendance/late-stats?from=${ANOM_FROM}&to=${ANOM_TO}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    const ids = (res.body.rows as LateRow[]).map((r) => r.employeeId)
    expect(ids).not.toContain(bEmpId)
  })

  it("a plain employee cannot query late-stats (403)", async () => {
    const res = await request(app)
      .get(`/attendance/late-stats?from=${ANOM_FROM}&to=${ANOM_TO}`)
      .set("Authorization", `Bearer ${emp2Token}`)
    expect(res.status).toBe(403)
  })
})

// --- notifications inbox guards ------------------------------------------------

describe("F1 notifications inbox", () => {
  it("unauthenticated GET /notifications → 401", async () => {
    const res = await request(app).get("/notifications")
    expect(res.status).toBe(401)
  })

  it("HR can see the whole tenant's queue; B's queue stays isolated", async () => {
    const aRes = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(aRes.status).toBe(200)
    const aItems = aRes.body.notifications as Array<{ employee_id: string; tenant_id: string }>
    // Every row belongs to tenant A; emp1's queued missing_punch is visible to HR.
    expect(aItems.every((n) => n.tenant_id === A.tenantId)).toBe(true)
    expect(aItems.some((n) => n.employee_id === emp1Id)).toBe(true)

    const bRes = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${B.adminToken}`)
    const bItems = bRes.body.notifications as Array<{ tenant_id: string }>
    expect(bItems.every((n) => n.tenant_id === B.tenantId)).toBe(true)
  })

  it("the recipient can mark their own notification read", async () => {
    const inbox = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${emp1Token}`)
    const first = (inbox.body.notifications as Array<{ id: string }>)[0]
    expect(first?.id).toBeTruthy()

    const read = await request(app)
      .post(`/notifications/${first.id}/read`)
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(read.status).toBe(200)
    expect(read.body.id).toBe(first.id)
  })

  it("emp2 cannot mark emp1's notification read (404)", async () => {
    const inbox = await request(app)
      .get("/notifications")
      .set("Authorization", `Bearer ${emp1Token}`)
    const first = (inbox.body.notifications as Array<{ id: string }>)[0]
    expect(first?.id).toBeTruthy()

    const read = await request(app)
      .post(`/notifications/${first.id}/read`)
      .set("Authorization", `Bearer ${emp2Token}`)
    expect(read.status).toBe(404)
  })
})
