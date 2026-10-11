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

// A plain employee under tenant A (role='employee'); proves a normal user cannot
// write shifts. (班表 /schedules 2026-10-11 隨班表功能移除，端點改測 404。)
let aEmployeeEmail: string
let aEmployeePassword: string
let aEmployeeToken: string
let aEmployeeId: string
let aEmployeeUserId: string

// A second employee under A, used to prove the first employee cannot see
// somebody else's schedule rows.
let aOtherEmployeeId: string

// A shift created under tenant B, used to prove A cannot mutate it.
let bShiftId: string

async function buildTenant(label: string): Promise<Tenant> {
  const name = `SCHEDTEST ${label} ${stamp}`
  const adminEmail = `sch-${stamp}-${label}-admin@example.com`
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
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run scheduling test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  // A real employee (own auth user + token) under A.
  aEmployeeEmail = `sch-${stamp}-a-emp@example.com`
  aEmployeePassword = `Pw-${stamp}-emp-Bb2!`
  const empRes = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${A.adminToken}`)
    .send({
      email: aEmployeeEmail,
      name: "Alice Employee",
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

  // A second employee under A (no auth user needed — just a row).
  const { data: other, error: otherErr } = await supabaseAdmin
    .from("employees")
    .insert({ tenant_id: A.tenantId, name: `Bob Other ${stamp}`, role: "employee" })
    .select("id")
    .single()
  if (otherErr || !other) {
    throw new Error(`beforeAll: A other-employee insert failed: ${otherErr?.message}`)
  }
  aOtherEmployeeId = other.id as string

  // A shift in B that A must never be able to touch.
  const { data: bShift, error: bShiftErr } = await supabaseAdmin
    .from("shifts")
    .insert({
      tenant_id: B.tenantId,
      name: `B-only Shift ${stamp}`,
      start_time: "09:00",
      end_time: "18:00",
    })
    .select("id")
    .single()
  if (bShiftErr || !bShift) {
    throw new Error(`beforeAll: B shift insert failed: ${bShiftErr?.message}`)
  }
  bShiftId = bShift.id as string
}, 60_000)

afterAll(async () => {
  // schedules → shifts → employees → tenants → auth users (respect FK order).
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

describe("F2 shifts CRUD — tenant A, HR admin", () => {
  let shiftId: string

  it("POST /shifts creates a shift scoped to A → 201 { id }", async () => {
    const res = await request(app)
      .post("/shifts")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        name: `Day ${stamp}`,
        startTime: "09:00",
        endTime: "18:00",
        breakMinutes: 60,
        isNightShift: false,
      })

    expect(res.status).toBe(201)
    expect(typeof res.body.id).toBe("string")
    shiftId = res.body.id

    const { data } = await supabaseAdmin
      .from("shifts")
      .select("tenant_id, name, start_time, end_time, break_minutes, is_night_shift")
      .eq("id", shiftId)
      .single()
    expect(data?.tenant_id).toBe(A.tenantId)
    expect(data?.start_time).toBe("09:00")
    expect(data?.end_time).toBe("18:00")
    expect(data?.break_minutes).toBe(60)
    expect(data?.is_night_shift).toBe(false)
  })

  it("GET /shifts lists ONLY A's shifts (includes the new one, never B's)", async () => {
    const res = await request(app)
      .get("/shifts")
      .set("Authorization", `Bearer ${A.adminToken}`)

    expect(res.status).toBe(200)
    const rows = res.body.shifts as Array<{ id: string; tenant_id: string }>
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.every((r) => r.tenant_id === A.tenantId)).toBe(true)
    expect(rows.some((r) => r.id === shiftId)).toBe(true)
    expect(rows.some((r) => r.id === bShiftId)).toBe(false)
  })

  it("PATCH /shifts/:id updates fields (A only)", async () => {
    const res = await request(app)
      .patch(`/shifts/${shiftId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ name: `Day-Renamed ${stamp}`, breakMinutes: 30, isNightShift: true })

    expect(res.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("shifts")
      .select("name, break_minutes, is_night_shift")
      .eq("id", shiftId)
      .single()
    expect(data?.name).toBe(`Day-Renamed ${stamp}`)
    expect(data?.break_minutes).toBe(30)
    expect(data?.is_night_shift).toBe(true)
  })

  it("DELETE /shifts/:id → 200, row gone", async () => {
    const res = await request(app)
      .delete(`/shifts/${shiftId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("id", shiftId)
      .maybeSingle()
    expect(data).toBeNull()
  })
})

describe("F2 authorization — non-HR employee cannot write shifts", () => {
  it("a role='employee' user POST /shifts → 403", async () => {
    const res = await request(app)
      .post("/shifts")
      .set("Authorization", `Bearer ${aEmployeeToken}`)
      .send({ name: `Nope ${stamp}`, startTime: "09:00", endTime: "18:00" })

    expect(res.status).toBe(403)
  })

})

describe("F2 cross-tenant — A cannot mutate B's shift", () => {
  it("PATCH /shifts/:id of a B shift with A's token does NOT change B's row", async () => {
    const before = await supabaseAdmin
      .from("shifts")
      .select("name")
      .eq("id", bShiftId)
      .single()

    const res = await request(app)
      .patch(`/shifts/${bShiftId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ name: "HIJACKED BY A" })

    expect(res.status).toBe(404)

    const after = await supabaseAdmin
      .from("shifts")
      .select("name")
      .eq("id", bShiftId)
      .single()
    expect(after.data?.name).toBe(before.data?.name)
    expect(after.data?.name).not.toBe("HIJACKED BY A")
  })

  it("DELETE /shifts/:id of a B shift with A's token does NOT delete B's row", async () => {
    const res = await request(app)
      .delete(`/shifts/${bShiftId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)

    expect(res.status).toBe(404)

    const { data } = await supabaseAdmin
      .from("shifts")
      .select("id")
      .eq("id", bShiftId)
      .maybeSingle()
    expect(data?.id).toBe(bShiftId)
  })
})

describe("班表端點已移除（2026-10-11，業主：不需要）→ 404", () => {
  it.each([
    ["GET", "/schedules"],
    ["POST", "/schedules"],
    ["POST", "/schedules/import"],
    ["POST", "/schedules/00000000-0000-0000-0000-000000000000/acknowledge"],
    ["POST", "/schedules/00000000-0000-0000-0000-000000000000/dispute"],
  ] as const)("%s %s（HR 與員工都一樣）→ 404 not_found", async (method, path) => {
    for (const token of [A.adminToken, aEmployeeToken]) {
      const req = method === "GET" ? request(app).get(path) : request(app).post(path).send({})
      const res = await req.set("Authorization", `Bearer ${token}`)
      expect(res.status).toBe(404)
      expect(res.body.error).toBe("not_found")
    }
  })
})
