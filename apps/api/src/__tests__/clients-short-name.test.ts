import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clientsRouter } from "../routes/clients.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(clientsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const authed = (req: request.Test) => req.set("Authorization", `Bearer ${HR_TOKEN}`)

const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const CLIENT_B = "aaaaaaaa-0000-4000-8000-00000000000b"
const CLIENT_C = "aaaaaaaa-0000-4000-8000-00000000000c"
const CLIENT_OTHER_TENANT = "aaaaaaaa-0000-4000-8000-00000000000d"

function seedClient(id: string, name: string, shortName: string | null, tenantId = TENANT_ID) {
  return { id, tenant_id: tenantId, name, short_name: shortName, tax_id: null, deleted_at: null }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
  fake.db.clients = []
})

function clientWrites(action: "insert" | "update") {
  return fake.writes.filter((write) => write.table === "clients" && write.action === action)
}

describe("POST /clients — 簡稱 shortName", () => {
  it("存 short_name（已 trim），回應帶 shortName", async () => {
    const res = await authed(request(app).post("/clients")).send({ name: "測試客戶甲股份有限公司", shortName: "  測試甲  " })

    expect(res.status).toBe(201)
    expect(res.body.client).toMatchObject({ name: "測試客戶甲股份有限公司", shortName: "測試甲" })
    expect(clientWrites("insert")).toHaveLength(1)
    expect(clientWrites("insert")[0]?.payload).toMatchObject({
      tenant_id: TENANT_ID,
      name: "測試客戶甲股份有限公司",
      short_name: "測試甲",
    })
  })

  it("不帶簡稱時回 shortName: null；只有空白的簡稱存成 null", async () => {
    const without = await authed(request(app).post("/clients")).send({ name: "測試客戶乙" })
    expect(without.status).toBe(201)
    expect(without.body.client.shortName).toBeNull()
    expect(clientWrites("insert")[0]?.payload).not.toHaveProperty("short_name")

    const blank = await authed(request(app).post("/clients")).send({ name: "測試客戶丙", shortName: "   " })
    expect(blank.status).toBe(201)
    expect(blank.body.client.shortName).toBeNull()
    expect(clientWrites("insert")[1]?.payload).toMatchObject({ short_name: null })
  })

  it("簡稱最長 40 字：41 字回 400 invalid_body 且不寫入，剛好 40 字可存", async () => {
    const tooLong = await authed(request(app).post("/clients")).send({ name: "測試客戶丁", shortName: "字".repeat(41) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe("invalid_body")
    expect(clientWrites("insert")).toHaveLength(0)

    const exactly40 = await authed(request(app).post("/clients")).send({ name: "測試客戶戊", shortName: "字".repeat(40) })
    expect(exactly40.status).toBe(201)
    expect(exactly40.body.client.shortName).toBe("字".repeat(40))
  })
})

describe("PATCH /clients/:id — 簡稱 shortName", () => {
  beforeEach(() => {
    fake.db.clients = [seedClient(CLIENT_A, "甲方建設股份有限公司", "甲方")]
  })

  it("只改簡稱：update 只帶 short_name（與 updated_at），回應反映新值", async () => {
    const res = await authed(request(app).patch(`/clients/${CLIENT_A}`)).send({ shortName: " 新簡稱 " })

    expect(res.status).toBe(200)
    expect(res.body.client).toMatchObject({ id: CLIENT_A, name: "甲方建設股份有限公司", shortName: "新簡稱" })
    expect(Object.keys(clientWrites("update")[0]?.payload as object).sort()).toEqual(["short_name", "updated_at"])
    expect(clientWrites("update")[0]?.payload).toMatchObject({ short_name: "新簡稱" })
  })

  it("帶 null 清除簡稱", async () => {
    const res = await authed(request(app).patch(`/clients/${CLIENT_A}`)).send({ shortName: null })

    expect(res.status).toBe(200)
    expect(res.body.client.shortName).toBeNull()
    expect(clientWrites("update")[0]?.payload).toMatchObject({ short_name: null })
  })

  it("簡稱超過 40 字回 400 invalid_body，不寫入", async () => {
    const res = await authed(request(app).patch(`/clients/${CLIENT_A}`)).send({ shortName: "字".repeat(41) })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
    expect(clientWrites("update")).toHaveLength(0)
  })
})

describe("GET /clients?q= — 搜尋也比對簡稱", () => {
  beforeEach(() => {
    fake.db.clients = [
      seedClient(CLIENT_A, "甲方建設股份有限公司", "甲方"),
      seedClient(CLIENT_B, "乙方工程有限公司", "乙工"),
      seedClient(CLIENT_C, "丙方事務所", null),
      seedClient(CLIENT_OTHER_TENANT, "別租戶的乙工", "乙工", "99999999-9999-4999-8999-999999999999"),
    ]
  })

  const idsOf = (res: request.Response) => (res.body.clients as Array<{ id: string }>).map((c) => c.id).sort()

  it("名稱沒有、只有簡稱符合時也搜得到（且不跨租戶）", async () => {
    const res = await authed(request(app).get("/clients")).query({ q: "乙工" })

    expect(res.status).toBe(200)
    expect(idsOf(res)).toEqual([CLIENT_B])
    expect(fake.orFilters.at(-1)).toContain("short_name.ilike.%乙工%")
  })

  it("原本的名稱比對不受影響，列表每一列都帶 shortName（沒有就是 null）", async () => {
    const byName = await authed(request(app).get("/clients")).query({ q: "丙方" })
    expect(idsOf(byName)).toEqual([CLIENT_C])
    expect(byName.body.clients[0].shortName).toBeNull()

    const all = await authed(request(app).get("/clients"))
    expect(all.status).toBe(200)
    expect(idsOf(all)).toEqual([CLIENT_A, CLIENT_B, CLIENT_C])
    expect(Object.fromEntries((all.body.clients as Array<{ id: string; shortName: string | null }>).map((c) => [c.id, c.shortName]))).toEqual({
      [CLIENT_A]: "甲方",
      [CLIENT_B]: "乙工",
      [CLIENT_C]: null,
    })
  })
})
