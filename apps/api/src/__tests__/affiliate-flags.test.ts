import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clientsRouter } from "../routes/clients.js"
import { vendorsRouter } from "../routes/vendors.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 客戶／廠商的「關係企業」標記 is_affiliate（packages/db 0062）：建立與更新接受 `isAffiliate`（boolean），
 * 列表與回應都帶 `isAffiliate`。集團總覽的集團合計靠這兩個旗標剔除姊妹公司往來（見 group-overview.test.ts）。
 * ⚠️ 全部是明顯的假資料。
 */
const app = express()
app.use(express.json())
app.use(clientsRouter)
app.use(vendorsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const PLATFORM_TOKEN = "platform-user"
const ACCOUNTANT_TOKEN = "accountant-user"
const STAFF_TOKEN = "staff-user"
const authed = (req: request.Test) => req.set("Authorization", `Bearer ${HR_TOKEN}`)
const asRole = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const CLIENT_B = "aaaaaaaa-0000-4000-8000-00000000000b"
const VENDOR_A = "bbbbbbbb-0000-4000-8000-00000000000a"
const VENDOR_B = "bbbbbbbb-0000-4000-8000-00000000000b"
const OTHER_TENANT_ROW = "dddddddd-0000-4000-8000-0000000000aa"
const DELETED_ROW = "dddddddd-0000-4000-8000-0000000000bb"

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "cccccccc-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: PLATFORM_TOKEN, role: "platform_admin", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000003", tenant_id: TENANT_ID, user_id: ACCOUNTANT_TOKEN, role: "accountant", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000004", tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.clients = [
    { id: CLIENT_A, tenant_id: TENANT_ID, name: "測試客戶甲", short_name: null, tax_id: null, is_affiliate: false, deleted_at: null },
    { id: CLIENT_B, tenant_id: TENANT_ID, name: "測試姊妹客戶乙", short_name: null, tax_id: null, is_affiliate: true, deleted_at: null },
  ]
  fake.db.vendors = [
    { id: VENDOR_A, tenant_id: TENANT_ID, name: "測試廠商甲", short_name: null, source: "manual", is_affiliate: false, deleted_at: null },
    { id: VENDOR_B, tenant_id: TENANT_ID, name: "測試姊妹廠商乙", short_name: null, source: "manual", is_affiliate: true, deleted_at: null },
  ]
})

const writes = (table: string, action: "insert" | "update") => fake.writes.filter((w) => w.table === table && w.action === action)

describe.each([
  { label: "客戶", path: "/clients", table: "clients", key: "client", listKey: "clients", ids: { off: CLIENT_A, on: CLIENT_B } },
  { label: "廠商", path: "/vendors", table: "vendors", key: "vendor", listKey: "vendors", ids: { off: VENDOR_A, on: VENDOR_B } },
])("$label 的關係企業標記 isAffiliate", ({ path, table, key, listKey, ids }) => {
  it("建立時帶 isAffiliate:true → 寫 is_affiliate、回應 isAffiliate:true", async () => {
    const res = await authed(request(app).post(path)).send({ name: "測試新往來單位", isAffiliate: true })

    expect(res.status).toBe(201)
    expect(res.body[key].isAffiliate).toBe(true)
    expect(writes(table, "insert")[0]?.payload).toMatchObject({ tenant_id: TENANT_ID, name: "測試新往來單位", is_affiliate: true })
  })

  it("建立時沒帶 → insert 不帶 is_affiliate（交給 DB 預設 false），回應 isAffiliate:false；明確帶 false 就寫 false", async () => {
    const without = await authed(request(app).post(path)).send({ name: "測試往來單位乙" })
    expect(without.status).toBe(201)
    expect(without.body[key].isAffiliate).toBe(false)
    expect(writes(table, "insert")[0]?.payload).not.toHaveProperty("is_affiliate")

    const explicit = await authed(request(app).post(path)).send({ name: "測試往來單位丙", isAffiliate: false })
    expect(explicit.status).toBe(201)
    expect(explicit.body[key].isAffiliate).toBe(false)
    expect(writes(table, "insert")[1]?.payload).toMatchObject({ is_affiliate: false })
  })

  it("更新只改旗標：update 只帶 is_affiliate（與 updated_at 或不帶），開與關都行", async () => {
    const on = await authed(request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: true })
    expect(on.status).toBe(200)
    expect(on.body[key]).toMatchObject({ id: ids.off, isAffiliate: true })
    expect(writes(table, "update")[0]?.payload).toMatchObject({ is_affiliate: true })
    expect(fake.db[table]?.find((r) => r.id === ids.off)?.is_affiliate).toBe(true)

    const off = await authed(request(app).patch(`${path}/${ids.on}`)).send({ isAffiliate: false })
    expect(off.status).toBe(200)
    expect(off.body[key]).toMatchObject({ id: ids.on, isAffiliate: false })
    expect(fake.db[table]?.find((r) => r.id === ids.on)?.is_affiliate).toBe(false)
  })

  it("更新別的欄位不動旗標（payload 沒有 is_affiliate、回應仍是原值）", async () => {
    const res = await authed(request(app).patch(`${path}/${ids.on}`)).send({ name: "測試改名後的姊妹單位" })
    expect(res.status).toBe(200)
    expect(res.body[key]).toMatchObject({ name: "測試改名後的姊妹單位", isAffiliate: true })
    expect(writes(table, "update")[0]?.payload).not.toHaveProperty("is_affiliate")
  })

  it("isAffiliate 只收 boolean：null、字串、數字都回 400 invalid_body 且不寫入（DB 欄位 NOT NULL）", async () => {
    for (const bad of [null, "true", 1, "yes"]) {
      const created = await authed(request(app).post(path)).send({ name: "測試壞資料", isAffiliate: bad })
      expect(created.status, `POST ${String(bad)}`).toBe(400)
      expect(created.body.error).toBe("invalid_body")
      const patched = await authed(request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: bad })
      expect(patched.status, `PATCH ${String(bad)}`).toBe(400)
    }
    expect(writes(table, "insert")).toHaveLength(0)
    expect(writes(table, "update")).toHaveLength(0)
  })

  it("列表每一列都帶 isAffiliate（舊列欄位缺值當 false）", async () => {
    fake.db[table]!.push({ ...fake.db[table]![0], id: `${ids.off.slice(0, -1)}f`, name: "測試舊資料", is_affiliate: undefined })
    const res = await authed(request(app).get(path))

    expect(res.status).toBe(200)
    const flags = Object.fromEntries((res.body[listKey] as Array<{ id: string; isAffiliate: boolean }>).map((r) => [r.id, r.isAffiliate]))
    expect(flags).toMatchObject({ [ids.off]: false, [ids.on]: true, [`${ids.off.slice(0, -1)}f`]: false })
  })
})

/**
 * 誰能設定「關係企業」：它會改變集團總覽的集團合計，所以只有 HR／平台管理員能設定或變更；
 * 會計（客戶、廠商名冊都是 requireFinance 放行）仍可維護其他欄位，也可以重送跟現值一樣的值。
 * 一般員工自 2026-10-27 起不能寫廠商名冊（見 roster-excel-fields.test.ts 的權限測試）。
 */
describe.each([
  { label: "客戶", path: "/clients", table: "clients", key: "client", ids: { off: CLIENT_A, on: CLIENT_B }, restricted: [ACCOUNTANT_TOKEN] },
  { label: "廠商", path: "/vendors", table: "vendors", key: "vendor", ids: { off: VENDOR_A, on: VENDOR_B }, restricted: [ACCOUNTANT_TOKEN] },
])("$label：只有 HR／平台管理員能設定關係企業標記", ({ path, table, key, ids, restricted }) => {
  const flagOf = (id: string) => fake.db[table]?.find((r) => r.id === id)?.is_affiliate

  it.each(restricted)("非 HR（%s）建立時帶 isAffiliate:true → 403 affiliate_hr_only，不寫入", async (token) => {
    const res = await asRole(token, request(app).post(path)).send({ name: "測試新往來單位", isAffiliate: true })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe("affiliate_hr_only")
    expect(res.body.message).toContain("HR")
    expect(writes(table, "insert")).toHaveLength(0)
  })

  it.each(restricted)("非 HR（%s）建立時沒帶或帶 false → 照常建立（其他欄位不受影響）", async (token) => {
    const without = await asRole(token, request(app).post(path)).send({ name: "測試往來單位甲" })
    expect(without.status).toBe(201)
    expect(without.body[key].isAffiliate).toBe(false)
    const explicitFalse = await asRole(token, request(app).post(path)).send({ name: "測試往來單位乙", isAffiliate: false })
    expect(explicitFalse.status).toBe(201)
    expect(explicitFalse.body[key].isAffiliate).toBe(false)
  })

  it.each(restricted)("非 HR（%s）更新時把旗標由 false 改 true、由 true 改 false → 403，資料不動", async (token) => {
    const turnOn = await asRole(token, request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: true })
    expect(turnOn.status).toBe(403)
    expect(turnOn.body.error).toBe("affiliate_hr_only")
    const turnOff = await asRole(token, request(app).patch(`${path}/${ids.on}`)).send({ isAffiliate: false, name: "測試想順便改名" })
    expect(turnOff.status).toBe(403)
    expect(writes(table, "update")).toHaveLength(0)
    expect(flagOf(ids.off)).toBe(false)
    expect(flagOf(ids.on)).toBe(true)
    expect(fake.db[table]?.find((r) => r.id === ids.on)?.name).not.toBe("測試想順便改名")
  })

  it.each(restricted)("非 HR（%s）重送跟現值一樣的旗標、或只改別的欄位 → 照常更新，而且不把旗標寫回去", async (token) => {
    const same = await asRole(token, request(app).patch(`${path}/${ids.on}`)).send({ isAffiliate: true, name: "測試姊妹單位改名" })
    expect(same.status).toBe(200)
    expect(same.body[key]).toMatchObject({ name: "測試姊妹單位改名", isAffiliate: true })
    // 一樣的值不寫回：HR 並發剛改過旗標時，不會被這次更新用舊值蓋回去
    expect(writes(table, "update")[0]?.payload).not.toHaveProperty("is_affiliate")
    const sameOff = await asRole(token, request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: false })
    expect(sameOff.status).toBe(200)
    expect(writes(table, "update")[1]?.payload).not.toHaveProperty("is_affiliate")
    const other = await asRole(token, request(app).patch(`${path}/${ids.off}`)).send({ name: "測試一般單位改名" })
    expect(other.status).toBe(200)
    expect(flagOf(ids.on)).toBe(true)
    expect(flagOf(ids.off)).toBe(false)
  })

  it.each(restricted)("非 HR（%s）重送旗標時，若 HR 剛好在這之間改了值 → 不會被蓋回舊值", async (token) => {
    // 模擬「非 HR 的網頁載入時旗標是 false → HR 改成 true → 非 HR 存檔仍帶 false」：現值 true ≠ 帶的 false → 403，不寫入
    fake.db[table]!.find((r) => r.id === ids.off)!.is_affiliate = true
    const res = await asRole(token, request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: false, name: "測試過期表單" })
    expect(res.status).toBe(403)
    expect(flagOf(ids.off)).toBe(true)
    expect(writes(table, "update")).toHaveLength(0)
  })

  it.each(restricted)("非 HR（%s）對不存在、別租戶、已軟刪的單位帶旗標 → 404（不是 403，也不洩漏旗標現況）", async (token) => {
    const missing = await asRole(token, request(app).patch(`${path}/aaaaaaaa-0000-4000-8000-0000000000ff`)).send({ isAffiliate: true })
    expect(missing.status).toBe(404)
    // 別租戶的列：現值是 false，帶 true 若讀現值沒綁租戶就會誤回 403
    fake.db[table]!.push({ ...fake.db[table]![0], id: OTHER_TENANT_ROW, tenant_id: OTHER_TENANT_ID, name: "別租戶的單位", is_affiliate: false })
    const otherTenant = await asRole(token, request(app).patch(`${path}/${OTHER_TENANT_ROW}`)).send({ isAffiliate: true })
    expect(otherTenant.status).toBe(404)
    // 已軟刪的列：同理，讀現值沒濾 deleted_at 就會誤回 403
    fake.db[table]!.push({ ...fake.db[table]![0], id: DELETED_ROW, name: "已刪除的單位", is_affiliate: false, deleted_at: "2026-10-01T00:00:00.000Z" })
    const deleted = await asRole(token, request(app).patch(`${path}/${DELETED_ROW}`)).send({ isAffiliate: true })
    expect(deleted.status).toBe(404)
    // 這三次 update 都沒命中任何一列（fake 仍會記下 update 呼叫，所以看 matched）
    expect(writes(table, "update").filter((w) => (w.matched ?? 0) > 0)).toHaveLength(0)
  })

  it("平台管理員與 HR 一樣可以設定與變更", async () => {
    const created = await asRole(PLATFORM_TOKEN, request(app).post(path)).send({ name: "測試平台管理員建立", isAffiliate: true })
    expect(created.status).toBe(201)
    expect(created.body[key].isAffiliate).toBe(true)
    const patched = await asRole(PLATFORM_TOKEN, request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: true })
    expect(patched.status).toBe(200)
    expect(flagOf(ids.off)).toBe(true)
    const hr = await authed(request(app).patch(`${path}/${ids.off}`)).send({ isAffiliate: false })
    expect(hr.status).toBe(200)
    expect(flagOf(ids.off)).toBe(false)
  })
})
