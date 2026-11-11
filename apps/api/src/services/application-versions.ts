import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"
import { loadContractsLite } from "./project-application-store.js"
import { resolveAmountUntaxed, summarizeContracts } from "./project-money.js"
import { buildApplicationSnapshot, type ApplicationSnapshot } from "../routes/projects.js"

/**
 * 專案申請單「版本」（2026-11-10，migration 0090 ＝ sql/0080，表 project_application_versions）。
 *
 * 業主需求：合約金額改了之後申請單就變下一版；之前的版本要能調出來看。
 *   • 合約金額（＝申請單「銷售金額（未稅）」，合約＋追加減，沒有合約時取最新報價單）有變的那次存檔，
 *     在**後端合約寫入的同一流程**裡建版（routes/contracts.ts 的 PUT main-contract／POST／PATCH／DELETE 都包
 *     withApplicationVersioning），申請單、合約與報價單卡片、MCP（走同一批 HTTP 路由）都不會漏：
 *       – 專案還沒有任何版本：先把「改之前」的內容存成第 1 版（initial），再把改後內容存成第 2 版（contract_amount_changed）。
 *       – 已有版本：把目前版（最新那一版）的 snapshot 更新成「改之前」的最後內容並記 superseded_at（凍結），
 *         再把改後內容存成第 N+1 版。
 *   • 手動「另存新版本」（manual，可填備註）：同樣先凍結目前版，再存一版目前內容。
 *   • 其他欄位修改不建新版：目前版＝即時資料（前端選「目前」時顯示的就是即時申請單）。
 * 舊版只能看（唯讀、可列印），不提供還原。
 * migration 未套用：versionsAvailable()=false → 合約照存不建版、列表回 available=false、手動另存回 409。
 */

export const VERSIONS_TABLE = "project_application_versions"
export const VERSION_TRIGGERS = ["initial", "contract_amount_changed", "manual"] as const
export type VersionTrigger = (typeof VERSION_TRIGGERS)[number]

const META_COLS = "id, project_id, version_no, trigger, amount_before, amount_after, note, created_by_emp_id, created_at, superseded_at"

/* ── 表是否已套用（探測一次；「有」永久快取、「沒有」快取 60 秒，套完不必重啟） ── */
const NEGATIVE_TTL_MS = 60_000
let probe: { exists: boolean; at: number } | null = null

export async function versionsAvailable(): Promise<boolean> {
  if (probe && (probe.exists || Date.now() - probe.at < NEGATIVE_TTL_MS)) return probe.exists
  const { error } = await supabaseAdmin.from(VERSIONS_TABLE).select("id, superseded_at").limit(1)
  const missing = !!error && (isMissingTableError(error) || isMissingColumnError(error))
  if (missing) warnSchemaGapOnce(`${VERSIONS_TABLE} (migration 0090)`, error)
  probe = { exists: !missing, at: Date.now() }
  return probe.exists
}

/** 測試用：清掉探測快取。 */
export function resetVersionsProbe(): void {
  probe = null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 申請單「銷售金額（未稅）」目前值（同 loadProjectFinance：合約＋追加減，沒有合約退用最新報價單）。 */
export async function currentAmountUntaxed(tenantId: string, projectId: string): Promise<number | null> {
  const summary = summarizeContracts(await loadContractsLite(tenantId, projectId))
  return resolveAmountUntaxed(summary.total, summary.latestQuotation).amountUntaxed
}

export interface VersionMeta {
  id: string
  versionNo: number
  trigger: VersionTrigger
  amountBefore: number | null
  amountAfter: number | null
  note: string | null
  createdByEmpId: string | null
  createdByName: string | null
  createdAt: string
  supersededAt: string | null
}

type VersionRow = {
  id: string
  project_id: string
  version_no: number
  trigger: string
  amount_before: string | number | null
  amount_after: string | number | null
  note: string | null
  created_by_emp_id: string | null
  created_at: string
  superseded_at: string | null
  snapshot?: unknown
}

function toMeta(r: VersionRow, names: Map<string, string>): VersionMeta {
  return {
    id: r.id,
    versionNo: Number(r.version_no),
    trigger: r.trigger as VersionTrigger,
    amountBefore: num(r.amount_before),
    amountAfter: num(r.amount_after),
    note: r.note ?? null,
    createdByEmpId: r.created_by_emp_id ?? null,
    createdByName: r.created_by_emp_id ? (names.get(r.created_by_emp_id) ?? null) : null,
    createdAt: r.created_at,
    supersededAt: r.superseded_at ?? null,
  }
}

async function namesOf(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  const out = new Map<string, string>()
  if (unique.length === 0) return out
  const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", unique)
  if (error) return out // 建立者名稱只是顯示用
  for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) if (r.name) out.set(r.id, r.name)
  return out
}

/** 該專案的版本（版號新→舊，不含 snapshot）。表未套用回 null。 */
export async function listVersions(tenantId: string, projectId: string): Promise<VersionMeta[] | null> {
  if (!(await versionsAvailable())) return null
  const { data, error } = await supabaseAdmin
    .from(VERSIONS_TABLE)
    .select(META_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .order("version_no", { ascending: false })
  if (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return null
    throw new Error(`listVersions: ${error.message}`)
  }
  const rows = (data ?? []) as VersionRow[]
  const names = await namesOf(tenantId, rows.map((r) => r.created_by_emp_id))
  return rows.map((r) => toMeta(r, names))
}

/** 單一版本（含 snapshot）。找不到／表未套用回 null。 */
export async function getVersion(
  tenantId: string,
  projectId: string,
  versionNo: number,
): Promise<(VersionMeta & { snapshot: ApplicationSnapshot }) | null> {
  if (!(await versionsAvailable())) return null
  const { data, error } = await supabaseAdmin
    .from(VERSIONS_TABLE)
    .select(`${META_COLS}, snapshot`)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("version_no", versionNo)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return null
    throw new Error(`getVersion: ${error.message}`)
  }
  if (!data) return null
  const row = data as VersionRow
  const names = await namesOf(tenantId, [row.created_by_emp_id])
  return { ...toMeta(row, names), snapshot: row.snapshot as ApplicationSnapshot }
}

async function latestVersion(tenantId: string, projectId: string): Promise<{ id: string; version_no: number } | null> {
  const { data, error } = await supabaseAdmin
    .from(VERSIONS_TABLE)
    .select("id, version_no")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .order("version_no", { ascending: false })
    .limit(1)
  if (error) throw new Error(`latestVersion: ${error.message}`)
  const row = (data ?? [])[0] as { id: string; version_no: number } | undefined
  return row ? { id: row.id, version_no: Number(row.version_no) } : null
}

/** 寫一版（版號＝目前最大＋1；併發撞號 23505 時重算再試，最多 3 次）。 */
async function insertVersion(
  tenantId: string,
  projectId: string,
  input: {
    snapshot: ApplicationSnapshot
    trigger: VersionTrigger
    amountBefore: number | null
    amountAfter: number | null
    note: string | null
    empId: string | null
  },
): Promise<{ id: string; versionNo: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await latestVersion(tenantId, projectId)
    const versionNo = (latest?.version_no ?? 0) + 1
    const { data, error } = await supabaseAdmin
      .from(VERSIONS_TABLE)
      .insert({
        tenant_id: tenantId,
        project_id: projectId,
        version_no: versionNo,
        snapshot: input.snapshot,
        trigger: input.trigger,
        amount_before: input.amountBefore,
        amount_after: input.amountAfter,
        note: input.note,
        created_by_emp_id: input.empId,
      })
      .select("id, version_no")
      .single()
    if (!error && data) return { id: (data as { id: string }).id, versionNo }
    if (error?.code === "23505") continue
    throw new Error(`insertVersion: ${error?.message ?? "missing row"}`)
  }
  throw new Error("insertVersion: version_no conflict (retries exhausted)")
}

/** 目前版（最新那一版）被取代：snapshot 更新成被取代前的最後內容、記 superseded_at。沒有任何版本回 false。 */
async function freezeLatest(tenantId: string, projectId: string, snapshot: ApplicationSnapshot): Promise<boolean> {
  const latest = await latestVersion(tenantId, projectId)
  if (!latest) return false
  const { error } = await supabaseAdmin
    .from(VERSIONS_TABLE)
    .update({ snapshot, superseded_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", latest.id)
  if (error) throw new Error(`freezeLatest: ${error.message}`)
  return true
}

export interface VersioningOutcome {
  /** 這次建的新版號（金額沒變／表未套用／建版失敗＝null）。 */
  versionNo: number | null
  warning: string | null
}

/**
 * 包住一次「可能改到合約金額」的寫入：寫入前記下金額與申請單內容，寫入後金額有變就建版。
 * 建版是附帶動作：失敗只記 log（合約已經存了，不能因為版本寫不進去就回錯），回傳 warning。
 */
export async function withApplicationVersioning<T>(
  ctx: { tenantId: string; projectId: string; empId: string | null; source: string },
  mutate: () => Promise<T>,
): Promise<{ result: T; versioning: VersioningOutcome }> {
  let before: { amount: number | null; snapshot: ApplicationSnapshot } | null = null
  try {
    if (await versionsAvailable()) {
      const snapshot = await buildApplicationSnapshot(ctx.tenantId, ctx.projectId)
      if (snapshot) before = { amount: await currentAmountUntaxed(ctx.tenantId, ctx.projectId), snapshot }
    }
  } catch (err) {
    logger.warn({ err, source: ctx.source, projectId: ctx.projectId }, "application version: pre-snapshot failed")
    before = null
  }
  const result = await mutate()
  if (!before) return { result, versioning: { versionNo: null, warning: null } }
  try {
    const after = await currentAmountUntaxed(ctx.tenantId, ctx.projectId)
    if (after === before.amount) return { result, versioning: { versionNo: null, warning: null } }
    const afterSnapshot = await buildApplicationSnapshot(ctx.tenantId, ctx.projectId)
    if (!afterSnapshot) return { result, versioning: { versionNo: null, warning: null } }
    const hadVersion = await freezeLatest(ctx.tenantId, ctx.projectId, before.snapshot)
    if (!hadVersion) {
      await insertVersion(ctx.tenantId, ctx.projectId, {
        snapshot: before.snapshot,
        trigger: "initial",
        amountBefore: null,
        amountAfter: before.amount,
        note: null,
        empId: ctx.empId,
      })
      // 第 1 版（改之前）一建好就被第 2 版取代。
      await freezeLatest(ctx.tenantId, ctx.projectId, before.snapshot)
    }
    const created = await insertVersion(ctx.tenantId, ctx.projectId, {
      snapshot: afterSnapshot,
      trigger: "contract_amount_changed",
      amountBefore: before.amount,
      amountAfter: after,
      note: null,
      empId: ctx.empId,
    })
    return { result, versioning: { versionNo: created.versionNo, warning: null } }
  } catch (err) {
    logger.error({ err, source: ctx.source, projectId: ctx.projectId }, "application version: create failed")
    return { result, versioning: { versionNo: null, warning: "application_version_failed" } }
  }
}

/** 手動另存新版本：凍結目前版，再存一版目前內容。表未套用回 null；專案不存在回 "not_found"。 */
export async function saveManualVersion(
  tenantId: string,
  projectId: string,
  empId: string | null,
  note: string | null,
): Promise<{ id: string; versionNo: number } | null | "not_found"> {
  if (!(await versionsAvailable())) return null
  const snapshot = await buildApplicationSnapshot(tenantId, projectId)
  if (!snapshot) return "not_found"
  await freezeLatest(tenantId, projectId, snapshot)
  return insertVersion(tenantId, projectId, {
    snapshot,
    trigger: "manual",
    amountBefore: null,
    amountAfter: snapshot.money?.amountUntaxed ?? null,
    note,
    empId,
  })
}
