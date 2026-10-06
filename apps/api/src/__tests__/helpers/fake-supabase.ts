/**
 * 純測試（不連任何 DB）用的記憶體版 supabase-js。
 *
 * 只實作 API 路由實際用到的 PostgREST 子集：
 *   select / insert / update / delete、eq / neq / is / not / in / ilike / or（ilike／eq／is）、
 *   order / limit、single / maybeSingle、await（thenable），以及 rpc。
 * 刻意仿真實行為的地方：`single()`／`maybeSingle()` 撞到多列回 PGRST116；
 * `select(cols)` 不裁欄（回整列的複本）；所有寫入都記在 `writes`，測試可直接斷言 payload。
 *
 * 用法（每個測試檔）：
 *   vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
 *   import { fake, TENANT_ID } from "./helpers/fake-supabase.js"
 * vi.mock 的 factory 與測試本體 import 到的是同一個 module 實例，所以 `fake` 是同一份。
 *
 * ⚠️ 這裡所有識別碼、名稱都是明顯的假值；不要在 repo 裡放真實公司／人名／統編。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>

export type FakeWrite = {
  table: string
  action: "insert" | "update" | "delete"
  payload: unknown
  /** update／delete 命中的列數。 */
  matched?: number
}

type PgError = { message: string; code?: string }
type RpcResult = { data: unknown; error: PgError | null }

export const TENANT_ID = "11111111-1111-4111-8111-111111111111"
export const OTHER_TENANT_ID = "99999999-9999-4999-8999-999999999999"

const NOW = "2026-10-07T00:00:00.000Z"

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchesIlike(value: unknown, pattern: string): boolean {
  if (value === null || value === undefined) return false
  const regex = new RegExp(`^${pattern.split("%").map(escapeRegExp).join(".*")}$`, "i")
  return regex.test(String(value))
}

/** PostgREST `or=(a.ilike.%x%,b.eq.y,c.is.null)` 的子集。 */
function parseOr(expression: string): (row: Row) => boolean {
  const terms = expression
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => {
      const [column, op, ...rest] = term.split(".")
      return { column: column as string, op: op as string, value: rest.join(".") }
    })
  return (row) =>
    terms.some(({ column, op, value }) => {
      if (op === "ilike") return matchesIlike(row[column], value)
      if (op === "eq") return String(row[column]) === value
      if (op === "is") return value === "null" ? (row[column] ?? null) === null : String(row[column]) === value
      throw new Error(`fake-supabase: or() 不支援的運算子 ${op}`)
    })
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  return (a as string | number) < (b as string | number) ? -1 : 1
}

export function createFakeSupabase() {
  const db: Record<string, Row[]> = {}
  const writes: FakeWrite[] = []
  const orFilters: string[] = []
  const rpcCalls: Array<{ name: string; args: Row }> = []
  const rpcHandlers: Record<string, (args: Row) => RpcResult | Promise<RpcResult>> = {}
  let idSeq = 0

  const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`

  function from(table: string) {
    const predicates: Array<(row: Row) => boolean> = []
    const orders: Array<{ column: string; ascending: boolean }> = []
    let action: "select" | "insert" | "update" | "delete" = "select"
    let payload: Row | Row[] | null = null
    let max: number | null = null

    const matches = (row: Row) => predicates.every((predicate) => predicate(row))

    const execute = async (mode: "many" | "maybeSingle" | "single"): Promise<{ data: unknown; error: PgError | null }> => {
      const stored = (db[table] ??= [])
      const respond = (rows: Row[]) => {
        if (mode === "many") return { data: rows, error: null }
        if (rows.length > 1) {
          return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }
        }
        if (rows.length === 0) {
          return mode === "single"
            ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }
            : { data: null, error: null }
        }
        return { data: rows[0], error: null }
      }

      if (action === "insert") {
        const inputs = Array.isArray(payload) ? payload : [payload as Row]
        const inserted = inputs.map((input) => ({ id: nextId(), created_at: NOW, updated_at: NOW, ...input }))
        stored.push(...inserted)
        writes.push({ table, action, payload })
        return respond(inserted.map((row) => ({ ...row })))
      }
      if (action === "update") {
        const hit = stored.filter(matches)
        for (const row of hit) Object.assign(row, payload)
        writes.push({ table, action, payload, matched: hit.length })
        return respond(hit.map((row) => ({ ...row })))
      }
      if (action === "delete") {
        const doomed = new Set(stored.filter(matches))
        db[table] = stored.filter((row) => !doomed.has(row))
        writes.push({ table, action, payload: null, matched: doomed.size })
        return respond([])
      }

      let rows = stored.filter(matches)
      if (orders.length > 0) {
        rows = [...rows].sort((left, right) => {
          for (const { column, ascending } of orders) {
            const cmp = compareValues(left[column], right[column])
            if (cmp !== 0) return ascending ? cmp : -cmp
          }
          return 0
        })
      }
      if (max !== null) rows = rows.slice(0, max)
      return respond(rows.map((row) => ({ ...row })))
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: () => builder,
      insert: (value: Row | Row[]) => ((action = "insert"), (payload = value), builder),
      update: (value: Row) => ((action = "update"), (payload = value), builder),
      delete: () => ((action = "delete"), builder),
      eq: (column: string, value: unknown) => (predicates.push((row) => (row[column] ?? null) === (value ?? null)), builder),
      neq: (column: string, value: unknown) => (predicates.push((row) => (row[column] ?? null) !== (value ?? null)), builder),
      is: (column: string, value: unknown) => (predicates.push((row) => (row[column] ?? null) === (value ?? null)), builder),
      not: (column: string, op: string, value: unknown) => {
        if (op !== "is" && op !== "eq") throw new Error(`fake-supabase: not() 不支援的運算子 ${op}`)
        predicates.push((row) => (row[column] ?? null) !== (value ?? null))
        return builder
      },
      in: (column: string, values: unknown[]) => (predicates.push((row) => values.includes(row[column])), builder),
      ilike: (column: string, pattern: string) => (predicates.push((row) => matchesIlike(row[column], pattern)), builder),
      or: (expression: string) => {
        orFilters.push(expression)
        predicates.push(parseOr(expression))
        return builder
      },
      order: (column: string, opts?: { ascending?: boolean }) => (orders.push({ column, ascending: opts?.ascending ?? true }), builder),
      limit: (n: number) => ((max = n), builder),
      maybeSingle: () => execute("maybeSingle"),
      single: () => execute("single"),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => execute("many").then(resolve, reject),
    }
    return builder
  }

  async function rpc(name: string, args: Row): Promise<RpcResult> {
    rpcCalls.push({ name, args })
    const handler = rpcHandlers[name]
    if (!handler) return { data: null, error: { message: `fake-supabase: 沒有註冊 rpc ${name}` } }
    return handler(args)
  }

  function reset() {
    for (const key of Object.keys(db)) delete db[key]
    writes.length = 0
    orFilters.length = 0
    rpcCalls.length = 0
    for (const key of Object.keys(rpcHandlers)) delete rpcHandlers[key]
    idSeq = 0
  }

  return { db, writes, orFilters, rpcCalls, rpcHandlers, from, rpc, reset }
}

export const fake = createFakeSupabase()

/** `vi.mock("../lib/supabase.js", …)` 的回傳值：token 直接當 userId，租戶固定為 TENANT_ID。 */
export function fakeSupabaseModule() {
  return {
    supabaseAdmin: {
      from: (table: string) => fake.from(table),
      rpc: (name: string, args: Row) => fake.rpc(name, args),
    },
    getUserFromToken: async (token: string) =>
      token ? { userId: token, email: null, appMetadata: { tenant_id: TENANT_ID } } : null,
  }
}
