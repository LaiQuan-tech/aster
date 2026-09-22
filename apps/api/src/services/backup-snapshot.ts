import { createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
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
 *       Storage `tenant-snapshots/{tenantId}/{period}/r{run:03}/{table}.json.gz`，最後
 *       寫同資料夾的 `manifest.json`（每表列數／bytes／sha256、產生時間、schema 版本）。
 *       **全表快照、非增量**；W7（2026-09-23）起**同 period 重跑不覆蓋**：每次新一輪
 *       配一個新的 run 序號（`allocateRun`＝現有最大值＋1），各自一個資料夾，保留
 *       84 個月。2026-09-23 之前的舊快照檔案直接躺在 `{period}/` 下，一律當 run 0：
 *       讀得到、列得出來，但不再往裡面寫。
 *       每頁最多 1000 列（PostgREST max-rows），翻頁以表開始時的 count(*) 為完整性
 *       判準：寫出列數少於它 → 該表與整份 manifest 標 incomplete，不寫 complete。
 *       serverless 沒有背景執行緒（Vercel maxDuration 60），所以設計成
 *       「一次呼叫做一小段、回游標、呼叫端續打」：每次呼叫在
 *       SNAPSHOT_STEP_BUDGET_MS 的軟預算內盡量多做幾頁／幾表，超過就把
 *       `nextRun/nextTable/nextOffset`（跨租戶模式另有 `nextTenantId`）交回去。進度
 *       存在 Storage 上的 manifest（status: running → complete），呼叫端不必
 *       保存任何狀態，只要把 next* 原樣帶回來（`run` 尤其要帶，否則續打會找不到
 *       這一輪的資料夾）。
 *
 *       另有 [D] M9 備份內容瀏覽（readSnapshotRows／planRowSlice）：後台可直接翻
 *       某次快照裡某張表的列，不必下載 .json.gz 自己解壓。
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
/**
 * 每頁列數上限＝PostgREST 的 max-rows（Supabase 預設 1000）。以前設 5000：
 * `.range(0, 4999)` 被 PostgREST 靜默截到 1000 列，`rows.length < pageSize`
 * 被當成「到底了」→ 第 1001 列起不備份、manifest 仍寫 complete（C3 驗收抓到）。
 * 表級 pageSize 覆寫只能往下調，不能超過這個上限。
 */
export const SNAPSHOT_MAX_PAGE_SIZE = 1000
export const SNAPSHOT_PAGE_SIZE = SNAPSHOT_MAX_PAGE_SIZE
/**
 * 單次呼叫的軟預算：到了就把游標交回，下一次續。規格要求單次 <20 秒、Vercel
 * maxDuration 60；12 秒留足夠餘裕給「最後一頁＋manifest 上傳」。
 */
export const SNAPSHOT_STEP_BUDGET_MS = 12_000
/**
 * 單次呼叫的硬上限（Vercel maxDuration 60 留 10 秒餘裕）：完成後「等 CDN 追上」的
 * 回讀只能用到這個上限以內的剩餘時間。
 */
export const SNAPSHOT_STEP_HARD_LIMIT_MS = 50_000
/** 續打時回讀 manifest 最多等 CDN 多久（實測失效延遲 16～34 秒）。 */
export const MANIFEST_FRESH_WAIT_RESUME_MS = 40_000
/** 後台清單回讀 manifest 最多等多久；超時就回舊版並標 manifestStale。 */
export const MANIFEST_FRESH_WAIT_LIST_MS = 8_000
export const MANIFEST_FILE = "manifest.json"
/**
 * 應用層保留月數（之後手動清；見 README「備份政策」）。
 * W7（2026-09-23 需求補齊）：客戶要「不覆蓋、5–7 年」→ 7 年＝84 個月。
 */
export const SNAPSHOT_RETENTION_MONTHS = 84
/**
 * 單一資料檔（gz）可供「後台瀏覽列內容」下載的大小上限；超過就回 413 too_large，
 * 請改用下載連結自行解壓。瀏覽是分頁讀，但每頁都要把整個 gz 抓下來解壓，
 * 太大的檔在 serverless 上會吃光記憶體與時間。
 */
export const SNAPSHOT_ROWS_MAX_FILE_BYTES = 20 * 1024 * 1024
/** 瀏覽列內容單頁上限。 */
export const SNAPSHOT_ROWS_MAX_LIMIT = 200

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
  { name: "bonus_runs" },
  { name: "bonus_run_items" },
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
/** run 資料夾名：`r001`…`r999`。run 0 ＝ 舊版（檔案直接落在 `{period}/`），沒有資料夾。 */
const runFolderRe = /^r(\d{3})$/

export type BackupErrorCode =
  | "invalid_period"
  | "unknown_table"
  | "invalid_offset"
  | "invalid_file"
  | "file_not_found"
  | "manifest_stale"
  | "invalid_run"
  | "run_not_found"
  | "too_large"

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
  /**
   * 表開始時 count(*)。翻頁以它為完整性判準：短頁但還沒蓋到 expectedRows 就繼續翻
   * （PostgREST max-rows 截頁時才會發生）；完成時 rows < expectedRows → incomplete。
   * 之後若列數增加（id 是隨機 uuid，翻頁中插入會讓邊界列被讀兩次），rows 可能大於
   * expectedRows，那是「多」不是「漏」，仍算 complete。
   */
  expectedRows: number | null
  /** 開始時預估頁數；完成後改成實際寫出的檔數。 */
  pages: number | null
  completedAt: string | null
  /** 該環境沒有這張表（migration 未套）→ 'table_missing'。 */
  skipped?: string
  /** 完成時 rows < expectedRows（有列沒備到）→ true；整份 manifest 連帶 status='incomplete'。 */
  incomplete?: boolean
}

export interface SnapshotManifest {
  manifestVersion: 1
  tenantId: string
  period: string
  /**
   * 這個月份的第幾次執行（W7）：1 起跳，每次「重新開跑」配一個新號、寫進
   * `{tenantId}/{period}/r{seq:03}/`，同月不再互相覆蓋。舊資料（檔案直接落在
   * `{period}/` 下）沒有這個欄位，一律當 run 0。
   */
  run?: number
  /**
   * running → 進行中；complete → 每張表 rows ≥ expectedRows；
   * incomplete → 至少一張表 rows < expectedRows（見 incompleteTables），不可當完整備份用。
   */
  status: "running" | "complete" | "incomplete"
  startedAt: string
  /** 全部表完成的時間；running 時為 null。 */
  generatedAt: string | null
  schemaVersion: { drizzle: string | null; sql: string | null }
  pageSize: number
  tables: SnapshotTableEntry[]
  totals: { tables: number; rows: number; bytes: number }
  /** rows < expectedRows 的表名；空陣列＝全部完整。舊 manifest 沒有這個欄位。 */
  incompleteTables?: string[]
}

export interface SnapshotStepInput {
  tenantId: string
  period: string
  table?: string
  offset?: number
  /**
   * 續打時把上一段回的 `run` 原樣帶回來（同一次執行要寫進同一個 r 資料夾）。
   * 新一輪（沒帶 table／offset）一律忽略這個值、另配新號——同月重跑不覆蓋。
   */
  run?: number
  /** 跨租戶模式（worker 排程）：本租戶做完自動指向下一個 active 租戶。 */
  allTenants?: boolean
  budgetMs?: number
}

export interface SnapshotStepResult {
  done: boolean
  tenantId: string
  period: string
  /** 這一段寫進哪一次執行（`{period}/r{run:03}/`）。續打要原樣帶回來。 */
  run: number
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
  /**
   * 續打時要帶回來的 run。指向下一個租戶（`nextTenantId`）時不回——那是新一輪，
   * 由 service 自己配號。
   */
  nextRun?: number
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

function storage() {
  return supabaseAdmin.storage.from(SNAPSHOT_BUCKET)
}

/** `1` → `r001`。 */
export function runFolder(run: number): string {
  return `r${String(Math.trunc(run)).padStart(3, "0")}`
}

/**
 * 一次執行的資料夾（W7）：run ≥ 1 → `{tenantId}/{period}/r{run:03}`；
 * run 0 ＝ 2026-09-23 之前的舊快照，檔案直接落在 `{tenantId}/{period}`（不搬、可讀不可寫）。
 */
function periodPrefix(tenantId: string, period: string, run: number): string {
  return run > 0 ? `${tenantId}/${period}/${runFolder(run)}` : `${tenantId}/${period}`
}

export function manifestPathOf(tenantId: string, period: string, run: number): string {
  return `${periodPrefix(tenantId, period, run)}/${MANIFEST_FILE}`
}

function assertPeriod(period: string): void {
  if (!periodRe.test(period)) throw new BackupError("invalid_period", 400, { period })
}

function assertRun(run: number): void {
  if (!Number.isInteger(run) || run < 0 || run > 999) throw new BackupError("invalid_run", 400, { run })
}

/**
 * 這個 period 底下已有的 run 序號（大到小）。0 代表「舊版快照」——`{period}/` 底下
 * 直接躺著檔案（manifest.json／*.json.gz），那是 2026-09-23 之前的產物。
 */
export async function listRuns(tenantId: string, period: string): Promise<number[]> {
  assertPeriod(period)
  const { data, error } = await storage().list(`${tenantId}/${period}`, { limit: 1000, sortBy: { column: "name", order: "asc" } })
  if (error) throw new Error(`backup-snapshot (list runs ${period}): ${error.message}`)
  const entries = data ?? []
  const runs = entries
    .filter((e) => e.id === null && runFolderRe.test(e.name))
    .map((e) => Number(runFolderRe.exec(e.name)![1]))
  // 舊版：資料夾裡直接有檔案（id 非 null）→ 視為 run 0。
  if (entries.some((e) => e.id !== null)) runs.push(0)
  return [...new Set(runs)].sort((a, b) => b - a)
}

/** 最新一次執行的序號；完全沒有快照 → null。 */
export async function latestRun(tenantId: string, period: string): Promise<number | null> {
  const runs = await listRuns(tenantId, period)
  return runs.length > 0 ? runs[0] : null
}

/**
 * 配一個新的 run 序號＝現有最大值＋1（沒有任何快照 → 1）。同月重跑一定落在新
 * 資料夾，既有那份原封不動（W7：不覆蓋、保留 7 年）。
 */
export async function allocateRun(tenantId: string, period: string): Promise<number> {
  const runs = await listRuns(tenantId, period)
  const max = runs.length > 0 ? Math.max(...runs) : 0
  const next = max + 1
  if (next > 999) throw new BackupError("invalid_run", 409, { period, run: next })
  return next
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

function newManifest(tenantId: string, period: string, run: number): SnapshotManifest {
  return {
    manifestVersion: 1,
    tenantId,
    period,
    run,
    status: "running",
    startedAt: new Date().toISOString(),
    generatedAt: null,
    schemaVersion: resolveSchemaVersion(),
    pageSize: SNAPSHOT_PAGE_SIZE,
    tables: [],
    totals: { tables: 0, rows: 0, bytes: 0 },
    incompleteTables: [],
  }
}

function recomputeTotals(manifest: SnapshotManifest): void {
  manifest.totals = {
    tables: manifest.tables.filter((t) => t.completedAt && !t.skipped).length,
    rows: manifest.tables.reduce((s, t) => s + t.rows, 0),
    bytes: manifest.tables.reduce((s, t) => s + t.bytes, 0),
  }
  manifest.incompleteTables = manifest.tables.filter((t) => t.incomplete).map((t) => t.name)
}

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex")
}

function parseManifest(buf: Buffer): SnapshotManifest | null {
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as SnapshotManifest
    if (parsed && parsed.manifestVersion === 1 && Array.isArray(parsed.tables)) return parsed
    return null
  } catch {
    return null
  }
}

/**
 * 物件目前的 ETag（單段上傳＝內容 md5），走 Storage 的 list()——那是查 DB 的
 * storage.objects，不經 CDN，永遠是最新。物件不存在 → null；multipart 的
 * ETag 不是純 md5（帶 -N）→ 回 null 代表無法比對。
 */
async function objectContentMd5(prefix: string, name: string): Promise<string | null | undefined> {
  const { data, error } = await storage().list(prefix, { limit: 1000, search: name })
  if (error) throw new Error(`backup-snapshot (list ${prefix}/${name}): ${error.message}`)
  const f = (data ?? []).find((x) => x.name === name && x.id !== null)
  if (!f) return null
  const raw = (f.metadata as { eTag?: string } | null | undefined)?.eTag
  const cleaned = raw ? raw.replace(/^W\//, "").replace(/"/g, "") : ""
  return /^[0-9a-f]{32}$/.test(cleaned) ? cleaned : undefined
}

/**
 * 讀一個 Storage 物件的**原始內容**，盡量繞過 CDN 快取。
 *
 * 背景：Supabase Storage 的下載走 Cloudflare（`cache-control: public, max-age=3600`），
 * 同路徑覆寫後失效會慢十幾到數十秒，`storage().download()` 這段時間拿到的是上一版。
 * 續打快照時讀到舊 manifest ＝ 把這一輪前面幾張表的紀錄蓋掉，所以原本的做法是
 * 「用 list() 的 ETag 核對＋每 2 秒重讀、最多等 40 秒」，等不到就 503。實測（尤其多條
 * live 測試同時打同一個專案時）會超過 40 秒 → 月度備份整輪失敗。
 *
 * 這裡改成直接打 Storage 的 REST 端點並加一個每次都不同的查詢參數：CDN 以完整 URL
 * 為快取鍵，帶著沒看過的參數必定回源，拿到的就是最新內容。查詢參數不參與
 * `/object/authenticated/` 的授權（授權在 Authorization header），所以加它是安全的。
 * 任何非預期的回應（端點形狀變了、env 沒設）都退回 `storage().download()`，行為與以前相同。
 */
async function downloadObject(path: string, opts: { bustCache?: boolean } = {}): Promise<Buffer | null> {
  if (opts.bustCache) {
    const base = process.env.SUPABASE_URL ?? ""
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
    if (base && key) {
      const encoded = path.split("/").map(encodeURIComponent).join("/")
      const url = `${base.replace(/\/$/, "")}/storage/v1/object/authenticated/${SNAPSHOT_BUCKET}/${encoded}?cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, apikey: key, "cache-control": "no-cache" },
        })
        if (res.ok) return Buffer.from(await res.arrayBuffer())
        if (res.status === 404) return null
        logger.warn({ path, status: res.status }, "backup-snapshot: cache-busted object read failed — falling back to storage().download()")
      } catch (err) {
        logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, "backup-snapshot: cache-busted object read threw — falling back")
      }
    }
  }
  const { data, error } = await storage().download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

export interface ReadManifestOptions {
  /**
   * 最多等多久讓 CDN 追上（毫秒）。Supabase Storage 的 `/object/` 下載走 Cloudflare
   * 快取（cache-control: public, max-age=3600）；同路徑覆寫後，若該物件先前被 signed
   * URL 抓過，快取失效會慢 16～34 秒（2026-09-15 實測，先刪再寫也一樣）。這段時間
   * download() 會拿到上一版。這裡用 list() 的 ETag（查 DB、不經 CDN）核對下載內容的
   * md5，不一致就每 2 秒重讀，直到一致或超時。0 ＝ 只讀一次。
   */
  freshWaitMs?: number
  /** 超時仍不一致時：'throw' 丟 BackupError manifest_stale（503）；'stale' 照回舊版（預設）。 */
  onStale?: "throw" | "stale"
}

export interface ReadManifestResult {
  manifest: SnapshotManifest | null
  /** true ＝ 超時仍是舊版（download 內容 md5 ≠ list() 的 ETag）。 */
  stale: boolean
}

/**
 * 讀 manifest.json 並核對它是不是最新版（見 ReadManifestOptions）。沒有 manifest → null。
 * 續打／完成後的回讀一定要用有 freshWaitMs 的版本：拿到上一輪的舊 manifest 接著寫，
 * 等於把這一輪前面幾張表的紀錄蓋掉。
 */
export async function readManifestChecked(
  tenantId: string,
  period: string,
  run: number,
  opts: ReadManifestOptions = {},
): Promise<ReadManifestResult> {
  const prefix = periodPrefix(tenantId, period, run)
  const path = manifestPathOf(tenantId, period, run)
  const deadline = Date.now() + (opts.freshWaitMs ?? 0)
  let lastStale: SnapshotManifest | null = null
  for (let attempt = 1; ; attempt++) {
    const expected = await objectContentMd5(prefix, MANIFEST_FILE)
    if (expected === null) return { manifest: null, stale: false }
    // bustCache：帶不重複的查詢參數回源，正常情況一次就拿到最新內容，不必等 CDN。
    const buf = await downloadObject(path, { bustCache: true })
    if (buf) {
      const parsed = parseManifest(buf)
      if (expected === undefined || md5(buf) === expected) return { manifest: parsed, stale: false }
      lastStale = parsed
    }
    // list() 說有、download 卻拿不到（CDN 負向快取）或內容是舊版 → 等 CDN 追上
    if (Date.now() >= deadline) {
      logger.warn({ tenantId, period, run, attempt, expected, hadBody: !!buf }, "backup-snapshot: manifest.json read is stale (CDN lag) — timed out waiting")
      if (opts.onStale === "throw") throw new BackupError("manifest_stale", 503, { tenantId, period, run })
      return { manifest: lastStale, stale: true }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

export async function readManifest(
  tenantId: string,
  period: string,
  run: number,
  opts: ReadManifestOptions = {},
): Promise<SnapshotManifest | null> {
  return (await readManifestChecked(tenantId, period, run, opts)).manifest
}

async function writeManifest(manifest: SnapshotManifest): Promise<string> {
  recomputeTotals(manifest)
  const path = manifestPathOf(manifest.tenantId, manifest.period, manifest.run ?? 0)
  const body = Buffer.from(JSON.stringify(manifest, null, 2))
  const { error } = await storage().upload(path, body, { contentType: "application/json", upsert: true })
  if (error) throw new Error(`backup-snapshot (manifest upload ${path}): ${error.message}`)
  return path
}

/**
 * 舊版（run 0）同 period 重跑時，上一份 manifest 的暫存名。W7 之後每次執行各有
 * 自己的 `r{seq}` 資料夾、不再互相覆蓋，所以不再產生這個檔；保留常數是為了
 * 讀得懂舊資料夾裡殘留的這一份（清單會列出，pruneStaleFiles 仍會清掉）。
 */
export const PREVIOUS_MANIFEST_FILE = "manifest.prev.json"

/**
 * 本輪完成後才刪「不在新 manifest 裡的舊檔」（上一輪多出來的 part 檔、
 * manifest.prev.json）。資料夾裡剩下的就是 manifest.json＋它列出的檔案。
 */
async function pruneStaleFiles(manifest: SnapshotManifest): Promise<string[]> {
  const prefix = periodPrefix(manifest.tenantId, manifest.period, manifest.run ?? 0)
  const { data, error } = await storage().list(prefix, { limit: 1000 })
  if (error) throw new Error(`backup-snapshot (list ${prefix}): ${error.message}`)
  const keep = new Set<string>([MANIFEST_FILE])
  for (const t of manifest.tables) for (const f of t.files) keep.add(f.path)
  const stale = (data ?? []).filter((f) => f.id !== null && !keep.has(f.name)).map((f) => f.name)
  if (stale.length === 0) return []
  const { error: rmErr } = await storage().remove(stale.map((name) => `${prefix}/${name}`))
  if (rmErr) throw new Error(`backup-snapshot (prune ${prefix}): ${rmErr.message}`)
  return stale
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
  run: number,
  spec: SnapshotTableSpec,
  startOffset: number,
  manifest: SnapshotManifest,
  hasBudget: () => boolean,
): Promise<TableOutcome> {
  // 表級覆寫只准往下調：超過 PostgREST max-rows 的頁會被靜默截短（C3 驗收的根因）。
  const pageSize = Math.min(spec.pageSize ?? SNAPSHOT_PAGE_SIZE, SNAPSHOT_MAX_PAGE_SIZE)
  const prefix = periodPrefix(tenantId, period, run)
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
  const expectedRows = entry.expectedRows ?? 0

  let offset = startOffset
  let rowsWritten = 0
  for (;;) {
    const rows = await fetchPage(spec, tenantId, offset, pageSize)
    if (rows.length === 0 && offset > 0) break
    // 檔名依「這張表已寫出幾個檔」流水編號（不是 offset ÷ pageSize）：游標是按實際
    // 拿到的列數前進的，就算某頁被截短也不會跳號或漏列。續打時 entry.files 從
    // manifest 讀回，接著往下編；同一游標重送會蓋掉同名檔，不會多出一份。
    const pageNo = entry.files.length
    const fileName = entry.pages === 1 && pageNo === 0 ? `${spec.name}.json.gz` : `${spec.name}.part-${String(pageNo + 1).padStart(4, "0")}.json.gz`
    const gz = gzipSync(Buffer.from(JSON.stringify(rows)))
    const { error } = await storage().upload(`${prefix}/${fileName}`, gz, { contentType: "application/gzip", upsert: true })
    if (error) throw new Error(`backup-snapshot (upload ${prefix}/${fileName}): ${error.message}`)
    const file: SnapshotFileEntry = { path: fileName, rows: rows.length, bytes: gz.length, sha256: sha256(gz) }
    entry.files = [...entry.files.filter((f) => f.path !== fileName), file]
    entry.rows = entry.files.reduce((s, f) => s + f.rows, 0)
    entry.bytes = entry.files.reduce((s, f) => s + f.bytes, 0)
    rowsWritten += rows.length
    offset += rows.length
    // 短頁通常代表到底了；但只有「已蓋到 count(*)」才算數——PostgREST max-rows 比
    // pageSize 小時頁會被截短，這時 offset 還沒到 expectedRows，要繼續翻，直到蓋滿
    // 或真的沒資料（下一頁 0 列，迴圈頂端 break）。
    if (rows.length < pageSize && (rows.length === 0 || offset >= expectedRows)) break
    if (!hasBudget()) return { completed: false, rowsWritten, nextOffset: offset }
  }
  entry.sha256 = entry.files.length === 1 ? entry.files[0].sha256 : sha256(Buffer.from(entry.files.map((f) => f.sha256).join("\n")))
  entry.pages = entry.files.length
  // 完整性：實際寫出的列數少於開始時的 count(*) → 有列沒備到，這張表與整份
  // manifest 都不可標 complete。多於 count(*)（翻頁中有新列插入）不算漏。
  entry.incomplete = entry.rows < expectedRows
  if (entry.incomplete) {
    logger.error({ table: spec.name, tenantId, rows: entry.rows, expectedRows }, "backup-snapshot: rows written < count(*) — table incomplete")
  }
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
 * 一次呼叫做一段。從 `table/offset` 開始（省略＝第一張表從頭，並視為**新一輪**：
 * 配一個新的 run 序號、開新的 `{period}/r{run:03}/` 資料夾、重建 manifest），在
 * 預算內連續處理；回 `run`＋`nextTable/nextOffset` 讓呼叫端續打（`run` 要原樣帶
 * 回來）；本租戶全做完 → 寫 complete manifest；`allTenants` 再指向下一個 active
 * 租戶（`nextTenantId`，那是新一輪 → 不回 `nextRun`）。`done: true` 只在完全沒有
 * 下一步時。
 *
 * W7（2026-09-23）：同月重跑不再覆蓋——每次新一輪各自落在自己的 r 資料夾，
 * 舊的那份原封不動（保留 84 個月）。
 */
export async function runSnapshotStep(input: SnapshotStepInput): Promise<SnapshotStepResult> {
  const started = Date.now()
  const budgetMs = input.budgetMs ?? SNAPSHOT_STEP_BUDGET_MS
  const hasBudget = () => Date.now() - started < budgetMs
  const { tenantId, period } = input
  assertPeriod(period)
  let tableIdx = input.table ? SNAPSHOT_TABLES.findIndex((t) => t.name === input.table) : 0
  if (tableIdx < 0) throw new BackupError("unknown_table", 400, { table: input.table })
  let offset = input.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) throw new BackupError("invalid_offset", 400, { offset })
  if (input.run !== undefined) assertRun(input.run)

  const fresh = tableIdx === 0 && offset === 0
  let manifest: SnapshotManifest
  let run: number
  if (fresh) {
    // 新一輪一律配新號（就算呼叫端帶了 run 也忽略）：這是「同月不覆蓋」的保證所在。
    run = await allocateRun(tenantId, period)
    manifest = newManifest(tenantId, period, run)
  } else {
    // 續打：run 由呼叫端帶回（沒帶就取最新一次，舊 worker 相容）。一定要拿到上一步
    // 剛寫的 manifest（ETag 核對＋等 CDN），拿到舊版接著寫會把這一輪前面幾張表的
    // 紀錄蓋掉；等不到就 503，呼叫端稍後再續打同一游標。
    run = input.run ?? (await latestRun(tenantId, period)) ?? 1
    manifest =
      (await readManifest(tenantId, period, run, { freshWaitMs: MANIFEST_FRESH_WAIT_RESUME_MS, onStale: "throw" })) ??
      newManifest(tenantId, period, run)
    manifest.run = run
    manifest.status = "running"
  }

  let rowsWritten = 0
  let tablesCompleted = 0
  let lastTable: string | null = null
  const base = () => ({ tenantId, period, run, table: lastTable, rowsWritten, tablesCompleted, elapsedMs: Date.now() - started })

  while (tableIdx < SNAPSHOT_TABLES.length) {
    const spec = SNAPSHOT_TABLES[tableIdx]
    lastTable = spec.name
    const outcome = await snapshotTable(tenantId, period, run, spec, offset, manifest, hasBudget)
    rowsWritten += outcome.rowsWritten
    if (!outcome.completed) {
      await writeManifest(manifest)
      return { done: false, ...base(), nextTable: spec.name, nextOffset: outcome.nextOffset, nextRun: run }
    }
    tablesCompleted += 1
    tableIdx += 1
    offset = 0
    if (tableIdx < SNAPSHOT_TABLES.length && !hasBudget()) {
      await writeManifest(manifest)
      return { done: false, ...base(), nextTable: SNAPSHOT_TABLES[tableIdx].name, nextOffset: 0, nextRun: run }
    }
  }

  // 任一表 rows < expectedRows → 整份 incomplete，絕不寫 complete（C3 驗收：以前
  // PostgREST 截頁後仍標 complete，等於用一份缺資料的備份騙自己）。
  const incompleteTables = manifest.tables.filter((t) => t.incomplete).map((t) => t.name)
  manifest.status = incompleteTables.length > 0 ? "incomplete" : "complete"
  manifest.generatedAt = new Date().toISOString()
  const manifestPath = await writeManifest(manifest)
  // 完成後才清掉不在新 manifest 裡的舊檔（上一輪多出來的 part 檔、manifest.prev.json）。
  const pruned = await pruneStaleFiles(manifest)
  logger[manifest.status === "complete" ? "info" : "error"](
    { tenantId, period, run, status: manifest.status, incompleteTables, pruned, tables: manifest.totals.tables, rows: manifest.totals.rows, bytes: manifest.totals.bytes },
    manifest.status === "complete" ? "backup-snapshot: tenant snapshot complete" : "backup-snapshot: tenant snapshot INCOMPLETE — rows < count(*) on some tables",
  )
  // 續打期間 manifest.json 被覆寫過多次：呼叫端下一秒就會 GET /backups 看結果，先在
  // 這裡把 CDN 等到追上（剩餘的硬上限時間內），清單才不會顯示中途那一版。等不到只記
  // log，不影響 done——資料已經寫對了，清單端 readManifestChecked 會再等一段並標 stale。
  const remaining = SNAPSHOT_STEP_HARD_LIMIT_MS - (Date.now() - started)
  if (remaining > 0) {
    const check = await readManifestChecked(tenantId, period, run, { freshWaitMs: remaining })
    if (check.stale) logger.warn({ tenantId, period, run, waitedMs: remaining }, "backup-snapshot: manifest.json still stale on CDN after completion")
  }

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

/** 一個 period 底下的一次執行（W7）。 */
export interface SnapshotRunSummary {
  /** 0 ＝ 2026-09-23 之前的舊快照（檔案直接在 `{period}/` 下）。 */
  run: number
  manifest: SnapshotManifest | null
  /** true ＝ 回的是 CDN 上的舊版 manifest（剛跑完、失效還沒追上），幾十秒後再讀就是新的。 */
  manifestStale?: boolean
  files: SnapshotStoredFile[]
}

export interface SnapshotPeriodSummary {
  period: string
  /** 這個月份的歷次執行，新到舊（run 大的在前）。 */
  runs: SnapshotRunSummary[]
  /** 最新一次執行的 manifest（＝`runs[0]`；相容舊呼叫端）。 */
  manifest: SnapshotManifest | null
  manifestStale?: boolean
  /** 最新一次執行的檔案清單（＝`runs[0].files`；相容舊呼叫端）。 */
  files: SnapshotStoredFile[]
}

async function listPeriodFiles(tenantId: string, period: string, run: number): Promise<SnapshotStoredFile[]> {
  const { data, error } = await storage().list(periodPrefix(tenantId, period, run), { limit: 1000, sortBy: { column: "name", order: "asc" } })
  if (error) throw new Error(`backup-snapshot (list files ${period}/r${run}): ${error.message}`)
  return (data ?? [])
    .filter((f) => f.id !== null)
    .map((f) => ({ name: f.name, size: f.metadata?.size ?? 0, updatedAt: f.updated_at ?? null }))
}

/** 有限併發的 map：清單要讀 84 個月×每月數次執行的 manifest，逐筆串起來會太慢。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

async function readRunSummary(tenantId: string, period: string, run: number, freshWaitMs: number): Promise<SnapshotRunSummary> {
  const [checked, files] = await Promise.all([
    readManifestChecked(tenantId, period, run, { freshWaitMs }),
    listPeriodFiles(tenantId, period, run),
  ])
  return { run, manifest: checked.manifest, ...(checked.stale ? { manifestStale: true } : {}), files }
}

/**
 * 租戶底下所有 period 資料夾（新到舊），每個月份再列出歷次執行（run 新到舊）。
 * 只有「每個月份最新的那次」會等 CDN 追上（剛跑完的那份才可能是舊版）；更早的
 * 執行不再變動，直接讀，免得清單被 84 個月 × 每月數次的等待拖垮。
 */
export async function listSnapshotPeriods(tenantId: string): Promise<SnapshotPeriodSummary[]> {
  const { data, error } = await storage().list(tenantId, { limit: 500, sortBy: { column: "name", order: "desc" } })
  if (error) throw new Error(`backup-snapshot (list periods): ${error.message}`)
  const periods = (data ?? []).filter((e) => e.id === null && periodRe.test(e.name)).map((e) => e.name)
  return mapLimit(periods, 4, async (period) => {
    const runs = await listRuns(tenantId, period)
    const summaries = await mapLimit(runs, 4, (run, idx) =>
      readRunSummary(tenantId, period, run, idx === 0 ? MANIFEST_FRESH_WAIT_LIST_MS : 0),
    )
    const latest = summaries[0]
    return {
      period,
      runs: summaries,
      manifest: latest?.manifest ?? null,
      ...(latest?.manifestStale ? { manifestStale: true } : {}),
      files: latest?.files ?? [],
    }
  })
}

/**
 * 短效 signed URL（預設 15 分鐘）；檔名只准 `[A-Za-z0-9_.-]`，不接受路徑。
 * `run` 省略＝0（舊版快照，檔案直接在 `{period}/` 下）。
 */
export async function signedSnapshotUrl(
  tenantId: string,
  period: string,
  fileName: string,
  run = 0,
  expiresIn = 900,
): Promise<string> {
  assertPeriod(period)
  assertRun(run)
  if (!fileNameRe.test(fileName)) throw new BackupError("invalid_file", 400, { file: fileName })
  const path = `${periodPrefix(tenantId, period, run)}/${fileName}`
  const { data, error } = await storage().createSignedUrl(path, expiresIn, { download: fileName })
  if (error || !data?.signedUrl) throw new BackupError("file_not_found", 404, { file: fileName, run })
  return data.signedUrl
}

// ── M9 備份內容瀏覽（後台直接翻資料，不必下載解壓） ──────────────────────────

/** `planRowSlice` 的一段：從哪個檔的第幾列起、拿幾列。 */
export interface RowSlicePick {
  path: string
  /** 該檔內要跳過的列數。 */
  skip: number
  /** 該檔內要取的列數。 */
  take: number
}

export interface RowSlicePlan {
  picks: RowSlicePick[]
  /** 這張表的總列數（manifest 各檔 rows 相加）。 */
  total: number
  /** 還有下一頁時的起始 offset；沒有就 null。 */
  nextOffset: number | null
}

/**
 * 純函式：依 manifest 的分頁檔（每檔知道自己有幾列）算出「第 offset 列起取 limit 列」
 * 要下載哪幾個檔、各自跳過／取幾列。大表拆成 part-0001…，逐檔累加列數就能定位，
 * 不必把整張表抓下來。offset 超出總列數 → picks 空陣列（呼叫端回空頁，不是錯誤）。
 */
export function planRowSlice(files: readonly { path: string; rows: number }[], offset: number, limit: number): RowSlicePlan {
  const total = files.reduce((s, f) => s + f.rows, 0)
  const picks: RowSlicePick[] = []
  let remaining = Math.max(0, limit)
  let cursor = 0 // 已掃過的列數（各檔累加）
  for (const f of files) {
    if (remaining <= 0) break
    const fileStart = cursor
    const fileEnd = cursor + f.rows
    cursor = fileEnd
    if (offset >= fileEnd) continue // 整個檔都在 offset 之前
    const skip = Math.max(0, offset - fileStart)
    const take = Math.min(f.rows - skip, remaining)
    if (take <= 0) continue
    picks.push({ path: f.path, skip, take })
    remaining -= take
  }
  const taken = picks.reduce((s, p) => s + p.take, 0)
  const nextOffset = offset + taken < total ? offset + taken : null
  return { picks, total, nextOffset }
}

export interface SnapshotRowsPage {
  tenantId: string
  period: string
  run: number
  table: string
  offset: number
  limit: number
  /** 這張表在該次快照裡的總列數。 */
  total: number
  rows: Record<string, unknown>[]
  /** 下一頁的 offset；null ＝ 已到底。 */
  nextOffset: number | null
  /** 欄位名（取自本頁第一列，供表頭用）。 */
  columns: string[]
}

async function downloadRows(prefix: string, file: { path: string; bytes: number }): Promise<Record<string, unknown>[]> {
  if (file.bytes > SNAPSHOT_ROWS_MAX_FILE_BYTES) {
    throw new BackupError("too_large", 413, { file: file.path, bytes: file.bytes, maxBytes: SNAPSHOT_ROWS_MAX_FILE_BYTES })
  }
  const { data, error } = await storage().download(`${prefix}/${file.path}`)
  if (error || !data) throw new BackupError("file_not_found", 404, { file: file.path })
  const gz = Buffer.from(await data.arrayBuffer())
  const parsed = JSON.parse(gunzipSync(gz).toString("utf8")) as unknown
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
}

/**
 * M9：直接在後台翻某次快照裡某張表的資料。下載該分頁檔 → gunzip → JSON.parse → 切片。
 * 未知的表（不在 manifest 裡、或該環境沒這張表被略過）→ 404 unknown_table；
 * 單檔 >20 MB → 413 too_large（請改用下載連結）。limit 上限 200。
 */
export async function readSnapshotRows(
  tenantId: string,
  period: string,
  run: number,
  table: string,
  offset = 0,
  limit = 50,
): Promise<SnapshotRowsPage> {
  assertPeriod(period)
  assertRun(run)
  if (!Number.isInteger(offset) || offset < 0) throw new BackupError("invalid_offset", 400, { offset })
  const cappedLimit = Math.min(Math.max(1, Math.trunc(limit)), SNAPSHOT_ROWS_MAX_LIMIT)
  const manifest = await readManifest(tenantId, period, run)
  if (!manifest) throw new BackupError("run_not_found", 404, { period, run })
  const entry = manifest.tables.find((t) => t.name === table)
  if (!entry || entry.skipped) throw new BackupError("unknown_table", 404, { table, run })
  const plan = planRowSlice(entry.files, offset, cappedLimit)
  const prefix = periodPrefix(tenantId, period, run)
  const rows: Record<string, unknown>[] = []
  for (const pick of plan.picks) {
    const file = entry.files.find((f) => f.path === pick.path)!
    const all = await downloadRows(prefix, file)
    rows.push(...all.slice(pick.skip, pick.skip + pick.take))
  }
  return {
    tenantId,
    period,
    run,
    table,
    offset,
    limit: cappedLimit,
    total: plan.total,
    rows,
    nextOffset: plan.nextOffset,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
  }
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

  // 月結紀錄指向「該月最新一次快照」的 manifest（W7 之後同月可能有多次執行）。
  const manifestRun = await latestRun(tenantId, period).catch(() => null)
  const manifest = manifestRun === null ? null : await readManifest(tenantId, period, manifestRun).catch(() => null)
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
        snapshot_manifest_path: manifest ? manifestPathOf(tenantId, period, manifestRun ?? 0) : null,
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
