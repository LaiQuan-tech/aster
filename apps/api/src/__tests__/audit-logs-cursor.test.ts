import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * GET /audit-logs 的 keyset 游標（cursor＝base64url 的 {at, id}）：`at` 不是合法 timestamptz、
 * `id` 不是 UUID 的游標一律 400 `invalid_cursor`，不讓它進 `.or()` 害 PostgREST 轉型失敗（→ 500）；
 * 合法游標（含 API 自己產生的 nextCursor）照舊翻頁，`.or()` 字串格式不變。
 * lib/supabase.js 換成會記下每段鏈式呼叫的假 builder，**不碰任何 DB**
 * （真的 requireAuth／requireTenant／requireHrAdmin 照跑：Bearer token 直接當 user id）。
 */
const sb = vi.hoisted(() => {
  type Call = { method: string; args: unknown[] }
  type Chain = { table: string; calls: Call[] }
  type Result = { data: unknown; error: { code?: string; message: string } | null }
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
  const chains: Chain[] = []
  /** audit_logs 清單查詢依序吐出的列；排完就回空清單。 */
  const auditPages: unknown[][] = []
  function from(table: string) {
    const chain: Chain = { table, calls: [] }
    chains.push(chain)
    const builder: Record<string, unknown> = {}
    for (const method of ["select", "eq", "in", "gte", "lt", "lte", "or", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => (chain.calls.push({ method, args }), builder)
    }
    // requireHrAdmin 查呼叫者角色
    builder.maybeSingle = () =>
      Promise.resolve<Result>(table === "employees" ? { data: { id: EMP_ID, role: "hr_admin" }, error: null } : { data: null, error: null })
    builder.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve<Result>({ data: table === "audit_logs" ? (auditPages.shift() ?? []) : [], error: null }).then(resolve, reject)
    return builder
  }
  return { TENANT, chains, auditPages, from }
})

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => sb.from(table) },
  getUserFromToken: async (token: string) =>
    token ? { userId: token, email: null, appMetadata: { tenant_id: sb.TENANT } } : null,
}))

import { auditLogsRouter } from "../routes/audit-logs.js"

const app = express()
app.use(auditLogsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const getLogs = (query: Record<string, string>) =>
  request(app).get("/audit-logs").set("Authorization", "Bearer audit-cursor-tester").query(query)

/** 與 routes/audit-logs.ts encodeCursor 相同的編碼。 */
const encodeCursor = (cursor: unknown) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
/** 修改前後都一樣的 keyset 條件格式。 */
const keysetOr = (at: string, id: string) => `at.lt.${at},and(at.eq.${at},id.lt.${id})`

const ID = "cccccccc-0000-4000-8000-000000000001"

const argsOf = (chain: { calls: Array<{ method: string; args: unknown[] }> }, method: string) =>
  chain.calls.filter((c) => c.method === method).map((c) => c.args)
const auditChains = () => sb.chains.filter((chain) => chain.table === "audit_logs")
const allOrFilters = () => sb.chains.flatMap((chain) => argsOf(chain, "or").map((args) => String(args[0])))

function logRow(id: string, at: string) {
  return {
    id,
    at,
    table_name: "vendors",
    record_id: null,
    action: "INSERT",
    old_row: null,
    new_row: { name: "測試廠商甲" },
    actor_emp_id: null,
    db_user: "postgres",
    context: null,
  }
}

beforeEach(() => {
  sb.chains.length = 0
  sb.auditPages.length = 0
})

describe("GET /audit-logs?cursor= — 不合法的游標回 400 invalid_cursor，不送進 or()", () => {
  const AT_OK = "2026-10-07T01:39:31.123456+00:00"

  it.each([
    ["at 只有允許的字元、不是時間", "::::", ID],
    ["2/30 不存在（Date.parse 會進位成 3/2）", "2026-02-30T00:00:00Z", ID],
    ["4/31 不存在（Date.parse 會進位成 5/1）", "2026-04-31T10:00:00+08:00", ID],
    ["24 點（Date.parse 會進位成隔天）", "2026-10-07T24:00:00Z", ID],
    ["時區位移 +25:00", "2026-10-07T01:39:31+25:00", ID],
    ["平年 2/29", "2026-02-29T00:00:00Z", ID],
    ["13 月", "2026-13-01T00:00:00Z", ID],
    ["0 日", "2026-10-00T00:00:00Z", ID],
    ["60 分", "2026-10-07T01:60:00Z", ID],
    ["60 秒", "2026-10-07T01:39:60Z", ID],
    ["時區位移 +15:00", "2026-10-07T01:39:31+15:00", ID],
    ["時區位移分鐘 60", "2026-10-07T01:39:31+08:60", ID],
    ["小數秒 7 位", "2026-10-07T01:39:31.1234567+00:00", ID],
    ["沒有秒", "2026-10-07T01:39+00:00", ID],
    ["沒有時區", "2026-10-07T01:39:31", ID],
    ["id 是 36 個 -", AT_OK, "-".repeat(36)],
    ["id 字元集與長度都對、但不是 UUID 的 8-4-4-4-12", AT_OK, "0123456789abcdef0123456789abcdef----"],
    ["id 不是 UUID", AT_OK, "not-a-uuid"],
  ])("%s", async (_label, at, id) => {
    const res = await getLogs({ cursor: encodeCursor({ at, id }) })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "invalid_cursor" })
    // 根本沒查 audit_logs，也沒有任何 or() 帶到這個值
    expect(auditChains()).toEqual([])
    const bad = id === ID ? at : id
    expect(allOrFilters().filter((filter) => filter.includes(bad))).toEqual([])
  })
})

describe("GET /audit-logs?cursor= — 合法游標照舊翻頁，or() 格式不變", () => {
  it.each([
    ["6 位小數秒＋+00:00（PostgREST 實際回的格式）", "2026-10-07T01:39:31.123456+00:00"],
    ["沒有小數秒", "2026-10-07T01:39:31+00:00"],
    ["Z", "2026-10-07T01:39:31Z"],
    ["1 位小數秒＋+08:00", "2026-10-07T09:39:31.5+08:00"],
    ["閏年 2/29＋負位移", "2028-02-29T23:59:59.999999-05:00"],
    ["位移上限 +14:00", "2026-10-07T01:39:31+14:00"],
  ])("%s", async (_label, at) => {
    const res = await getLogs({ cursor: encodeCursor({ at, id: ID }) })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ logs: [], nextCursor: null })
    const chains = auditChains()
    expect(chains).toHaveLength(1)
    expect(argsOf(chains[0], "eq")).toContainEqual(["tenant_id", sb.TENANT])
    // 原字串原樣帶進 or()（不經 Date，保留微秒）
    expect(argsOf(chains[0], "or")).toEqual([[keysetOr(at, ID)]])
  })

  it("API 自己產生的 nextCursor 原樣帶回：解得開、at 保留微秒原字串", async () => {
    const AT_A = "2026-10-07T01:39:31.123456+00:00"
    const ID_A = "cccccccc-0000-4000-8000-00000000000a"
    const ID_B = "cccccccc-0000-4000-8000-00000000000b"
    sb.auditPages.push([logRow(ID_A, AT_A), logRow(ID_B, "2026-10-07T01:39:30+00:00")])

    const first = await getLogs({ limit: "1" })
    expect(first.status).toBe(200)
    expect((first.body.logs as Array<{ id: string }>).map((log) => log.id)).toEqual([ID_A])
    expect(first.body.nextCursor).toBe(encodeCursor({ at: AT_A, id: ID_A }))

    const second = await getLogs({ limit: "1", cursor: first.body.nextCursor as string })
    expect(second.status).toBe(200)
    expect(auditChains()).toHaveLength(2)
    expect(argsOf(auditChains()[1], "or")).toEqual([[keysetOr(AT_A, ID_A)]])
  })
})
