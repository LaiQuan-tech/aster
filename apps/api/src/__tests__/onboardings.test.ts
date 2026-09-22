import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let adminToken: string
let tenantId: string
let empToken: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run onboardings test")
  }
  const adminEmail = `ob-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const prov = await provisionTenant({ name: `OBTEST ${stamp}`, adminEmail, adminPassword })
  tenantId = prov.tenantId
  createdTenantIds.push(prov.tenantId)
  createdUserIds.push(prov.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  // A plain employee (with a token) to prove non-HR is blocked.
  const empEmail = `ob-${stamp}-emp@example.com`
  const empPassword = `Pw-${stamp}-emp-Bb2!`
  const empRes = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email: empEmail, name: "Emp One", password: empPassword, role: "employee" })
  if (empRes.status !== 201) throw new Error(`create emp failed (${empRes.status})`)
  createdUserIds.push(empRes.body.userId)
  empToken = await signIn(empEmail, empPassword)
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("onboardings").delete().eq("tenant_id", tid)
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

describe("F-Hire 報到管理 — HR manages onboardings", () => {
  let obId: string

  it("HR POST /onboardings creates a pending record → 201", async () => {
    const res = await request(app)
      .post("/onboardings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Newbie Nina", identityType: "全職", region: "台北", reportDate: "2026-08-01" })
    expect(res.status).toBe(201)
    obId = res.body.id
    expect(typeof obId).toBe("string")
  })

  it("GET /onboardings?status=pending lists it (tenant-scoped)", async () => {
    const res = await request(app)
      .get("/onboardings?status=pending")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const rows = res.body.onboardings as Array<{ id: string; tenant_id: string; status: string }>
    expect(rows.every((r) => r.tenant_id === tenantId)).toBe(true)
    expect(rows.some((r) => r.id === obId && r.status === "pending")).toBe(true)
  })

  it("PATCH /onboardings/:id updates region", async () => {
    const res = await request(app)
      .patch(`/onboardings/${obId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ region: "新竹" })
    expect(res.status).toBe(200)
    const { data } = await supabaseAdmin.from("onboardings").select("region").eq("id", obId).single()
    expect(data?.region).toBe("新竹")
  })

  it("POST /onboardings/:id/complete provisions an employee and marks completed", async () => {
    const res = await request(app)
      .post(`/onboardings/${obId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("completed")
    const empId = res.body.employeeId as string
    expect(typeof empId).toBe("string")

    // The employee row exists in this tenant.
    const { data: emp } = await supabaseAdmin
      .from("employees")
      .select("id, tenant_id, name")
      .eq("id", empId)
      .single()
    expect(emp?.tenant_id).toBe(tenantId)
    expect(emp?.name).toBe("Newbie Nina")

    // The onboarding is now completed and linked.
    const { data: ob } = await supabaseAdmin
      .from("onboardings")
      .select("status, employee_id")
      .eq("id", obId)
      .single()
    expect(ob?.status).toBe("completed")
    expect(ob?.employee_id).toBe(empId)
  })

  it("completing an already-completed onboarding → 409", async () => {
    const res = await request(app)
      .post(`/onboardings/${obId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(409)
  })

  it("a non-HR employee cannot list or create onboardings → 403", async () => {
    const list = await request(app).get("/onboardings").set("Authorization", `Bearer ${empToken}`)
    expect(list.status).toBe(403)
    const create = await request(app)
      .post("/onboardings")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ name: "Nope" })
    expect(create.status).toBe(403)
  })

  it("報到管理 filters: 報到區間 from/to + 關鍵字 keyword narrow the list", async () => {
    await request(app)
      .post("/onboardings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "早鳥恩", reportDate: "2026-07-15" })
    await request(app)
      .post("/onboardings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "晚到溫", reportDate: "2026-09-15" })

    const ranged = await request(app)
      .get("/onboardings?from=2026-07-01&to=2026-07-31")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(ranged.status).toBe(200)
    const rangedNames = (ranged.body.onboardings as Array<{ name: string }>).map((r) => r.name)
    expect(rangedNames).toContain("早鳥恩")
    expect(rangedNames).not.toContain("晚到溫")

    const kw = await request(app)
      .get(`/onboardings?keyword=${encodeURIComponent("晚到")}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(kw.status).toBe(200)
    const kwNames = (kw.body.onboardings as Array<{ name: string }>).map((r) => r.name)
    expect(kwNames).toContain("晚到溫")
    expect(kwNames).not.toContain("早鳥恩")
  })

  it("批次匯入: POST /onboardings/import inserts valid rows, reports bad lines", async () => {
    const csv = [
      "name,reportDate,identityType,region",
      "匯入甲,2026-08-01,全職,台北",
      ",2026-08-02,全職,台中",
      "匯入乙,2026-08-03,兼職,高雄",
    ].join("\n")
    const res = await request(app)
      .post("/onboardings/import")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv })
    expect(res.status).toBe(201)
    expect(res.body.count).toBe(2)
    expect(res.body.errors.length).toBe(1)
    expect(res.body.errors[0].line).toBe(3)

    const { count } = await supabaseAdmin
      .from("onboardings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("name", ["匯入甲", "匯入乙"])
    expect(count).toBe(2)
  })
})
