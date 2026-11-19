import { supabaseAdmin } from "../lib/supabase.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { runPeriod } from "./bonus-run.js"

/**
 * 每期款獎金 × 季獎金（2026-11-19，migration 0119）。
 *
 * 申請單付款階段每一期：「本期獎金」（手填）＋「算法說明」＋分給成員的金額（project_billing_shares）＋發獎金日
 * （project_billing_bonus_dates）。這支負責：
 *   • 季度偵測：季獎金批次（bonus_runs）建立／重算時，把「發獎金日 ≤ 該批次季末、有分給成員、尚未發放」的每期分潤
 *     自動帶入，凍結在 bonus_run_billing_items（批次 × 期別 × 員工一列）。季度＝季獎金既有定義
 *     （bonus-run.ts runPeriod：標籤 "YYYY-Qn"，不是這個格式就用基準日所在季）。
 *     發獎金日在**本季以前**、但還沒發的（例如上季批次已發後才補設定）也帶入、標「逾期補發」——不然永遠不會被發到。
 *     發獎金日未填、在本季以後、金額 0 → 不帶入。
 *   • 已發認定：所屬批次 status='paid'、未刪 → 已發；沖銷批次寫負數列，同一（期別、員工）淨額歸零＝未發（解鎖、
 *     下一季重新帶入）。已發的期別在 DB 函式 set_billing_bonus_shares_batch 鎖住（BL409）。
 *   • 專案總覽：合約（未稅）、獎金上限（合約未稅 × 上限比例）、已發（每期分潤＋季獎金，分開列）、占合約 %、
 *     已設定未發、可發餘額。
 * 季獎金原本的比例制計算（computeBonusRun／bonus_run_items）一行都不動：沒有每期分潤的專案，季獎金金額與改前相同。
 */

export const RUN_BILLING_ITEMS_TABLE = "bonus_run_billing_items"
export const BONUS_CAPS_TABLE = "project_billing_bonus_caps"
export const BONUS_DATES_TABLE = "project_billing_bonus_dates"
export const SHARES_TABLE = "project_billing_shares"

/** DB 錯誤碼：分給成員的合計超過本期獎金（migration 0119）。 */
export const SHARES_EXCEED_BONUS_ERRCODE = "BS422"
/** DB 錯誤碼：期別已發放（季獎金批次 paid）不可改人／金額／本期獎金／發獎金日（migration 0119）。 */
export const BILLING_BONUS_PAID_ERRCODE = "BL409"

const NEGATIVE_TTL_MS = 60_000
let probe: { exists: boolean; at: number } | null = null

/** migration 0119 是否已套用（新欄＋兩張新表）；「有」永久快取、「沒有」快取 60 秒。 */
export async function billingBonusQuarterReady(): Promise<boolean> {
  if (probe && (probe.exists || Date.now() - probe.at < NEGATIVE_TTL_MS)) return probe.exists
  const [a, b, c] = await Promise.all([
    supabaseAdmin.from(BONUS_DATES_TABLE).select("billing_id, bonus_amount, formula_note").limit(1),
    supabaseAdmin.from(RUN_BILLING_ITEMS_TABLE).select("id").limit(1),
    supabaseAdmin.from(BONUS_CAPS_TABLE).select("project_id").limit(1),
  ])
  const err = a.error ?? b.error ?? c.error
  const missing = !!err && (isMissingTableError(err) || isMissingColumnError(err))
  if (missing) warnSchemaGapOnce(`${RUN_BILLING_ITEMS_TABLE} (migration 0119)`, err)
  if (err && !missing) throw new Error(`billingBonusQuarterReady: ${err.message}`)
  probe = { exists: !missing, at: Date.now() }
  return probe.exists
}

/** 測試用：清掉探測快取。 */
export function resetBillingBonusQuarterProbe(): void {
  probe = null
}

/* ──────────────────────────────────────────────────────────────────
 * 純函式
 * ────────────────────────────────────────────────────────────────── */

const pad2 = (n: number) => String(n).padStart(2, "0")

/** 季的起訖日（含）："2026-Q4" → 2026-10-01 ～ 2026-12-31。 */
export function quarterRange(year: number, quarter: number): { start: string; end: string } {
  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = startMonth + 2
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate()
  return { start: `${year}-${pad2(startMonth)}-01`, end: `${year}-${pad2(endMonth)}-${pad2(lastDay)}` }
}

/** 批次所屬季（同季獎金既有定義：標籤能 parse 用標籤，否則基準日所在季）與起訖日。 */
export function runQuarterOf(run: { label: string; asOf: string }): { year: number; quarter: number; start: string; end: string } {
  const p = runPeriod({ id: "", label: run.label, asOf: run.asOf, paidOn: null })
  return { ...p, ...quarterRange(p.year, p.quarter) }
}

export function billingNetKey(billingId: string, employeeId: string): string {
  return `${billingId.toLowerCase()}:${employeeId.toLowerCase()}`
}

const cents = (n: number) => Math.round(n * 100)
const fromCents = (c: number) => c / 100

export type BillingShareRow = { billingId: string; projectId: string; employeeId: string; amount: number }
export type BillingDateRow = { billingId: string; projectId: string; bonusPaidOn: string | null; bonusAmount: number | null; formulaNote: string | null }
export type BillingMeta = { billingId: string; projectId: string; installmentNo: number | null; milestone: string | null; kind: string | null; deleted: boolean }

export type RunBillingCandidate = {
  billingId: string
  projectId: string
  employeeId: string
  amount: number
  bonusPaidOn: string
  /** 發獎金日在本季以前（逾期補發）。 */
  overdue: boolean
}

/**
 * 純函式：某季批次要帶入的每期分潤。
 * 帶入條件：發獎金日已填且 ≤ 季末；金額 > 0；期別存在、未刪、不是代墊款；專案未刪；該（期別、員工）在其他
 * 已發批次的淨額為 0（沒發過，或發過又被沖銷）。
 */
export function selectRunBillingItems(input: {
  range: { start: string; end: string }
  shares: readonly BillingShareRow[]
  dates: ReadonlyMap<string, BillingDateRow>
  billings: ReadonlyMap<string, BillingMeta>
  liveProjects: ReadonlySet<string>
  netPaid: ReadonlyMap<string, number>
}): RunBillingCandidate[] {
  const out: RunBillingCandidate[] = []
  for (const s of input.shares) {
    const bid = s.billingId.toLowerCase()
    const d = input.dates.get(bid)
    if (!d?.bonusPaidOn || d.bonusPaidOn > input.range.end) continue
    if (!(cents(s.amount) > 0)) continue
    const b = input.billings.get(bid)
    if (!b || b.deleted || b.kind === "guild_advance") continue
    if (!input.liveProjects.has(s.projectId.toLowerCase())) continue
    if (cents(input.netPaid.get(billingNetKey(s.billingId, s.employeeId)) ?? 0) !== 0) continue
    out.push({
      billingId: s.billingId,
      projectId: s.projectId,
      employeeId: s.employeeId,
      amount: fromCents(cents(s.amount)),
      bonusPaidOn: d.bonusPaidOn,
      overdue: d.bonusPaidOn < input.range.start,
    })
  }
  out.sort(
    (a, b) =>
      a.bonusPaidOn.localeCompare(b.bonusPaidOn) ||
      a.projectId.localeCompare(b.projectId) ||
      a.billingId.localeCompare(b.billingId) ||
      a.employeeId.localeCompare(b.employeeId),
  )
  return out
}

/** 已發放（淨額 ≠ 0）的期別 id（小寫）。 */
export function paidBillingIdsOf(netPaid: ReadonlyMap<string, number>): Set<string> {
  const out = new Set<string>()
  for (const [key, amount] of netPaid) if (cents(amount) !== 0) out.add(key.split(":")[0])
  return out
}

/** 金額指紋用：每期分潤列以 `billing:<id>` 當 projectId，跟比例制明細一起算指紋（沒有每期分潤時指紋與改前相同）。 */
export function billingFingerprintEntries(items: ReadonlyArray<{ billingId: string; employeeId: string; amount: number }>) {
  return items.map((i) => ({ projectId: `billing:${i.billingId.toLowerCase()}`, employeeId: i.employeeId, amount: i.amount }))
}

export type BillingBonusOverview = {
  /** 合約金額（未稅，同 billing-store.contractTotal）；沒有合約 null。 */
  contractTotal: number | null
  /** 獎金上限比例（%）；沒設 null。 */
  capPct: number | null
  /** 獎金上限＝合約（未稅）× 上限比例（到元）；任一缺 null。 */
  cap: number | null
  /** 已發：每期款獎金（已發批次帶入的淨額）。 */
  paidBilling: number
  /** 已發：季獎金比例制（已發批次 bonus_run_items 淨額，含沖銷）。 */
  paidQuarterly: number
  paidTotal: number
  /** 已發合計占合約 %（小數 2 位）；沒有合約 null。 */
  paidPct: number | null
  /** 已設定未發：分給成員、尚未發放的每期分潤合計。 */
  setUnpaid: number
  /** 可發餘額＝上限 − 已發 − 已設定未發；沒有上限 null。 */
  available: number | null
  /** 同一案同時有季獎金比例制與每期分潤（兩種來源，提醒不要重複發）。 */
  dualSource: boolean
}

/** 純函式：專案獎金總覽。 */
export function billingOverviewOf(input: {
  contractTotal: number | null
  capPct: number | null
  /** 該案每一列分潤（期別、員工、金額）。 */
  shares: ReadonlyArray<{ billingId: string; employeeId: string; amount: number }>
  /** （期別、員工）→ 已發淨額。 */
  netPaid: ReadonlyMap<string, number>
  paidQuarterly: number
  hasQuarterlyShares: boolean
}): BillingBonusOverview {
  let paidC = 0
  for (const v of input.netPaid.values()) paidC += cents(v)
  let unpaidC = 0
  for (const s of input.shares) {
    if (cents(input.netPaid.get(billingNetKey(s.billingId, s.employeeId)) ?? 0) !== 0) continue
    unpaidC += cents(s.amount)
  }
  const paidBilling = fromCents(paidC)
  const paidQuarterly = fromCents(cents(input.paidQuarterly))
  const paidTotal = fromCents(paidC + cents(input.paidQuarterly))
  const cap =
    input.contractTotal !== null && input.capPct !== null ? Math.round((input.contractTotal * input.capPct) / 100) : null
  return {
    contractTotal: input.contractTotal,
    capPct: input.capPct,
    cap,
    paidBilling,
    paidQuarterly,
    paidTotal,
    paidPct: input.contractTotal !== null && input.contractTotal > 0 ? Math.round((paidTotal / input.contractTotal) * 10000) / 100 : null,
    setUnpaid: fromCents(unpaidC),
    available: cap === null ? null : fromCents(cents(cap) - paidC - cents(input.paidQuarterly) - unpaidC),
    dualSource: input.hasQuarterlyShares && input.shares.some((s) => cents(s.amount) > 0),
  }
}

/* ──────────────────────────────────────────────────────────────────
 * IO
 * ────────────────────────────────────────────────────────────────── */

function n(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const x = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(x) ? x : null
}

function chunks<T>(arr: readonly T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * （期別、員工）→ 已發淨額：status='paid'、未刪批次裡的 bonus_run_billing_items 加總（沖銷負數會抵掉）。
 * excludeRunId：重算某批次時不算它自己。billingIds／projectIds：只撈這些（省流量）。
 */
export async function loadBillingNetPaid(
  tenantId: string,
  opts: { excludeRunId?: string | null; billingIds?: readonly string[]; projectIds?: readonly string[] } = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let q = supabaseAdmin.from("bonus_runs").select("id").eq("tenant_id", tenantId).eq("status", "paid").is("deleted_at", null)
  if (opts.excludeRunId) q = q.neq("id", opts.excludeRunId)
  const { data: runs, error } = await q
  if (error) throw new Error(`billing-bonus loadBillingNetPaid (runs): ${error.message}`)
  const runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (runIds.length === 0) return out
  if (opts.billingIds && opts.billingIds.length === 0) return out
  if (opts.projectIds && opts.projectIds.length === 0) return out
  type Row = { billing_id: string; employee_id: string; amount: string | number }
  const filterChunks: Array<{ col: string; ids: string[] } | null> = opts.billingIds
    ? chunks([...new Set(opts.billingIds)]).map((ids) => ({ col: "billing_id", ids }))
    : opts.projectIds
      ? chunks([...new Set(opts.projectIds)]).map((ids) => ({ col: "project_id", ids }))
      : [null]
  for (const runChunk of chunks(runIds)) {
    for (const f of filterChunks) {
      const rows = await selectAllPages<Row>(
        (from, to) => {
          let qq = supabaseAdmin
            .from(RUN_BILLING_ITEMS_TABLE)
            .select("billing_id, employee_id, amount")
            .eq("tenant_id", tenantId)
            .in("run_id", runChunk)
          if (f) qq = qq.in(f.col, f.ids)
          return qq.order("id", { ascending: true }).range(from, to)
        },
        "billing-bonus loadBillingNetPaid (items)",
      )
      for (const r of rows) {
        const key = billingNetKey(r.billing_id, r.employee_id)
        out.set(key, fromCents(cents(out.get(key) ?? 0) + cents(n(r.amount) ?? 0)))
      }
    }
  }
  return out
}

/** 寫進 bonus_run_billing_items.snapshot 的顯示資訊（人名／案名／期別日後改了也不影響已發批次的可讀性）。 */
export type RunBillingSnapshot = {
  projectCode?: string | null
  projectName?: string | null
  installmentNo?: number | null
  milestone?: string | null
  employeeName?: string | null
  empNo?: string | null
  formulaNote?: string | null
  bonusAmount?: number | null
  overdue?: boolean
  reversalOfItemId?: string
}

export type RunBillingItemCalc = RunBillingCandidate & { snapshot: RunBillingSnapshot }

/** 某季批次要帶入的每期分潤（含顯示用快照）。migration 0119 未套用 → 空陣列。 */
export async function loadRunBillingCandidates(
  tenantId: string,
  run: { label: string; asOf: string },
  excludeRunId?: string | null,
): Promise<RunBillingItemCalc[]> {
  if (!(await billingBonusQuarterReady())) return []
  const range = runQuarterOf(run)
  type DateDb = { billing_id: string; project_id: string; bonus_paid_on: string | null; bonus_amount: string | number | null; formula_note: string | null }
  const dateRows = await selectAllPages<DateDb>(
    (from, to) =>
      supabaseAdmin
        .from(BONUS_DATES_TABLE)
        .select("billing_id, project_id, bonus_paid_on, bonus_amount, formula_note")
        .eq("tenant_id", tenantId)
        .not("bonus_paid_on", "is", null)
        .lte("bonus_paid_on", range.end)
        .order("billing_id", { ascending: true })
        .range(from, to),
    "billing-bonus loadRunBillingCandidates (dates)",
  )
  if (dateRows.length === 0) return []
  const billingIds = dateRows.map((d) => d.billing_id)
  type ShareDb = { billing_id: string; project_id: string; employee_id: string; amount: string | number }
  type BillingDb = { id: string; project_id: string; installment_no: number | null; milestone: string | null; kind: string | null; deleted_at: string | null }
  const shares: ShareDb[] = []
  const billingRows: BillingDb[] = []
  for (const ids of chunks(billingIds)) {
    shares.push(
      ...(await selectAllPages<ShareDb>(
        (from, to) =>
          supabaseAdmin
            .from(SHARES_TABLE)
            .select("billing_id, project_id, employee_id, amount")
            .eq("tenant_id", tenantId)
            .in("billing_id", ids)
            .order("id", { ascending: true })
            .range(from, to),
        "billing-bonus loadRunBillingCandidates (shares)",
      )),
    )
    const { data, error } = await supabaseAdmin
      .from("project_billings")
      .select("id, project_id, installment_no, milestone, kind, deleted_at")
      .eq("tenant_id", tenantId)
      .in("id", ids)
    if (error) throw new Error(`billing-bonus loadRunBillingCandidates (billings): ${error.message}`)
    billingRows.push(...((data ?? []) as BillingDb[]))
  }
  if (shares.length === 0) return []
  const projectIds = [...new Set(shares.map((s) => s.project_id))]
  type ProjectDb = { id: string; code: string | null; name: string | null; deleted_at: string | null }
  const projects: ProjectDb[] = []
  for (const ids of chunks(projectIds)) {
    const { data, error } = await supabaseAdmin.from("projects").select("id, code, name, deleted_at").eq("tenant_id", tenantId).in("id", ids)
    if (error) throw new Error(`billing-bonus loadRunBillingCandidates (projects): ${error.message}`)
    projects.push(...((data ?? []) as ProjectDb[]))
  }
  const netPaid = await loadBillingNetPaid(tenantId, { excludeRunId, billingIds })
  const dates = new Map<string, BillingDateRow>(
    dateRows.map((d) => [
      d.billing_id.toLowerCase(),
      { billingId: d.billing_id, projectId: d.project_id, bonusPaidOn: d.bonus_paid_on, bonusAmount: n(d.bonus_amount), formulaNote: d.formula_note },
    ]),
  )
  const billings = new Map<string, BillingMeta>(
    billingRows.map((b) => [
      b.id.toLowerCase(),
      { billingId: b.id, projectId: b.project_id, installmentNo: b.installment_no, milestone: b.milestone, kind: b.kind, deleted: b.deleted_at !== null },
    ]),
  )
  const liveProjects = new Set(projects.filter((p) => !p.deleted_at).map((p) => p.id.toLowerCase()))
  const picked = selectRunBillingItems({
    range,
    shares: shares.map((s) => ({ billingId: s.billing_id, projectId: s.project_id, employeeId: s.employee_id, amount: n(s.amount) ?? 0 })),
    dates,
    billings,
    liveProjects,
    netPaid,
  })
  if (picked.length === 0) return []
  const empIds = [...new Set(picked.map((p) => p.employeeId))]
  const emps = new Map<string, { name: string | null; emp_no: string | null }>()
  for (const ids of chunks(empIds)) {
    const { data, error } = await supabaseAdmin.from("employees").select("id, name, emp_no").eq("tenant_id", tenantId).in("id", ids)
    if (error) throw new Error(`billing-bonus loadRunBillingCandidates (employees): ${error.message}`)
    for (const e of (data ?? []) as Array<{ id: string; name: string | null; emp_no: string | null }>) emps.set(e.id.toLowerCase(), e)
  }
  const projectOf = new Map(projects.map((p) => [p.id.toLowerCase(), p]))
  return picked.map((p) => {
    const b = billings.get(p.billingId.toLowerCase())
    const d = dates.get(p.billingId.toLowerCase())
    const pr = projectOf.get(p.projectId.toLowerCase())
    const e = emps.get(p.employeeId.toLowerCase())
    return {
      ...p,
      snapshot: {
        projectCode: pr?.code ?? null,
        projectName: pr?.name ?? null,
        installmentNo: b?.installmentNo ?? null,
        milestone: b?.milestone ?? null,
        employeeName: e?.name ?? null,
        empNo: e?.emp_no ?? null,
        formulaNote: d?.formulaNote ?? null,
        bonusAmount: d?.bonusAmount ?? null,
        overdue: p.overdue,
      },
    }
  })
}

export type RunBillingItemRow = {
  id: string
  run_id: string
  project_id: string
  billing_id: string
  employee_id: string
  amount: string | number
  bonus_paid_on: string | null
  snapshot: RunBillingSnapshot | null
}

const ITEM_COLS = "id, run_id, project_id, billing_id, employee_id, amount, bonus_paid_on, snapshot"

/** 批次的每期分潤列；migration 未套用 → 空陣列。runIds 可一次多批。 */
export async function loadRunBillingItemRows(tenantId: string, runIds: readonly string[], employeeId?: string | null): Promise<RunBillingItemRow[]> {
  if (runIds.length === 0 || !(await billingBonusQuarterReady())) return []
  const out: RunBillingItemRow[] = []
  for (const ids of chunks([...new Set(runIds)])) {
    out.push(
      ...(await selectAllPages<RunBillingItemRow>(
        (from, to) => {
          let q = supabaseAdmin.from(RUN_BILLING_ITEMS_TABLE).select(ITEM_COLS).eq("tenant_id", tenantId).in("run_id", ids)
          if (employeeId) q = q.eq("employee_id", employeeId)
          return q.order("id", { ascending: true }).range(from, to)
        },
        "billing-bonus loadRunBillingItemRows",
      )),
    )
  }
  return out
}

/** 整批換掉某（未發放）批次的每期分潤列。paid 批次 DB 觸發器會擋（23001）。 */
export async function replaceRunBillingItems(
  tenantId: string,
  runId: string,
  items: ReadonlyArray<{ billingId: string; projectId: string; employeeId: string; amount: number; bonusPaidOn: string | null; snapshot: RunBillingSnapshot }>,
): Promise<void> {
  if (!(await billingBonusQuarterReady())) return
  const existing = await loadRunBillingItemRows(tenantId, [runId])
  if (existing.length > 0) {
    const { error } = await supabaseAdmin.from(RUN_BILLING_ITEMS_TABLE).delete().eq("tenant_id", tenantId).eq("run_id", runId)
    if (error) {
      const e = new Error(`billing-bonus replaceRunBillingItems (delete): ${error.message}`) as Error & { code?: string }
      e.code = error.code ?? undefined
      throw e
    }
  }
  if (items.length === 0) return
  const { error } = await supabaseAdmin.from(RUN_BILLING_ITEMS_TABLE).insert(
    items.map((i) => ({
      tenant_id: tenantId,
      run_id: runId,
      project_id: i.projectId,
      billing_id: i.billingId,
      employee_id: i.employeeId,
      amount: i.amount,
      bonus_paid_on: i.bonusPaidOn,
      snapshot: i.snapshot,
    })),
  )
  if (error) {
    const e = new Error(`billing-bonus replaceRunBillingItems (insert): ${error.message}`) as Error & { code?: string }
    e.code = error.code ?? undefined
    throw e
  }
}

export type SerializedRunBillingItem = {
  id: string | null
  runId: string | null
  /** 固定 'billing'：來源「每期款獎金」（與季獎金比例制明細區分）。 */
  source: "billing"
  projectId: string
  projectCode: string | null
  projectName: string | null
  billingId: string
  installmentNo: number | null
  milestone: string | null
  employeeId: string
  employeeName: string | null
  empNo: string | null
  amount: number
  bonusPaidOn: string | null
  formulaNote: string | null
  overdue: boolean
  /** 顯示用來源說明：「每期款獎金：專案X第N期」。 */
  sourceLabel: string
}

export function sourceLabelOf(s: { projectCode?: string | null; projectName?: string | null; installmentNo?: number | null }): string {
  const proj = [s.projectCode, s.projectName].filter((x) => !!x && String(x).trim() !== "").join(" ") || "專案"
  return `每期款獎金：${proj}${s.installmentNo ? `第${s.installmentNo}期` : ""}`
}

export function serializeRunBillingItem(row: RunBillingItemRow): SerializedRunBillingItem {
  const s = row.snapshot ?? {}
  return {
    id: row.id,
    runId: row.run_id,
    source: "billing",
    projectId: row.project_id,
    projectCode: s.projectCode ?? null,
    projectName: s.projectName ?? null,
    billingId: row.billing_id,
    installmentNo: s.installmentNo ?? null,
    milestone: s.milestone ?? null,
    employeeId: row.employee_id,
    employeeName: s.employeeName ?? null,
    empNo: s.empNo ?? null,
    amount: n(row.amount) ?? 0,
    bonusPaidOn: row.bonus_paid_on,
    formulaNote: s.formulaNote ?? null,
    overdue: s.overdue === true,
    sourceLabel: sourceLabelOf(s),
  }
}

export function serializeCandidate(c: RunBillingItemCalc): SerializedRunBillingItem {
  return serializeRunBillingItem({
    id: null as unknown as string,
    run_id: null as unknown as string,
    project_id: c.projectId,
    billing_id: c.billingId,
    employee_id: c.employeeId,
    amount: c.amount,
    bonus_paid_on: c.bonusPaidOn,
    snapshot: c.snapshot,
  })
}

export function compareBillingItems(a: SerializedRunBillingItem, b: SerializedRunBillingItem): number {
  return (
    (a.projectCode ?? "").localeCompare(b.projectCode ?? "") ||
    (a.projectName ?? "").localeCompare(b.projectName ?? "") ||
    (a.installmentNo ?? 0) - (b.installmentNo ?? 0) ||
    (a.empNo ?? "").localeCompare(b.empNo ?? "") ||
    (a.employeeName ?? "").localeCompare(b.employeeName ?? "")
  )
}

/** 一案的獎金上限比例（%）；沒設或表未套用 → null。 */
export async function loadCapPct(tenantId: string, projectId: string): Promise<number | null> {
  if (!(await billingBonusQuarterReady())) return null
  const { data, error } = await supabaseAdmin
    .from(BONUS_CAPS_TABLE)
    .select("cap_pct")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .maybeSingle()
  if (error) throw new Error(`billing-bonus loadCapPct: ${error.message}`)
  return n((data as { cap_pct?: string | number | null } | null)?.cap_pct ?? null)
}

/** 全租戶的上限比例（管理檢視用）。 */
export async function loadAllCapPct(tenantId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!(await billingBonusQuarterReady())) return out
  const rows = await selectAllPages<{ project_id: string; cap_pct: string | number }>(
    (from, to) =>
      supabaseAdmin.from(BONUS_CAPS_TABLE).select("project_id, cap_pct").eq("tenant_id", tenantId).order("project_id", { ascending: true }).range(from, to),
    "billing-bonus loadAllCapPct",
  )
  for (const r of rows) {
    const v = n(r.cap_pct)
    if (v !== null) out.set(r.project_id, v)
  }
  return out
}

/** 寫入上限比例（DB 函式 set_billing_bonus_cap；null＝清掉）。 */
export async function saveCapPct(tenantId: string, projectId: string, capPct: number | null, actorEmpId: string | null): Promise<void> {
  const { error } = await supabaseAdmin.rpc("set_billing_bonus_cap", {
    p_tenant_id: tenantId,
    p_project_id: projectId,
    p_cap_pct: capPct,
    p_actor_emp_id: actorEmpId,
  })
  if (error) {
    const e = new Error(`set_billing_bonus_cap: ${error.message}`) as Error & { code?: string }
    e.code = error.code ?? undefined
    throw e
  }
}

/** 每案季獎金比例制已發淨額（paid、未刪批次的 bonus_run_items，含沖銷；stale 列金額已是 0）。 */
export async function loadQuarterlyPaidByProject(tenantId: string, projectIds?: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const { data: runs, error } = await supabaseAdmin.from("bonus_runs").select("id").eq("tenant_id", tenantId).eq("status", "paid").is("deleted_at", null)
  if (error) throw new Error(`billing-bonus loadQuarterlyPaidByProject (runs): ${error.message}`)
  const runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (runIds.length === 0 || (projectIds && projectIds.length === 0)) return out
  const projectChunks: Array<string[] | null> = projectIds ? chunks([...new Set(projectIds)]) : [null]
  for (const runChunk of chunks(runIds)) {
    for (const pc of projectChunks) {
      const rows = await selectAllPages<{ project_id: string; amount: string | number | null }>(
        (from, to) => {
          let q = supabaseAdmin.from("bonus_run_items").select("project_id, amount").eq("tenant_id", tenantId).in("run_id", runChunk)
          if (pc) q = q.in("project_id", pc)
          return q.order("id", { ascending: true }).range(from, to)
        },
        "billing-bonus loadQuarterlyPaidByProject (items)",
      )
      for (const r of rows) out.set(r.project_id, fromCents(cents(out.get(r.project_id) ?? 0) + cents(n(r.amount) ?? 0)))
    }
  }
  return out
}

/** 全租戶：每案每期分潤列（管理檢視總覽用）；表未套用 → 空。 */
export async function loadAllBillingShares(tenantId: string): Promise<Array<{ billingId: string; projectId: string; employeeId: string; amount: number }>> {
  if (!(await billingBonusQuarterReady())) return []
  const rows = await selectAllPages<{ billing_id: string; project_id: string; employee_id: string; amount: string | number }>(
    (from, to) =>
      supabaseAdmin
        .from(SHARES_TABLE)
        .select("billing_id, project_id, employee_id, amount")
        .eq("tenant_id", tenantId)
        .order("id", { ascending: true })
        .range(from, to),
    "billing-bonus loadAllBillingShares",
  )
  // 已刪期別的分潤不算（期別軟刪除前一定要先清分潤，DB 觸發器擋；這裡保守再濾一次）。
  return rows.map((r) => ({ billingId: r.billing_id, projectId: r.project_id, employeeId: r.employee_id, amount: n(r.amount) ?? 0 }))
}

/** 全租戶：（期別、員工）已發淨額＋期別所屬專案（管理檢視總覽用）。 */
export async function loadAllBillingNetPaidByProject(tenantId: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>()
  if (!(await billingBonusQuarterReady())) return out
  const { data: runs, error } = await supabaseAdmin.from("bonus_runs").select("id").eq("tenant_id", tenantId).eq("status", "paid").is("deleted_at", null)
  if (error) throw new Error(`billing-bonus loadAllBillingNetPaidByProject (runs): ${error.message}`)
  const runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id)
  for (const ids of chunks(runIds)) {
    const rows = await selectAllPages<{ project_id: string; billing_id: string; employee_id: string; amount: string | number }>(
      (from, to) =>
        supabaseAdmin
          .from(RUN_BILLING_ITEMS_TABLE)
          .select("project_id, billing_id, employee_id, amount")
          .eq("tenant_id", tenantId)
          .in("run_id", ids)
          .order("id", { ascending: true })
          .range(from, to),
      "billing-bonus loadAllBillingNetPaidByProject (items)",
    )
    for (const r of rows) {
      const m = out.get(r.project_id) ?? new Map<string, number>()
      const key = billingNetKey(r.billing_id, r.employee_id)
      m.set(key, fromCents(cents(m.get(key) ?? 0) + cents(n(r.amount) ?? 0)))
      out.set(r.project_id, m)
    }
  }
  return out
}
