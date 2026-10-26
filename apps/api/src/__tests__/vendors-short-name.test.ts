import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { vendorsRouter } from "../routes/vendors.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 廠商「簡稱」short_name（packages/db 0060）：建立／更新（trim、最長 40、可清除）、
 * 列表回傳、GET /vendors?q= 也比對簡稱。比照 clients-short-name.test.ts。
 */
const app = express()
app.use(express.json())
app.use(vendorsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const USER_TOKEN = "vendor-short-name-tester"
const authed = (req: request.Test) => req.set("Authorization", `Bearer ${USER_TOKEN}`)

const VENDOR_A = "aaaaaaaa-0000-4000-8000-00000000000a"
const VENDOR_B = "aaaaaaaa-0000-4000-8000-00000000000b"
const VENDOR_C = "aaaaaaaa-0000-4000-8000-00000000000c"
const VENDOR_OTHER_TENANT = "aaaaaaaa-0000-4000-8000-00000000000d"
const VENDOR_DELETED = "aaaaaaaa-0000-4000-8000-00000000000e"

function seedVendor(id: string, name: string, shortName: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    name,
    short_name: shortName,
    category: null,
    contact_name: null,
    tax_id: null,
    phone: null,
    mobile: null,
    source: "manual",
    deleted_at: null,
    ...extra,
  }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [{ id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: USER_TOKEN, role: "accountant", dept_id: null }]
  fake.db.vendors = []
})

function vendorWrites(action: "insert" | "update") {
  return fake.writes.filter((write) => write.table === "vendors" && write.action === action)
}

describe("POST /vendors — 簡稱 shortName", () => {
  it("存 short_name（已 trim），回應帶 shortName", async () => {
    const res = await authed(request(app).post("/vendors")).send({ name: "測試廠商甲股份有限公司", shortName: "  測試甲  " })

    expect(res.status).toBe(201)
    expect(res.body.vendor).toMatchObject({ name: "測試廠商甲股份有限公司", shortName: "測試甲" })
    expect(vendorWrites("insert")).toHaveLength(1)
    expect(vendorWrites("insert")[0]?.payload).toMatchObject({
      tenant_id: TENANT_ID,
      name: "測試廠商甲股份有限公司",
      short_name: "測試甲",
    })
  })

  it("不帶簡稱時回 shortName: null、insert 不帶 short_name；只有空白的簡稱存成 null", async () => {
    const without = await authed(request(app).post("/vendors")).send({ name: "測試廠商乙" })
    expect(without.status).toBe(201)
    expect(without.body.vendor.shortName).toBeNull()
    expect(vendorWrites("insert")[0]?.payload).not.toHaveProperty("short_name")

    const blank = await authed(request(app).post("/vendors")).send({ name: "測試廠商丙", shortName: "   " })
    expect(blank.status).toBe(201)
    expect(blank.body.vendor.shortName).toBeNull()
    expect(vendorWrites("insert")[1]?.payload).toMatchObject({ short_name: null })
  })

  it("簡稱最長 40 字：41 字回 400 invalid_body 且不寫入，剛好 40 字可存", async () => {
    const tooLong = await authed(request(app).post("/vendors")).send({ name: "測試廠商丁", shortName: "字".repeat(41) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe("invalid_body")
    expect(vendorWrites("insert")).toHaveLength(0)

    const exactly40 = await authed(request(app).post("/vendors")).send({ name: "測試廠商戊", shortName: "字".repeat(40) })
    expect(exactly40.status).toBe(201)
    expect(exactly40.body.vendor.shortName).toBe("字".repeat(40))
    expect(vendorWrites("insert")).toHaveLength(1)
  })

  it("前後空白不佔額度：40 字加前後空白仍可存、41 字加空白仍擋", async () => {
    const padded40 = await authed(request(app).post("/vendors")).send({ name: "測試廠商己", shortName: `  ${"字".repeat(40)}  ` })
    expect(padded40.status).toBe(201)
    expect(padded40.body.vendor.shortName).toBe("字".repeat(40))

    const padded41 = await authed(request(app).post("/vendors")).send({ name: "測試廠商庚", shortName: `  ${"字".repeat(41)}  ` })
    expect(padded41.status).toBe(400)
  })
})

describe("PATCH /vendors/:id — 簡稱 shortName", () => {
  beforeEach(() => {
    fake.db.vendors = [
      seedVendor(VENDOR_A, "甲方工程顧問有限公司", "甲方"),
      seedVendor(VENDOR_OTHER_TENANT, "別租戶的廠商", "別租戶", { tenant_id: OTHER_TENANT_ID }),
    ]
  })

  it("只改簡稱：update 只帶 short_name（與 updated_at），回應反映新值", async () => {
    const res = await authed(request(app).patch(`/vendors/${VENDOR_A}`)).send({ shortName: " 新簡稱 " })

    expect(res.status).toBe(200)
    expect(res.body.vendor).toMatchObject({ id: VENDOR_A, name: "甲方工程顧問有限公司", shortName: "新簡稱" })
    expect(Object.keys(vendorWrites("update")[0]?.payload as object).sort()).toEqual(["short_name", "updated_at"])
    expect(vendorWrites("update")[0]?.payload).toMatchObject({ short_name: "新簡稱" })
  })

  it.each([
    ["null", null],
    ["空字串", ""],
    ["只有空白", "   "],
  ])("帶 %s 清除簡稱", async (_label, value) => {
    const res = await authed(request(app).patch(`/vendors/${VENDOR_A}`)).send({ shortName: value })

    expect(res.status).toBe(200)
    expect(res.body.vendor.shortName).toBeNull()
    expect(vendorWrites("update")[0]?.payload).toMatchObject({ short_name: null })
    expect(fake.db.vendors?.find((row) => row.id === VENDOR_A)?.short_name).toBeNull()
  })

  it("簡稱超過 40 字回 400 invalid_body，不寫入", async () => {
    const res = await authed(request(app).patch(`/vendors/${VENDOR_A}`)).send({ shortName: "字".repeat(41) })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
    expect(vendorWrites("update")).toHaveLength(0)
  })

  it("不帶 shortName 的 PATCH 不動簡稱", async () => {
    const res = await authed(request(app).patch(`/vendors/${VENDOR_A}`)).send({ category: "測試類別" })

    expect(res.status).toBe(200)
    expect(res.body.vendor.shortName).toBe("甲方")
    expect(vendorWrites("update")[0]?.payload).not.toHaveProperty("short_name")
  })

  it("別租戶的廠商：404 not_found，簡稱不會被改到", async () => {
    const res = await authed(request(app).patch(`/vendors/${VENDOR_OTHER_TENANT}`)).send({ shortName: "被改掉" })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe("not_found")
    expect(fake.db.vendors?.find((row) => row.id === VENDOR_OTHER_TENANT)?.short_name).toBe("別租戶")
  })
})

describe("GET /vendors?q= — 搜尋也比對簡稱", () => {
  beforeEach(() => {
    fake.db.vendors = [
      seedVendor(VENDOR_A, "甲方工程顧問有限公司", "甲方"),
      seedVendor(VENDOR_B, "乙方印刷股份有限公司", "乙印"),
      seedVendor(VENDOR_C, "丙方事務所", null),
      seedVendor(VENDOR_OTHER_TENANT, "別租戶的乙印", "乙印", { tenant_id: OTHER_TENANT_ID }),
      seedVendor(VENDOR_DELETED, "已刪除的乙印", "乙印", { deleted_at: "2026-10-01T00:00:00.000Z" }),
    ]
  })

  const idsOf = (res: request.Response) => (res.body.vendors as Array<{ id: string }>).map((v) => v.id).sort()

  it("名稱沒有、只有簡稱符合時也搜得到（不跨租戶、不含已刪除）", async () => {
    const res = await authed(request(app).get("/vendors")).query({ q: "乙印" })

    expect(res.status).toBe(200)
    expect(idsOf(res)).toEqual([VENDOR_B])
    expect(fake.orFilters.at(-1)).toContain("short_name.ilike.%乙印%")
  })

  it("簡稱的比對不分大小寫、可只打一部分", async () => {
    fake.db.vendors = [seedVendor(VENDOR_A, "甲方工程顧問有限公司", "ABC工程")]

    const upper = await authed(request(app).get("/vendors")).query({ q: "abc" })
    expect(idsOf(upper)).toEqual([VENDOR_A])

    const partial = await authed(request(app).get("/vendors")).query({ q: "C工" })
    expect(idsOf(partial)).toEqual([VENDOR_A])
  })

  it("簡稱的搜尋字串同樣先剝 % _ , ( )，不能藉簡稱欄位多塞條件", async () => {
    const res = await authed(request(app).get("/vendors")).query({ q: "乙(印),deleted.is.null" })

    expect(res.status).toBe(200)
    const filter = fake.orFilters.at(-1) ?? ""
    // 剝完是「乙印deleted.is.null」：八段 ilike（0076 加了細目 sub_category），沒有多出任何其他運算子的條件
    expect(filter.split(",")).toHaveLength(8)
    expect(filter.split(",").every((term) => term.includes(".ilike.%乙印deleted.is.null%"))).toBe(true)
    expect(filter).toContain("short_name.ilike.%乙印deleted.is.null%")
    expect(idsOf(res)).toEqual([])
  })

  it("原本的名稱比對不受影響，列表每一列都帶 shortName（沒有就是 null）", async () => {
    const byName = await authed(request(app).get("/vendors")).query({ q: "丙方" })
    expect(idsOf(byName)).toEqual([VENDOR_C])
    expect(byName.body.vendors[0].shortName).toBeNull()

    const all = await authed(request(app).get("/vendors"))
    expect(all.status).toBe(200)
    expect(idsOf(all)).toEqual([VENDOR_A, VENDOR_B, VENDOR_C])
    expect(Object.fromEntries((all.body.vendors as Array<{ id: string; shortName: string | null }>).map((v) => [v.id, v.shortName]))).toEqual({
      [VENDOR_A]: "甲方",
      [VENDOR_B]: "乙印",
      [VENDOR_C]: null,
    })
  })
})
