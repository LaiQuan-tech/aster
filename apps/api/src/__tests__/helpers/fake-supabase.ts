/**
 * 純測試（不連任何 DB）用的記憶體版 supabase-js。
 *
 * 只實作 API 路由實際用到的 PostgREST 子集：
 *   select / insert / update / delete、eq / neq / is / not / in / like / ilike / gt·gte·lt·lte /
 *   or（ilike／eq／is）、order / limit、single / maybeSingle、await（thenable），以及 rpc。
 * 另外支援 `range(from, to)`（分頁，含上界）與
 * `upsert(rows, { onConflict, ignoreDuplicates })`（`ignoreDuplicates` ＝ ON CONFLICT DO NOTHING，
 * 衝突的列略過；沒設＝衝突的列合併更新）。
 * 刻意仿真實行為的地方：`single()`／`maybeSingle()` 撞到多列回 PGRST116；
 * `select("a, b")` 只回有列名的欄位（沒列到的欄位拿不到，漏 select 欄位的 bug 才抓得到；
 * `select()` 不帶參數或 `*` 回整列；內嵌關聯如 `vendors(name)` 不模擬）；
 * 所有寫入記在 `writes`、所有讀取的資料表記在 `reads`（可斷言「只查了一次」），
 * 測試可直接斷言 payload。
 *
 * 測試專用的鉤子：
 *   • `injectError({ table, action, error })`：讓下一次對該表的該動作回傳指定的 PG 錯誤
 *     （例如外鍵競態 23503），資料不動、不記進 `writes`；一次性，用完即失效。
 *   • `checks[table] = (row) => 違反訊息 | null`：仿 DB 的列級 CHECK。insert／update 套用後的
 *     列違反時整句失敗（code 23514、不動任何一列、不記進 `writes`），可驗證「寫入順序不會中途違反 CHECK」。
 *   • `uniques[table] = [["a", "b"], …]`：仿 DB 的唯一索引（每組欄位一個索引；欄位值有 null 的列不算重複，
 *     與 Postgres 相同）。insert／update／upsert 讓兩列的某組欄位完全相同時整句失敗（code 23505、
 *     不動任何一列、不記進 `writes`）；upsert 的 `onConflict` 那組是仲裁索引，衝突時照 DO NOTHING／合併處理，
 *     其餘組仍會 23505。可驗證「同一批改名不會在中途撞到唯一索引」。
 *   • delete 若先呼叫了 `select()`，回傳被刪掉的列（仿 PostgREST `Prefer: return=representation`）。
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
  action: "insert" | "update" | "delete" | "upsert"
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

function matchesLike(value: unknown, pattern: string, flags: string): boolean {
  if (value === null || value === undefined) return false
  const regex = new RegExp(`^${pattern.split("%").map(escapeRegExp).join(".*")}$`, flags)
  return regex.test(String(value))
}

const matchesIlike = (value: unknown, pattern: string) => matchesLike(value, pattern, "i")

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

/** 依 `select("a, b, alias:c")` 的欄位清單裁欄；括號內的內嵌關聯（`vendors(name)`）不模擬、略過。 */
function projectColumns(row: Row, columns: string | null): Row {
  if (columns === null) return { ...row }
  const tokens: string[] = []
  let depth = 0
  let current = ""
  for (const ch of columns) {
    if (ch === "(") depth += 1
    if (ch === ")") depth -= 1
    if (ch === "," && depth === 0) {
      tokens.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) tokens.push(current.trim())
  if (tokens.includes("*")) return { ...row }
  const out: Row = {}
  for (const token of tokens) {
    if (token.includes("(")) continue
    const [aliasOrColumn, column] = token.split(":").map((part) => part.trim())
    if (column) out[aliasOrColumn as string] = row[column]
    else if (aliasOrColumn !== undefined && aliasOrColumn in row) out[aliasOrColumn] = row[aliasOrColumn]
  }
  return out
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
  /** 每次 select 查詢的資料表名（依執行順序）。 */
  const reads: string[] = []
  const orFilters: string[] = []
  const rpcCalls: Array<{ name: string; args: Row }> = []
  const rpcHandlers: Record<string, (args: Row) => RpcResult | Promise<RpcResult>> = {}
  /** 一次性的錯誤注入（見檔頭）。 */
  const injected: Array<{ table: string; action: "select" | "insert" | "update" | "delete" | "upsert"; error: PgError }> = []
  /** 列級 CHECK（見檔頭）：回傳違反訊息，null＝通過。 */
  const checks: Record<string, (row: Row) => string | null> = {}
  /** 唯一索引（見檔頭）：每個資料表一組一組的欄位。 */
  const uniques: Record<string, string[][]> = {}
  let idSeq = 0

  const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`

  function from(table: string) {
    const predicates: Array<(row: Row) => boolean> = []
    const orders: Array<{ column: string; ascending: boolean }> = []
    let action: "select" | "insert" | "update" | "delete" | "upsert" = "select"
    let payload: Row | Row[] | null = null
    let upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let max: number | null = null
    let rangeFrom: number | null = null
    let rangeTo: number | null = null
    /** `select("a, b")` 的欄位清單；null＝沒呼叫過 select()（或不帶參數）→ 回整列。 */
    let columns: string | null = null

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

      const injectedAt = injected.findIndex((entry) => entry.table === table && entry.action === action)
      if (injectedAt >= 0) {
        const [entry] = injected.splice(injectedAt, 1)
        return { data: null, error: entry!.error }
      }
      const violation = (candidates: Row[]): string | null => {
        const check = checks[table]
        if (!check) return null
        for (const candidate of candidates) {
          const message = check(candidate)
          if (message) return message
        }
        return null
      }
      const checkFailure = (message: string) => ({ data: null, error: { message, code: "23514" } })
      /**
       * 唯一索引違反：`candidates` 每一列與 `others`（庫裡不在這句裡的列＋這句裡的其他列）比；
       * `arbiter` 是 upsert 的 onConflict 那組（由呼叫端先處理衝突，這裡略過）。
       */
      const uniqueViolation = (candidates: Row[], others: Row[], arbiter?: string[]): string | null => {
        for (const candidate of candidates) {
          for (const columns of uniques[table] ?? []) {
            if (arbiter && columns.length === arbiter.length && columns.every((c) => arbiter.includes(c))) continue
            // Postgres 的唯一索引不把 null 當成相同。
            if (columns.some((c) => candidate[c] === null || candidate[c] === undefined)) continue
            const clash = others.some((other) => other !== candidate && columns.every((c) => other[c] === candidate[c]))
            if (clash) return `duplicate key value violates unique constraint on (${columns.join(", ")})`
          }
        }
        return null
      }
      const uniqueFailure = (message: string) => ({ data: null, error: { message, code: "23505" } })

      if (action === "insert") {
        const inputs = Array.isArray(payload) ? payload : [payload as Row]
        const inserted = inputs.map((input) => ({ id: nextId(), created_at: NOW, updated_at: NOW, ...input }))
        const broken = violation(inserted)
        if (broken) return checkFailure(broken)
        const clash = uniqueViolation(inserted, [...stored, ...inserted])
        if (clash) return uniqueFailure(clash)
        stored.push(...inserted)
        writes.push({ table, action, payload })
        return respond(inserted.map((row) => projectColumns(row, columns)))
      }
      if (action === "update") {
        const hit = stored.filter(matches)
        const merged = hit.map((row) => ({ ...row, ...payload }))
        const broken = violation(merged)
        if (broken) return checkFailure(broken)
        const hitSet = new Set(hit)
        const clash = uniqueViolation(merged, [...stored.filter((row) => !hitSet.has(row)), ...merged])
        if (clash) return uniqueFailure(clash)
        for (const row of hit) Object.assign(row, payload)
        writes.push({ table, action, payload, matched: hit.length })
        return respond(hit.map((row) => projectColumns(row, columns)))
      }
      if (action === "upsert") {
        const inputs = Array.isArray(payload) ? payload : [payload as Row]
        const keys = (upsertOptions.onConflict ?? "id")
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean)
        const sameKey = (left: Row, right: Row) => keys.every((key) => (left[key] ?? null) === (right[key] ?? null))
        const toInsert: Row[] = []
        const toMerge: Array<{ row: Row; input: Row }> = []
        for (const input of inputs) {
          const existing = stored.find((row) => sameKey(row, input)) ?? toInsert.find((row) => sameKey(row, input))
          if (existing) {
            if (!upsertOptions.ignoreDuplicates) toMerge.push({ row: existing, input })
            continue
          }
          toInsert.push({ id: nextId(), created_at: NOW, updated_at: NOW, ...input })
        }
        const mergedRows = toMerge.map(({ row, input }) => ({ ...row, ...input }))
        const broken = violation([...toInsert, ...mergedRows])
        if (broken) return checkFailure(broken)
        const touched = new Set(toMerge.map(({ row }) => row))
        const clash = uniqueViolation(
          [...toInsert, ...mergedRows],
          [...stored.filter((row) => !touched.has(row)), ...toInsert, ...mergedRows],
          keys,
        )
        if (clash) return uniqueFailure(clash)
        for (const { row, input } of toMerge) Object.assign(row, input)
        stored.push(...toInsert)
        writes.push({ table, action, payload })
        return respond([...toInsert, ...toMerge.map(({ row }) => row)].map((row) => projectColumns(row, columns)))
      }
      if (action === "delete") {
        const doomed = new Set(stored.filter(matches))
        db[table] = stored.filter((row) => !doomed.has(row))
        writes.push({ table, action, payload: null, matched: doomed.size })
        return respond(columns === null ? [] : [...doomed].map((row) => projectColumns(row, columns)))
      }

      reads.push(table)
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
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1)
      if (max !== null) rows = rows.slice(0, max)
      return respond(rows.map((row) => projectColumns(row, columns)))
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: (cols?: string) => ((columns = cols ?? null), builder),
      insert: (value: Row | Row[]) => ((action = "insert"), (payload = value), builder),
      upsert: (value: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => (
        (action = "upsert"), (payload = value), (upsertOptions = opts ?? {}), builder
      ),
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
      like: (column: string, pattern: string) => (predicates.push((row) => matchesLike(row[column], pattern, "")), builder),
      ilike: (column: string, pattern: string) => (predicates.push((row) => matchesIlike(row[column], pattern)), builder),
      gt: (column: string, value: unknown) => (predicates.push((row) => compareValues(row[column], value) > 0), builder),
      gte: (column: string, value: unknown) => (predicates.push((row) => compareValues(row[column], value) >= 0), builder),
      lt: (column: string, value: unknown) => (predicates.push((row) => compareValues(row[column], value) < 0), builder),
      lte: (column: string, value: unknown) => (predicates.push((row) => compareValues(row[column], value) <= 0), builder),
      or: (expression: string) => {
        orFilters.push(expression)
        predicates.push(parseOr(expression))
        return builder
      },
      order: (column: string, opts?: { ascending?: boolean }) => (orders.push({ column, ascending: opts?.ascending ?? true }), builder),
      limit: (n: number) => ((max = n), builder),
      range: (from: number, to: number) => ((rangeFrom = from), (rangeTo = to), builder),
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
    reads.length = 0
    orFilters.length = 0
    rpcCalls.length = 0
    for (const key of Object.keys(rpcHandlers)) delete rpcHandlers[key]
    for (const key of Object.keys(checks)) delete checks[key]
    for (const key of Object.keys(uniques)) delete uniques[key]
    injected.length = 0
    idSeq = 0
  }

  /** 讓下一次對 `table` 的 `action` 回傳 `error`（一次性，見檔頭）。 */
  function injectError(entry: { table: string; action: "select" | "insert" | "update" | "delete" | "upsert"; error: PgError }) {
    injected.push(entry)
  }

  return { db, writes, reads, orFilters, rpcCalls, rpcHandlers, checks, uniques, injectError, from, rpc, reset }
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
