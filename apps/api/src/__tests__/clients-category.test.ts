import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clientsRouter } from "../routes/clients.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 客戶分類改由「選項清單」驗證（2026-10-10）：DB 的 clients_category_chk 已拿掉，
 * 建立／更新時依租戶的 client_category 清單檢查——
 *   建立：必須是啟用的 code 或 null；更新：改選停用項 400 category_inactive、不存在的 code 400 invalid_category、
 *   沿用客戶已存的值放行（即使該分類後來被停用）。
 * 清單本身的讀寫在 option-lists.test.ts。⚠️ 名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(clientsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const authed = (req: request.Test) => req.set("Authorization", `Bearer ${HR_TOKEN}`)

const KEY = "client_category"
const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const CLIENT_OTHER_TENANT = "aaaaaaaa-0000-4000-8000-00000000000d"
const CLIENT_DELETED = "aaaaaaaa-0000-4000-8000-00000000000e"

let seq = 0
function option(code: string, label: string, over: Row = {}): Row {
  return {
    id: `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    tenant_id: TENANT_ID,
    list_key: KEY,
    code,
    label,
    sort_order: 10 * seq,
    is_active: true,
    created_by_emp_id: null,
    ...over,
  }
}

function seedClient(id: string, category: string | null, over: Row = {}): Row {
  return { id, tenant_id: TENANT_ID, name: "測試客戶", short_name: null, tax_id: null, category, deleted_at: null, ...over }
}

const clientWrites = (action: "insert" | "update") => fake.writes.filter((write) => write.table === "clients" && write.action === action)
const storedClient = (id: string) => fake.db.clients?.find((row) => row.id === id)

beforeEach(() => {
  fake.reset()
  seq = 0
  fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
  fake.db.clients = []
  fake.db.option_items = [
    option("architect", "建築師"),
    option("gov", "政府機關"),
    option("option_custom", "室內設計"), // 管理員自己加的啟用項
    option("option_old", "舊分類", { is_active: false }), // 已停用
    option("foreign_only", "別租戶才有", { tenant_id: OTHER_TENANT_ID }),
  ]
})

describe("POST /clients — 分類必須是啟用的選項", () => {
  it("啟用的預設分類與管理員新增的分類都可以存", async () => {
    const preset = await authed(request(app).post("/clients")).send({ name: "測試客戶甲", category: "architect" })
    expect(preset.status).toBe(201)
    expect(preset.body.client.category).toBe("architect")

    const custom = await authed(request(app).post("/clients")).send({ name: "測試客戶乙", category: "option_custom" })
    expect(custom.status).toBe(201)
    expect(custom.body.client.category).toBe("option_custom")
    expect(clientWrites("insert").map((write) => (write.payload as Row).category)).toEqual(["architect", "option_custom"])
  })

  it("停用的分類：400 category_inactive，不寫入", async () => {
    const res = await authed(request(app).post("/clients")).send({ name: "測試客戶丙", category: "option_old" })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "category_inactive", category: "option_old" })
    expect(clientWrites("insert")).toHaveLength(0)
  })

  it("不存在的 code（含只有別租戶才有的）：400 invalid_category，不寫入", async () => {
    for (const category of ["not_a_real_category", "foreign_only", "ARCHITECT"]) {
      const res = await authed(request(app).post("/clients")).send({ name: "測試客戶丁", category })
      expect(res.status, category).toBe(400)
      expect(res.body, category).toEqual({ error: "invalid_category", category })
    }
    expect(clientWrites("insert")).toHaveLength(0)
  })

  it("不選分類（null 或不帶）永遠可以，而且不用讀選項清單", async () => {
    const withNull = await authed(request(app).post("/clients")).send({ name: "測試客戶戊", category: null })
    const without = await authed(request(app).post("/clients")).send({ name: "測試客戶己" })

    expect(withNull.status).toBe(201)
    expect(withNull.body.client.category).toBeNull()
    expect(without.status).toBe(201)
    expect(without.body.client.category).toBeNull()
    expect(fake.reads).not.toContain("option_items")
  })

  it("空字串或超過 100 字不是合法的分類值：400 invalid_body", async () => {
    for (const category of ["", "   ", "x".repeat(101), 123]) {
      const res = await authed(request(app).post("/clients")).send({ name: "測試客戶庚", category })
      expect(res.status, JSON.stringify(category)).toBe(400)
      expect(res.body.error).toBe("invalid_body")
    }
    expect(clientWrites("insert")).toHaveLength(0)
  })

  it("租戶還沒補種過選項清單：先補種預設五項，預設分類一開始就能選", async () => {
    fake.db.option_items = []

    const res = await authed(request(app).post("/clients")).send({ name: "測試客戶辛", category: "engineer" })

    expect(res.status).toBe(201)
    expect(res.body.client.category).toBe("engineer")
    expect(fake.db.option_items.map((row) => row.code)).toEqual(["architect", "engineer", "owner", "gov", "other"])
  })
})

describe("PATCH /clients/:id — 改選分類", () => {
  beforeEach(() => {
    fake.db.clients = [
      seedClient(CLIENT_A, "architect"),
      seedClient(CLIENT_OTHER_TENANT, "architect", { tenant_id: OTHER_TENANT_ID }),
      seedClient(CLIENT_DELETED, "architect", { deleted_at: "2026-09-01T00:00:00.000Z" }),
    ]
  })

  const patch = (id: string, body: object) => authed(request(app).patch(`/clients/${id}`)).send(body)

  it("改選到啟用的分類（預設或管理員新增的）可以", async () => {
    const res = await patch(CLIENT_A, { category: "option_custom" })

    expect(res.status).toBe(200)
    expect(res.body.client.category).toBe("option_custom")
    expect(storedClient(CLIENT_A)?.category).toBe("option_custom")
  })

  it("改選到停用的分類：400 category_inactive；不存在的 code：400 invalid_category；都不寫入", async () => {
    const inactive = await patch(CLIENT_A, { category: "option_old" })
    expect(inactive.status).toBe(400)
    expect(inactive.body).toEqual({ error: "category_inactive", category: "option_old" })

    const unknown = await patch(CLIENT_A, { category: "not_a_real_category" })
    expect(unknown.status).toBe(400)
    expect(unknown.body).toEqual({ error: "invalid_category", category: "not_a_real_category" })

    expect(clientWrites("update")).toHaveLength(0)
    expect(storedClient(CLIENT_A)?.category).toBe("architect")
  })

  it("沿用客戶已存的停用分類放行：舊客戶照樣改得了備註等其他欄位", async () => {
    fake.db.clients = [seedClient(CLIENT_A, "option_old")]

    const sameValue = await patch(CLIENT_A, { category: "option_old", note: "改備註" })
    expect(sameValue.status).toBe(200)
    expect(sameValue.body.client.category).toBe("option_old")
    expect(clientWrites("update")[0]?.payload).toMatchObject({ category: "option_old", note: "改備註" })

    // 只改別的欄位（不帶 category）也一樣
    const otherField = await patch(CLIENT_A, { note: "再改一次" })
    expect(otherField.status).toBe(200)
    expect(storedClient(CLIENT_A)?.category).toBe("option_old")
  })

  it("沿用已存的值也包含「清單裡根本找不到」的舊值（例如分類被刪掉前留下的資料）", async () => {
    fake.db.clients = [seedClient(CLIENT_A, "legacy_code")]

    const res = await patch(CLIENT_A, { category: "legacy_code", note: "x" })

    expect(res.status).toBe(200)
    expect(res.body.client.category).toBe("legacy_code")
  })

  it("從停用的分類改選到啟用的可以；從啟用的改選到停用的不行", async () => {
    fake.db.clients = [seedClient(CLIENT_A, "option_old")]
    const toActive = await patch(CLIENT_A, { category: "gov" })
    expect(toActive.status).toBe(200)
    expect(storedClient(CLIENT_A)?.category).toBe("gov")

    const toInactive = await patch(CLIENT_A, { category: "option_old" })
    expect(toInactive.status).toBe(400)
    expect(toInactive.body.error).toBe("category_inactive")
    expect(storedClient(CLIENT_A)?.category).toBe("gov")
  })

  it("category: null 清除分類永遠可以；不帶 category 的更新不讀選項清單", async () => {
    const cleared = await patch(CLIENT_A, { category: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.client.category).toBeNull()
    expect(fake.reads).not.toContain("option_items")

    fake.reads.length = 0
    const noCategory = await patch(CLIENT_A, { note: "只改備註" })
    expect(noCategory.status).toBe(200)
    // 除了 requireFinance 查呼叫者角色（employees）之外，沒有任何讀取：不讀清單、也不先讀客戶現值。
    expect(fake.reads.filter((table) => table !== "employees")).toEqual([])
  })

  it("別租戶的客戶或已軟刪的客戶：回 404 not_found（不是 400），也不寫入", async () => {
    for (const id of [CLIENT_OTHER_TENANT, CLIENT_DELETED]) {
      const res = await patch(id, { category: "gov" })
      expect(res.status, id).toBe(404)
      expect(res.body.error, id).toBe("not_found")
    }
    // fake 對沒命中任何列的 update 也會記一筆（matched: 0）；要確認的是沒有任何一列被改到。
    expect(clientWrites("update").filter((write) => (write.matched ?? 0) > 0)).toHaveLength(0)
    expect(storedClient(CLIENT_OTHER_TENANT)?.category).toBe("architect")
    expect(storedClient(CLIENT_DELETED)?.category).toBe("architect")
  })

  it("沿用比對的是這個客戶自己存的值：別人的客戶存著停用分類，不會讓這個客戶也能選", async () => {
    fake.db.clients = [seedClient(CLIENT_A, "architect"), seedClient("aaaaaaaa-0000-4000-8000-00000000000b", "option_old")]

    const res = await patch(CLIENT_A, { category: "option_old" })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("category_inactive")
  })
})

describe("GET /clients — 分類照原樣回傳 code", () => {
  it("回的是存在資料列上的 code（畫面用選項清單把它翻成名稱），停用或已不在清單的舊值也照回", async () => {
    fake.db.clients = [
      seedClient(CLIENT_A, "option_old", { name: "測試客戶甲" }),
      seedClient("aaaaaaaa-0000-4000-8000-00000000000b", "legacy_code", { name: "測試客戶乙" }),
      seedClient("aaaaaaaa-0000-4000-8000-00000000000c", null, { name: "測試客戶丙" }),
    ]

    const res = await authed(request(app).get("/clients"))

    expect(res.status).toBe(200)
    expect((res.body.clients as Row[]).map((entry) => [entry.name, entry.category])).toEqual([
      ["測試客戶丙", null],
      ["測試客戶乙", "legacy_code"],
      ["測試客戶甲", "option_old"],
    ])
  })
})
