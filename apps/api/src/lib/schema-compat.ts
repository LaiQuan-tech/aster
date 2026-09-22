import { logger } from "./logger.js"

/**
 * Schema-compatibility helpers for the P0 attendance columns/tables added by
 * packages/db migration 0038 (`tenants.timezone`, `tenant_calendar_days`,
 * `leave_types.deduct_rate`, `punch_records.request_id`,
 * `attendance_days.leave_minutes / leave_breakdown / outing_minutes /
 * early_leave_minutes`).
 *
 * Deploy order in this repo is "migration first, then code" (see memory:
 * PostgREST 500s when code selects a column the live DB lacks). Because the
 * API can ship before an operator applies 0038, every P0 read/write is
 * written to *degrade* when the column/table is missing — fall back to the
 * pre-P0 behaviour, log once, and carry on — instead of failing the whole
 * settlement / approval. Once 0038 is applied the fallbacks are never taken.
 *
 * PostgREST error codes:
 *   42703   Postgres "column does not exist" (select / filter on a column)
 *   PGRST204 "Could not find the '<col>' column of '<table>' in the schema
 *            cache" (insert / upsert payload has an unknown column)
 *   PGRST205 "Could not find the table" (whole table missing)
 *   42P01   Postgres "relation does not exist"
 */

export interface PgErrorLike {
  code?: string | null
  message?: string | null
}

export function isMissingColumnError(err: PgErrorLike | null | undefined): boolean {
  if (!err) return false
  return err.code === "42703" || err.code === "PGRST204"
}

export function isMissingTableError(err: PgErrorLike | null | undefined): boolean {
  if (!err) return false
  return err.code === "PGRST205" || err.code === "42P01"
}

const warned = new Set<string>()

/** Log a schema-gap warning once per process per feature key. */
export function warnSchemaGapOnce(key: string, err: PgErrorLike | null | undefined): void {
  if (warned.has(key)) return
  warned.add(key)
  logger.warn(
    { key, code: err?.code ?? null, message: err?.message ?? null },
    "schema not applied yet (packages/db migration 0038 / 0049) — degrading to pre-migration behaviour",
  )
}

/* ── 欄位探測（多級簽核 migration 0049）──────────────────────────────
 * 上面的 try/fallback 寫法每個查詢點都要寫兩份 query；多級簽核有十幾個讀寫點
 * （departments.manager_emp_ids、approval_steps.candidate_emp_ids／step_kind），
 * 改成「探測一次、之後分支」：第一次呼叫打一次 `select <cols> limit 1`，
 * 「有」永久快取；「沒有」只快取 60 秒——遷移套完不必重啟 API 就會自動切到
 * 新行為。探測本身出錯（非 42703／PGRST204，例如連線失敗）視為「有」，
 * 讓後面真正的查詢把原始錯誤丟出來，不要在這裡吞掉。
 */

const NEGATIVE_TTL_MS = 60_000
const probeCache = new Map<string, { exists: boolean; at: number }>()
const probeInflight = new Map<string, Promise<boolean>>()

/**
 * 某表是否已有這些欄位（逗號分隔，一次探測）。呼叫端用它決定 select／insert
 * 要不要帶新欄位、filter 要用 `.or(...cs.{})` 還是退回 `.eq()`。
 */
export async function columnsExist(table: string, columns: string): Promise<boolean> {
  const key = `${table}.${columns}`
  const cached = probeCache.get(key)
  if (cached && (cached.exists || Date.now() - cached.at < NEGATIVE_TTL_MS)) return cached.exists
  let inflight = probeInflight.get(key)
  if (!inflight) {
    inflight = (async () => {
      // 延遲載入：schema-compat 是 lib 底層，避免與 lib/supabase 形成載入環。
      const { supabaseAdmin } = await import("./supabase.js")
      const { error } = await supabaseAdmin.from(table).select(columns).limit(1)
      const exists = !error || !isMissingColumnError(error)
      if (!exists) warnSchemaGapOnce(key, error)
      probeCache.set(key, { exists, at: Date.now() })
      return exists
    })().finally(() => probeInflight.delete(key))
    probeInflight.set(key, inflight)
  }
  return inflight
}

/** 測試用：清掉探測快取（例如同一程序內先後模擬「未套」與「已套」）。 */
export function resetColumnProbeCache(): void {
  probeCache.clear()
}

/** departments.manager_emp_ids（migration 0049）是否已在。 */
export function departmentsHaveManagerList(): Promise<boolean> {
  return columnsExist("departments", "manager_emp_ids")
}

/** approval_steps.candidate_emp_ids ＋ step_kind（migration 0049）是否已在。 */
export function approvalStepsHaveCandidates(): Promise<boolean> {
  return columnsExist("approval_steps", "candidate_emp_ids, step_kind")
}
