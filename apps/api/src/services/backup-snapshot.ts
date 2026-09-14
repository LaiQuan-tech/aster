import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { monthRangeKeys } from "../lib/tz.js"
import { writeAuditLog } from "./audit.js"
import { lockSheet } from "./attendance-sheets.js"
import type { SheetStatus } from "./attendance-sheet-types.js"

/**
 * C3 資料快照備份 — 三件事放同一支 service：
 *
 *   [A] 月度全表快照（runSnapshotStep）
 *       把租戶的業務表（SNAPSHOT_TABLES，寫死在本檔）逐表分頁讀出、gzip、上傳
 *       Storage `tenant-snapshots/{tenantId}/{period}/{table}.json.gz`，最後寫
 *       `manifest.json`（每表列數／bytes／sha256、產生時間、schema 版本）。
 *       **全表快照、非增量**；同 period 重跑會先清掉該資料夾再重寫（覆蓋）。
 *       serverless 沒有背景執行緒（Vercel maxDuration 60），所以設計成
 *       「一次呼叫做一小段、回游標、呼叫端續打」：每次呼叫在
 *       SNAPSHOT_STEP_BUDGET_MS 的軟預算內盡量多做幾頁／幾表，超過就把
 *       `nextTable/nextOffset`（跨租戶模式另有 `nextTenantId`）交回去。進度
 *       存在 Storage 上的 manifest（status: running → complete），呼叫端不必
 *       保存任何狀態，只要把 next* 原樣帶回來。
 *
 *   [B] 整公司月結 Final（closePeriod / reopenPeriod / listPeriodCloses）
 *       該月所有在職員工的月表都 approved／locked 才准月結；月結＝把 approved
 *       全部轉 locked（沿用 attendance-sheets.lockSheet）＋寫 period_closes 一列
 *       （unique(tenant, period)，重跑覆蓋）。reopen 只把 period_closes 標成
 *       reopened、留理由，**不解鎖月表**——要改哪張表再走該表自己的 reopen。
 *
 *   [C] 月表快照歷史（listSheetSnapshots）
 *       attendance_sheet_snapshots 的讀取端；寫入端在 attendance-sheets.approveSheet
 *       （每次核准 append 一列，seq 遞增；return／reopen 清 sheets.snapshot 但歷史留著）。
 *
 * 所有查詢走 supabaseAdmin（service_role），每一句都自帶 tenant 過濾。
 */

// ─────────────────────────────────────────────────────────────────────────────
// [A] 月度全表快照
// ─────────────────────────────────────────────────────────────────────────────

export const SNAPSHOT_BUCKET = "tenant-snapshots"
export const SNAPSHOT_PAGE_SIZE = 5000
/**
 * 單次呼叫的軟預算：到了就把游標交回，下一次續。規格要求單次 <20 秒、Vercel
 * maxDuration 60；12 秒留足夠餘裕給「最後一頁＋manifest 上傳」。
 */
export const SNAPSHOT_STEP_BUDGET_MS = 12_000
export const MANIFEST_FILE = "manifest.json"
/** 應用層保留月數（之後手動清；見 README「備份政策」）。 */
export const SNAPSHOT_RETENTION_MONTHS = 24

export interface SnapshotTableSpec {
  name: string
  /** 租戶欄位：預設 tenant_id；tenants 本體用 id。 */
  tenantColumn?: "tenant_id" | "id"
  /** 覆寫每頁列數（audit_logs 的 old_row／new_row jsonb 很肥，頁縮小才守得住預算）。 */
  pageSize?: number
}

/**
 * 要快照的業務表（順序＝重要性：人事／出勤／薪資先做，稽核 log 最後）。
 * 刻意不收：notifications（暫態站內通知）、knowledge_chunks（向量，可由
 * knowledge_documents 重建）、personal_notes（員工私人筆記）、user_preferences
 * （UI 偏好）。表不存在的環境（尚未套 migration）→ 該表記 skipped，不中斷。
 */
export const SNAPSHOT_TABLES: readonly SnapshotTableSpec[] = [
  { name: "tenants", tenantColumn: "id" },
  { name: "employees" },
  { name: "employee_profiles" },
  { name: "employee_job_history" },
  { name: "employee_certifications" },
  { name: "employee_educations" },
  { name: "employee_work_history" },
  { name: "income_tax_dependents" },
  { name: "nhi_dependents" },
  { name: "departments" },
  { name: "shifts" },
  { name: "schedules" },
  { name: "tenant_calendar_days" },
  { name: "punch_records" },
  { name: "attendance_days" },
  { name: "attendance_sheets" },
  { name: "attendance_sheet_days" },
  { name: "attendance_sheet_snapshots" },
  { name: "period_closes" },
  { name: "leave_types" },
  { name: "leave_requests" },
  { name: "request_attachments" },
  { name: "approval_flows" },
  { name: "approval_steps" },
  { name: "leave_balances" },
  { name: "comp_time_ledger" },
  { name: "rule_configs" },
  { name: "salary_structures" },
  { name: "salary_adjustments" },
  { name: "payslips" },
  { name: "non_employee_income" },
  { name: "expense_categories" },
  { name: "expense_settings" },
  { name: "expense_claims" },
  { name: "expense_claim_attachments" },
  { name: "expense_settlements" },
  { name: "advances" },
  { name: "projects" },
  { name: "project_settings" },
  { name: "project_members" },
  { name: "project_share_adjustments" },
  { name: "contracts" },
  { name: "project_billings" },
  { name: "project_subcontracts" },
  { name: "project_subcontract_payments" },
  { name: "project_documents" },
  { name: "clients" },
  { name: "vendors" },
  { name: "companies" },
  { name: "company_pages" },
  { name: "disbursements" },
  { name: "disbursement_allocations" },
  { name: "disbursement_attachments" },
  { name: "announcements" },
  { name: "announcement_versions" },
  { name: "announcement_acknowledgements" },
  { name: "announcement_signature_sheets" },
  { name: "onboardings" },
  { name: "job_requisitions" },
  { name: "candidates" },
  { name: "interviews" },
  { name: "offers" },
  { name: "kpi_templates" },
  { name: "kpi_reviews" },
  { name: "employee_mailboxes" },
  { name: "knowledge_documents" },
  { name: "audit_logs", pageSize: 1000 },
]

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/
const fileNameRe = /^[A-Za-z0-9_.-]+$/

export type BackupErrorCode = "invalid_period" | "unknown_table" | "invalid_offset" | "invalid_file" | "file_not_found"

export class BackupError extends Error {
  readonly code: BackupErrorCode
  readonly httpStatus: number
  readonly details?: Record<string, unknown>
  constructor(code: BackupErrorCode, httpStatus: number, details?: Record<string, unknown>) {
    super(code)
    this.name = "BackupError"
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

export interface SnapshotFileEntry {
  /** 相對於 `{tenantId}/{period}/` 的檔名。 */
  path: string
  rows: number
  bytes: number
  /** gzip 檔本體的 sha256（hex）。 */
  sha256: string
}

export interface SnapshotTableEntry {
  name: string
  rows: number
  bytes: number
  /** 單檔＝該檔 sha256；多檔（分頁）＝各檔 sha256 以 "\n" 串起再 sha256。 */
  sha256: string
  files: SnapshotFileEntry[]
  /** 表開始時 count(*)；之後若列數增加，仍會多寫 part 檔（rows 以實際寫入為準）。 */
  expectedRows: number | null
  pages: number | null
  completedAt: string | null
  /** 該環境沒有這張表（migration 未套）→ 'table_missing'。 */
  skipped?: string
}

export interface SnapshotManifest {
  manifestVersion: 1
  tenantId: string
  period: string
  status: "running" | "complete"
  startedAt: string
  /** 全部表完成的時間；running 時為 null。 */
  generatedAt: string | null
  schemaVersion: { drizzle: string | null; sql: string | null }
  pageSize: number
  tables: SnapshotTableEntry[]
  totals: { tables: number; rows: number; bytes: number }
}

export interface SnapshotStepInput {
  tenantId: string
  period: string
  table?: string
  offset?: number
  /** 跨租戶模式（worker 排程）：本租戶做完自動指向下一個 active 租戶。 */
  allTenants?: boolean
  budgetMs?: number
}

export interface SnapshotStepResult {
  done: boolean
  tenantId: string
  period: string
  /** 本次最後處理到的表。 */
  table: string | null
  rowsWritten: number
  tablesCompleted: number
  elapsedMs: number
  /** 本租戶全部完成時的 manifest 路徑（bucket 內相對路徑）。 */
  manifestPath?: string
  nextTenantId?: string
  nextTable?: string
  nextOffset?: number
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

function storage() {
  return supabaseAdmin.storage.from(SNAPSHOT_BUCKET)
}

function periodPrefix(tenantId: string, period: string): string {
  return `${tenantId}/${period}`
}

export function manifestPathOf(tenantId: string, period: string): string {
  return `${periodPrefix(tenantId, period)}/${MANIFEST_FILE}`
}

let schemaVersionCache: SnapshotManifest["schemaVersion"] | null = null

/**
 * 從 repo 的 drizzle journal／sql 目錄讀「目前程式碼對應的 schema 版本」寫進
 * manifest，還原時才知道這包資料是哪一版的表結構。部署環境（Vercel 函式）
 * 不一定帶著 packages/db → 找不到就記 null，不影響快照本身。
 */
export function resolveSchemaVersion(): SnapshotManifest["schemaVersion"] {
  if (schemaVersionCache) return schemaVersionCache
  const here = dirname(fileURLToPath(import.meta.url))
  const roots = [resolve(here, "../../../.."), process.cwd(), resolve(process.cwd(), "../..")]
  for (const root of roots) {
    try {
      const journal = resolve(root, "packages/db/migrations/meta/_journal.json")
      if (!existsSync(journal)) continue
      const parsed = JSON.parse(readFileSync(journal, "utf8")) as { entries?: Array<{ tag?: string }> }
      const drizzle = parsed.entries?.at(-1)?.tag ?? null
      let sql: string | null = null
      const sqlDir = resolve(root, "packages/db/sql")
      if (existsSync(sqlDir)) {
        sql =
          readdirSync(sqlDir)
            .filter((f) => /^\d{4}_.*\.sql$/.test(f))
            .sort()
            .at(-1)
            ?.replace(/\.sql$/, "") ?? null
      }
      schemaVersionCache = { drizzle, sql }
      return schemaVersionCache
    } catch {
      /* try next root */
    }
  }
  schemaVersionCache = { drizzle: null, sql: null }
  return schemaVersionCache
}

function newManifest(tenantId: string, period: string): SnapshotManifest {
  return {
    manifestVersion: 1,
    tenantId,
    period,
    status: "running",
    startedAt: new Date().toISOString(),
    generatedAt: null,
    schemaVersion: resolveSchemaVersion(),
    pageSize: SNAPSHOT_PAGE_SIZE,
    tables: [],
    totals: { tables: 0, rows: 0, bytes: 0 },
  }
}

function recomputeTotals(manifest: SnapshotManifest): void {
  manifest.totals = {
    tables: manifest.tables.filter((t) => t.completedAt && !t.skipped).length,
    rows: manifest.tables.reduce((s, t) => s + t.rows, 0),
    bytes: manifest.tables.reduce((s, t) => s + t.bytes, 0),
  }
}

export async function readManifest(tenantId: string, period: string): Promise<SnapshotManifest | null> {
  const { data, error } = await storage().download(manifestPathOf(tenantId, period))
  if (error || !data) return null
  try {
    const parsed = JSON.parse(await data.text()) as SnapshotManifest
    if (parsed && parsed.manifestVersion === 1 && Array.isArray(parsed.tables)) return parsed
    return null
  } catch {
    return null
  }
}

async function writeManifest(manifest: SnapshotManifest): Promise<string> {
  recomputeTotals(manifest)
  const path = manifestPathOf(manifest.tenantId, manifest.period)
  const body = Buffer.from(JSON.stringify(manifest, null, 2))
  const { error } = await storage().upload(path, body, { contentType: "application/json", upsert: true })
  if (error) throw new Error(`backup-snapshot (manifest upload ${path}): ${error.message}`)
  return path
}

/** 同 period 重跑＝覆蓋：先把資料夾清空，舊 run 的多餘 part 檔才不會殘留。 */
async function clearPeriodFolder(tenantId: string, period: string): Promise<void> {
  const prefix = periodPrefix(tenantId, period)
  const { data, error } = await storage().list(prefix, { limit: 1000 })
  if (error) throw new Error(`backup-snapshot (list ${prefix}): ${error.message}`)
  const paths = (data ?? []).filter((f) => f.id !== null).map((f) => `${prefix}/${f.name}`)
  if (paths.length === 0) return
  const { error: rmErr } = await storage().remove(paths)
  if (rmErr) throw new Error(`backup-snapshot (clear ${prefix}): ${rmErr.message}`)
}

/** count(*)；表不存在 → null。 */
async function countRows(spec: SnapshotTableSpec, tenantId: string): Promise<number | null> {
  const { count, error } = await supabaseAdmin
    .from(spec.name)
    .select("id", { count: "exact", head: true })
    .eq(spec.tenantColumn ?? "tenant_id", tenantId)
  if (error) {
    if (isMissingTableError(error)) return null
    throw new Error(`backup-snapshot (count ${spec.name}): ${error.message}`)
  }
  return count ?? 0
}

async function fetchPage(spec: SnapshotTableSpec, tenantId: string, offset: number, pageSize: number): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin
    .from(spec.name)
    .select("*")
    .eq(spec.tenantColumn ?? "tenant_id", tenantId)
    .order("id", { ascending: true })
    .range(offset, offset + pageSize - 1)
  if (error) throw new Error(`backup-snapshot (read ${spec.name} @${offset}): ${error.message}`)
  return (data ?? []) as Record<string, unknown>[]
}

interface TableOutcome {
  completed: boolean
  rowsWritten: number
  nextOffset: number
}

/**
 * 一張表從 `startOffset` 開始逐頁寫，直到表完成或預算用完。分頁檔命名在表
 * 開始時依 count(*) 決定：一頁內 → `{table}.json.gz`；多頁 → `{table}.part-0001.json.gz`…。
 */
async function snapshotTable(
  tenantId: string,
  period: string,
  spec: SnapshotTableSpec,
  startOffset: number,
  manifest: SnapshotManifest,
  hasBudget: () => boolean,
): Promise<TableOutcome> {
  const pageSize = spec.pageSize ?? SNAPSHOT_PAGE_SIZE
  const prefix = periodPrefix(tenantId, period)
  let entry = manifest.tables.find((t) => t.name === spec.name)
  if (!entry || startOffset === 0) {
    entry = { name: spec.name, rows: 0, bytes: 0, sha256: "", files: [], expectedRows: null, pages: null, completedAt: null }
    manifest.tables = [...manifest.tables.filter((t) => t.name !== spec.name), entry]
  }
  if (entry.pages == null) {
    const count = await countRows(spec, tenantId)
    if (count === null) {
      entry.skipped = "table_missing"
      entry.completedAt = new Date().toISOString()
      logger.warn({ table: spec.name, tenantId }, "backup-snapshot: table missing in this environment — skipped")
      return { completed: true, rowsWritten: 0, nextOffset: 0 }
    }
    entry.expectedRows = count
    entry.pages = Math.max(1, Math.ceil(count / pageSize))
  }

  let offset = startOffset
  let rowsWritten = 0
  for (;;) {
    const rows = await fetchPage(spec, tenantId, offset, pageSize)
    if (rows.length === 0 && offset > 0) break
    const pageNo = Math.floor(offset / pageSize)
    const fileName = entry.pages === 1 && pageNo === 0 ? `${spec.name}.json.gz` : `${spec.name}.part-${String(pageNo + 1).padStart(4, "0")}.json.gz`
    const gz = gzipSync(Buffer.from(JSON.stringify(rows)))
    const { error } = await storage().upload(`${prefix}/${fileName}`, gz, { contentType: "application/gzip", upsert: true })
    if (error) throw new Error(`backup-snapshot (upload ${prefix}/${fileName}): ${error.message}`)
    const file: SnapshotFileEntry = { path: fileName, rows: rows.length, bytes: gz.length, sha256: sha256(gz) }
    entry.files = [...entry.files.filter((f) => f.path !== fileName), file]
    entry.rows = entry.files.reduce((s, f) => s + f.rows, 0)
    entry.bytes = entry.files.reduce((s, f) => s + f.bytes, 0)
    rowsWritten += rows.length
    offset += pageSize
    if (rows.length < pageSize) break
    if (!hasBudget()) return { completed: false, rowsWritten, nextOffset: offset }
  }
  entry.sha256 = entry.files.length === 1 ? entry.files[0].sha256 : sha256(Buffer.from(entry.files.map((f) => f.sha256).join("\n")))
  entry.completedAt = new Date().toISOString()
  return { completed: true, rowsWritten, nextOffset: 0 }
}

export async function firstActiveTenantId(): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("tenants").select("id").eq("status", "active").order("id", { ascending: true }).limit(1).maybeSingle()
  if (error) throw new Error(`backup-snapshot (first tenant): ${error.message}`)
  return (data?.id as string | undefined) ?? null
}

async function nextActiveTenantId(afterTenantId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("id")
    .eq("status", "active")
    .gt("id", afterTenantId)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`backup-snapshot (next tenant): ${error.message}`)
  return (data?.id as string | undefined) ?? null
}

/**
 * 一次呼叫做一段。從 `table/offset` 開始（省略＝第一張表從頭，並視為新一輪：
 * 清資料夾、重建 manifest），在預算內連續處理；回 `nextTable/nextOffset`
 * 讓呼叫端續打；本租戶全做完 → 寫 complete manifest；`allTenants` 再指向下一個
 * active 租戶（`nextTenantId`）。`done: true` 只在完全沒有下一步時。
 */
export async function runSnapshotStep(input: SnapshotStepInput): Promise<SnapshotStepResult> {
  const started = Date.now()
  const budgetMs = input.budgetMs ?? SNAPSHOT_STEP_BUDGET_MS
  const hasBudget = () => Date.now() - started < budgetMs
  const { tenantId, period } = input
  if (!periodRe.test(period)) throw new BackupError("invalid_period", 400, { period })
  let tableIdx = input.table ? SNAPSHOT_TABLES.findIndex((t) => t.name === input.table) : 0
  if (tableIdx < 0) throw new BackupError("unknown_table", 400, { table: input.table })
  let offset = input.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) throw new BackupError("invalid_offset", 400, { offset })

  const fresh = tableIdx === 0 && offset === 0
  let manifest: SnapshotManifest
  if (fresh) {
    await clearPeriodFolder(tenantId, period)
    manifest = newManifest(tenantId, period)
  } else {
    manifest = (await readManifest(tenantId, period)) ?? newManifest(tenantId, period)
    manifest.status = "running"
  }

  let rowsWritten = 0
  let tablesCompleted = 0
  let lastTable: string | null = null
  const base = () => ({ tenantId, period, table: lastTable, rowsWritten, tablesCompleted, elapsedMs: Date.now() - started })

  while (tableIdx < SNAPSHOT_TABLES.length) {
    const spec = SNAPSHOT_TABLES[tableIdx]
    lastTable = spec.name
    const outcome = await snapshotTable(tenantId, period, spec, offset, manifest, hasBudget)
    rowsWritten += outcome.rowsWritten
    if (!outcome.completed) {
      await writeManifest(manifest)
      return { done: false, ...base(), nextTable: spec.name, nextOffset: outcome.nextOffset }
    }
    tablesCompleted += 1
    tableIdx += 1
    offset = 0
    if (tableIdx < SNAPSHOT_TABLES.length && !hasBudget()) {
      await writeManifest(manifest)
      return { done: false, ...base(), nextTable: SNAPSHOT_TABLES[tableIdx].name, nextOffset: 0 }
    }
  }

  manifest.status = "complete"
  manifest.generatedAt = new Date().toISOString()
  const manifestPath = await writeManifest(manifest)
  logger.info(
    { tenantId, period, tables: manifest.totals.tables, rows: manifest.totals.rows, bytes: manifest.totals.bytes },
    "backup-snapshot: tenant snapshot complete",
  )

  if (input.allTenants) {
    const next = await nextActiveTenantId(tenantId)
    if (next) return { done: false, ...base(), manifestPath, nextTenantId: next, nextTable: SNAPSHOT_TABLES[0].name, nextOffset: 0 }
  }
  return { done: true, ...base(), manifestPath }
}

// ── 後台讀取端 ────────────────────────────────────────────────────────────────

export interface SnapshotStoredFile {
  name: string
  size: number
  updatedAt: string | null
}

export interface SnapshotPeriodSummary {
  period: string
  manifest: SnapshotManifest | null
  files: SnapshotStoredFile[]
}

async function listPeriodFiles(tenantId: string, period: string): Promise<SnapshotStoredFile[]> {
  const { data, error } = await storage().list(periodPrefix(tenantId, period), { limit: 1000, sortBy: { column: "name", order: "asc" } })
  if (error) throw new Error(`backup-snapshot (list files ${period}): ${error.message}`)
  return (data ?? [])
    .filter((f) => f.id !== null)
    .map((f) => ({ name: f.name, size: f.metadata?.size ?? 0, updatedAt: f.updated_at ?? null }))
}

/** 租戶底下所有 period 資料夾（新到舊）＋各自的 manifest 與檔案清單。 */
export async function listSnapshotPeriods(tenantId: string): Promise<SnapshotPeriodSummary[]> {
  const { data, error } = await storage().list(tenantId, { limit: 500, sortBy: { column: "name", order: "desc" } })
  if (error) throw new Error(`backup-snapshot (list periods): ${error.message}`)
  const periods = (data ?? []).filter((e) => e.id === null && periodRe.test(e.name)).map((e) => e.name)
  const out: SnapshotPeriodSummary[] = []
  for (const period of periods) {
    const [manifest, files] = await Promise.all([readManifest(tenantId, period), listPeriodFiles(tenantId, period)])
    out.push({ period, manifest, files })
  }
  return out
}

/** 短效 signed URL（預設 15 分鐘）；檔名只准 `[A-Za-z0-9_.-]`，不接受路徑。 */
export async function signedSnapshotUrl(tenantId: string, period: string, fileName: string, expiresIn = 900): Promise<string> {
  if (!periodRe.test(period)) throw new BackupError("invalid_period", 400, { period })
  if (!fileNameRe.test(fileName)) throw new BackupError("invalid_file", 400, { file: fileName })
  const path = `${periodPrefix(tenantId, period)}/${fileName}`
  const { data, error } = await storage().createSignedUrl(path, expiresIn, { download: fileName })
  if (error || !data?.signedUrl) throw new BackupError("file_not_found", 404, { file: fileName })
  return data.signedUrl
}

// ─────────────────────────────────────────────────────────────────────────────
// [B] 整公司月結 Final（period_closes）
// ─────────────────────────────────────────────────────────────────────────────

export type PeriodCloseErrorCode = "invalid_period" | "sheets_not_approved" | "period_not_closed" | "period_closes_not_migrated"

export class PeriodCloseError extends Error {
  readonly code: PeriodCloseErrorCode
  readonly httpStatus: number
  readonly details?: Record<string, unknown>
  constructor(code: PeriodCloseErrorCode, httpStatus: number, details?: Record<string, unknown>) {
    super(code)
    this.name = "PeriodCloseError"
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

export interface PeriodCloseRow {
  id: string
  tenant_id: string
  period: string
  status: "closed" | "reopened"
  closed_at: string
  closed_by_emp_id: string | null
  sheet_count: number
  locked_count: number
  snapshot_manifest_path: string | null
  note: string | null
  created_at: string
  updated_at: string
}

const PERIOD_CLOSE_COLS = "id, tenant_id, period, status, closed_at, closed_by_emp_id, sheet_count, locked_count, snapshot_manifest_path, note, created_at, updated_at"

export interface NotReadySheet {
  employeeId: string
  employeeName: string
  sheetId: string | null
  /** 月表目前狀態；'missing' ＝ 在職但這個月連月表都還沒產生。 */
  status: SheetStatus | "missing"
}

export interface ClosePeriodResult {
  periodClose: PeriodCloseRow
  /** 本次由 approved 轉 locked 的張數。 */
  lockedNow: number
  /** force 模式下被略過（未核准）的月表；一般模式永遠是空陣列。 */
  skipped: NotReadySheet[]
}

function wrapPeriodCloseDbError(scope: string, err: { code?: string | null; message?: string | null }): Error {
  if (isMissingTableError(err)) return new PeriodCloseError("period_closes_not_migrated", 503)
  return new Error(`${scope}: ${err.message ?? "unknown error"}`)
}

interface EmployeeLite {
  id: string
  name: string
  status: string
  hire_date: string | null
  terminated_at: string | null
}

/** 該月份在職的員工（同 attendance-sheets.generateSheets 的判準）。 */
async function employedInPeriod(tenantId: string, period: string): Promise<EmployeeLite[]> {
  const { from, to } = monthRangeKeys(period)
  const { data, error } = await supabaseAdmin.from("employees").select("id, name, status, hire_date, terminated_at").eq("tenant_id", tenantId)
  if (error) throw new Error(`closePeriod (employees): ${error.message}`)
  return ((data ?? []) as EmployeeLite[]).filter((e) => {
    const employed = e.status === "active" || (e.terminated_at != null && e.terminated_at >= from)
    const hired = e.hire_date == null || e.hire_date <= to
    return employed && hired
  })
}

/**
 * closePeriod — 整公司月結 Final。
 *   1. 該月在職員工每人都要有月表且 approved／locked；否則 409 sheets_not_approved
 *      附清單（含 'missing'）。`force: true` 略過未核准的，只鎖已核准的。
 *   2. approved → locked（lockSheet：會通知員工）。
 *   3. upsert period_closes（status closed、sheet_count／locked_count、
 *      snapshot_manifest_path＝該月已有的快照 manifest 路徑，否則 null）。
 * 重跑冪等：已 locked 的不動，period_closes 覆蓋成最新一次的數字。
 */
export async function closePeriod(
  tenantId: string,
  period: string,
  actorEmpId: string,
  opts: { force?: boolean } = {},
): Promise<ClosePeriodResult> {
  if (!periodRe.test(period)) throw new PeriodCloseError("invalid_period", 400, { period })
  const employees = await employedInPeriod(tenantId, period)
  const { data: sheetData, error: sheetErr } = await supabaseAdmin
    .from("attendance_sheets")
    .select("id, employee_id, status")
    .eq("tenant_id", tenantId)
    .eq("period", period)
  if (sheetErr) throw new Error(`closePeriod (sheets): ${sheetErr.message}`)
  const sheets = (sheetData ?? []) as Array<{ id: string; employee_id: string; status: SheetStatus }>
  const sheetByEmp = new Map(sheets.map((s) => [s.employee_id, s]))
  const nameByEmp = new Map(employees.map((e) => [e.id, e.name]))

  const notReady: NotReadySheet[] = []
  for (const e of employees) {
    const s = sheetByEmp.get(e.id)
    if (!s) notReady.push({ employeeId: e.id, employeeName: e.name, sheetId: null, status: "missing" })
    else if (s.status !== "approved" && s.status !== "locked") notReady.push({ employeeId: e.id, employeeName: e.name, sheetId: s.id, status: s.status })
  }
  // 月份內有月表但已不在在職判準內（例如離職日在月初前才補的表）：一樣要核准才鎖。
  for (const s of sheets) {
    if (nameByEmp.has(s.employee_id)) continue
    if (s.status !== "approved" && s.status !== "locked") notReady.push({ employeeId: s.employee_id, employeeName: "（非在職）", sheetId: s.id, status: s.status })
  }
  if (notReady.length > 0 && !opts.force) throw new PeriodCloseError("sheets_not_approved", 409, { period, sheets: notReady })

  let lockedNow = 0
  for (const s of sheets) {
    if (s.status !== "approved") continue
    await lockSheet(tenantId, s.id)
    lockedNow += 1
  }
  const lockedCount = sheets.filter((s) => s.status === "locked").length + lockedNow

  const manifest = await readManifest(tenantId, period).catch(() => null)
  const now = new Date().toISOString()
  const note =
    opts.force && notReady.length > 0
      ? `強制月結：${notReady.length} 張未核准未鎖定（${notReady.map((n) => `${n.employeeName}:${n.status}`).join("、")}）`
      : null
  const { data: row, error: upErr } = await supabaseAdmin
    .from("period_closes")
    .upsert(
      {
        tenant_id: tenantId,
        period,
        status: "closed",
        closed_at: now,
        closed_by_emp_id: actorEmpId,
        sheet_count: sheets.length,
        locked_count: lockedCount,
        snapshot_manifest_path: manifest ? manifestPathOf(tenantId, period) : null,
        note,
      },
      { onConflict: "tenant_id,period" },
    )
    .select(PERIOD_CLOSE_COLS)
    .single()
  if (upErr || !row) throw wrapPeriodCloseDbError("closePeriod (period_closes upsert)", upErr ?? { message: "no row" })
  const periodClose = row as unknown as PeriodCloseRow
  await writeAuditLog({
    tenantId,
    tableName: "period_closes",
    recordId: periodClose.id,
    action: "UPDATE",
    newRow: { ...periodClose, lockedNow, skipped: opts.force ? notReady : [] },
    actorEmpId,
    context: "attendance-sheets/close-period",
  })
  return { periodClose, lockedNow, skipped: opts.force ? notReady : [] }
}

/** reopenPeriod — 只把月結標成 reopened 並留理由；月表不解鎖。沒月結過 → 404 period_not_closed。 */
export async function reopenPeriod(tenantId: string, period: string, actorEmpId: string, reason: string): Promise<PeriodCloseRow> {
  if (!periodRe.test(period)) throw new PeriodCloseError("invalid_period", 400, { period })
  const { data: existing, error: getErr } = await supabaseAdmin
    .from("period_closes")
    .select(PERIOD_CLOSE_COLS)
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .maybeSingle()
  if (getErr) throw wrapPeriodCloseDbError("reopenPeriod (get)", getErr)
  if (!existing) throw new PeriodCloseError("period_not_closed", 404, { period })
  const { data: row, error } = await supabaseAdmin
    .from("period_closes")
    .update({ status: "reopened", note: reason })
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .select(PERIOD_CLOSE_COLS)
    .single()
  if (error || !row) throw wrapPeriodCloseDbError("reopenPeriod (update)", error ?? { message: "no row" })
  const periodClose = row as unknown as PeriodCloseRow
  await writeAuditLog({
    tenantId,
    tableName: "period_closes",
    recordId: periodClose.id,
    action: "UPDATE",
    oldRow: existing,
    newRow: periodClose,
    actorEmpId,
    context: "attendance-sheets/reopen-period",
  })
  return periodClose
}

export interface PeriodCloseView {
  id: string
  period: string
  status: "closed" | "reopened"
  closedAt: string
  closedByEmpId: string | null
  closedByName: string | null
  sheetCount: number
  lockedCount: number
  snapshotManifestPath: string | null
  note: string | null
  updatedAt: string
}

async function employeeNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return new Map()
  const { data } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", unique)
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]))
}

export async function listPeriodCloses(tenantId: string, period?: string): Promise<PeriodCloseView[]> {
  let q = supabaseAdmin.from("period_closes").select(PERIOD_CLOSE_COLS).eq("tenant_id", tenantId).order("period", { ascending: false })
  if (period) q = q.eq("period", period)
  const { data, error } = await q
  if (error) throw wrapPeriodCloseDbError("listPeriodCloses", error)
  const rows = (data ?? []) as unknown as PeriodCloseRow[]
  const names = await employeeNames(
    tenantId,
    rows.map((r) => r.closed_by_emp_id).filter((v): v is string => !!v),
  )
  return rows.map((r) => ({
    id: r.id,
    period: r.period,
    status: r.status,
    closedAt: r.closed_at,
    closedByEmpId: r.closed_by_emp_id,
    closedByName: r.closed_by_emp_id ? (names.get(r.closed_by_emp_id) ?? null) : null,
    sheetCount: r.sheet_count,
    lockedCount: r.locked_count,
    snapshotManifestPath: r.snapshot_manifest_path,
    note: r.note,
    updatedAt: r.updated_at,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// [C] 月表快照歷史（attendance_sheet_snapshots 讀取端）
// ─────────────────────────────────────────────────────────────────────────────

export interface SheetSnapshotView {
  id: string
  sheetId: string
  employeeId: string
  period: string
  seq: number
  takenAt: string
  takenByEmpId: string | null
  takenByName: string | null
  reason: string | null
  ruleConfigVersion: number | null
  /** 快照內的月度加總與薪資試算淨額（列表用；完整快照要 `full`）。 */
  totals: unknown
  net: number | null
  snapshot?: unknown
}

export async function listSheetSnapshots(tenantId: string, sheetId: string, opts: { full?: boolean } = {}): Promise<SheetSnapshotView[]> {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheet_snapshots")
    .select("id, sheet_id, employee_id, period, seq, taken_at, taken_by_emp_id, reason, rule_config_version, snapshot")
    .eq("tenant_id", tenantId)
    .eq("sheet_id", sheetId)
    .order("seq", { ascending: true })
  if (error) {
    if (isMissingTableError(error)) return []
    throw new Error(`listSheetSnapshots: ${error.message}`)
  }
  type Row = {
    id: string
    sheet_id: string
    employee_id: string
    period: string
    seq: number
    taken_at: string
    taken_by_emp_id: string | null
    reason: string | null
    rule_config_version: number | null
    snapshot: { totals?: unknown; money?: { net?: number } | null } | null
  }
  const rows = (data ?? []) as Row[]
  const names = await employeeNames(
    tenantId,
    rows.map((r) => r.taken_by_emp_id).filter((v): v is string => !!v),
  )
  return rows.map((r) => ({
    id: r.id,
    sheetId: r.sheet_id,
    employeeId: r.employee_id,
    period: r.period,
    seq: r.seq,
    takenAt: r.taken_at,
    takenByEmpId: r.taken_by_emp_id,
    takenByName: r.taken_by_emp_id ? (names.get(r.taken_by_emp_id) ?? null) : null,
    reason: r.reason,
    ruleConfigVersion: r.rule_config_version,
    totals: r.snapshot?.totals ?? null,
    net: typeof r.snapshot?.money?.net === "number" ? r.snapshot.money.net : null,
    ...(opts.full ? { snapshot: r.snapshot } : {}),
  }))
}
