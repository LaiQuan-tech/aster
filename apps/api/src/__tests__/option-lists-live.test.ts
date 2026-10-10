import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { catalogCode } from "../services/catalog-code"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * 選項清單（客戶分類）— live 合約測試（throwaway 租戶，打真的 DB）。
 *
 * 規則（2026-10-10 業主要求）：客戶分類讓管理員自行新增；用過的分類只能停用、沒用過的才可刪除；
 * 停用後新客戶不能再選它，舊客戶照常顯示原分類。機制是全站共用的「選項清單」（services/option-lists.ts），
 * 客戶分類是第一個掛上去的清單（list_key＝client_category）。
 *
 * 流程：新租戶第一次讀取補種預設五項 → 新增「室內設計」→ 用它建客戶 → 改名（code 不變，客戶照樣對得上）→
 * 刪它被 409（用過）→ 停用 → 用停用的分類建新客戶被 400 → 舊客戶照常讀到、沿用原值也能改別的欄位 →
 * 把舊客戶改選到別的分類後它沒人用了、可以刪 → 刪掉之後不能再選。另外對真的唯一索引驗：
 * 同清單名稱重複（API 擋 409、DB 也擋 23505）與「兩個項目名稱互換」的寫入順序。
 *
 * 正式庫尚未套用 option_items（packages/db sql/0048）時整組 describe.skipIf 跳過。
 * 只在自建的 throwaway 租戶裡動資料，結束時 purge_test_tenant 清掉。
 * ⚠️ 名稱都是明顯的假值（repo 是公開的）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("option_items").select("id").limit(1)
  return !error
}
const ready = await migrated()

const KEY = "client_category"
const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string

type ItemBody = { code: string; label: string; sortOrder: number; isActive: boolean }
type ListBody = { key: string; title: string; canManage: boolean; items: ItemBody[]; usage?: Record<string, number> }

const DEFAULT_CODES = ["architect", "engineer", "owner", "gov", "other"]
const DEFAULT_LABELS = ["建築師", "技師", "業主", "政府機關", "其他"]

const LABEL_NEW = "室內設計"
const LABEL_RENAMED = "室內設計與裝修"

let newCode: string
let oldClientId: string
const oldClientName = `選項清單測試客戶甲 ${stamp}`

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}
async function readList(query = ""): Promise<ListBody> {
  const res = await asAdmin(request(app).get(`/option-lists/${KEY}${query}`))
  expect(res.status).toBe(200)
  return res.body as ListBody
}
/** 整批存檔：只列要動的項目（沒列的不會被刪、也不會被動到）。 */
function putItems(items: Array<Record<string, unknown>>) {
  return asAdmin(request(app).put(`/option-lists/${KEY}`)).send({ items })
}
function createClientRow(body: Record<string, unknown>) {
  return asAdmin(request(app).post("/clients")).send(body)
}
async function clientById(id: string): Promise<{ id: string; category: string | null; note: string | null } | undefined> {
  const res = await asAdmin(request(app).get("/clients"))
  expect(res.status).toBe(200)
  return (res.body.clients as Array<{ id: string; category: string | null; note: string | null }>).find((c) => c.id === id)
}

describe.skipIf(!ready)("選項清單（客戶分類）— live", () => {
  beforeAll(async () => {
    const adminEmail = `option-lists-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const provisioned = await provisionTenant({ name: `OPTIONLISTTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = provisioned.tenantId
    createdTenantIds.push(provisioned.tenantId)
    createdUserIds.push(provisioned.userId)
    adminToken = await signIn(adminEmail, adminPassword)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) await purgeTestTenant(tid)
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  it("沒帶 token 一律 401；清單定義帶 canManage", async () => {
    expect((await request(app).get("/option-lists")).status).toBe(401)
    expect((await request(app).get(`/option-lists/${KEY}`)).status).toBe(401)
    expect((await request(app).put(`/option-lists/${KEY}`).send({ items: [{ label: "x" }] })).status).toBe(401)
    expect((await request(app).delete(`/option-lists/${KEY}/architect`)).status).toBe(401)

    const res = await asAdmin(request(app).get("/option-lists"))
    expect(res.status).toBe(200)
    expect(res.body.lists).toEqual([expect.objectContaining({ key: KEY, title: "客戶分類", canManage: true })])
  })

  it("新租戶第一次讀取：補種預設五項（建築師／技師／業主／政府機關／其他），DB 裡真的有五列", async () => {
    const list = await readList()

    expect(list).toMatchObject({ key: KEY, title: "客戶分類", canManage: true })
    expect(list.items.map((i) => i.code)).toEqual(DEFAULT_CODES)
    expect(list.items.map((i) => i.label)).toEqual(DEFAULT_LABELS)
    expect(list.items.every((i) => i.isActive)).toBe(true)
    expect(list).not.toHaveProperty("usage")

    const { data, error } = await supabaseAdmin.from("option_items").select("code").eq("tenant_id", tenantId).eq("list_key", KEY)
    expect(error).toBeNull()
    expect((data ?? []).map((r) => r.code as string).sort()).toEqual([...DEFAULT_CODES].sort())

    // 再讀一次不會重複補種
    expect((await readList()).items).toHaveLength(5)
  })

  it("管理視圖：停用項與使用量；預設五項都沒被用過", async () => {
    const list = await readList("?manage=1")

    expect(list.usage).toEqual({ architect: 0, engineer: 0, owner: 0, gov: 0, other: 0 })
  })

  it("新增「室內設計」：code 由名稱雜湊產生，排在最後、預設啟用、使用量 0", async () => {
    const existing = (await readList()).items.map(({ code, label, sortOrder }) => ({ code, label, sortOrder }))

    const res = await putItems([...existing, { label: LABEL_NEW }])

    expect(res.status).toBe(200)
    const body = res.body as ListBody
    expect(body.items).toHaveLength(6)
    const created = body.items.find((i) => i.label === LABEL_NEW) as ItemBody
    expect(created).toMatchObject({ code: catalogCode(LABEL_NEW), label: LABEL_NEW, sortOrder: 60, isActive: true })
    expect(body.items[5]?.code).toBe(created.code)
    expect(body.usage?.[created.code]).toBe(0)
    newCode = created.code
  })

  it("用它建客戶：存得進去，GET /clients 回同一個 code", async () => {
    const res = await createClientRow({ name: oldClientName, category: newCode })

    expect(res.status).toBe(201)
    expect(res.body.client.category).toBe(newCode)
    oldClientId = res.body.client.id as string
    expect((await clientById(oldClientId))?.category).toBe(newCode)
    expect((await readList("?manage=1")).usage?.[newCode]).toBe(1)
  })

  it("改名：code 不變，客戶照樣對得上（客戶資料存的是 code 不是名稱）", async () => {
    const res = await putItems([{ code: newCode, label: LABEL_RENAMED }])

    expect(res.status).toBe(200)
    const renamed = (res.body as ListBody).items.find((i) => i.code === newCode) as ItemBody
    expect(renamed.label).toBe(LABEL_RENAMED)
    expect((res.body as ListBody).items).toHaveLength(6) // 沒列在 payload 裡的預設五項沒被動、也沒被刪
    expect((await clientById(oldClientId))?.category).toBe(newCode)
    expect((res.body as ListBody).usage?.[newCode]).toBe(1)
  })

  it("刪它被擋：409 option_in_use（附筆數），項目還在", async () => {
    const res = await asAdmin(request(app).delete(`/option-lists/${KEY}/${newCode}`))

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "option_in_use", usage: 1 })
    expect((await readList()).items.some((i) => i.code === newCode)).toBe(true)
  })

  it("名稱重複：API 回 409 label_taken（大小寫、全半形視為同名），DB 的唯一索引也擋（23505）", async () => {
    const same = await putItems([{ label: "技師" }])
    expect(same.status).toBe(409)
    expect(same.body).toEqual({ error: "label_taken", label: "技師" })

    const renameToExisting = await putItems([{ code: newCode, label: " 建築師 " }])
    expect(renameToExisting.status).toBe(409)
    expect(renameToExisting.body.error).toBe("label_taken")

    const direct = await supabaseAdmin.from("option_items").insert({ tenant_id: tenantId, list_key: KEY, code: "dup_probe", label: "技師" })
    expect(direct.error?.code).toBe("23505")
  })

  it("停用：一般讀取看不到、?includeInactive=1 看得到；使用量照舊（仍被用過）", async () => {
    const off = await putItems([{ code: newCode, label: LABEL_RENAMED, isActive: false }])
    expect(off.status).toBe(200)
    expect((off.body as ListBody).items.find((i) => i.code === newCode)).toMatchObject({ isActive: false })

    const plain = await readList()
    expect(plain.items.some((i) => i.code === newCode)).toBe(false)
    const all = await readList("?includeInactive=1")
    expect(all.items.find((i) => i.code === newCode)).toMatchObject({ label: LABEL_RENAMED, isActive: false })
    expect((await readList("?manage=1")).usage?.[newCode]).toBe(1)

    // 停用了、而且還在用：一樣刪不掉
    const del = await asAdmin(request(app).delete(`/option-lists/${KEY}/${newCode}`))
    expect(del.status).toBe(409)
  })

  it("用停用的分類建新客戶 → 400 category_inactive；不存在的 code → 400 invalid_category；啟用的照常可選", async () => {
    const inactive = await createClientRow({ name: `選項清單測試客戶乙 ${stamp}`, category: newCode })
    expect(inactive.status).toBe(400)
    expect(inactive.body).toMatchObject({ error: "category_inactive", category: newCode })

    const unknown = await createClientRow({ name: `選項清單測試客戶乙 ${stamp}`, category: "not_a_real_category" })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe("invalid_category")

    const active = await createClientRow({ name: `選項清單測試客戶丙 ${stamp}`, category: "architect" })
    expect(active.status).toBe(201)
    expect(active.body.client.category).toBe("architect")
  })

  it("舊客戶照常讀到停用的分類；沿用原值也能改別的欄位；改選到停用項被擋", async () => {
    expect((await clientById(oldClientId))?.category).toBe(newCode)

    const keep = await asAdmin(request(app).patch(`/clients/${oldClientId}`)).send({ category: newCode, note: "沿用停用分類改備註" })
    expect(keep.status).toBe(200)
    expect(keep.body.client.category).toBe(newCode)
    expect((await clientById(oldClientId))?.note).toBe("沿用停用分類改備註")

    const other = await createClientRow({ name: `選項清單測試客戶丁 ${stamp}`, category: "gov" })
    expect(other.status).toBe(201)
    const toInactive = await asAdmin(request(app).patch(`/clients/${other.body.client.id}`)).send({ category: newCode })
    expect(toInactive.status).toBe(400)
    expect(toInactive.body.error).toBe("category_inactive")
  })

  it("舊客戶改選到別的分類後，停用的分類沒人用了：可以刪；刪掉之後不能再選", async () => {
    const move = await asAdmin(request(app).patch(`/clients/${oldClientId}`)).send({ category: "owner" })
    expect(move.status).toBe(200)
    expect((await readList("?manage=1")).usage?.[newCode]).toBe(0)

    const del = await asAdmin(request(app).delete(`/option-lists/${KEY}/${newCode}`))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ code: newCode })
    expect((await readList("?includeInactive=1")).items.some((i) => i.code === newCode)).toBe(false)

    const again = await asAdmin(request(app).delete(`/option-lists/${KEY}/${newCode}`))
    expect(again.status).toBe(404)
    const reuse = await createClientRow({ name: `選項清單測試客戶戊 ${stamp}`, category: newCode })
    expect(reuse.status).toBe(400)
    expect(reuse.body.error).toBe("invalid_category")
  })

  it("互換兩個項目的名稱（對真的唯一索引驗寫入順序）：同一批 PUT 成功、最後名稱互換", async () => {
    const created = await putItems([{ label: `互換甲 ${stamp}` }, { label: `互換乙 ${stamp}` }])
    expect(created.status).toBe(200)
    const a = (created.body as ListBody).items.find((i) => i.label === `互換甲 ${stamp}`) as ItemBody
    const b = (created.body as ListBody).items.find((i) => i.label === `互換乙 ${stamp}`) as ItemBody

    const swapped = await putItems([
      { code: a.code, label: `互換乙 ${stamp}` },
      { code: b.code, label: `互換甲 ${stamp}` },
    ])

    expect(swapped.status).toBe(200)
    const items = (swapped.body as ListBody).items
    expect(items.find((i) => i.code === a.code)?.label).toBe(`互換乙 ${stamp}`)
    expect(items.find((i) => i.code === b.code)?.label).toBe(`互換甲 ${stamp}`)
    // 互換過程中用過的暫名不會留在最後的名稱裡
    expect(items.some((i) => i.label.includes("⟲"))).toBe(false)
  })

  it("沒登記的清單 404；刪除沒有的 code 404", async () => {
    const unknown = await asAdmin(request(app).get("/option-lists/not_a_list"))
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe("list_not_found")

    const missing = await asAdmin(request(app).delete(`/option-lists/${KEY}/option_gone`))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe("not_found")
  })
})
