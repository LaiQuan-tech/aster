import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * helpers/purge.ts 安全網的純邏輯：門檻解析、過期時刻、以及「只清自己建的＋過期殘留」
 * 的查詢與合併。不打真 Supabase——把 supabaseAdmin 換成會記下鏈式呼叫的假 builder，
 * services/tenants 的登記表換成可控的 Set。
 */
const { from, rpc, registry } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  registry: new Set<string>(),
}))
vi.mock("../lib/supabase", () => ({ supabaseAdmin: { from, rpc } }))
vi.mock("../services/tenants", () => ({ provisionedTestTenantIds: registry }))

import {
  DEFAULT_STALE_MINUTES,
  STALE_MINUTES_ENV,
  purgeLeftoverTestTenants,
  resolveStaleMinutes,
  staleCutoff,
} from "./helpers/purge"

type Row = { id: string; name: string }
type QueryResult = { data: Row[] | null; error: { message: string } | null }
type Call = { method: string; args: unknown[] }

const NOW = new Date("2026-09-22T10:00:00.000Z")
const STALE_ID = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OWN_ID = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

/** 每次 from() 記一段鏈式呼叫；await 時吐出預先排好的結果，排完就回空清單。 */
const calls: Call[][] = []
const queue: QueryResult[] = []
function installFakeBuilder() {
  from.mockImplementation((table: string) => {
    const chain: Call[] = [{ method: "from", args: [table] }]
    calls.push(chain)
    const builder: Record<string, unknown> = {}
    for (const method of ["select", "eq", "lt", "in"]) {
      builder[method] = (...args: unknown[]) => {
        chain.push({ method, args })
        return builder
      }
    }
    builder.then = (resolve: (v: QueryResult) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? { data: [], error: null }).then(resolve, reject)
    return builder
  })
}

const envBefore = process.env[STALE_MINUTES_ENV]
beforeEach(() => {
  calls.length = 0
  queue.length = 0
  registry.clear()
  installFakeBuilder()
  rpc.mockReset()
  rpc.mockResolvedValue({ data: { deleted: {} }, error: null })
  delete process.env[STALE_MINUTES_ENV]
})
afterEach(() => {
  if (envBefore === undefined) delete process.env[STALE_MINUTES_ENV]
  else process.env[STALE_MINUTES_ENV] = envBefore
})

describe("resolveStaleMinutes", () => {
  it("沒設或空白 → 預設 30 分鐘", () => {
    expect(DEFAULT_STALE_MINUTES).toBe(30)
    expect(resolveStaleMinutes(undefined)).toBe(30)
    expect(resolveStaleMinutes("")).toBe(30)
    expect(resolveStaleMinutes("   ")).toBe(30)
  })

  it("數字照用；0 代表不分新舊全清", () => {
    expect(resolveStaleMinutes("45")).toBe(45)
    expect(resolveStaleMinutes("0")).toBe(0)
    expect(resolveStaleMinutes("2.5")).toBe(2.5)
  })

  it("非數字／負數直接丟錯，不默默改用別的門檻", () => {
    expect(() => resolveStaleMinutes("abc")).toThrow(STALE_MINUTES_ENV)
    expect(() => resolveStaleMinutes("-5")).toThrow(STALE_MINUTES_ENV)
  })

  it("預設從環境變數讀", () => {
    process.env[STALE_MINUTES_ENV] = "7"
    expect(resolveStaleMinutes()).toBe(7)
  })
})

describe("staleCutoff", () => {
  it("now 往前推 N 分鐘的 ISO 字串", () => {
    expect(staleCutoff(NOW, 30)).toBe("2026-09-22T09:30:00.000Z")
    expect(staleCutoff(NOW, 0)).toBe("2026-09-22T10:00:00.000Z")
  })
})

describe("purgeLeftoverTestTenants", () => {
  it("沒有自建租戶：只查 status=test 且 created_at 早於門檻的，逐一 purge", async () => {
    queue.push({ data: [{ id: STALE_ID, name: "舊殘留" }], error: null })
    const result = await purgeLeftoverTestTenants({ now: NOW, staleMinutes: 30, ownTenantIds: [] })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      { method: "from", args: ["tenants"] },
      { method: "select", args: ["id, name"] },
      { method: "eq", args: ["status", "test"] },
      { method: "lt", args: ["created_at", "2026-09-22T09:30:00.000Z"] },
    ])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("purge_test_tenant", { p_tenant: STALE_ID })
    expect(result).toEqual({ purged: ["舊殘留 (11111111)"], failed: [], cutoff: "2026-09-22T09:30:00.000Z" })
  })

  it("有自建租戶：再用 id 查一次，兩邊合併去重後 purge", async () => {
    queue.push({ data: [{ id: STALE_ID, name: "舊殘留" }, { id: OWN_ID, name: "自建但也過期" }], error: null })
    queue.push({ data: [{ id: OWN_ID, name: "自建但也過期" }], error: null })
    const result = await purgeLeftoverTestTenants({ now: NOW, staleMinutes: 30, ownTenantIds: [OWN_ID] })

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([
      { method: "from", args: ["tenants"] },
      { method: "select", args: ["id, name"] },
      { method: "eq", args: ["status", "test"] },
      { method: "in", args: ["id", [OWN_ID]] },
    ])
    // 同一個租戶兩邊都出現只 purge 一次
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls.map((c) => (c[1] as { p_tenant: string }).p_tenant)).toEqual([STALE_ID, OWN_ID])
    expect(result.purged).toEqual(["舊殘留 (11111111)", "自建但也過期 (22222222)"])
  })

  it("預設從 services/tenants 的登記表拿自建租戶 id", async () => {
    registry.add(OWN_ID)
    queue.push({ data: [], error: null })
    queue.push({ data: [{ id: OWN_ID, name: "本檔漏網" }], error: null })
    const result = await purgeLeftoverTestTenants({ now: NOW, staleMinutes: 30 })

    expect(calls).toHaveLength(2)
    expect(calls[1][3]).toEqual({ method: "in", args: ["id", [OWN_ID]] })
    expect(result.purged).toEqual(["本檔漏網 (22222222)"])
  })

  it("別的程序剛建的租戶（不夠舊、也不是自己的）完全不會被碰", async () => {
    // 假 DB 只會回符合條件的列；這裡驗的是查詢本身帶了門檻，且沒有自建 id 時不多查一次
    const result = await purgeLeftoverTestTenants({ now: NOW, staleMinutes: 30 })
    expect(calls).toHaveLength(1)
    expect(calls[0][3]).toEqual({ method: "lt", args: ["created_at", "2026-09-22T09:30:00.000Z"] })
    expect(rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ purged: [], failed: [], cutoff: "2026-09-22T09:30:00.000Z" })
  })

  it("門檻沒傳就讀環境變數", async () => {
    process.env[STALE_MINUTES_ENV] = "5"
    await purgeLeftoverTestTenants({ now: NOW, ownTenantIds: [] })
    expect(calls[0][3]).toEqual({ method: "lt", args: ["created_at", "2026-09-22T09:55:00.000Z"] })
  })

  it("某個租戶 purge 失敗只進 failed，其餘照清", async () => {
    queue.push({ data: [{ id: STALE_ID, name: "清不掉" }, { id: OWN_ID, name: "清得掉" }], error: null })
    rpc.mockImplementation(async (_fn: string, args: { p_tenant: string }) =>
      args.p_tenant === STALE_ID ? { data: null, error: { message: "still referenced" } } : { data: { deleted: {} }, error: null },
    )
    const result = await purgeLeftoverTestTenants({ now: NOW, staleMinutes: 30, ownTenantIds: [] })
    expect(result.purged).toEqual(["清得掉 (22222222)"])
    expect(result.failed).toEqual([{ id: STALE_ID, error: `purge_test_tenant(${STALE_ID}): still referenced` }])
  })

  it("列表查詢失敗就整個丟錯，不會 purge 任何東西", async () => {
    queue.push({ data: null, error: { message: "permission denied" } })
    await expect(purgeLeftoverTestTenants({ now: NOW, staleMinutes: 30, ownTenantIds: [] })).rejects.toThrow(
      "purgeLeftoverTestTenants (stale): permission denied",
    )
    expect(rpc).not.toHaveBeenCalled()
  })
})
