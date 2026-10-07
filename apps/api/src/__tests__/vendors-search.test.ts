import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * GET /vendors?q=：q 進 PostgREST `.or()` 之前過 lib/search-term.ts（剝 `% _ , ( )`、截 100 字）。
 * lib/supabase.js 換成會記下每段鏈式呼叫的假 builder，**不碰任何 DB**
 * （真的 requireAuth／requireTenant 照跑：Bearer token 直接當 user id）。
 */
const sb = vi.hoisted(() => {
  type Call = { method: string; args: unknown[] }
  type Chain = { table: string; calls: Call[] }
  type Result = { data: unknown; error: { code?: string; message: string } | null }
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const chains: Chain[] = []
  /** 每次 await 依序吐出的結果；排完就回空清單。 */
  const queue: Result[] = []
  function from(table: string) {
    const chain: Chain = { table, calls: [] }
    chains.push(chain)
    const builder: Record<string, unknown> = {}
    for (const method of ["select", "eq", "is", "or", "order"]) {
      builder[method] = (...args: unknown[]) => (chain.calls.push({ method, args }), builder)
    }
    builder.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? { data: [], error: null }).then(resolve, reject)
    return builder
  }
  return { TENANT, chains, queue, from }
})

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => sb.from(table) },
  getUserFromToken: async (token: string) =>
    token ? { userId: token, email: null, appMetadata: { tenant_id: sb.TENANT } } : null,
}))

import { vendorsRouter } from "../routes/vendors.js"

const app = express()
app.use(vendorsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const search = (q?: string) => {
  const req = request(app).get("/vendors").set("Authorization", "Bearer vendor-search-tester")
  return q === undefined ? req : req.query({ q })
}

const VENDOR_ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  tenant_id: sb.TENANT,
  name: "測試廠商甲",
  phone: "02-1234-5678",
  source: "manual",
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-01T00:00:00+00:00",
}

/** routes/vendors.ts 的 or() 依序比對的六個欄位。 */
const SEARCH_COLS = ["name", "contact_name", "category", "tax_id", "phone", "mobile"]
const expectedOr = (needle: string) => SEARCH_COLS.map((col) => `${col}.ilike.%${needle}%`).join(",")

const vendorChains = () => sb.chains.filter((chain) => chain.table === "vendors")
const argsOf = (chain: { calls: Array<{ method: string; args: unknown[] }> }, method: string) =>
  chain.calls.filter((call) => call.method === method).map((call) => call.args)

/** 唯一一段 vendors 查詢：租戶條件照帶、恰好一個 or()，回傳那串 or 條件。 */
function soleOrFilter(): string {
  const chains = vendorChains()
  expect(chains).toHaveLength(1)
  const [chain] = chains
  expect(argsOf(chain, "eq")).toContainEqual(["tenant_id", sb.TENANT])
  const ors = argsOf(chain, "or")
  expect(ors).toHaveLength(1)
  return ors[0][0] as string
}

/** or 條件拆回六段：欄位順序不變、每段都是 `<col>.ilike.%<needle>%`，needle 不含 % _ , ( )。 */
function needlesOf(filter: string): string[] {
  const terms = filter.split(",")
  expect(terms).toHaveLength(SEARCH_COLS.length)
  return terms.map((term, i) => {
    const prefix = `${SEARCH_COLS[i]}.ilike.%`
    expect(term.startsWith(prefix)).toBe(true)
    expect(term.endsWith("%")).toBe(true)
    const needle = term.slice(prefix.length, -1)
    expect(needle).not.toMatch(/[%_,()]/)
    return needle
  })
}

beforeEach(() => {
  sb.chains.length = 0
  sb.queue.length = 0
})

describe("GET /vendors?q= — 剝除 % _ , ( )", () => {
  it.each([
    ["多塞 OR 條件", "測試廠商甲,name.not.is.null", "測試廠商甲name.not.is.null"],
    ["提早關括號", "測試廠商甲)", "測試廠商甲"],
    ["開括號", "(測試廠商甲", "測試廠商甲"],
    ["LIKE 萬用字元", "50%_折扣", "50折扣"],
    ["全部混在一起", "%_,()測試(廠商),甲_%", "測試廠商甲"],
  ])("%s：剝完才進 or()，仍是六段 ilike、不多出條件", async (_label, q, needle) => {
    const res = await search(q)

    expect(res.status).toBe(200)
    const filter = soleOrFilter()
    expect(filter).toBe(expectedOr(needle))
    expect(needlesOf(filter)).toEqual(Array(SEARCH_COLS.length).fill(needle))
  })
})

describe("GET /vendors?q= — 搜尋字串長度上限", () => {
  it.each([
    ["8000 個英文字", "a".repeat(8000), "a"],
    ["1000 個中文字", "字".repeat(1000), "字"],
  ])("%s的 q：六段 ilike 的 needle 各恰好 100 字", async (_label, q, ch) => {
    const res = await search(q)

    expect(res.status).toBe(200)
    const filter = soleOrFilter()
    expect(needlesOf(filter)).toEqual(Array(SEARCH_COLS.length).fill(ch.repeat(100)))
    expect(filter).toBe(expectedOr(ch.repeat(100)))
  })

  it("先剝除再截長：被剝掉的字元不佔名額", async () => {
    await search(`%_,()${"丙".repeat(100)}%_,()`)
    expect(soleOrFilter()).toBe(expectedOr("丙".repeat(100)))
  })
})

describe("GET /vendors?q= — 一般搜尋不受影響", () => {
  it.each([
    ["中文名稱（前後空白先 trim）", "  測試廠商甲  ", "測試廠商甲"],
    ["電話（- 保留）", "02-1234-5678", "02-1234-5678"],
    ["全形括號保留", "測試廠商（台北）", "測試廠商（台北）"],
  ])("%s", async (_label, q, needle) => {
    sb.queue.push({ data: [VENDOR_ROW], error: null })
    const res = await search(q)

    expect(res.status).toBe(200)
    expect(soleOrFilter()).toBe(expectedOr(needle))
    expect(res.body.vendors).toEqual([expect.objectContaining({ id: VENDOR_ROW.id, name: "測試廠商甲", phone: "02-1234-5678" })])
  })

  it("沒帶 q：不加 or()，租戶條件照帶", async () => {
    const res = await search()

    expect(res.status).toBe(200)
    expect(vendorChains()).toHaveLength(1)
    expect(argsOf(vendorChains()[0], "eq")).toContainEqual(["tenant_id", sb.TENANT])
    expect(argsOf(vendorChains()[0], "or")).toEqual([])
  })
})

// ⚠️ 放最後：撞到缺欄位後 routes/vendors.ts 的 bankColsMissing 會在本檔剩下的生命週期內維持 true。
describe("GET /vendors?q= — 缺匯款欄位重試（withVendorCols）", () => {
  it("第一次撞 42703、改用舊欄位集重跑：兩次查詢都帶同一個清洗後的 or() 與租戶條件", async () => {
    sb.queue.push({ data: null, error: { code: "42703", message: "column vendors.bank_name does not exist" } })
    sb.queue.push({ data: [VENDOR_ROW], error: null })

    const res = await search(`測試(廠商)甲,${"乙".repeat(200)}`)

    expect(res.status).toBe(200)
    expect(res.body.vendors).toHaveLength(1)
    const chains = vendorChains()
    expect(chains).toHaveLength(2)
    // 第一次用含銀行欄的完整欄位集、第二次退回舊欄位集——確實走到重試
    expect(String(argsOf(chains[0], "select")[0][0])).toContain("bank_name")
    expect(String(argsOf(chains[1], "select")[0][0])).not.toContain("bank_name")
    const needle = `測試廠商甲${"乙".repeat(95)}`
    for (const chain of chains) {
      expect(argsOf(chain, "eq")).toContainEqual(["tenant_id", sb.TENANT])
      expect(argsOf(chain, "or")).toEqual([[expectedOr(needle)]])
    }
  })
})
