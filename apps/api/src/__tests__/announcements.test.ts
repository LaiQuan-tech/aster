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

// An ordinary employee in tenant A (role 'employee') — proves reads are open to
// all staff and writes are denied to non-HR.
let empToken: string

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
  const name = `ANNTEST ${label} ${stamp}`
  const adminEmail = `ann-${stamp}-${label}-admin@example.com`
  const adminPassword = `Pw-${stamp}-${label}-Aa1!`

  const { tenantId, userId } = await provisionTenant({ name, adminEmail, adminPassword })
  createdTenantIds.push(tenantId)
  createdUserIds.push(userId)

  const adminToken = await signIn(adminEmail, adminPassword)
  return { name, tenantId, adminEmail, adminPassword, adminToken }
}

// Create an employee with a real auth user (so they have a token) under a tenant.
async function createEmployee(
  adminToken: string,
  email: string,
  password: string,
  name: string,
  role: string,
): Promise<string> {
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, name, password, role })
  if (res.status !== 201) {
    throw new Error(`createEmployee(${email}) failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  createdUserIds.push(res.body.userId)
  return signIn(email, password)
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run announcements test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  empToken = await createEmployee(
    A.adminToken,
    `ann-${stamp}-a-emp@example.com`,
    `Pw-${stamp}-emp-Bb2!`,
    "Eve Employee",
    "employee",
  )
}, 60_000)

afterAll(async () => {
  // announcements → employees → tenants → auth users (respect FK order).
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("announcements").delete().eq("tenant_id", tid)
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

describe("F5 announcements — HR publishes, employees read", () => {
  let annId: string

  it("HR POST /announcements → 201; an employee GET sees it", async () => {
    const res = await request(app)
      .post("/announcements")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ title: "颱風假公告", body: "明日全日停班停課。" })
    expect(res.status).toBe(201)
    expect(typeof res.body.id).toBe("string")
    annId = res.body.id

    const list = await request(app)
      .get("/announcements")
      .set("Authorization", `Bearer ${empToken}`)
    expect(list.status).toBe(200)
    const items = list.body.announcements as Array<{
      id: string
      title: string
      tenant_id: string
    }>
    const found = items.find((a) => a.id === annId)
    expect(found?.title).toBe("颱風假公告")
    expect(items.every((a) => a.tenant_id === A.tenantId)).toBe(true)
  })

  it("HR PATCH /announcements/:id updates the title", async () => {
    const res = await request(app)
      .patch(`/announcements/${annId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ title: "颱風假公告（更新）" })
    expect(res.status).toBe(200)

    const list = await request(app)
      .get("/announcements")
      .set("Authorization", `Bearer ${A.adminToken}`)
    const found = (list.body.announcements as Array<{ id: string; title: string }>).find(
      (a) => a.id === annId,
    )
    expect(found?.title).toBe("颱風假公告（更新）")
  })

  it("HR DELETE /announcements/:id 未附理由 → 400 reason_required", async () => {
    const res = await request(app)
      .delete(`/announcements/${annId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("reason_required")
  })

  it("HR DELETE /announcements/:id 附理由 → 200，GET 不再列出，但 DB 內該列仍在", async () => {
    const res = await request(app)
      .delete(`/announcements/${annId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ reason: "內容有誤，另行重發" })
    expect(res.status).toBe(200)

    const list = await request(app)
      .get("/announcements")
      .set("Authorization", `Bearer ${empToken}`)
    const items = list.body.announcements as Array<{ id: string }>
    expect(items.some((a) => a.id === annId)).toBe(false)

    // 軟刪除：公告是勞資爭議證據，列必須還在。
    const { data } = await supabaseAdmin
      .from("announcements")
      .select("id, deleted_at, delete_reason, deleted_by_emp_id")
      .eq("id", annId)
      .maybeSingle()
    expect(data).not.toBeNull()
    expect(data?.deleted_at).not.toBeNull()
    expect(data?.delete_reason).toBe("內容有誤，另行重發")
    expect(data?.deleted_by_emp_id).not.toBeNull() // 有記到操作者
  })

  it("重複註銷 → 404（已註銷者不再匹配）", async () => {
    const res = await request(app)
      .delete(`/announcements/${annId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ reason: "再一次" })
    expect(res.status).toBe(404)
  })
})

describe("F5 permissions — only HR may write", () => {
  it("a normal employee cannot POST → 403", async () => {
    const res = await request(app)
      .post("/announcements")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ title: "x", body: "y" })
    expect(res.status).toBe(403)
  })

  it("a normal employee cannot PATCH or DELETE → 403", async () => {
    // Seed a row owned by HR to attempt to mutate.
    const created = await request(app)
      .post("/announcements")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ title: "policy", body: "body" })
    const id = created.body.id as string

    const patch = await request(app)
      .patch(`/announcements/${id}`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ title: "hacked" })
    expect(patch.status).toBe(403)

    const del = await request(app)
      .delete(`/announcements/${id}`)
      .set("Authorization", `Bearer ${empToken}`)
    expect(del.status).toBe(403)
  })
})

describe("F5 cross-tenant isolation", () => {
  it("A's HR cannot PATCH/DELETE B's announcement (→404) and B's row is untouched", async () => {
    // Seed an announcement directly in tenant B.
    const { data: bAnn, error: bErr } = await supabaseAdmin
      .from("announcements")
      .insert({ tenant_id: B.tenantId, title: "B 公告", body: "B 內容" })
      .select("id")
      .single()
    if (bErr || !bAnn) throw new Error(`seed B announcement failed: ${bErr?.message}`)

    const patch = await request(app)
      .patch(`/announcements/${bAnn.id}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ title: "tampered" })
    expect(patch.status).toBe(404)

    const del = await request(app)
      .delete(`/announcements/${bAnn.id}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ reason: "跨租戶測試" })
    expect(del.status).toBe(404)

    // B's row is unchanged and still present.
    const { data: still } = await supabaseAdmin
      .from("announcements")
      .select("title")
      .eq("id", bAnn.id)
      .single()
    expect(still?.title).toBe("B 公告")
  })

  it("A's employee never sees B's announcements", async () => {
    const list = await request(app)
      .get("/announcements")
      .set("Authorization", `Bearer ${empToken}`)
    expect(list.status).toBe(200)
    const items = list.body.announcements as Array<{ tenant_id: string }>
    expect(items.every((a) => a.tenant_id === A.tenantId)).toBe(true)
  })
})
