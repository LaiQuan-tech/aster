import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { optionListsRouter } from "../routes/option-lists.js"
import { DESIGN_DISCIPLINE_LIST_KEY, findOptionList, planOptionQuickAdd } from "../services/option-lists.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 設計內容科別選項（2026-11-12）：預設含規費、快速加入去重、權限（能編輯專案的人可加；刪除／排序限 HR／
 * platform_admin／老闆）、上限 20 字／50 項。⚠️ 名稱、代碼都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(optionListsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const KEY = DESIGN_DISCIPLINE_LIST_KEY
const DEF = findOptionList(KEY)!
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const HR = { id: "bbbbbbbb-0000-4000-8000-000000000001", token: "hr-user", role: "hr_admin" }
const PA = { id: "bbbbbbbb-0000-4000-8000-000000000002", token: "pa-user", role: "platform_admin" }
const ACC = { id: "bbbbbbbb-0000-4000-8000-000000000003", token: "acc-user", role: "accountant" }
const LEAD = { id: "bbbbbbbb-0000-4000-8000-000000000004", token: "lead-user", role: "employee" }
const STAFF = { id: "bbbbbbbb-0000-4000-8000-000000000005", token: "staff-user", role: "employee" }
const BOSS = { id: "bbbbbbbb-0000-4000-8000-000000000006", token: "boss-user", role: "employee" }
const PROJECT_ID = "dddddddd-0000-4000-8000-000000000001"

const mine = () => (fake.db.option_items ?? []).filter((row) => row.tenant_id === TENANT_ID && row.list_key === KEY)
const labels = () => mine().sort((a, b) => (a.sort_order as number) - (b.sort_order as number)).map((row) => row.label)

beforeEach(() => {
  fake.reset()
  fake.db.employees = [HR, PA, ACC, LEAD, STAFF, BOSS].map((e) => ({
    id: e.id,
    tenant_id: TENANT_ID,
    user_id: e.token,
    role: e.role,
    dept_id: null,
    status: "active",
  }))
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS.id } } } as Row]
  fake.db.projects = [{ id: PROJECT_ID, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: LEAD.id } as Row]
  fake.db.project_members = []
  fake.db.departments = []
  fake.db.option_items = []
  fake.uniques.option_items = [
    ["tenant_id", "list_key", "code"],
    ["tenant_id", "list_key", "label"],
  ]
})

describe("設計內容科別選項：登記與預設", () => {
  it("預設＝電機、空調、消防、汙水、規費；上限 20 字／50 項；usage 空（專案存文字，刪了不影響）", async () => {
    expect(DEF.defaults.map((d) => d.label)).toEqual(["電機", "空調", "消防", "汙水", "規費"])
    expect(DEF.labelMax).toBe(20)
    expect(DEF.maxItems).toBe(50)
    expect(DEF.usage).toEqual([])
    const res = await as(STAFF.token, request(app).get(`/option-lists/${KEY}`))
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: Row) => i.label)).toEqual(["電機", "空調", "消防", "汙水", "規費"])
    expect(res.body.canManage).toBe(false)
  })

  it("canManage：HR／platform_admin／老闆 true；會計、一般員工、lead false", async () => {
    for (const [who, want] of [[HR, true], [PA, true], [BOSS, true], [ACC, false], [LEAD, false], [STAFF, false]] as const) {
      const res = await as(who.token, request(app).get("/option-lists"))
      const list = (res.body.lists as Row[]).find((l) => l.key === KEY)
      expect(list?.canManage, who.token).toBe(want)
      expect(list).toMatchObject({ labelMax: 20, maxItems: 50, quickAdd: "project_editor" })
    }
  })
})

describe("POST /option-lists/:key/items — 快速加入", () => {
  it("專案 lead 帶 projectId 可加；排在最後", async () => {
    const res = await as(LEAD.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: " 弱電 ", projectId: PROJECT_ID }))
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ added: true, item: { label: "弱電", isActive: true } })
    expect(labels()).toEqual(["電機", "空調", "消防", "汙水", "規費", "弱電"])
  })

  it("去重：去空白、大小寫／全半形不分，已存在回 200 added:false 不新增", async () => {
    await as(HR.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "BIM" }))
    const before = mine().length
    for (const label of ["  規費 ", "bim", "ＢＩＭ"]) {
      const res = await as(HR.token, request(app).post(`/option-lists/${KEY}/items`).send({ label }))
      expect(res.status, label).toBe(200)
      expect(res.body.added, label).toBe(false)
    }
    expect(mine().length).toBe(before)
  })

  it("會計（可建案）不帶 projectId 也可加；一般員工不帶或帶別人的案子 403", async () => {
    expect((await as(ACC.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "結構" }))).status).toBe(201)
    expect((await as(STAFF.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "景觀" }))).status).toBe(403)
    expect(
      (await as(STAFF.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "景觀", projectId: PROJECT_ID }))).status,
    ).toBe(403)
    expect(labels()).not.toContain("景觀")
  })

  it("沒有 quickAdd 的清單（客戶分類），非管理者 403", async () => {
    const res = await as(LEAD.token, request(app).post("/option-lists/client_category/items").send({ label: "測試", projectId: PROJECT_ID }))
    expect(res.status).toBe(403)
  })

  it("超過 20 字 400 label_too_long；空白 400 invalid_label；滿 50 項 400 too_many_items", async () => {
    expect((await as(HR.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "字".repeat(21) }))).body.error).toBe("label_too_long")
    expect((await as(HR.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "   " }))).body.error).toBe("invalid_label")
    for (let i = 0; i < 45; i += 1) {
      const r = await as(HR.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: `項目${i}` }))
      expect(r.status).toBe(201)
    }
    expect(mine().length).toBe(50)
    const full = await as(HR.token, request(app).post(`/option-lists/${KEY}/items`).send({ label: "再一個" }))
    expect(full.status).toBe(400)
    expect(full.body.error).toBe("too_many_items")
  })
})

describe("設定頁：PUT／DELETE 權限與上限", () => {
  it("老闆（非 HR）可排序與刪除；lead／會計 403", async () => {
    const view = await as(BOSS.token, request(app).get(`/option-lists/${KEY}?manage=1`))
    expect(view.status).toBe(200)
    const items = (view.body.items as Row[]).map((i) => ({ code: i.code as string, label: i.label as string }))
    const reordered = [items[4]!, ...items.slice(0, 4)].map((i, idx) => ({ ...i, sortOrder: (idx + 1) * 10 }))
    const put = await as(BOSS.token, request(app).put(`/option-lists/${KEY}`).send({ items: reordered }))
    expect(put.status).toBe(200)
    expect(labels()).toEqual(["規費", "電機", "空調", "消防", "汙水"])

    for (const who of [LEAD, ACC]) {
      expect((await as(who.token, request(app).put(`/option-lists/${KEY}`).send({ items: reordered }))).status, who.token).toBe(403)
      expect((await as(who.token, request(app).delete(`/option-lists/${KEY}/fees`))).status, who.token).toBe(403)
    }
    const del = await as(PA.token, request(app).delete(`/option-lists/${KEY}/fees`))
    expect(del.status).toBe(200)
    expect(labels()).toEqual(["電機", "空調", "消防", "汙水"])
  })

  it("PUT 名稱超過 20 字回 400 label_too_long", async () => {
    await as(HR.token, request(app).get(`/option-lists/${KEY}`))
    const res = await as(HR.token, request(app).put(`/option-lists/${KEY}`).send({ items: [{ label: "字".repeat(21) }] }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("label_too_long")
  })
})

describe("planOptionQuickAdd（純函式）", () => {
  const existing = [{ code: "a", label: "Ab", sort_order: 30, is_active: false }]
  it("停用的同名也算已存在；新增排最後", () => {
    expect(planOptionQuickAdd(existing, " ab ", { labelMax: 20, maxItems: 50 })).toEqual({ ok: true, kind: "exists", code: "a" })
    const plan = planOptionQuickAdd(existing, "新項", { labelMax: 20, maxItems: 50 })
    expect(plan).toMatchObject({ ok: true, kind: "insert", row: { label: "新項", sort_order: 40, is_active: true } })
    expect(planOptionQuickAdd(existing, "新項", { labelMax: 20, maxItems: 1 })).toEqual({ ok: false, error: "too_many_items" })
  })
})
