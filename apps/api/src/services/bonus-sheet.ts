import { supabaseAdmin } from "../lib/supabase.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { DEFAULT_COMPANY_NAME } from "../lib/letterhead.js"
import { logger } from "../lib/logger.js"
import type { StatementGrid } from "../lib/statements/grid.js"
import {
  buildClosedSheet,
  buildOpenSheet,
  CLOSED_HEADER_ROWS,
  isInThisRound,
  OPEN_HEADER_ROWS,
  sortProjects,
  mmddOf,
  periodLabelOf,
  type BonusSheetContext,
  type BonusSheetProject,
} from "../lib/statements/bonus-sheet.js"
import { BONUS_BASES, isDuplicateReplacedArchive, memberEntitledOf, projectBonusBasisOf, receivedRatioOf, type BonusBasis } from "./bonus-run.js"
import { loadShareRevisions, revisionNoteOf, type ShareRevision } from "./bonus-sheet-revisions.js"
import {
  getRun,
  listProjectRunItems,
  listRuns,
  loadInputs,
  loadProjectPaymentTotals,
  previewRun,
  tenantToday,
  type ProjectPaymentTotals,
  type SerializedItem,
  type SerializedRun,
} from "./bonus-run-store.js"
import { buildManageRows, manageTotalsOf, type ManageRow, type ManageTotals } from "./bonus-manage.js"
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
  /**
   * 格線資料列 → 專案（畫面點開專案列載入發放歷程用；row＝格線列號，0 起算）。只給畫面，Excel／列印不受影響。
   */
  rowProjects: { open: BonusSheetRowProject[]; closed: BonusSheetRowProject[] }
}

export type BonusSheetRowProject = { row: number; projectId: string }

/** 與 buildOpenSheet／buildClosedSheet 同一個排序：第 i 案在格線第 headerRows＋i 列。 */
export function rowProjectsOf(projects: readonly BonusSheetProject[], headerRows: number): BonusSheetRowProject[] {
  return sortProjects(projects).map((p, i) => ({ row: headerRows + i, projectId: p.projectId }))
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
        entitled: r.entitledCumulative,
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

/** @internal 租戶全部專案（id 排序）扣掉 exclude 與複製取代的原案；匯出供分頁測試用。 */
export async function listOtherProjectIds(tenantId: string, exclude: ReadonlySet<string>): Promise<string[]> {
  const ids: string[] = []
  const rows = await selectAllPages<{ id: string; archive_reason: string | null }>(
    (from, to) =>
      supabaseAdmin.from("projects").select("id, archive_reason").eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to),
    "bonus-sheet (projects)",
  )
  for (const r of rows) if (!exclude.has(r.id) && !isDuplicateReplacedArchive(r.archive_reason)) ids.push(r.id)
  return ids
}

/**
 * 批次明細以外的專案（租戶全部專案扣掉 exclude、扣掉複製取代的原案）：用獎金試算同一支 loadInputs 讀合約、
 * 截至基準日的入帳與成員（archiveRule 'all'、指定 projectIds＝沒有成員也回）。
 */
async function loadOtherProjects(tenantId: string, asOf: string, exclude: ReadonlySet<string>): Promise<BonusSheetProject[]> {
  const ids = await listOtherProjectIds(tenantId, exclude)
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
        basisHint: b.basis,
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
            entitled: memberEntitledOf(p, b, m),
          }
        }),
      })
    }
  }
  return out
}

/**
 * 純函式（2026-10-27 驗收）：試算跳過（缺合約／缺獎金池）的案，快照裡沒有成員——補上現任成員與其％／固定金額，
 * 管理檢視才不會把領過錢的現任成員當成「已移除」、獎金總額（固定金額合計）也算得出來。
 * 被跳過的案引擎不發錢：累計應得一律 null（可發＝0、不算超發）。原地修改 projects。
 */
export function fillSkippedMembers(projects: BonusSheetProject[], inputs: Pick<LoadedInputsLike, "projects" | "employeeMeta">): void {
  const byId = new Map(inputs.projects.map((ip) => [ip.projectId, ip]))
  for (const p of projects) {
    if (!p.skipped || p.members.length > 0) continue
    const ip = byId.get(p.projectId)
    if (!ip) continue
    const b = projectBonusBasisOf(ip)
    p.basisHint = b.basis
    if (ip.members.length === 0) continue
    p.basis = p.basis ?? b.basis
    if (p.basis === "fixed_amount") p.pool = null
    if (p.basis === "legacy_pool" && p.pool === null) p.pool = ip.bonusPool ?? null
    p.members = ip.members.map((m) => {
      const e = inputs.employeeMeta.get(m.employeeId)
      return {
        employeeId: m.employeeId,
        name: e?.name ?? null,
        empNo: e?.emp_no ?? null,
        role: m.roleInProject ?? null,
        shareMode: ip.shareMode,
        sharePct: m.sharePct,
        shareAmount: m.shareAmount,
        amount: 0,
        entitled: null,
      }
    })
    if (ip.shareMode === "pool_pct") {
      const allocated = ip.members.reduce((s, m) => s + (m.sharePct ?? 0), 0)
      p.unallocatedPct = Math.max(0, Math.round((100 - allocated) * 10000) / 10000)
    }
  }
}

type LoadedInputsLike = Awaited<ReturnType<typeof loadInputs>>

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

  const projects = await assembleProjects(tenantId, items, snapshot, baseDate, warnings, { keepInRoundOpen: true })

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
    rowProjects: { open: rowProjectsOf(open, OPEN_HEADER_ROWS), closed: rowProjectsOf(closed, CLOSED_HEADER_ROWS) },
  }
}

/**
 * 批次（或試算）明細 → 每案一列，補上批次外的專案、結案分表、分潤調整備註。子資料失敗降級寫進 warnings。
 * keepInRoundOpen：公司格式——已結案但這一批還有本次入帳／本次獎金的案留在「未結案」；管理檢視不需要。
 */
async function assembleProjects(
  tenantId: string,
  items: readonly SerializedItem[],
  snapshot: Record<string, unknown> | null,
  baseDate: string,
  warnings: string[],
  opts: { keepInRoundOpen: boolean; fillSkippedMembers?: boolean },
): Promise<BonusSheetProject[]> {
  const projects = projectsFromItems(items, snapshot)
  if (opts.fillSkippedMembers) {
    const skippedIds = projects.filter((p) => p.skipped && p.members.length === 0).map((p) => p.projectId)
    try {
      for (let i = 0; i < skippedIds.length; i += 100) {
        fillSkippedMembers(projects, await loadInputs(tenantId, baseDate, { projectIds: skippedIds.slice(i, i + 100), archiveRule: "all" }))
      }
    } catch (err) {
      warn(warnings, "被試算跳過的專案成員讀取失敗，這些案的成員與獎金總額暫時不完整", err)
    }
  }
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
      for (const p of projects) p.closed = closed.has(p.projectId) && !(opts.keepInRoundOpen && isInThisRound(p))
    } catch (err) {
      warn(warnings, "專案結案狀態讀取失敗，全部列在「未結案」", err)
    }
  }

  // 分潤調整寫進備註（業主 2026-10-27）；讀不到只少這段，不擋總表。
  if (projects.length > 0) {
    try {
      const roles = new Map(projects.map((p) => [p.projectId, new Map(p.members.map((m) => [m.employeeId, m.role]))]))
      const revisions = await loadShareRevisions(tenantId, projects.map((p) => p.projectId), roles)
      for (const p of projects) {
        const revs = revisions.get(p.projectId)
        if (revs) p.revisionNote = revisionNoteOf(revs)
      }
    } catch (err) {
      warn(warnings, "分潤調整紀錄讀取失敗，備註暫不含分潤調整", err)
    }
  }
  return projects
}

/* ──────────────────────────────────────────────────────────────────
 * 管理檢視（GET /bonus-sheet/manage）：網頁預設，口徑見 services/bonus-manage.ts
 * ────────────────────────────────────────────────────────────────── */

export type BonusManageResult = {
  /** 累計應得的基準日（租戶今天）。 */
  asOf: string
  vatRate: number
  counts: { open: number; closed: number }
  warnings: string[]
  rows: { open: ManageRow[]; closed: ManageRow[] }
  totals: { open: ManageTotals; closed: ManageTotals }
}

export async function loadBonusManage(tenantId: string): Promise<BonusManageResult> {
  const warnings: string[] = []
  const vatRate = await loadP3Settings(tenantId)
    .then((s) => s.vatRate)
    .catch((err) => {
      warn(warnings, "營業稅率讀取失敗，含稅金額暫以 5% 計", err)
      return DEFAULT_VAT_RATE
    })
  const asOf = await tenantToday(tenantId)
  let items: SerializedItem[] = []
  let snapshot: Record<string, unknown> | null = null
  try {
    const preview = await previewRun(tenantId, asOf, null)
    items = preview.items
    snapshot = preview.snapshot
  } catch (err) {
    warn(warnings, "即時試算失敗，可發金額暫時算不出來（只列專案層數字）", err)
  }
  const projects = await assembleProjects(tenantId, items, snapshot, asOf, warnings, { keepInRoundOpen: false, fillSkippedMembers: true })
  let payments: ProjectPaymentTotals = { paid: new Map(), unpaid: new Map() }
  try {
    payments = await loadProjectPaymentTotals(tenantId)
  } catch (err) {
    warn(warnings, "已發放紀錄讀取失敗，已發放暫以 0 計（未發放金額不可信）", err)
  }
  const rows = buildManageRows(projects, payments, vatRate)
  const open = rows.filter((r) => !r.closed)
  const closed = rows.filter((r) => r.closed)
  return {
    asOf,
    vatRate,
    counts: { open: open.length, closed: closed.length },
    warnings,
    rows: { open, closed },
    totals: { open: manageTotalsOf(open), closed: manageTotalsOf(closed) },
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 單一專案的發放歷程（GET /bonus-sheet/projects/:projectId/payouts）
 * ────────────────────────────────────────────────────────────────── */

/**
 * 成員該次的差額標記：
 *   • reversal：紅字沖銷批次（金額為負，等於追回原批）。
 *   • clawback：一般批次金額為負（引擎正常不會產生；舊資料或手動調整才有）＝追扣。
 *   • overpaid：累計應得 < 已發放（超發），本次 0、差額記在 overpaidBy，**不自動追討**（bonus-run.ts）。
 *   • top_up：前一次已發放紀錄是沖銷 → 這次重算把被沖掉的補回來＝補發。
 */
export type PayoutAdjustment = "reversal" | "clawback" | "overpaid" | "top_up"

export type ProjectPayoutMember = {
  employeeId: string
  name: string | null
  empNo: string | null
  /** manager／lead／member／support（批次凍結當下）。 */
  role: string | null
  shareMode: string
  sharePct: number | null
  shareAmount: number | null
  /** 這次的金額（沖銷為負）。 */
  amount: number
  /** 這次之前已發放（批次凍結值）。 */
  paidBefore: number
  /** 超發差額（>0 才有意義）。 */
  overpaidBy: number
  adjustment: PayoutAdjustment | null
}

export type ProjectPayoutRun = {
  runId: string
  label: string
  kind: SerializedRun["kind"]
  status: SerializedRun["status"]
  asOf: string
  submittedAt: string | null
  approvedAt: string | null
  /** 實際發放日（paid 才有）。 */
  paidOn: string | null
  /** 沖銷批次：被沖銷的批次期別。 */
  reversesLabel: string | null
  /** 這批已被（有效的）沖銷批次沖掉；含沖銷草稿＝沖銷中。 */
  reversedByStatus: SerializedRun["status"] | null
  /** 本專案這次的發放總額（成員金額合計）。 */
  total: number
  /** 只有已發放的批次計入累計。 */
  countsTowardPaid: boolean
  /** 截至這次（含）累計已發放。 */
  cumulativePaid: number
  members: ProjectPayoutMember[]
}

export type ProjectPayoutsResult = {
  project: { id: string; code: string | null; name: string | null }
  /** 依時間排序（舊 → 新）；草稿不列。 */
  runs: ProjectPayoutRun[]
  /** 累計已發放＝已發放（含沖銷）批次金額合計＝下一批試算扣掉的「已發放」（loadPaidBefore 口徑）。 */
  paidTotal: number
  /** 已核准／送審中、尚未發放的金額合計（不計入累計）。 */
  pendingTotal: number
  /** 沒列出的草稿批次數（草稿會隨入帳自動重算，金額未定）。 */
  draftCount: number
  /** 分潤調整（依時間舊 → 新；畫面與發放紀錄依時間穿插）。 */
  revisions: ShareRevision[]
  warnings: string[]
}

const roleRank = (role: string | null) => (role === "manager" ? 0 : role === "lead" ? 1 : role === "member" ? 2 : role === "support" ? 3 : 4)

/** 排序時間：已發放用發放日，其餘用核准／送審日，最後用基準日。 */
function payoutTimeKey(r: SerializedRun): string {
  return r.paidOn ?? r.approvedAt?.slice(0, 10) ?? r.submittedAt?.slice(0, 10) ?? r.asOf
}

/** 純函式：批次清單＋本專案的明細列 → 依時間排序的發放歷程。草稿不列（只回筆數）。 */
export function buildProjectPayouts(
  project: ProjectPayoutsResult["project"],
  runs: readonly SerializedRun[],
  items: readonly SerializedItem[],
  revisions: readonly ShareRevision[] = [],
): ProjectPayoutsResult {
  const byRun = new Map<string, SerializedItem[]>()
  for (const it of items) {
    if (it.projectId !== project.id || !it.runId) continue
    const arr = byRun.get(it.runId) ?? []
    arr.push(it)
    byRun.set(it.runId, arr)
  }
  const labelById = new Map(runs.map((r) => [r.id, r.label]))
  const involved = runs.filter((r) => byRun.has(r.id))
  const draftCount = involved.filter((r) => r.status === "draft").length
  const ordered = involved
    .filter((r) => r.status !== "draft")
    .sort((a, b) => payoutTimeKey(a).localeCompare(payoutTimeKey(b)) || a.createdAt.localeCompare(b.createdAt))

  const warnings: string[] = []
  let cumulative = 0
  // 每位成員：累計已發放、最近一次已發放紀錄是不是沖銷（判斷補發）。
  const paidByEmp = new Map<string, number>()
  const lastPaidWasReversal = new Map<string, boolean>()
  const out: ProjectPayoutRun[] = ordered.map((r) => {
    const rows = [...(byRun.get(r.id) ?? [])].sort(
      (a, b) => roleRank(a.roleInProject) - roleRank(b.roleInProject) || (a.empNo ?? "").localeCompare(b.empNo ?? "") || (a.employeeName ?? "").localeCompare(b.employeeName ?? ""),
    )
    const paid = r.status === "paid"
    let mismatch = false
    const members: ProjectPayoutMember[] = rows.map((it) => {
      const adjustment: PayoutAdjustment | null =
        r.kind === "reversal"
          ? "reversal"
          : it.amount < 0
            ? "clawback"
            : it.overpaid && it.overpaidBy > 0
              ? "overpaid"
              : it.amount > 0 && lastPaidWasReversal.get(it.employeeId)
                ? "top_up"
                : null
      if (paid) {
        const before = paidByEmp.get(it.employeeId) ?? 0
        if (Math.abs(before - it.paidBefore) >= 1) mismatch = true
        paidByEmp.set(it.employeeId, before + it.amount)
        if (it.amount !== 0) lastPaidWasReversal.set(it.employeeId, r.kind === "reversal")
      }
      return {
        employeeId: it.employeeId,
        name: it.employeeName,
        empNo: it.empNo,
        role: it.roleInProject,
        shareMode: it.shareMode,
        sharePct: it.sharePct,
        shareAmount: it.shareAmount,
        amount: it.amount,
        paidBefore: it.paidBefore,
        overpaidBy: it.overpaid ? it.overpaidBy : 0,
        adjustment,
      }
    })
    const total = Math.round(members.reduce((s, m) => s + m.amount, 0) * 100) / 100
    if (paid) cumulative = Math.round((cumulative + total) * 100) / 100
    if (mismatch) warnings.push(`${r.label}：批次記錄的「之前已發放」與歷程累計不一致（可能有已刪除或排序不同的批次），以各批次凍結金額為準`)
    return {
      runId: r.id,
      label: r.label,
      kind: r.kind,
      status: r.status,
      asOf: r.asOf,
      submittedAt: r.submittedAt,
      approvedAt: r.approvedAt,
      paidOn: r.paidOn,
      reversesLabel: r.reversesRunId ? (labelById.get(r.reversesRunId) ?? null) : null,
      reversedByStatus: r.reversedByStatus,
      total,
      countsTowardPaid: paid,
      cumulativePaid: cumulative,
      members,
    }
  })
  const pendingTotal = Math.round(out.filter((r) => !r.countsTowardPaid).reduce((s, r) => s + r.total, 0) * 100) / 100
  return { project, runs: out, paidTotal: cumulative, pendingTotal, draftCount, revisions: [...revisions], warnings }
}

/** IO：專案不存在（或別租戶）→ null（路由回 404）。 */
export async function loadProjectPayouts(tenantId: string, projectId: string): Promise<ProjectPayoutsResult | null> {
  const { data, error } = await supabaseAdmin.from("projects").select("id, code, name").eq("tenant_id", tenantId).eq("id", projectId).maybeSingle()
  if (error) throw new Error(`bonus-sheet payouts (project): ${error.message}`)
  if (!data) return null
  const { runs, items } = await listProjectRunItems(tenantId, projectId)
  let revisions: ShareRevision[] = []
  let revisionError: unknown = null
  try {
    revisions = (await loadShareRevisions(tenantId, [projectId])).get(projectId) ?? []
  } catch (err) {
    revisionError = err
  }
  const result = buildProjectPayouts({ id: data.id as string, code: (data.code as string | null) ?? null, name: (data.name as string | null) ?? null }, runs, items, revisions)
  if (revisionError) warn(result.warnings, "分潤調整紀錄讀取失敗，暫不顯示分潤調整", revisionError)
  return result
}
