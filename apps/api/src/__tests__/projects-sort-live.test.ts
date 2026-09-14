import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * B4 —— `GET /projects` 排序（`?sort=&dir=`）與 `clients.category` 欄位，
 * live Supabase 整合測試（仿 projects-application-live.test.ts 的既有慣例：
 * 用 provisionTenant 開一個全新、獨立的租戶，不碰共用的 demo 租戶資料，
 * afterAll 清乾淨）。
 */

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_ANON_KEY ?? "", {
    auth: { persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}
function createProject(body: Record<string, unknown>) {
  return asAdmin(request(app).post("/projects")).send(body)
}
function listProjects(qs: string) {
  return asAdmin(request(app).get(`/projects${qs}`))
}

beforeAll(async () => {
  const name = `B4SORTTEST ${stamp}`
  const adminEmail = `b4-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
  tenantId = provisioned.tenantId
  createdTenantIds.push(provisioned.tenantId)
  createdUserIds.push(provisioned.userId)
  adminToken = await signIn(adminEmail, adminPassword)
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("clients").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 60_000)

describe("B4-1 GET /projects 排序", () => {
  // 刻意用不照建立順序、不照字母順序的名字／開案日，這樣任何一種排序都會
  // 洗出不同的順序，才驗得出「真的照該欄位排」而不是恰好符合建立序。
  const seeds = [
    { name: "Charlie 案", openedOn: "2025-06-15" },
    { name: "Alpha 案", openedOn: "2026-03-10" },
    { name: "Bravo 案", openedOn: "2024-01-01" },
  ]
  const ids: Record<string, string> = {}
  const codes: Record<string, string> = {}

  beforeAll(async () => {
    for (const s of seeds) {
      const res = await createProject({ name: s.name, openedOn: s.openedOn })
      expect(res.status).toBe(201)
      ids[s.name] = res.body.id
      codes[s.name] = res.body.code
    }
  }, 30_000)

  it("預設（省略 sort／dir）＝ created desc：最後建立的在最前面", async () => {
    const res = await listProjects("")
    expect(res.status).toBe(200)
    const names = (res.body.projects as Array<{ name: string }>).map((p) => p.name)
    // 三筆依序建立：Charlie → Alpha → Bravo，created desc 應該是 Bravo, Alpha, Charlie。
    expect(names.slice(0, 3)).toEqual(["Bravo 案", "Alpha 案", "Charlie 案"])
  })

  it("sort=name&dir=asc：依名稱遞增", async () => {
    const res = await listProjects("?sort=name&dir=asc")
    expect(res.status).toBe(200)
    const names = (res.body.projects as Array<{ name: string }>).map((p) => p.name)
    expect(names.slice(0, 3)).toEqual(["Alpha 案", "Bravo 案", "Charlie 案"])
  })

  it("sort=name&dir=desc：依名稱遞減", async () => {
    const res = await listProjects("?sort=name&dir=desc")
    expect(res.status).toBe(200)
    const names = (res.body.projects as Array<{ name: string }>).map((p) => p.name)
    expect(names.slice(0, 3)).toEqual(["Charlie 案", "Bravo 案", "Alpha 案"])
  })

  it("sort=opened&dir=desc：依開案日期遞減", async () => {
    const res = await listProjects("?sort=opened&dir=desc")
    expect(res.status).toBe(200)
    const names = (res.body.projects as Array<{ name: string; openedOn: string }>).map((p) => p.name)
    // 2026-03-10（Alpha）> 2025-06-15（Charlie）> 2024-01-01（Bravo）
    expect(names.slice(0, 3)).toEqual(["Alpha 案", "Charlie 案", "Bravo 案"])
  })

  it("sort=opened&dir=asc：依開案日期遞增", async () => {
    const res = await listProjects("?sort=opened&dir=asc")
    expect(res.status).toBe(200)
    const names = (res.body.projects as Array<{ name: string }>).map((p) => p.name)
    expect(names.slice(0, 3)).toEqual(["Bravo 案", "Charlie 案", "Alpha 案"])
  })

  it("sort=code（省略 dir）＝ code desc：編號是流水號，遞減＝後建立的號碼在前", async () => {
    const res = await listProjects("?sort=code")
    expect(res.status).toBe(200)
    const names = (res.body.projects as Array<{ name: string }>).map((p) => p.name)
    // 編號依建立序遞增產生（Charlie=001, Alpha=002, Bravo=003），desc 就是 Bravo, Alpha, Charlie。
    expect(names.slice(0, 3)).toEqual(["Bravo 案", "Alpha 案", "Charlie 案"])
    expect(codes["Bravo 案"] > codes["Alpha 案"]).toBe(true)
    expect(codes["Alpha 案"] > codes["Charlie 案"]).toBe(true)
  })

  it("sort=status&dir=asc：不炸——三筆狀態都是 active，只驗證有回資料且不報錯", async () => {
    const res = await listProjects("?sort=status&dir=asc")
    expect(res.status).toBe(200)
    expect((res.body.projects as unknown[]).length).toBeGreaterThanOrEqual(3)
  })

  it("不合法 sort 值 → 400 invalid_sort", async () => {
    const res = await listProjects("?sort=bogus")
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_sort")
  })

  it("不合法 dir 值 → 400 invalid_dir", async () => {
    const res = await listProjects("?sort=name&dir=sideways")
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_dir")
  })

  it("includeArchived 行為不變：預設不回封存的案子，且排序仍套用在剩下的案子上", async () => {
    // 把 Charlie 案先轉暫停（archived 要求非 active）再封存。
    const suspend = await asAdmin(request(app).patch(`/projects/${ids["Charlie 案"]}`)).send({
      status: "suspended",
      statusReason: "B4 測試：驗證 includeArchived 與排序不互相影響",
    })
    expect(suspend.status).toBe(200)
    const archive = await asAdmin(request(app).patch(`/projects/${ids["Charlie 案"]}`)).send({ archived: true })
    expect(archive.status).toBe(200)

    const withoutArchived = await listProjects("?sort=name&dir=asc")
    expect(withoutArchived.status).toBe(200)
    const namesWithout = (withoutArchived.body.projects as Array<{ name: string }>).map((p) => p.name)
    expect(namesWithout).not.toContain("Charlie 案")
    expect(namesWithout.slice(0, 2)).toEqual(["Alpha 案", "Bravo 案"])

    const withArchived = await listProjects("?includeArchived=1&sort=name&dir=asc")
    expect(withArchived.status).toBe(200)
    const namesWith = (withArchived.body.projects as Array<{ name: string }>).map((p) => p.name)
    expect(namesWith.slice(0, 3)).toEqual(["Alpha 案", "Bravo 案", "Charlie 案"])
  })
})

describe("B4-2 clients.category", () => {
  it("POST 帶 category → GET 回同值", async () => {
    const create = await asAdmin(request(app).post("/clients")).send({ name: `B4客戶 ${stamp}`, category: "architect" })
    expect(create.status).toBe(201)
    expect(create.body.client.category).toBe("architect")
    const clientId = create.body.client.id as string

    const list = await asAdmin(request(app).get("/clients"))
    expect(list.status).toBe(200)
    const found = (list.body.clients as Array<{ id: string; category: string | null }>).find((c) => c.id === clientId)
    expect(found?.category).toBe("architect")
  })

  it("PATCH category 後 GET 回同值", async () => {
    const create = await asAdmin(request(app).post("/clients")).send({ name: `B4客戶改分類 ${stamp}` })
    expect(create.status).toBe(201)
    expect(create.body.client.category).toBeNull()
    const clientId = create.body.client.id as string

    const patch = await asAdmin(request(app).patch(`/clients/${clientId}`)).send({ category: "engineer" })
    expect(patch.status).toBe(200)
    expect(patch.body.client.category).toBe("engineer")

    const list = await asAdmin(request(app).get("/clients"))
    const found = (list.body.clients as Array<{ id: string; category: string | null }>).find((c) => c.id === clientId)
    expect(found?.category).toBe("engineer")
  })

  it("非法 category 值 → 400（POST 與 PATCH 都擋）", async () => {
    const create = await asAdmin(request(app).post("/clients")).send({ name: `B4非法分類 ${stamp}`, category: "not_a_real_category" })
    expect(create.status).toBe(400)

    const ok = await asAdmin(request(app).post("/clients")).send({ name: `B4合法先建 ${stamp}` })
    expect(ok.status).toBe(201)
    const patchBad = await asAdmin(request(app).patch(`/clients/${ok.body.client.id}`)).send({ category: "not_a_real_category" })
    expect(patchBad.status).toBe(400)
  })
})
