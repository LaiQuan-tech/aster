import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { optionListsRouter } from "../routes/option-lists.js"
import { catalogCode } from "../services/catalog-code.js"
import {
  OPTION_LABEL_MAX,
  OPTION_LISTS,
  OPTION_LIST_MAX_ITEMS,
  allocateOptionCode,
  checkOptionPick,
  findOptionList,
  loadOptionItems,
  loadOptionUsage,
  optionLabelKey,
  planOptionPut,
  type OptionExisting,
  type OptionUpdateStep,
} from "../services/option-lists.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 全站共用「選項清單」機制（2026-10-10）：登記表、讀取（含補種）、整批存檔（新增／改名／排序／停用）、
 * 刪除（沒用過才可刪）、使用量、權限；客戶路由的分類驗證在 clients-category.test.ts。
 * ⚠️ 名稱、代碼都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(optionListsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const KEY = "client_category"
const DEF = findOptionList(KEY)!

const HR_TOKEN = "hr-user"
const ACCOUNTANT_TOKEN = "accountant-user"
const STAFF_TOKEN = "staff-user"
/** 有登入、但在這個租戶沒有員工列。 */
const GHOST_TOKEN = "ghost-user"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const ACCOUNTANT_ID = "bbbbbbbb-0000-4000-8000-000000000003"

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

/** 預設五項在 API 回應裡的樣子（sortOrder 10–50）。 */
const DEFAULTS = [
  { code: "architect", label: "建築師", sortOrder: 10, isActive: true },
  { code: "engineer", label: "技師", sortOrder: 20, isActive: true },
  { code: "owner", label: "業主", sortOrder: 30, isActive: true },
  { code: "gov", label: "政府機關", sortOrder: 40, isActive: true },
  { code: "other", label: "其他", sortOrder: 50, isActive: true },
]

let seq = 0
const rowId = () => `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`

function item(over: Row = {}): Row {
  return {
    id: rowId(),
    tenant_id: TENANT_ID,
    list_key: KEY,
    code: "custom",
    label: "自訂",
    sort_order: 10,
    is_active: true,
    created_by_emp_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  }
}

function client(id: string, category: string | null, over: Row = {}): Row {
  return { id: `cccccccc-0000-4000-8000-${id.padStart(12, "0")}`, tenant_id: TENANT_ID, name: `測試客戶${id}`, category, deleted_at: null, ...over }
}

const stored = () => (fake.db.option_items ??= [])
const mine = () => stored().filter((row) => row.tenant_id === TENANT_ID && row.list_key === KEY)
const byCode = (code: string) => mine().find((row) => row.code === code)
const itemWrites = (action?: "insert" | "update" | "delete" | "upsert") =>
  fake.writes.filter((write) => write.table === "option_items" && (!action || write.action === action))
const auditRows = () => fake.writes.filter((write) => write.table === "audit_logs").map((write) => write.payload as Row)
const codesOf = (res: request.Response) => (res.body.items as Row[]).map((entry) => entry.code)

function seedDefaults(tenantId = TENANT_ID) {
  for (const d of DEF.defaults) stored().push(item({ tenant_id: tenantId, code: d.code, label: d.label, sort_order: d.sortOrder }))
}

beforeEach(() => {
  fake.reset()
  seq = 0
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: STAFF_ID, tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
    { id: ACCOUNTANT_ID, tenant_id: TENANT_ID, user_id: ACCOUNTANT_TOKEN, role: "accountant", dept_id: null },
  ]
  fake.db.option_items = []
  fake.db.clients = []
  // 仿 DB 的兩個唯一索引（packages/db sql/0048）：(tenant, list, code) 與 (tenant, list, label)。
  fake.uniques.option_items = [
    ["tenant_id", "list_key", "code"],
    ["tenant_id", "list_key", "label"],
  ]
})

describe("登記表 OPTION_LISTS", () => {
  it("key 不重複；每筆的標題／說明／管理角色／使用欄位／預設項目都合規（掛新清單時守住這份清單）", () => {
    const keys = OPTION_LISTS.map((def) => def.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const def of OPTION_LISTS) {
      expect(def.key).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(def.title.length, def.key).toBeGreaterThan(0)
      expect(def.description.length, def.key).toBeGreaterThan(0)
      expect(def.manageRoles.length, def.key).toBeGreaterThan(0)
      for (const source of def.usage) {
        expect(source.table).toMatch(/^[a-z][a-z0-9_]*$/)
        expect(source.column).toMatch(/^[a-z][a-z0-9_]*$/)
      }
      const codes = def.defaults.map((d) => d.code)
      expect(new Set(codes).size, `${def.key} 預設 code 不重複`).toBe(codes.length)
      const labels = def.defaults.map((d) => optionLabelKey(d.label))
      expect(new Set(labels).size, `${def.key} 預設名稱不重複`).toBe(labels.length)
      for (const d of def.defaults) {
        expect(d.code).toMatch(/^[a-z0-9_]+$/)
        expect(d.label.trim().length).toBeGreaterThan(0)
        expect(d.label.length).toBeLessThanOrEqual(OPTION_LABEL_MAX)
      }
      expect(findOptionList(def.key)).toBe(def)
    }
    expect(findOptionList("nope")).toBeUndefined()
  })

  it("客戶分類：預設五項與舊的寫死清單一致（code 一經發佈不能改，舊客戶資料存的就是它）；用 clients.category 計數；財務層可管理", () => {
    expect(DEF.defaults.map((d) => `${d.code}:${d.label}:${d.sortOrder}`)).toEqual([
      "architect:建築師:10",
      "engineer:技師:20",
      "owner:業主:30",
      "gov:政府機關:40",
      "other:其他:50",
    ])
    expect(DEF.usage).toEqual([{ table: "clients", column: "category" }])
    expect([...DEF.manageRoles].sort()).toEqual(["accountant", "hr_admin", "platform_admin"])
  })
})

describe("GET /option-lists — 清單定義", () => {
  it("沒帶 token 回 401", async () => {
    const res = await request(app).get("/option-lists")
    expect(res.status).toBe(401)
  })

  it("回登記表裡的清單；canManage 依角色：HR／會計 true，一般員工與沒有員工列的 false", async () => {
    const expected = (role: string | null) => ({
      lists: OPTION_LISTS.map((def) => ({
        key: def.key,
        title: def.title,
        description: def.description,
        canManage: !!role && def.manageRoles.includes(role),
      })),
    })
    for (const [token, role] of [
      [HR_TOKEN, "hr_admin"],
      [ACCOUNTANT_TOKEN, "accountant"],
      [STAFF_TOKEN, "employee"],
      [GHOST_TOKEN, null],
    ] as const) {
      const res = await as(token, request(app).get("/option-lists"))
      expect(res.status, token).toBe(200)
      expect(res.body, token).toEqual(expected(role))
    }
    const hr = await as(HR_TOKEN, request(app).get("/option-lists"))
    expect(hr.body.lists[0]).toMatchObject({ key: KEY, title: "客戶分類", canManage: true })
    const staff = await as(STAFF_TOKEN, request(app).get("/option-lists"))
    expect(staff.body.lists[0]).toMatchObject({ key: KEY, canManage: false })
  })
})

describe("GET /option-lists/:key — 讀取與補種", () => {
  it("沒登記的 key 回 404 list_not_found", async () => {
    const res = await as(HR_TOKEN, request(app).get("/option-lists/not_a_list"))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("list_not_found")
  })

  it("租戶這份清單一列都沒有：補種預設五項再回，依 sortOrder 排；一次 upsert（ON CONFLICT DO NOTHING）", async () => {
    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ key: KEY, title: "客戶分類", canManage: false })
    expect(res.body.items).toEqual(DEFAULTS)
    expect(res.body).not.toHaveProperty("usage")
    expect(mine().map((row) => row.code)).toEqual(["architect", "engineer", "owner", "gov", "other"])
    const upserts = itemWrites("upsert")
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.payload).toHaveLength(5)
    for (const row of upserts[0]?.payload as Row[]) {
      expect(row).toMatchObject({ tenant_id: TENANT_ID, list_key: KEY })
      expect(row).not.toHaveProperty("created_by_emp_id")
    }
  })

  it("補種只發生一次：第二次讀取不再寫入", async () => {
    await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))
    const again = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(again.status).toBe(200)
    expect(again.body.items).toEqual(DEFAULTS)
    expect(itemWrites()).toHaveLength(1)
    expect(mine()).toHaveLength(5)
  })

  it("已經有任何一列就不補種：管理員刪掉的預設項目不會自己長回來", async () => {
    stored().push(item({ code: "option_only", label: "唯一的自訂項", sort_order: 10 }))

    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(res.status).toBe(200)
    expect(codesOf(res)).toEqual(["option_only"])
    expect(itemWrites()).toHaveLength(0)
  })

  it("別租戶的列不會被讀到、也不會擋住補種；別租戶的資料不被動到", async () => {
    stored().push(item({ tenant_id: OTHER_TENANT_ID, code: "option_other", label: "別租戶的項目" }))

    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(res.status).toBe(200)
    expect(res.body.items).toEqual(DEFAULTS)
    expect(stored().filter((row) => row.tenant_id === OTHER_TENANT_ID)).toHaveLength(1)
    expect(mine()).toHaveLength(5)
  })

  it("兩個請求同時第一次讀取：仍然只種一份、兩邊都讀到五項", async () => {
    const [first, second] = await Promise.all([loadOptionItems(TENANT_ID, DEF), loadOptionItems(TENANT_ID, DEF)])

    expect(first.map((row) => row.code)).toEqual(["architect", "engineer", "owner", "gov", "other"])
    expect(second.map((row) => row.code)).toEqual(["architect", "engineer", "owner", "gov", "other"])
    expect(mine()).toHaveLength(5)
  })

  it("補種失敗（非競態的錯誤）不吞掉：回 500", async () => {
    fake.injectError({ table: "option_items", action: "upsert", error: { code: "XX000", message: "boom" } })

    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(res.status).toBe(500)
    expect(res.body.error).toContain("boom")
    expect(mine()).toHaveLength(0)
  })
})

describe("GET /option-lists/:key — 停用項與使用量的可見範圍", () => {
  beforeEach(() => {
    seedDefaults()
    stored().push(item({ code: "option_old", label: "舊分類", sort_order: 60, is_active: false }))
    fake.db.clients = [
      client("1", "architect"),
      client("2", "architect", { deleted_at: "2026-09-01T00:00:00.000Z" }), // 已軟刪：照算
      client("3", "owner"),
      client("4", null),
      client("5", "legacy_code"), // 不在清單裡的舊值：不算任何項目
      client("6", "architect", { tenant_id: OTHER_TENANT_ID }), // 別租戶：不算
      client("7", "option_old"),
    ]
  })

  it("預設只回啟用的項目，沒有 usage", async () => {
    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(res.status).toBe(200)
    expect(res.body.items).toEqual(DEFAULTS)
    expect(res.body).not.toHaveProperty("usage")
  })

  it("?includeInactive=1：任何登入者都可連停用的一起看（畫面把舊資料的代碼翻成名稱用），仍不含使用量", async () => {
    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}?includeInactive=1`))

    expect(res.status).toBe(200)
    expect(res.body.canManage).toBe(false)
    expect(codesOf(res)).toEqual(["architect", "engineer", "owner", "gov", "other", "option_old"])
    expect((res.body.items as Row[]).find((entry) => entry.code === "option_old")).toEqual({
      code: "option_old",
      label: "舊分類",
      sortOrder: 60,
      isActive: false,
    })
    expect(res.body).not.toHaveProperty("usage")
    expect(fake.reads.filter((table) => table === "clients")).toHaveLength(0)
  })

  it("?manage=1（管理者）：全部項目＋usage；已軟刪的客戶照算，別租戶、沒分類、不在清單的舊值都不算", async () => {
    for (const token of [HR_TOKEN, ACCOUNTANT_TOKEN]) {
      const res = await as(token, request(app).get(`/option-lists/${KEY}?manage=1`))

      expect(res.status, token).toBe(200)
      expect(res.body.canManage, token).toBe(true)
      expect(codesOf(res), token).toEqual(["architect", "engineer", "owner", "gov", "other", "option_old"])
      expect(res.body.usage, token).toEqual({ architect: 2, engineer: 0, owner: 1, gov: 0, other: 0, option_old: 1 })
    }
  })

  it("使用量是批次查：整份清單只掃一次來源資料表，不隨選項數增加", async () => {
    await as(HR_TOKEN, request(app).get(`/option-lists/${KEY}?manage=true`))

    expect(fake.reads.filter((table) => table === "clients")).toHaveLength(1)
    expect(fake.reads.filter((table) => table === "option_items")).toHaveLength(1)
  })

  it("?manage=1 但沒有管理權限：被忽略（只回啟用項、沒有 usage），不是 403", async () => {
    for (const token of [STAFF_TOKEN, GHOST_TOKEN]) {
      const res = await as(token, request(app).get(`/option-lists/${KEY}?manage=1`))

      expect(res.status, token).toBe(200)
      expect(res.body.canManage, token).toBe(false)
      expect(res.body.items, token).toEqual(DEFAULTS)
      expect(res.body, token).not.toHaveProperty("usage")
    }
  })

  it("使用量超過 PostgREST 單頁 1000 列也數得準：後面頁的選項不會被誤判成沒被用過", async () => {
    const pad = (n: number) => String(n).padStart(12, "0")
    fake.db.clients = [
      ...Array.from({ length: 1000 }, (_, i) => ({ id: `aaaaaaaa-0000-4000-8000-${pad(i)}`, tenant_id: TENANT_ID, category: "architect", deleted_at: null })),
      { id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, category: "gov", deleted_at: null },
    ]

    const usage = await loadOptionUsage(TENANT_ID, DEF, ["architect", "gov", "owner"])

    expect(usage).toEqual({ architect: 1000, gov: 1, owner: 0 })
    expect(fake.reads.filter((table) => table === "clients")).toHaveLength(2)
  })

  it("沒有任何 code 時不打來源資料表；來源查詢出錯不吞（回 500，不能讓人在查不到時誤刪）", async () => {
    expect(await loadOptionUsage(TENANT_ID, DEF, [])).toEqual({})
    expect(fake.reads).toEqual([])

    fake.injectError({ table: "clients", action: "select", error: { code: "XX000", message: "boom" } })
    const res = await as(HR_TOKEN, request(app).get(`/option-lists/${KEY}?manage=1`))
    expect(res.status).toBe(500)
    expect(res.body.error).toContain("boom")
  })
})

describe("PUT /option-lists/:key — 整批存檔", () => {
  beforeEach(() => {
    seedDefaults()
  })

  const putItems = (token: string, items: unknown[], key = KEY) => as(token, request(app).put(`/option-lists/${key}`)).send({ items })
  const defaultsPayload = () => DEFAULTS.map(({ code, label, sortOrder }) => ({ code, label, sortOrder }))

  it("新增：沒帶 code 的項目由名稱雜湊產生 code、排在最後、預設啟用；沒變的既有項目不產生寫入；回管理視圖", async () => {
    const res = await putItems(HR_TOKEN, [...defaultsPayload(), { label: "室內設計" }])

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ key: KEY, canManage: true })
    expect(res.body.items).toHaveLength(6)
    const created = (res.body.items as Row[]).find((entry) => entry.label === "室內設計") as Row
    expect(created).toEqual({ code: catalogCode("室內設計"), label: "室內設計", sortOrder: 60, isActive: true })
    expect(created.code).toMatch(/^option_[a-f0-9]{12}$/)
    expect(res.body.usage[created.code]).toBe(0)
    expect(itemWrites("update")).toHaveLength(0)
    expect(itemWrites("insert")).toHaveLength(1)
    expect(itemWrites("insert")[0]?.payload).toEqual([
      { tenant_id: TENANT_ID, list_key: KEY, created_by_emp_id: HR_ID, code: catalogCode("室內設計"), label: "室內設計", sort_order: 60, is_active: true },
    ])
    expect(auditRows()).toEqual([
      expect.objectContaining({ tenant_id: TENANT_ID, table_name: "option_items", action: "UPDATE", actor_emp_id: HR_ID }),
    ])
  })

  it("新增多項：依序接在最後（每項加 10）；指定 sortOrder 與 isActive 照用；名稱前後空白會去掉", async () => {
    const res = await putItems(HR_TOKEN, [
      { label: "  室內設計  " },
      { label: "景觀", sortOrder: 5, isActive: false },
      { label: "測量" },
    ])

    expect(res.status).toBe(200)
    const created = (res.body.items as Row[]).filter((entry) => String(entry.code).startsWith("option_"))
    expect(created.map((entry) => [entry.label, entry.sortOrder, entry.isActive])).toEqual([
      ["景觀", 5, false],
      ["室內設計", 60, true],
      ["測量", 80, true],
    ])
    expect(byCode(catalogCode("室內設計"))?.label).toBe("室內設計")
  })

  it("改名：code 不變、舊資料照樣對得上；只寫 label（與 updated_at）；沒列在 payload 的項目不動也不會被刪", async () => {
    fake.db.clients = [client("1", "owner")]

    const res = await putItems(HR_TOKEN, [{ code: "owner", label: "業主單位" }])

    expect(res.status).toBe(200)
    expect(byCode("owner")?.label).toBe("業主單位")
    expect(itemWrites("update")).toHaveLength(1)
    expect(Object.keys(itemWrites("update")[0]?.payload as object).sort()).toEqual(["label", "updated_at"])
    expect(res.body.usage.owner).toBe(1)
    expect(mine()).toHaveLength(5)
    expect(byCode("architect")?.label).toBe("建築師")
  })

  it("排序：照 sortOrder 重排，只寫 sort_order 真的有變的項目", async () => {
    const reversed = defaultsPayload()
      .reverse()
      .map((entry, index) => ({ ...entry, sortOrder: (index + 1) * 10 }))

    const res = await putItems(HR_TOKEN, reversed)

    expect(res.status).toBe(200)
    expect(codesOf(res)).toEqual(["other", "gov", "owner", "engineer", "architect"])
    expect(itemWrites("update")).toHaveLength(4) // owner 的 30 沒變
    for (const write of itemWrites("update")) expect(Object.keys(write.payload as object).sort()).toEqual(["sort_order", "updated_at"])
  })

  it("停用／重新啟用：一般讀取看不到停用項、?includeInactive=1 看得到；省略 isActive 維持現狀", async () => {
    const off = await putItems(HR_TOKEN, [{ code: "gov", label: "政府機關", isActive: false }])
    expect(off.status).toBe(200)
    expect(byCode("gov")?.is_active).toBe(false)
    expect(itemWrites("update")[0]?.payload).toEqual({ is_active: false, updated_at: expect.any(String) })

    const plain = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))
    expect(codesOf(plain)).not.toContain("gov")
    const all = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}?includeInactive=1`))
    expect((all.body.items as Row[]).find((entry) => entry.code === "gov")).toMatchObject({ isActive: false })

    const keep = await putItems(HR_TOKEN, [{ code: "gov", label: "政府機關" }])
    expect(keep.status).toBe(200)
    expect(byCode("gov")?.is_active).toBe(false)

    const on = await putItems(HR_TOKEN, [{ code: "gov", label: "政府機關", isActive: true }])
    expect(on.status).toBe(200)
    expect(byCode("gov")?.is_active).toBe(true)
  })

  it("還沒補種過的租戶直接存檔：先補種預設五項，新增的接在後面", async () => {
    fake.db.option_items = []

    const res = await putItems(HR_TOKEN, [{ label: "室內設計" }])

    expect(res.status).toBe(200)
    expect(codesOf(res)).toEqual(["architect", "engineer", "owner", "gov", "other", catalogCode("室內設計")])
    expect((res.body.items as Row[])[5]).toMatchObject({ sortOrder: 60 })
  })

  it("名稱重複回 409 label_taken，整批一筆都不寫：撞到既有項、撞到 payload 內另一項、大小寫與全半形視為同名", async () => {
    const cases: Array<{ name: string; items: unknown[]; label: string }> = [
      { name: "新增撞到既有項", items: [{ label: "業主" }], label: "業主" },
      { name: "新增撞到既有項（前後空白不算不同）", items: [{ label: "  業主 " }], label: "業主" },
      { name: "payload 內兩個新項同名", items: [{ label: "新甲" }, { label: "新甲" }], label: "新甲" },
      { name: "改名撞到沒動的另一項", items: [{ code: "engineer", label: "建築師" }], label: "建築師" },
    ]
    for (const { name, items, label } of cases) {
      const res = await putItems(HR_TOKEN, items)
      expect(res.status, name).toBe(409)
      expect(res.body, name).toEqual({ error: "label_taken", label })
    }
    stored().push(item({ code: "option_abc", label: "Abc", sort_order: 60 }))
    const width = await putItems(HR_TOKEN, [{ label: "ＡＢＣ" }])
    expect(width.status).toBe(409)
    const lower = await putItems(HR_TOKEN, [{ label: "abc" }])
    expect(lower.status).toBe(409)
    expect(itemWrites("insert")).toHaveLength(0)
    expect(itemWrites("update")).toHaveLength(0)
    expect(auditRows()).toHaveLength(0)
  })

  it("自己改大小寫不算重複", async () => {
    stored().push(item({ code: "option_abc", label: "Abc", sort_order: 60 }))

    const res = await putItems(HR_TOKEN, [{ code: "option_abc", label: "ABC" }])

    expect(res.status).toBe(200)
    expect(byCode("option_abc")?.label).toBe("ABC")
  })

  it("格式不對回 400 invalid_body，不寫入：空清單、空白名稱、超過 40 字、sortOrder 非整數或負數、isActive 非布林", async () => {
    const bad: unknown[] = [
      {},
      { items: "x" },
      { items: [] },
      { items: [{ label: "" }] },
      { items: [{ label: "   " }] },
      { items: [{ label: "字".repeat(OPTION_LABEL_MAX + 1) }] },
      { items: [{ label: "A", sortOrder: 1.5 }] },
      { items: [{ label: "A", sortOrder: -1 }] },
      { items: [{ label: "A", isActive: "yes" }] },
      { items: [{ label: "A", code: "" }] },
    ]
    for (const body of bad) {
      const res = await as(HR_TOKEN, request(app).put(`/option-lists/${KEY}`)).send(body as object)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error).toBe("invalid_body")
    }
    expect(itemWrites()).toHaveLength(0)

    const exactly40 = await putItems(HR_TOKEN, [{ label: "字".repeat(OPTION_LABEL_MAX) }])
    expect(exactly40.status).toBe(200)
  })

  it("帶了不存在的 code 回 404 not_found；同一個 code 出現兩次回 400 duplicate_item；都不寫入", async () => {
    const missing = await putItems(HR_TOKEN, [{ code: "option_gone", label: "不存在" }])
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: "not_found", code: "option_gone" })

    const twice = await putItems(HR_TOKEN, [
      { code: "owner", label: "業主甲" },
      { code: "owner", label: "業主乙" },
    ])
    expect(twice.status).toBe(400)
    expect(twice.body).toEqual({ error: "duplicate_item", code: "owner" })
    expect(itemWrites("update")).toHaveLength(0)
    expect(byCode("owner")?.label).toBe("業主")
  })

  it("一份清單最多 200 項：超過回 400 too_many_items，剛好 200 可以", async () => {
    fake.db.option_items = Array.from({ length: OPTION_LIST_MAX_ITEMS - 1 }, (_, i) => item({ code: `c${i}`, label: `項目${i}`, sort_order: i }))

    const over = await putItems(HR_TOKEN, [{ label: "新一" }, { label: "新二" }])
    expect(over.status).toBe(400)
    expect(over.body).toEqual({ error: "too_many_items", max: OPTION_LIST_MAX_ITEMS })
    expect(itemWrites("insert")).toHaveLength(0)

    const exactly = await putItems(HR_TOKEN, [{ label: "新一" }])
    expect(exactly.status).toBe(200)
    expect(mine()).toHaveLength(OPTION_LIST_MAX_ITEMS)
  })

  it("兩個項目名稱互換：不會在中途撞到唯一索引（先把一筆挪去暫名騰位），最後名稱不含暫名", async () => {
    fake.db.option_items = [item({ code: "a", label: "甲", sort_order: 10 }), item({ code: "b", label: "乙", sort_order: 20 })]

    const res = await putItems(HR_TOKEN, [
      { code: "a", label: "乙" },
      { code: "b", label: "甲" },
    ])

    expect(res.status).toBe(200)
    expect(byCode("a")?.label).toBe("乙")
    expect(byCode("b")?.label).toBe("甲")
    expect(itemWrites("update")).toHaveLength(3) // a→暫名、b→甲、a→乙
    expect(mine().every((row) => !String(row.label).includes("⟲"))).toBe(true)
  })

  it("改名鏈：甲→乙、乙→丙 在同一批——先改乙（騰出名稱），再改甲", async () => {
    fake.db.option_items = [item({ code: "a", label: "甲", sort_order: 10 }), item({ code: "b", label: "乙", sort_order: 20 })]

    const res = await putItems(HR_TOKEN, [
      { code: "a", label: "乙" },
      { code: "b", label: "丙" },
    ])

    expect(res.status).toBe(200)
    expect(itemWrites("update").map((write) => (write.payload as Row).label)).toEqual(["丙", "乙"])
    expect(mine().map((row) => `${row.code}:${row.label}`)).toEqual(["a:乙", "b:丙"])
  })

  it("改名後又新增同名項：新項拿不同的 code（不撞舊項的 code），兩個都在", async () => {
    const oldCode = catalogCode("室內設計")
    stored().push(item({ code: oldCode, label: "室內設計二", sort_order: 60 }))

    const res = await putItems(HR_TOKEN, [{ label: "室內設計" }])

    expect(res.status).toBe(200)
    const created = (res.body.items as Row[]).find((entry) => entry.label === "室內設計") as Row
    expect(created.code).toBe(catalogCode("室內設計#2"))
    expect(created.code).not.toBe(oldCode)
    expect(byCode(oldCode)?.label).toBe("室內設計二")
  })

  it("競態：寫入時撞到唯一索引（另一位管理者剛好改成同名）是 409 label_taken，不是 500；其他資料庫錯誤才是 500", async () => {
    fake.injectError({ table: "option_items", action: "update", error: { code: "23505", message: "duplicate key" } })
    const update = await putItems(HR_TOKEN, [{ code: "owner", label: "業主單位" }])
    expect(update.status).toBe(409)
    expect(update.body.error).toBe("label_taken")

    fake.injectError({ table: "option_items", action: "insert", error: { code: "23505", message: "duplicate key" } })
    const insert = await putItems(HR_TOKEN, [{ label: "室內設計" }])
    expect(insert.status).toBe(409)
    expect(insert.body.error).toBe("label_taken")

    fake.injectError({ table: "option_items", action: "update", error: { code: "XX000", message: "boom" } })
    const broken = await putItems(HR_TOKEN, [{ code: "owner", label: "業主單位" }])
    expect(broken.status).toBe(500)
    expect(broken.body.error).toContain("boom")
  })

  it("權限：HR 與會計（比照客戶名冊寫入）可以；一般員工、沒有員工列的帳號 403 且不寫入", async () => {
    for (const token of [STAFF_TOKEN, GHOST_TOKEN]) {
      const res = await putItems(token, [{ label: "室內設計" }])
      expect(res.status, token).toBe(403)
      expect(res.body.error, token).toBe("forbidden")
    }
    expect(itemWrites()).toHaveLength(0)

    const accountant = await putItems(ACCOUNTANT_TOKEN, [{ label: "景觀" }])
    expect(accountant.status).toBe(200)
    expect(itemWrites("insert")[0]?.payload).toEqual([expect.objectContaining({ created_by_emp_id: ACCOUNTANT_ID })])
  })

  it("沒登記的 key 回 404（先於權限檢查）；沒帶 token 回 401", async () => {
    const unknown = await putItems(STAFF_TOKEN, [{ label: "x" }], "not_a_list")
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe("list_not_found")

    const anonymous = await request(app).put(`/option-lists/${KEY}`).send({ items: [{ label: "x" }] })
    expect(anonymous.status).toBe(401)
  })
})

describe("DELETE /option-lists/:key/:code — 只能刪沒被用過的選項", () => {
  beforeEach(() => {
    seedDefaults()
  })

  const del = (token: string, code: string, key = KEY) => as(token, request(app).delete(`/option-lists/${key}/${code}`))

  it("沒被用過：刪掉，留稽核紀錄（舊值＋操作者）", async () => {
    const id = byCode("gov")?.id

    const res = await del(HR_TOKEN, "gov")

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ code: "gov" })
    expect(byCode("gov")).toBeUndefined()
    expect(mine()).toHaveLength(4)
    expect(itemWrites("delete")).toHaveLength(1)
    expect(auditRows()).toEqual([
      expect.objectContaining({
        tenant_id: TENANT_ID,
        table_name: "option_items",
        record_id: id,
        action: "DELETE",
        actor_emp_id: HR_ID,
        old_row: expect.objectContaining({ listKey: KEY, code: "gov", label: "政府機關" }),
      }),
    ])
  })

  it("被用過：409 option_in_use 附筆數，項目留著、不寫入；已軟刪的客戶也算用過", async () => {
    fake.db.clients = [client("1", "architect"), client("2", "architect", { deleted_at: "2026-09-01T00:00:00.000Z" })]

    const res = await del(HR_TOKEN, "architect")

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "option_in_use", usage: 2 })
    expect(byCode("architect")).toBeDefined()
    expect(itemWrites("delete")).toHaveLength(0)
    expect(auditRows()).toHaveLength(0)
  })

  it("只被「已軟刪」的客戶用到也不能刪（外鍵不存在，規則靠計數；所有列都算）", async () => {
    fake.db.clients = [client("1", "gov", { deleted_at: "2026-09-01T00:00:00.000Z" })]

    const res = await del(HR_TOKEN, "gov")

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "option_in_use", usage: 1 })
  })

  it("停用的選項只要還有資料在用，一樣不能刪", async () => {
    stored().push(item({ code: "option_old", label: "舊分類", sort_order: 60, is_active: false }))
    fake.db.clients = [client("1", "option_old")]

    const res = await del(HR_TOKEN, "option_old")

    expect(res.status).toBe(409)
    expect(res.body.usage).toBe(1)
    expect(byCode("option_old")).toBeDefined()
  })

  it("別租戶的客戶用到同一個 code 不影響本租戶刪除；別租戶的項目也刪不到", async () => {
    fake.db.clients = [client("1", "gov", { tenant_id: OTHER_TENANT_ID })]
    stored().push(item({ tenant_id: OTHER_TENANT_ID, code: "zzz", label: "別租戶的項目" }))

    const ok = await del(HR_TOKEN, "gov")
    expect(ok.status).toBe(200)

    const foreign = await del(HR_TOKEN, "zzz")
    expect(foreign.status).toBe(404)
    expect(stored().some((row) => row.tenant_id === OTHER_TENANT_ID && row.code === "zzz")).toBe(true)
  })

  it("找不到的 code 回 404 not_found；沒登記的 key 回 404 list_not_found", async () => {
    const missing = await del(HR_TOKEN, "option_gone")
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: "not_found", code: "option_gone" })

    const unknown = await del(HR_TOKEN, "gov", "not_a_list")
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe("list_not_found")
    expect(byCode("gov")).toBeDefined()
  })

  it("權限：會計可以刪；一般員工、沒有員工列的帳號 403，項目留著", async () => {
    for (const token of [STAFF_TOKEN, GHOST_TOKEN]) {
      const res = await del(token, "other")
      expect(res.status, token).toBe(403)
      expect(res.body.error, token).toBe("forbidden")
    }
    expect(byCode("other")).toBeDefined()
    expect(itemWrites("delete")).toHaveLength(0)

    const accountant = await del(ACCOUNTANT_TOKEN, "other")
    expect(accountant.status).toBe(200)
    expect(byCode("other")).toBeUndefined()
  })

  it("查使用量出錯就不刪（回 500，項目留著）——這個數字決定能不能刪，查不到不能當成 0", async () => {
    fake.injectError({ table: "clients", action: "select", error: { code: "XX000", message: "boom" } })

    const res = await del(HR_TOKEN, "gov")

    expect(res.status).toBe(500)
    expect(byCode("gov")).toBeDefined()
    expect(itemWrites("delete")).toHaveLength(0)
  })

  it("整份刪光之後，下一次讀取會重新補種預設（空清單＝重新開始）", async () => {
    for (const d of DEFAULTS) {
      const res = await del(HR_TOKEN, d.code)
      expect(res.status, d.code).toBe(200)
    }
    expect(mine()).toHaveLength(0)

    const res = await as(STAFF_TOKEN, request(app).get(`/option-lists/${KEY}`))

    expect(res.body.items).toEqual(DEFAULTS)
  })
})

describe("checkOptionPick — 寫入時驗證新選或改選的值", () => {
  beforeEach(() => {
    seedDefaults()
    stored().push(item({ code: "option_old", label: "舊分類", sort_order: 60, is_active: false }))
  })

  it("沒選、沿用原值：直接 ok，不查資料庫（即使原值已停用或根本不在清單裡）", async () => {
    expect(await checkOptionPick(TENANT_ID, DEF, null)).toBe("ok")
    expect(await checkOptionPick(TENANT_ID, DEF, undefined, "architect")).toBe("ok")
    expect(await checkOptionPick(TENANT_ID, DEF, "")).toBe("ok")
    expect(await checkOptionPick(TENANT_ID, DEF, "option_old", "option_old")).toBe("ok")
    expect(await checkOptionPick(TENANT_ID, DEF, "legacy_code", "legacy_code")).toBe("ok")
    expect(fake.reads).toEqual([])
  })

  it("新選或改選：啟用 ok、停用 inactive、不存在 unknown；別租戶的項目不算", async () => {
    stored().push(item({ tenant_id: OTHER_TENANT_ID, code: "option_foreign", label: "別租戶的項目" }))

    expect(await checkOptionPick(TENANT_ID, DEF, "gov")).toBe("ok")
    expect(await checkOptionPick(TENANT_ID, DEF, "gov", "owner")).toBe("ok")
    expect(await checkOptionPick(TENANT_ID, DEF, "option_old")).toBe("inactive")
    expect(await checkOptionPick(TENANT_ID, DEF, "option_old", "gov")).toBe("inactive")
    expect(await checkOptionPick(TENANT_ID, DEF, "nope")).toBe("unknown")
    expect(await checkOptionPick(TENANT_ID, DEF, "option_foreign")).toBe("unknown")
  })

  it("租戶還沒補種過：先補種預設再比對（預設的 architect 一開始就能選）", async () => {
    fake.db.option_items = []

    expect(await checkOptionPick(TENANT_ID, DEF, "architect")).toBe("ok")
    expect(mine()).toHaveLength(5)
  })
})

describe("名稱與 code 的純函式", () => {
  it("optionLabelKey：與 catalogCode 同一套正規化（trim、全形轉半形、轉小寫）", () => {
    expect(optionLabelKey("  ＡＢＣ ")).toBe("abc")
    expect(optionLabelKey("Abc")).toBe(optionLabelKey("aBC"))
    expect(optionLabelKey("室內設計")).toBe("室內設計")
    expect(optionLabelKey("室內設計")).not.toBe(optionLabelKey("室內設計二"))
  })

  it("allocateOptionCode：先用 catalogCode；撞到就改雜湊「名稱#2」「名稱#3」…，同一批配出去的也算", () => {
    const first = catalogCode("室內設計")
    expect(allocateOptionCode("室內設計", new Set())).toBe(first)
    const second = allocateOptionCode("室內設計", new Set([first]))
    expect(second).toBe(catalogCode("室內設計#2"))
    expect(second).toMatch(/^option_[a-f0-9]{12}$/)
    expect(allocateOptionCode("室內設計", new Set([first, second]))).toBe(catalogCode("室內設計#3"))
    expect(allocateOptionCode("別的名稱", new Set([first, second]))).toBe(catalogCode("別的名稱"))
  })

  it("fake 的唯一索引仿真：把一筆改成另一筆的名稱會被 23505 擋下（確認上面的互換測試不是空轉）", async () => {
    seedDefaults()

    const result = await fake.from("option_items").update({ label: "技師" }).eq("code", "architect")

    expect(result.error?.code).toBe("23505")
    expect(byCode("architect")?.label).toBe("建築師")
  })
})

describe("planOptionPut — 整批存檔的規劃（純函式）", () => {
  const row = (code: string, label: string, sort_order = 10, is_active = true): OptionExisting => ({ code, label, sort_order, is_active })

  /** 照規劃的順序逐筆套用，並像 DB 的唯一索引一樣：任何一步讓兩列同名就丟錯。回最後的 code → 名稱。 */
  function simulate(existing: readonly OptionExisting[], updates: readonly OptionUpdateStep[]): Map<string, string> {
    const labels = new Map(existing.map((entry) => [entry.code, entry.label]))
    for (const { code, patch } of updates) {
      if (patch.label === undefined) continue
      for (const [other, label] of labels) {
        if (other !== code && label === patch.label) throw new Error(`撞名：${code} → ${patch.label}（被 ${other} 佔著）`)
      }
      labels.set(code, patch.label)
    }
    return labels
  }

  it("沒有任何變動：不產生更新與新增", () => {
    const existing = [row("a", "甲", 10), row("b", "乙", 20, false)]

    const plan = planOptionPut(existing, [
      { code: "a", label: "甲", sortOrder: 10, isActive: true },
      { code: "b", label: "乙" },
    ])

    expect(plan).toEqual({ ok: true, updates: [], inserts: [] })
  })

  it("更新只列出真的有變的欄位", () => {
    const plan = planOptionPut([row("a", "甲", 10), row("b", "乙", 20)], [
      { code: "a", label: "甲二", sortOrder: 10, isActive: false },
      { code: "b", label: "乙", sortOrder: 5 },
    ])

    expect(plan).toEqual({
      ok: true,
      updates: [
        { code: "a", patch: { label: "甲二", is_active: false } },
        { code: "b", patch: { sort_order: 5 } },
      ],
      inserts: [],
    })
  })

  it("互換名稱：先把一筆挪去暫名；暫名不含 NUL（Postgres text 不收），也不會撞到既有名稱", () => {
    const existing = [row("a", "甲"), row("b", "乙")]

    const plan = planOptionPut(existing, [
      { code: "a", label: "乙" },
      { code: "b", label: "甲" },
    ])

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.updates).toHaveLength(3)
    expect(plan.updates[0]).toEqual({ code: "a", patch: { label: expect.stringMatching(/^⟲a/) } })
    expect(plan.updates[0]?.patch.label).not.toContain("\u0000")
    expect(plan.updates.slice(1)).toEqual([
      { code: "b", patch: { label: "甲" } },
      { code: "a", patch: { label: "乙" } },
    ])
    expect(Object.fromEntries(simulate(existing, plan.updates))).toEqual({ a: "乙", b: "甲" })
  })

  it("暫名剛好被別人用掉：再加符號直到沒人叫這個名字", () => {
    const existing = [row("a", "甲"), row("b", "乙"), row("c", "⟲a")]

    const plan = planOptionPut(existing, [
      { code: "a", label: "乙" },
      { code: "b", label: "甲" },
      { code: "c", label: "⟲a" },
    ])

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.updates[0]?.patch.label).toBe("⟲a′")
    expect(Object.fromEntries(simulate(existing, plan.updates))).toEqual({ a: "乙", b: "甲", c: "⟲a" })
  })

  it("三個名稱輪轉、隨機排列：任何改名組合照規劃的順序寫都不會中途撞名，最後都是想要的名稱", () => {
    let state = 20261010
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return state / 4294967296
    }
    for (let round = 0; round < 300; round += 1) {
      const size = 2 + Math.floor(random() * 6)
      const existing = Array.from({ length: size }, (_, i) => row(`c${i}`, `名稱${i}`, i * 10))
      const targets = existing.map((entry) => entry.label)
      for (let i = targets.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        ;[targets[i], targets[j]] = [targets[j] as string, targets[i] as string]
      }
      // 隨機挑幾筆維持原名（部分改名），其餘照排列改
      const wanted = existing.map((entry, i) => ({ code: entry.code, label: targets[i] as string }))
      const plan = planOptionPut(existing, wanted)
      // 排列後若有兩項名稱相同不可能（是排列）；若某筆「沒變」就不會有更新
      expect(plan.ok, `round ${round}`).toBe(true)
      if (!plan.ok) continue
      const finalLabels = simulate(existing, plan.updates)
      for (const entry of wanted) expect(finalLabels.get(entry.code), `round ${round}`).toBe(entry.label)
    }
  })

  it("not_found／duplicate_item／label_taken／too_many_items", () => {
    const existing = [row("a", "甲"), row("b", "乙")]

    expect(planOptionPut(existing, [{ code: "zz", label: "x" }])).toEqual({ ok: false, error: "not_found", code: "zz" })
    expect(
      planOptionPut(existing, [
        { code: "a", label: "甲一" },
        { code: "a", label: "甲二" },
      ]),
    ).toEqual({ ok: false, error: "duplicate_item", code: "a" })
    expect(planOptionPut(existing, [{ label: "乙" }])).toEqual({ ok: false, error: "label_taken", label: "乙" })
    expect(planOptionPut(existing, [{ code: "a", label: "乙" }])).toEqual({ ok: false, error: "label_taken", label: "乙" })
    // 同一批把乙改走、甲改成乙：套用後沒有重複，可以
    expect(planOptionPut(existing, [{ code: "a", label: "乙" }, { code: "b", label: "丙" }]).ok).toBe(true)

    const many = Array.from({ length: OPTION_LIST_MAX_ITEMS }, (_, i) => row(`c${i}`, `項目${i}`))
    expect(planOptionPut(many, [{ label: "多一個" }])).toEqual({ ok: false, error: "too_many_items" })
    expect(planOptionPut(many, [{ code: "c0", label: "改名不增加" }]).ok).toBe(true)
  })

  it("新項目：code 由名稱雜湊配、排在目前最大排序之後（每項加 10）、預設啟用；撞 code 就改雜湊", () => {
    const taken = catalogCode("新甲")
    const existing = [row("a", "甲", 10), row("b", "乙", 70), row(taken, "新甲的舊名字", 30)]

    const plan = planOptionPut(existing, [{ label: "新甲" }, { label: "新乙", sortOrder: 5, isActive: false }, { label: "新丙" }])

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.inserts).toEqual([
      { code: catalogCode("新甲#2"), label: "新甲", sort_order: 80, is_active: true },
      { code: catalogCode("新乙"), label: "新乙", sort_order: 5, is_active: false },
      { code: catalogCode("新丙"), label: "新丙", sort_order: 100, is_active: true },
    ])
  })
})
