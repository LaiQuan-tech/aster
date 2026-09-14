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
    "P0 schema not applied (packages/db migration 0038) — degrading to pre-P0 behaviour",
  )
}
