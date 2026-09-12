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

let tenantId: string
let adminToken: string

/** 編號的年度＝建立年。測試與程式取同一個來源。 */
const YEAR = new Date().getFullYear()

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

function createProject(body: Record<string, unknown>) {
  return request(app)
    .post("/projects")
    .set("Authorization", `Bearer ${adminToken}`)
    .send(body)
}

beforeAll(async () => {
  const name = `PROJTEST ${stamp}`
  const adminEmail = `proj-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
  tenantId = provisioned.tenantId
  createdTenantIds.push(provisioned.tenantId)
  createdUserIds.push(provisioned.userId)
  adminToken = await signIn(adminEmail, adminPassword)
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("project_share_adjustments").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_members").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_documents").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 60_000)

describe("M4-1 專案編號 — 系統產號", () => {
  let firstId: string

  it("第一個案子拿到 P{建立年}-001", async () => {
    const res = await createProject({ name: "官網改版" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-001`)
    firstId = res.body.id
  })

  it("流水號遞增", async () => {
    const res = await createProject({ name: "倉儲系統" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-002`)
  })

  it("歸屬年度未指定時預設為建立年", async () => {
    const res = await request(app)
      .get(`/projects/${firstId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.project.fiscalYear).toBe(YEAR)
  })

  it("建立時可指定與建立年不同的歸屬年度（12 月談成、1 月立案）", async () => {
    const res = await createProject({ name: "跨年案", fiscalYear: YEAR - 1 })
    expect(res.status).toBe(201)
    // 編號仍是建立年——編號不表達歸屬。
    expect(res.body.code).toBe(`P${YEAR}-003`)

    const got = await request(app)
      .get(`/projects/${res.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.fiscalYear).toBe(YEAR - 1)
  })
})

describe("M4-1 專案編號 — 人工指定（匯入舊案）", () => {
  it("可人工指定編號", async () => {
    const res = await createProject({ name: "民國 112 年舊案", code: "ABC-999" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe("ABC-999")
  })

  it("人工編號不參與流水號計算，下一個自動號不會被推高", async () => {
    // ABC-999 若被算進去，這裡會變成 P{YEAR}-1000。
    const res = await createProject({ name: "後續案" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-004`)
  })

  it("撞號回 409，不自動改號——人工指定代表那個號有意義", async () => {
    const res = await createProject({ name: "又一個舊案", code: "ABC-999" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_taken")
  })

  it("人工指定既有的系統編號一樣擋下", async () => {
    const res = await createProject({ name: "手打撞到自動號", code: `P${YEAR}-001` })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_taken")
  })
})

describe("M4-1 專案編號 — 不可變更", () => {
  let projectId: string
  let originalCode: string

  beforeAll(async () => {
    const res = await createProject({ name: "已出合約的案子" })
    projectId = res.body.id
    originalCode = res.body.code
  })

  it("PATCH 帶 code 回 409，不是靜默忽略", async () => {
    const res = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "NEW-001" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_immutable")
  })

  it("編號確實沒被改掉", async () => {
    const res = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.project.code).toBe(originalCode)
  })

  it("同一次請求裡夾帶 code，其餘欄位也不會被寫入（整筆拒絕）", async () => {
    const res = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "NEW-002", name: "改過的名字" })
    expect(res.status).toBe(409)

    const got = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.name).toBe("已出合約的案子")
  })

  it("歸屬年度可以改，編號不動", async () => {
    const res = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fiscalYear: YEAR - 1 })
    expect(res.status).toBe(200)

    const got = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.fiscalYear).toBe(YEAR - 1)
    expect(got.body.project.code).toBe(originalCode)
  })
})

describe("M4-1 專案編號 — 租戶隔離", () => {
  it("另一租戶的流水號從 001 重新開始", async () => {
    const otherEmail = `proj-${stamp}-b@example.com`
    const otherPassword = `Pw-${stamp}-Bb1!`
    const other = await provisionTenant({
      name: `PROJTEST-B ${stamp}`,
      adminEmail: otherEmail,
      adminPassword: otherPassword,
    })
    createdTenantIds.push(other.tenantId)
    createdUserIds.push(other.userId)
    const otherToken = await signIn(otherEmail, otherPassword)

    const res = await request(app)
      .post("/projects")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "別家的第一個案子" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-001`)
    expect(other.tenantId).not.toBe(tenantId)
  }, 60_000)
})
