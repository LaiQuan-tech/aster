import { supabaseAdmin } from "../lib/supabase.js"
import { DEFAULT_COMPANY_NAME } from "../lib/letterhead.js"
import { logger } from "../lib/logger.js"
import type { StatementGrid } from "../lib/statements/grid.js"
import {
  buildClosedSheet,
  buildOpenSheet,
  isInThisRound,
  mmddOf,
  periodLabelOf,
  type BonusSheetContext,
  type BonusSheetProject,
} from "../lib/statements/bonus-sheet.js"
import { BONUS_BASES, isDuplicateReplacedArchive, projectBonusBasisOf, receivedRatioOf, type BonusBasis } from "./bonus-run.js"
import { getRun, listRuns, loadInputs, previewRun, tenantToday, type SerializedItem, type SerializedRun } from "./bonus-run-store.js"
import { loadP3Settings } from "./project-application-store.js"
import { DEFAULT_VAT_RATE } from "./project-money.js"
import { isTerminal } from "./project-status.js"

/**
 * 獎金分潤總表（後台「專案與財務 → 獎金分潤」，GET /bonus-sheet）的資料組裝——IO 層。
 * 版面在 lib/statements/bonus-sheet.ts（純函式）；這裡只決定「本次」是哪一批、把批次明細攤成每案一列。
 *
 * 「本次」的來源（使用者在頁面上選）：
 *   • runId：該獎金批次（任何狀態，未刪）的凍結明細＋快照（被跳過的案在 snapshot.projects 裡）。
 *   • asOf：依基準日即時試算（同獎金季發放的「試算」，不寫入）。
 *   • 都沒帶：最新一個一般批次（依基準日；優先已發放且沒被沖銷的，見 defaultRunOf）；一個批次都沒有 → 今天的即時試算。
 * 批次（或試算）明細以外的專案（沒有成員、試算不列的封存案）也列出：只有專案層數字，沒有「本次」，成員欄照
 * 專案現有成員（沒有就空白）；「複製專案而封存的原案」不列（已由新案取代）。
 * 已結案（結案／解約／封存）的案放「已結案」表，但這一批還有本次入帳或本次獎金的留在「未結案」。
 *
 * 子資料失敗降級（回 200＋warnings，不整頁 500）：批次清單讀不到 → 選單空白；指定批次讀不到 → 改用試算；
 * 試算也失敗 → 空表；其他專案讀不到 → 只列批次內的案；專案狀態讀不到 → 全部當未結案；營業稅率讀不到 → 5%；公司名稱讀不到 → 預設名稱。
 * 指定的批次不存在（或別租戶）→ BonusSheetNotFound（路由回 404）。
 */

export class BonusSheetNotFound extends Error {}

export type BonusSheetRunOption = Pick<SerializedRun, "id" | "label" | "asOf" | "status" | "kind">

export type BonusSheetResult = {
  source: "run" | "preview" | "empty"
  asOf: string
  run: BonusSheetRunOption | null
  runs: BonusSheetRunOption[]
  periodLabel: string
  mmdd: string
  vatRate: number
  counts: { open: number; closed: number }
  warnings: string[]
  sheets: { open: StatementGrid; closed: StatementGrid }
}

type SnapshotProject = {
  projectId?: unknown
  code?: unknown
  name?: unknown
  shareMode?: unknown
  basis?: unknown
  bonusRatePct?: unknown
  effectivePool?: unknown
  bonusPool?: unknown
  projectNote?: unknown
  contractTotal?: unknown
  receivedTotal?: unknown
  skipped?: unknown
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null)
const basisOf = (v: unknown): BonusBasis | null => ((BONUS_BASES as readonly string[]).includes(v as string) ? (v as BonusBasis) : null)

/** 預設批次：最新（依基準日）的一般批次，優先「已發放且沒被沖銷」，其次沒被沖銷的，再其次任何一般批次。 */
export function defaultRunOf(runs: readonly SerializedRun[]): SerializedRun | null {
  const regular = runs.filter((r) => r.kind === "regular")
  return (
    regular.find((r) => r.status === "paid" && !r.reversedByRunId) ??
    regular.find((r) => !r.reversedByRunId) ??
    regular[0] ??
    null
  )
}

function optionOf(run: SerializedRun): BonusSheetRunOption {
  return { id: run.id, label: run.label, asOf: run.asOf, status: run.status, kind: run.kind }
}

/**
 * 純函式：批次（或試算）明細＋快照 → 每案一列。明細依專案分組；快照裡被跳過（缺合約／缺獎金池）、
 * 沒有明細的案另外補一列（只有專案層數字，沒有成員）。closed 由呼叫端補。
 */
export function projectsFromItems(items: readonly SerializedItem[], snapshot: Record<string, unknown> | null | undefined): BonusSheetProject[] {
  const groups = new Map<string, SerializedItem[]>()
  for (const it of items) {
    const arr = groups.get(it.projectId) ?? []
    arr.push(it)
    groups.set(it.projectId, arr)
  }
  const snapProjects = Array.isArray(snapshot?.projects) ? (snapshot!.projects as SnapshotProject[]) : []
  const snapById = new Map(snapProjects.filter((p) => typeof p.projectId === "string").map((p) => [p.projectId as string, p]))
  const skippedReason = new Map<string, "no_contract" | "no_pool">()
  if (Array.isArray(snapshot?.skipped)) {
    for (const s of snapshot!.skipped as Array<{ projectId?: unknown; reason?: unknown }>) {
      if (typeof s.projectId === "string" && (s.reason === "no_contract" || s.reason === "no_pool")) skippedReason.set(s.projectId, s.reason)
    }
  }

  const out: BonusSheetProject[] = []
  for (const [projectId, rows] of groups) {
    const f = rows[0]!
    const snap = snapById.get(projectId)
    const allocatedPct = rows.reduce((s, r) => s + (r.shareMode === "pool_pct" ? (r.sharePct ?? 0) : 0), 0)
    out.push({
      projectId,
      code: f.projectCode ?? strOrNull(snap?.code),
      name: f.projectName ?? strOrNull(snap?.name),
      closed: false,
      contractTotal: f.contractTotal,
      receivedTotal: f.receivedTotal,
      previousReceived: f.previousReceived,
      currentReceived: f.currentReceived,
      receivedRatio: f.receivedPct,
      previousRatio: f.previousReceivedPct,
      currentRatio: f.currentReceivedPct,
      bonusRatePct: f.bonusRatePct,
      pool: f.basis === "fixed_amount" || f.shareMode !== "pool_pct" ? null : f.bonusPool,
      basis: f.basis ?? basisOf(snap?.basis),
      currentBonus: rows.reduce((s, r) => s + r.amount, 0),
      overpaidBy: rows.reduce((s, r) => s + (r.overpaid ? r.overpaidBy : 0), 0),
      // 舊明細的 unallocatedPct 可能是 0（沒存）——以成員趴數重算為準。
      unallocatedPct: f.shareMode === "pool_pct" ? Math.max(0, Math.round((100 - allocatedPct) * 10000) / 10000) : null,
      note: f.projectNote ?? strOrNull(snap?.projectNote),
      skipped: null,
      members: rows.map((r) => ({
        employeeId: r.employeeId,
        name: r.employeeName,
        empNo: r.empNo,
        role: r.roleInProject,
        shareMode: r.shareMode,
        sharePct: r.sharePct,
        shareAmount: r.shareAmount,
        amount: r.amount,
      })),
    })
  }
  // 被試算跳過的案（沒有明細）：只有專案層數字。
  for (const [projectId, reason] of skippedReason) {
    if (groups.has(projectId)) continue
    const snap = snapById.get(projectId)
    const contractTotal = numOrNull(snap?.contractTotal)
    const receivedTotal = numOrNull(snap?.receivedTotal) ?? 0
    const ratio = contractTotal && contractTotal > 0 ? receivedTotal / contractTotal : 0
    out.push({
      projectId,
      code: strOrNull(snap?.code),
      name: strOrNull(snap?.name),
      closed: false,
      contractTotal,
      receivedTotal,
      // 跳過的案沒有「之前／本次」拆分：累計都放在已收款。
      previousReceived: receivedTotal,
      currentReceived: 0,
      receivedRatio: ratio,
      previousRatio: ratio,
      currentRatio: 0,
      bonusRatePct: numOrNull(snap?.bonusRatePct),
      // 固定金額制沒有獎金池；舊制的 effectivePool 就是手填池。
      pool: basisOf(snap?.basis) === "fixed_amount" ? null : numOrNull(snap?.effectivePool),
      basis: basisOf(snap?.basis),
      currentBonus: 0,
      overpaidBy: 0,
      unallocatedPct: null,
      note: strOrNull(snap?.projectNote),
      skipped: reason,
      members: [],
    })
  }
  return out
}

/**
 * 批次明細以外的專案（租戶全部專案扣掉 exclude、扣掉複製取代的原案）：用獎金試算同一支 loadInputs 讀合約、
 * 截至基準日的入帳與成員（archiveRule 'all'、指定 projectIds＝沒有成員也回）。
 */
async function loadOtherProjects(tenantId: string, asOf: string, exclude: ReadonlySet<string>): Promise<BonusSheetProject[]> {
  const ids: string[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .select("id, archive_reason")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`bonus-sheet (projects): ${error.message}`)
    const rows = (data ?? []) as Array<{ id: string; archive_reason: string | null }>
    for (const r of rows) if (!exclude.has(r.id) && !isDuplicateReplacedArchive(r.archive_reason)) ids.push(r.id)
    if (rows.length < 1000) break
  }
  const out: BonusSheetProject[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const inputs = await loadInputs(tenantId, asOf, { projectIds: ids.slice(i, i + 100), archiveRule: "all" })
    for (const p of inputs.projects) {
      const meta = inputs.projectMeta.get(p.projectId)
      const b = projectBonusBasisOf(p)
      const ratio = receivedRatioOf(p.contractTotal, p.receivedTotal)
      const allocated = p.members.reduce((s, m) => s + (m.sharePct ?? 0), 0)
      out.push({
        projectId: p.projectId,
        code: meta?.code ?? null,
        name: meta?.name ?? null,
        closed: false,
        contractTotal: p.contractTotal,
        receivedTotal: p.receivedTotal,
        previousReceived: p.receivedTotal,
        currentReceived: 0,
        receivedRatio: ratio,
        previousRatio: ratio,
        currentRatio: 0,
        bonusRatePct: p.bonusRatePct,
        pool: b.pool,
        basis: p.members.length > 0 ? b.basis : null,
        currentBonus: 0,
        overpaidBy: 0,
        unallocatedPct: p.members.length > 0 && p.shareMode === "pool_pct" ? Math.max(0, Math.round((100 - allocated) * 10000) / 10000) : null,
        note: p.projectNote,
        skipped: null,
        members: p.members.map((m) => {
          const e = inputs.employeeMeta.get(m.employeeId)
          return {
            employeeId: m.employeeId,
            name: e?.name ?? null,
            empNo: e?.emp_no ?? null,
            role: m.roleInProject ?? null,
            shareMode: p.shareMode,
            sharePct: m.sharePct,
            shareAmount: m.shareAmount,
            amount: 0,
          }
        }),
      })
    }
  }
  return out
}

/** 已結案：status 結案／解約，或已封存。 */
async function loadClosedIds(tenantId: string, projectIds: readonly string[]): Promise<Set<string>> {
  const closed = new Set<string>()
  for (let i = 0; i < projectIds.length; i += 100) {
    const chunk = projectIds.slice(i, i + 100)
    const { data, error } = await supabaseAdmin.from("projects").select("id, status, archived_at").eq("tenant_id", tenantId).in("id", chunk)
    if (error) throw new Error(`bonus-sheet (projects status): ${error.message}`)
    for (const row of (data ?? []) as Array<{ id: string; status: string | null; archived_at: string | null }>) {
      if (isTerminal(row.status ?? "") || row.archived_at) closed.add(row.id)
    }
  }
  return closed
}

async function loadCompanyName(tenantId: string): Promise<string> {
  const { data, error } = await supabaseAdmin.from("tenants").select("name, branding").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`bonus-sheet (tenant): ${error.message}`)
  const branding = (data?.branding ?? {}) as { appName?: string }
  return (data?.name as string | undefined) || branding.appName || DEFAULT_COMPANY_NAME
}

function warn(warnings: string[], text: string, err: unknown): void {
  warnings.push(text)
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, `bonus-sheet: ${text}`)
}

export async function loadBonusSheet(tenantId: string, query: { runId?: string | null; asOf?: string | null }): Promise<BonusSheetResult> {
  const warnings: string[] = []
  const [runs, vatRate, companyName] = await Promise.all([
    listRuns(tenantId).catch((err) => {
      warn(warnings, "獎金批次清單讀取失敗，批次選單暫時空白", err)
      return [] as SerializedRun[]
    }),
    loadP3Settings(tenantId)
      .then((s) => s.vatRate)
      .catch((err) => {
        warn(warnings, "營業稅率讀取失敗，含稅金額暫以 5% 計", err)
        return DEFAULT_VAT_RATE
      }),
    loadCompanyName(tenantId).catch((err) => {
      warn(warnings, "公司名稱讀取失敗，改用預設名稱", err)
      return DEFAULT_COMPANY_NAME
    }),
  ])

  let source: BonusSheetResult["source"] = "preview"
  let run: SerializedRun | null = null
  let items: SerializedItem[] = []
  let snapshot: Record<string, unknown> | null = null
  let asOf: string | null = query.asOf ?? null

  const runId = query.runId ?? (query.asOf ? null : defaultRunOf(runs)?.id ?? null)
  if (runId) {
    try {
      const detail = await getRun(tenantId, runId)
      if (!detail) {
        if (query.runId) throw new BonusSheetNotFound(runId)
      } else {
        source = "run"
        run = detail.run
        items = detail.items
        snapshot = detail.snapshot
        asOf = detail.run.asOf
      }
    } catch (err) {
      if (err instanceof BonusSheetNotFound) throw err
      warn(warnings, "獎金批次明細讀取失敗，改用今天的即時試算", err)
    }
  }
  if (source !== "run") {
    try {
      asOf = asOf ?? (await tenantToday(tenantId))
      const preview = await previewRun(tenantId, asOf, null)
      items = preview.items
      snapshot = preview.snapshot
      source = "preview"
    } catch (err) {
      warn(warnings, "即時試算失敗，總表暫時沒有資料", err)
      source = "empty"
      asOf = asOf ?? new Date().toISOString().slice(0, 10)
    }
  }
  const baseDate = asOf as string

  const projects = projectsFromItems(items, snapshot)
  try {
    projects.push(...(await loadOtherProjects(tenantId, baseDate, new Set(projects.map((p) => p.projectId)))))
  } catch (err) {
    warn(warnings, "批次以外的專案讀取失敗，只列批次內的專案", err)
  }
  if (projects.length > 0) {
    try {
      const closed = await loadClosedIds(tenantId, projects.map((p) => p.projectId))
      // 已結案但這一批還有本次入帳／本次獎金的案（例如收尾款那一季）留在「未結案」：已結案表沒有本次欄，
      // 放過去本次獎金就看不到、合計對不上批次總額。
      for (const p of projects) p.closed = closed.has(p.projectId) && !isInThisRound(p)
    } catch (err) {
      warn(warnings, "專案結案狀態讀取失敗，全部列在「未結案」", err)
    }
  }

  const ctx: BonusSheetContext = {
    companyName,
    vatRate,
    periodLabel: periodLabelOf(run?.label ?? null, baseDate),
    mmdd: mmddOf(baseDate),
  }
  const open = projects.filter((p) => !p.closed)
  const closed = projects.filter((p) => p.closed)
  return {
    source,
    asOf: baseDate,
    run: run ? optionOf(run) : null,
    runs: runs.map(optionOf),
    periodLabel: ctx.periodLabel,
    mmdd: ctx.mmdd,
    vatRate,
    counts: { open: open.length, closed: closed.length },
    warnings,
    sheets: { open: buildOpenSheet(open, ctx), closed: buildClosedSheet(closed, ctx) },
  }
}
