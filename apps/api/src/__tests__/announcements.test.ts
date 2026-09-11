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
describe("F5 版本鏈 — PATCH 發新版，不覆寫歷史（模組二第 2 條）", () => {
  let annId: string
  let v1Id: string

  it("POST 建立公告時同時建第一版（initial）", async () => {
    const res = await request(app)
      .post("/announcements")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        title: "工作規則",
        body: "第一版內容",
        requiresSignature: true,
        effectiveFrom: "2026-01-01",
      })
    expect(res.status).toBe(201)
    annId = res.body.id
    v1Id = res.body.versionId
    expect(res.body.versionNo).toBe(1)
  })

  it("PATCH 產生第二版，舊版被補上 effective_to，內容都還在", async () => {
    const res = await request(app)
      .patch(`/announcements/${annId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        body: "第二版內容",
        changeType: "amendment",
        changeNote: "加班規定調整",
        effectiveFrom: "2026-07-01",
        isAdverseChange: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.versionNo).toBe(2)

    const versions = await request(app)
      .get(`/announcements/${annId}/versions`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(versions.status).toBe(200)
    const list = versions.body.versions as Array<Record<string, unknown>>
    expect(list).toHaveLength(2)

    // 第一版的文字沒有被覆寫 —— 這正是舊實作做不到的事。
    expect(list[0].version_no).toBe(1)
    expect(list[0].body).toBe("第一版內容")
    expect(list[0].effective_to).toBe("2026-07-01")

    expect(list[1].version_no).toBe(2)
    expect(list[1].body).toBe("第二版內容")
    expect(list[1].change_type).toBe("amendment")
    expect(list[1].is_adverse_change).toBe(true)
    expect(list[1].effective_to).toBeNull()

    // requires_signature 未指定時沿用前一版（是文件性質，不因改一行字消失）。
    expect(list[1].requires_signature).toBe(true)
  })

  it("跨年度進版：條款一字未改也能發新版", async () => {
    const res = await request(app)
      .patch(`/announcements/${annId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ changeType: "annual_rollover", effectiveFrom: "2027-01-01" })
    expect(res.status).toBe(200)
    expect(res.body.versionNo).toBe(3)

    const versions = await request(app)
      .get(`/announcements/${annId}/versions`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    const v3 = (versions.body.versions as Array<Record<string, unknown>>)[2]
    expect(v3.change_type).toBe("annual_rollover")
    expect(v3.body).toBe("第二版內容") // 內容沿用，但這是不同的一版
  })

  it("列表的快取欄位跟著現行版走", async () => {
    const list = await request(app)
      .get("/announcements")
      .set("Authorization", `Bearer ${A.adminToken}`)
    const found = (list.body.announcements as Array<{ id: string; body: string }>).find(
      (a) => a.id === annId,
    )
    expect(found?.body).toBe("第二版內容")
  })

  it("員工自行 acknowledge 只寫 viewed_at（查閱紀錄，非勾選同意）", async () => {
    const res = await request(app)
      .post(`/announcement-versions/${v1Id}/acknowledge`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.acknowledgement.viewed_at).not.toBeNull()
    expect(res.body.acknowledgement.signed_at).toBeNull()
  })

  it("員工不可代他人登錄 → 403", async () => {
    const res = await request(app)
      .post(`/announcement-versions/${v1Id}/acknowledge`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ employeeId: "00000000-0000-0000-0000-000000000001" })
    expect(res.status).toBe(403)
  })

  it("同意率只計 consent_to_change，新人 accept_on_hire 不進分母", async () => {
    // 取得該租戶兩位員工。
    const { data: emps } = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("tenant_id", A.tenantId)
      .limit(2)
    const ids = (emps ?? []).map((e) => e.id as string)
    expect(ids.length).toBeGreaterThanOrEqual(2)

    // 一位在職員工簽了「同意變更」。
    const signed = await request(app)
      .post(`/announcement-versions/${v1Id}/acknowledge`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: ids[0], kind: "consent_to_change", signedAt: "2026-02-01T00:00:00.000Z" })
    expect(signed.status).toBe(200)
    expect(signed.body.acknowledgement.signed_at).not.toBeNull()

    // 一位新人是「到職接受」，尚未簽。
    await supabaseAdmin.from("announcement_acknowledgements").upsert(
      { tenant_id: A.tenantId, version_id: v1Id, employee_id: ids[1], kind: "accept_on_hire" },
      { onConflict: "tenant_id,version_id,employee_id" },
    )

    const res = await request(app)
      .get(`/announcements/${annId}/acknowledgements?versionId=${v1Id}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    // 分母只有那位 consent_to_change 的在職員工，不含新人。
    expect(res.body.consentRate).toEqual({ signed: 1, total: 1 })
    // 但新人仍出現在 pending，HR 看得到「誰還沒簽」。
    const pending = res.body.pending as Array<{ employee_id: string }>
    expect(pending.some((r) => r.employee_id === ids[1])).toBe(true)
  })
})
