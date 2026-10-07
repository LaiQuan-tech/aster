import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 匯款紀錄列表 GET /disbursements?q=（與 /disbursements/export.xlsx 共用 services/disbursements.ts
 * 的 listDisbursements）：q 進 PostgREST `.or()` 之前過 lib/search-term.ts（剝 `% _ , ( )`、截 100 字），
 * 另一個日期窗 `.or()` 不受影響。lib/supabase.js 換成會記下每段鏈式呼叫的假 builder，
 * **不碰任何 DB**（真的 requireAuth／requireTenant／requireFinance 照跑：Bearer token 直接當 user id）。
 */
const sb = vi.hoisted(() => {
  type Call = { method: string; args: unknown[] }
  type Chain = { table: string; calls: Call[] }
  type Result = { data: unknown; error: { code?: string; message: string } | null }
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
  const chains: Chain[] = []
  /** 單列查詢：requireFinance 查呼叫者角色、getTenantTimezone 查租戶時區。 */
  function one(table: string): Result {
    if (table === "employees") return { data: { id: EMP_ID, role: "accountant" }, error: null }
    if (table === "tenants") return { data: { timezone: "Asia/Taipei" }, error: null }
    return { data: null, error: null }
  }
  function from(table: string) {
    const chain: Chain = { table, calls: [] }
    chains.push(chain)
    const builder: Record<string, unknown> = {}
    for (const method of ["select", "eq", "neq", "in", "or", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => (chain.calls.push({ method, args }), builder)
    }
    builder.maybeSingle = () => Promise.resolve(one(table))
    // 清單查詢（schema-compat 的欄位探測、匯款單列表）一律回空清單：serializeMany 遇到 0 筆直接回 []。
    builder.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve<Result>({ data: [], error: null }).then(resolve, reject)
    return builder
  }
  return { TENANT, chains, from }
})

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => sb.from(table) },
  getUserFromToken: async (token: string) =>
    token ? { userId: token, email: null, appMetadata: { tenant_id: sb.TENANT } } : null,
}))

import { disbursementsRouter } from "../routes/disbursements.js"
import { listDisbursements } from "../services/disbursements.js"

const app = express()
app.use(disbursementsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

/** 固定日期範圍，日期窗那個 or() 才有確定的字串可比。租戶時區 Asia/Taipei（UTC+8）。 */
const RANGE = { from: "2026-07-01", to: "2026-09-30" }
const DATE_WINDOW = [
  "and(paid_on.gte.2026-07-01,paid_on.lte.2026-09-30)",
  "status.eq.draft",
  "status.eq.pending_approval",
  "status.eq.approved",
  "and(status.eq.void,paid_on.is.null,updated_at.gte.2026-06-30T16:00:00.000Z,updated_at.lt.2026-09-30T16:00:00.000Z)",
].join(",")

/** listDisbursements 的 q 依序比對的四個欄位。 */
const SEARCH_COLS = ["disbursement_no", "payee_name", "receipt_ref", "purpose"]
const expectedQ = (needle: string) => SEARCH_COLS.map((col) => `${col}.ilike.%${needle}%`).join(",")
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const call = (path: string, q?: string) =>
  request(app)
    .get(path)
    .set("Authorization", "Bearer disbursement-search-tester")
    .query(q === undefined ? RANGE : { ...RANGE, q })
const list = (q?: string) => call("/disbursements", q)

const argsOf = (chain: { calls: Array<{ method: string; args: unknown[] }> }, method: string) =>
  chain.calls.filter((c) => c.method === method).map((c) => c.args)

/**
 * 匯款單列表那一段查詢（帶租戶條件的 disbursements 查詢；schema-compat 的欄位探測不帶），
 * 回傳它所有 or() 的字串（依呼叫順序）。
 */
function listOrFilters(): string[] {
  const chains = sb.chains.filter(
    (chain) => chain.table === "disbursements" && argsOf(chain, "eq").some(([col]) => col === "tenant_id"),
  )
  expect(chains).toHaveLength(1)
  expect(argsOf(chains[0], "eq")).toContainEqual(["tenant_id", sb.TENANT])
  return argsOf(chains[0], "or").map((args) => args[0] as string)
}

/** q 的 or 條件拆回四段：欄位順序不變、每段都是 `<col>.ilike.%<needle>%`，needle 不含 % _ , ( )。 */
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
})

describe("GET /disbursements?q= — 剝除 % _ , ( )", () => {
  it.each([
    ["多塞 OR 條件", "測試廠商甲,status.eq.void", "測試廠商甲status.eq.void"],
    ["提早關括號", "測試廠商甲)", "測試廠商甲"],
    ["開括號", "(測試廠商甲", "測試廠商甲"],
    ["LIKE 萬用字元", "50%_訂金", "50訂金"],
    ["全部混在一起", "%_,()測試(廠商),甲_%", "測試廠商甲"],
  ])("%s：q 的 or() 仍是四段 ilike，日期窗 or() 不變", async (_label, q, needle) => {
    const res = await list(q)

    expect(res.status).toBe(200)
    expect(res.body.disbursements).toEqual([])
    const [dateWindow, qFilter, ...rest] = listOrFilters()
    expect(dateWindow).toBe(DATE_WINDOW)
    expect(qFilter).toBe(expectedQ(needle))
    expect(needlesOf(qFilter)).toEqual(Array(SEARCH_COLS.length).fill(needle))
    expect(rest).toEqual([])
  })
})

describe("GET /disbursements?q= — 搜尋字串長度上限", () => {
  it.each([
    ["8000 個英文字", "a".repeat(8000), "a"],
    ["1000 個中文字", "字".repeat(1000), "字"],
  ])("%s的 q：四段 ilike 的 needle 各恰好 100 字", async (_label, q, ch) => {
    const res = await list(q)

    expect(res.status).toBe(200)
    const [dateWindow, qFilter] = listOrFilters()
    expect(dateWindow).toBe(DATE_WINDOW)
    expect(needlesOf(qFilter)).toEqual(Array(SEARCH_COLS.length).fill(ch.repeat(100)))
  })

  it("先剝除再截長：被剝掉的字元不佔名額（路由不先截，與 service 層一致留滿 100 字）", async () => {
    const res = await list(`%_,()${"丙".repeat(100)}`)

    expect(res.status).toBe(200)
    expect(listOrFilters()[1]).toBe(expectedQ("丙".repeat(100)))
  })

  it.each([
    // 以 UTF-16 code unit 截 100 會切在第 50 個 emoji 中間；以 code point 算只有 61 字，不必截
    ["a＋60 個 emoji", `a${"😀".repeat(60)}`, `a${"😀".repeat(60)}`, 61],
    // 151 個 code point → 截成 a＋99 個 emoji，截斷點落在兩個 emoji 之間
    ["a＋150 個 emoji", `a${"😀".repeat(150)}`, `a${"😀".repeat(99)}`, 100],
  ])("emoji 邊界（%s）：以 code point 截斷，不留落單的 surrogate", async (_label, q, needle, codePoints) => {
    const res = await list(q)

    expect(res.status).toBe(200)
    const qFilter = listOrFilters()[1]
    expect(qFilter).toBe(expectedQ(needle))
    const [first] = needlesOf(qFilter)
    expect(Array.from(first)).toHaveLength(codePoints)
    expect(LONE_SURROGATE.test(qFilter)).toBe(false)
  })
})

describe("GET /disbursements?q= — 一般搜尋不受影響", () => {
  it.each([
    ["匯款單號（- 保留）", "D-115-001", "D-115-001"],
    ["中文收款方（前後空白先 trim）", "  測試廠商甲  ", "測試廠商甲"],
    ["全形括號保留", "測試廠商（台北）", "測試廠商（台北）"],
  ])("%s", async (_label, q, needle) => {
    const res = await list(q)

    expect(res.status).toBe(200)
    expect(listOrFilters()).toEqual([DATE_WINDOW, expectedQ(needle)])
  })

  it.each([
    ["沒帶 q", undefined],
    ["空字串", ""],
    ["只有空白", "   "],
  ])("%s：只有日期窗那個 or()", async (_label, q) => {
    const res = await list(q)

    expect(res.status).toBe(200)
    expect(listOrFilters()).toEqual([DATE_WINDOW])
  })
})

describe("GET /disbursements/export.xlsx?q= — 匯出走同一個 listDisbursements", () => {
  it.each([
    ["注入樣態", "%_,()測試(廠商),甲_%", "測試廠商甲"],
    ["8000 個英文字", "a".repeat(8000), "a".repeat(100)],
  ])("%s：q 一樣被清洗＋截長，日期窗 or() 不變", async (_label, q, needle) => {
    const res = await call("/disbursements/export.xlsx", q)

    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    expect(listOrFilters()).toEqual([DATE_WINDOW, expectedQ(needle)])
  })
})

describe("listDisbursements — 清洗與長度上限都在 service 層（直接呼叫）", () => {
  it.each([
    ["8000 個英文字", "a".repeat(8000), "a".repeat(100)],
    ["被剝字元不佔名額", `%_,()${"丙".repeat(100)}%_,()`, "丙".repeat(100)],
    ["以 code point 截斷（emoji 不切半）", "😀".repeat(150), "😀".repeat(100)],
  ])("%s", async (_label, q, needle) => {
    await listDisbursements(sb.TENANT, { ...RANGE, q })

    expect(listOrFilters()).toEqual([DATE_WINDOW, expectedQ(needle)])
  })
})
