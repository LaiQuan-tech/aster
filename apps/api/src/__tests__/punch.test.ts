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

// Two real employees under tenant A (each with their own auth user + token).
// emp1 is the protagonist; emp2 proves a normal user cannot see emp1's punches
// and cannot punch on emp1's behalf.
let emp1Id: string
let emp1Token: string
let emp2Id: string
let emp2Token: string

// An employee under tenant B with a punch, to prove A's HR can't see B's data.
let bEmployeeId: string

async function buildTenant(label: string): Promise<Tenant> {
  const name = `PUNCHTEST ${label} ${stamp}`
  const adminEmail = `punch-${stamp}-${label}-admin@example.com`
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

// Create an employee with a real auth user (so they have a token) under a tenant.
async function createEmployee(
  adminToken: string,
  email: string,
  password: string,
  name: string,
): Promise<{ employeeId: string; token: string }> {
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, name, password, role: "employee" })
  if (res.status !== 201) {
    throw new Error(`createEmployee(${email}) failed (${res.status})`)
  }
  createdUserIds.push(res.body.userId)
  const token = await signIn(email, password)
  return { employeeId: res.body.employeeId, token }
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run punch test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  const e1 = await createEmployee(
    A.adminToken,
    `punch-${stamp}-a-emp1@example.com`,
    `Pw-${stamp}-emp1-Bb2!`,
    "Alice One",
  )
  emp1Id = e1.employeeId
  emp1Token = e1.token

  const e2 = await createEmployee(
    A.adminToken,
    `punch-${stamp}-a-emp2@example.com`,
    `Pw-${stamp}-emp2-Cc3!`,
    "Bob Two",
  )
  emp2Id = e2.employeeId
  emp2Token = e2.token

  // An employee row + one punch in tenant B (no auth user needed — just rows).
  const { data: bEmp, error: bErr } = await supabaseAdmin
    .from("employees")
    .insert({ tenant_id: B.tenantId, name: `B Employee ${stamp}`, role: "employee" })
    .select("id")
    .single()
  if (bErr || !bEmp) {
    throw new Error(`beforeAll: B employee insert failed: ${bErr?.message}`)
  }
  bEmployeeId = bEmp.id as string
  const { error: bPunchErr } = await supabaseAdmin.from("punch_records").insert({
    tenant_id: B.tenantId,
    employee_id: bEmployeeId,
    type: "in",
    source: "web",
  })
  if (bPunchErr) {
    throw new Error(`beforeAll: B punch insert failed: ${bPunchErr.message}`)
  }
}, 60_000)

afterAll(async () => {
  // announcement acks → versions → announcements → punch_records → employees
  // → tenants → auth users (respect FK order; announcements/punch_records
  // carry the no_hard_delete trigger, which lets status='test' tenants through).
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("announcement_acknowledgements").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("announcement_versions").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("announcements").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("punch_records").delete().eq("tenant_id", tid)
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

describe("F3 punch in/out — auto-inferred type", () => {
  it("first POST /punch (no type) → 201 type='in'", async () => {
    const res = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({})

    expect(res.status).toBe(201)
    expect(res.body.type).toBe("in")
    expect(typeof res.body.id).toBe("string")
    expect(typeof res.body.punchAt).toBe("string")

    // WP1: the 201 body also carries source/lat/lng/deviceId and the full
    // stored row (`record`, snake_case) so the client can render it at once.
    expect(res.body.source).toBe("web")
    expect(res.body.lat).toBeNull()
    expect(res.body.lng).toBeNull()
    expect(res.body.deviceId).toBeNull()
    expect(res.body.record.id).toBe(res.body.id)
    expect(res.body.record.type).toBe("in")
    expect(res.body.record.punch_at).toBe(res.body.punchAt)
    expect(res.body.record.employee_id).toBe(emp1Id)
    expect(res.body.record.tenant_id).toBe(A.tenantId)

    // The stored row belongs to emp1, in tenant A.
    const { data } = await supabaseAdmin
      .from("punch_records")
      .select("tenant_id, employee_id, type")
      .eq("id", res.body.id)
      .single()
    expect(data?.tenant_id).toBe(A.tenantId)
    expect(data?.employee_id).toBe(emp1Id)
    expect(data?.type).toBe("in")
  })

  it("second POST /punch (no type) → 201 type='out' (inferred from last punch)", async () => {
    const res = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({})

    expect(res.status).toBe(201)
    expect(res.body.type).toBe("out")
  })

  it("GET /punch/today returns both punches and status 'off' (last was out)", async () => {
    const res = await request(app)
      .get("/punch/today")
      .set("Authorization", `Bearer ${emp1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe("off")
    const records = res.body.records as Array<{ employee_id: string; type: string }>
    expect(records.length).toBeGreaterThanOrEqual(2)
    // All today's records belong to emp1.
    expect(records.every((r) => r.employee_id === emp1Id)).toBe(true)
    // in then out, in chronological order.
    expect(records[0].type).toBe("in")
    expect(records[records.length - 1].type).toBe("out")
  })

  it("POST /punch with lat/lng/source='gps' stores the coordinates", async () => {
    const res = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ source: "gps", lat: 25.033964, lng: 121.564468 })

    expect(res.status).toBe(201)
    // This is the 3rd punch → in again.
    expect(res.body.type).toBe("in")

    const { data } = await supabaseAdmin
      .from("punch_records")
      .select("source, lat, lng")
      .eq("id", res.body.id)
      .single()
    expect(data?.source).toBe("gps")
    expect(data?.lat).toBeCloseTo(25.033964, 4)
    expect(data?.lng).toBeCloseTo(121.564468, 4)
  })

  it("GET /punch/today now shows status 'working' (last was in)", async () => {
    const res = await request(app)
      .get("/punch/today")
      .set("Authorization", `Bearer ${emp1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe("working")
  })

  it("POST /punch honours an explicit type", async () => {
    const res = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ type: "out" })

    expect(res.status).toBe(201)
    expect(res.body.type).toBe("out")
  })
})

describe("F3 anti-proxy-punch — a token only ever punches for itself", () => {
  it("emp1 cannot punch for emp2 even by passing employeeId — row is emp1's", async () => {
    const res = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp1Token}`)
      // Malicious attempt to clock in on emp2's behalf.
      .send({ type: "in", employeeId: emp2Id })

    expect(res.status).toBe(201)

    const { data } = await supabaseAdmin
      .from("punch_records")
      .select("employee_id")
      .eq("id", res.body.id)
      .single()
    // The punch was recorded for emp1 (the token owner), NOT emp2.
    expect(data?.employee_id).toBe(emp1Id)
    expect(data?.employee_id).not.toBe(emp2Id)
  })

  it("emp2 has no punches yet (emp1 never punched on their behalf)", async () => {
    const res = await request(app)
      .get("/punch/today")
      .set("Authorization", `Bearer ${emp2Token}`)

    expect(res.status).toBe(200)
    const records = res.body.records as Array<unknown>
    expect(records.length).toBe(0)
    expect(res.body.status).toBe("off")
  })
})

describe("F3 query scoping — HR sees tenant, employees see only self", () => {
  it("HR GET /punch?employeeId=emp1 returns emp1's punches", async () => {
    const res = await request(app)
      .get(`/punch?employeeId=${emp1Id}`)
      .set("Authorization", `Bearer ${A.adminToken}`)

    expect(res.status).toBe(200)
    const records = res.body.records as Array<{ employee_id: string; tenant_id: string }>
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.employee_id === emp1Id)).toBe(true)
    expect(records.every((r) => r.tenant_id === A.tenantId)).toBe(true)
  })

  it("HR GET /punch (no filter) sees the whole tenant (never B's)", async () => {
    const res = await request(app)
      .get("/punch")
      .set("Authorization", `Bearer ${A.adminToken}`)

    expect(res.status).toBe(200)
    const records = res.body.records as Array<{ employee_id: string; tenant_id: string }>
    expect(records.every((r) => r.tenant_id === A.tenantId)).toBe(true)
    expect(records.some((r) => r.employee_id === emp1Id)).toBe(true)
    // B's punch must never leak.
    expect(records.some((r) => r.employee_id === bEmployeeId)).toBe(false)
  })

  it("emp2 GET /punch?employeeId=emp1 is forced to self → never sees emp1's rows", async () => {
    const res = await request(app)
      .get(`/punch?employeeId=${emp1Id}`)
      .set("Authorization", `Bearer ${emp2Token}`)

    expect(res.status).toBe(200)
    const records = res.body.records as Array<{ employee_id: string }>
    // Forced back to emp2 (who has no punches) → empty, and definitely no emp1.
    expect(records.some((r) => r.employee_id === emp1Id)).toBe(false)
  })
})

describe("F3 cross-tenant isolation", () => {
  it("A's HR GET /punch can never see any of B's punches", async () => {
    const res = await request(app)
      .get("/punch")
      .set("Authorization", `Bearer ${A.adminToken}`)

    expect(res.status).toBe(200)
    const records = res.body.records as Array<{ tenant_id: string }>
    expect(records.every((r) => r.tenant_id === A.tenantId)).toBe(true)
    expect(records.some((r) => r.tenant_id === B.tenantId)).toBe(false)
  })
})

// ── WP1: 連按冷卻、完整回傳、today 狀態只看 in/out、公告 viewed_at ──────────
//
// A third employee (emp3) so the cooldown cases start from a clean punch
// history — the cooldown looks at the employee's LAST punch of any type on
// ANY day, so emp1/emp2's earlier punches must not leak into these cases.
let emp3Id: string
let emp3Token: string

function withCooldownSeconds(value: string): () => void {
  const prev = process.env.PUNCH_COOLDOWN_SECONDS
  process.env.PUNCH_COOLDOWN_SECONDS = value
  return () => {
    if (prev === undefined) delete process.env.PUNCH_COOLDOWN_SECONDS
    else process.env.PUNCH_COOLDOWN_SECONDS = prev
  }
}

describe("WP1 punch cooldown — PUNCH_COOLDOWN_SECONDS blocks a double tap", () => {
  beforeAll(async () => {
    const e3 = await createEmployee(
      A.adminToken,
      `punch-${stamp}-a-emp3@example.com`,
      `Pw-${stamp}-emp3-Dd4!`,
      "Carol Three",
    )
    emp3Id = e3.employeeId
    emp3Token = e3.token
  }, 60_000)

  it("env=60: first punch 201 (with record.punch_at); second within 60s → 409 punch_too_soon; HR manual back-fill exempt", async () => {
    // The setupFile pins PUNCH_COOLDOWN_SECONDS=0 for every suite; this case
    // turns the cooldown on for its own duration only and restores it after.
    const restore = withCooldownSeconds("60")
    try {
      const first = await request(app)
        .post("/punch")
        .set("Authorization", `Bearer ${emp3Token}`)
        .send({ type: "in" })
      expect(first.status).toBe(201)
      expect(first.body.type).toBe("in")
      expect(typeof first.body.record?.punch_at).toBe("string")
      expect(first.body.record.punch_at).toBe(first.body.punchAt)
      expect(first.body.record.employee_id).toBe(emp3Id)
      expect(first.body.record.source).toBe("web")

      const second = await request(app)
        .post("/punch")
        .set("Authorization", `Bearer ${emp3Token}`)
        .send({ type: "out" })
      expect(second.status).toBe(409)
      expect(second.body.error).toBe("punch_too_soon")
      expect(Number.isInteger(second.body.retryAfterSeconds)).toBe(true)
      expect(second.body.retryAfterSeconds).toBeGreaterThan(0)
      expect(second.body.retryAfterSeconds).toBeLessThanOrEqual(60)
      expect(second.headers["retry-after"]).toBe(String(second.body.retryAfterSeconds))
      // `last` points at the punch that triggered the cooldown.
      expect(second.body.last).toEqual({
        id: first.body.id,
        type: "in",
        punchAt: first.body.punchAt,
      })

      // Exactly one row was written for emp3 — the double tap did not land.
      const { data: rows } = await supabaseAdmin
        .from("punch_records")
        .select("id, type")
        .eq("tenant_id", A.tenantId)
        .eq("employee_id", emp3Id)
      expect(rows).toHaveLength(1)
      expect(rows?.[0].id).toBe(first.body.id)

      // HR back-fill for the same employee moments later is NOT subject to the
      // cooldown (explicit timestamp, not a double tap). A break_in "now" also
      // sets up the today-status case below.
      const manual = await request(app)
        .post("/punch/manual")
        .set("Authorization", `Bearer ${A.adminToken}`)
        .send({ employeeId: emp3Id, punchAt: new Date().toISOString(), type: "break_in" })
      expect(manual.status).toBe(201)
    } finally {
      restore()
    }
  })

  it("with the cooldown back at 0 (setup default) an immediate punch is accepted again", async () => {
    expect(process.env.PUNCH_COOLDOWN_SECONDS).toBe("0")
    const res = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp3Token}`)
      .send({ type: "break_out" })
    expect(res.status).toBe(201)
    expect(res.body.type).toBe("break_out")
    expect(res.body.record.punch_at).toBe(res.body.punchAt)
  })
})

describe("WP1 GET /punch/today — status derives from in/out only", () => {
  it("break_in/break_out after an 'in' keep status 'working'", async () => {
    const res = await request(app)
      .get("/punch/today")
      .set("Authorization", `Bearer ${emp3Token}`)
    expect(res.status).toBe(200)
    const types = (res.body.records as Array<{ type: string }>).map((r) => r.type)
    expect(types).toEqual(["in", "break_in", "break_out"])
    // Old logic looked at the last row (break_out) and answered 'off'.
    expect(res.body.status).toBe("working")
  })

  it("after an 'out' → 'off', and a later outing_in does not flip it back", async () => {
    const out = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp3Token}`)
      .send({ type: "out" })
    expect(out.status).toBe(201)

    const afterOut = await request(app)
      .get("/punch/today")
      .set("Authorization", `Bearer ${emp3Token}`)
    expect(afterOut.body.status).toBe("off")

    const outing = await request(app)
      .post("/punch")
      .set("Authorization", `Bearer ${emp3Token}`)
      .send({ type: "outing_in" })
    expect(outing.status).toBe(201)

    const afterOuting = await request(app)
      .get("/punch/today")
      .set("Authorization", `Bearer ${emp3Token}`)
    expect(afterOuting.body.status).toBe("off")
    const types = (afterOuting.body.records as Array<{ type: string }>).map((r) => r.type)
    expect(types).toEqual(["in", "break_in", "break_out", "out", "outing_in"])
  })
})

describe("WP1 GET /announcements — viewed_at is the caller's own acknowledgement", () => {
  let annId: string
  let versionId: string

  beforeAll(async () => {
    const res = await request(app)
      .post("/announcements")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ title: `WP1 規章 ${stamp}`, body: "需簽收的規章內容", requiresSignature: true })
    if (res.status !== 201) {
      throw new Error(`POST /announcements failed (${res.status}): ${JSON.stringify(res.body)}`)
    }
    annId = res.body.id
    versionId = res.body.versionId
  }, 30_000)

  type AnnRow = { id: string; requires_signature: boolean; viewed_at: string | null }
  const findAnn = async (token: string): Promise<AnnRow | undefined> => {
    const res = await request(app).get("/announcements").set("Authorization", `Bearer ${token}`)
    expect(res.status).toBe(200)
    return (res.body.announcements as AnnRow[]).find((a) => a.id === annId)
  }

  it("not yet viewed → viewed_at present and null", async () => {
    const row = await findAnn(emp1Token)
    expect(row).toBeDefined()
    expect(row).toHaveProperty("viewed_at", null)
    expect(row?.requires_signature).toBe(true)
  })

  it("after the employee acknowledges → viewed_at set for them, still null for everyone else", async () => {
    const ack = await request(app)
      .post(`/announcement-versions/${versionId}/acknowledge`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({})
    expect(ack.status).toBe(200)
    expect(typeof ack.body.acknowledgement.viewed_at).toBe("string")

    const mine = await findAnn(emp1Token)
    expect(mine?.viewed_at).toBe(ack.body.acknowledgement.viewed_at)

    // Per caller: emp2 and HR have not viewed it.
    const other = await findAnn(emp2Token)
    expect(other?.viewed_at).toBeNull()
    const hr = await findAnn(A.adminToken)
    expect(hr?.viewed_at).toBeNull()
  })
})
