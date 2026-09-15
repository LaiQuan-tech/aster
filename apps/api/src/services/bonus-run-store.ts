import { supabaseAdmin } from "../lib/supabase.js"
import { OUR_CONTRACT_ROLES } from "../lib/contract-role.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { isUniqueViolation } from "./project-code.js"
import { writeAuditLog } from "./audit.js"
import {
  buildBonusSummary,
  computeBonusRun,
  paidBeforeKey,
  type BonusItemCalc,
  type BonusProjectInput,
  type BonusRunStatus,
  type BonusSummary,
  type BonusTotals,
  type SummaryItemInput,
  type SummaryRunInput,
} from "./bonus-run.js"

/**
 * 獎金季發放批次的 IO（bonus_runs／bonus_run_items）。算法在 bonus-run.ts（純函式），
 * 這裡負責：把專案／成員／合約／入帳從 DB 讀成純函式的輸入、把結果寫成快照、
 * 狀態機（draft → paid）、軟刪、列表／明細／歷年彙總／ESS 個人紀錄。
 *
 * ── 狀態機 ────────────────────────────────────────────────────────
 *   draft ──pay──▶ paid（凍結：DB trigger forbid_paid_bonus_mutation 擋 UPDATE/DELETE）
 *   draft ──delete──▶ 軟刪（deleted_at；no_hard_delete 不允許實體刪）
 *   paid 不能改、不能刪、也**不做 void**：發錯了就再開一批（v1 尚未提供負數
 *   調整批次，見 routes/bonus-runs.ts 檔頭）。
 *
 * ── draft 重算與「stale」明細列 ─────────────────────────────────────
 * PATCH draft 會重算 items。bonus_run_items 對正式租戶掛了 no_hard_delete，
 * 重算時「這個人已經不在該案成員名單」的舊列**刪不掉**，只能就地歸零並在
 * snapshot 標 `stale: true`；所有讀取端（明細／xlsx／summary／ESS）一律過濾
 * stale 列，paid_before 加總也不受影響（金額已是 0）。同一人日後再被加回成員，
 * upsert 會把同一列救回來（unique(run, project, employee)）。
 *
 * ── pay 前的一致性檢查 ───────────────────────────────────────────────
 * 兩個 draft 同時存在、先 pay 了其中一個，另一個 draft 存的 paid_before 就過期了
 * （沒扣到剛發出去的那筆）——直接 pay 會重複發放。所以 pay 時逐列重抓 paid_before
 * 比對，任何一列不一致就 409 stale_paid_before，要求先重算（PATCH）再 pay。
 */

export class BonusRunError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = "BonusRunError"
  }
}

export type Actor = { empId: string | null }

/* ──────────────────────────────────────────────────────────────────
 * DB 列型別（snake_case）與序列化
 * ────────────────────────────────────────────────────────────────── */

const RUN_COLS =
  "id, tenant_id, label, as_of, status, paid_on, totals, snapshot, note, created_by_emp_id, paid_by_emp_id, created_at, updated_at, deleted_at, deleted_by_emp_id, delete_reason"

type RunRow = {
  id: string
  tenant_id: string
  label: string
  as_of: string
  status: string
  paid_on: string | null
  totals: BonusTotals | Record<string, never> | null
  snapshot: Record<string, unknown> | null
  note: string | null
  created_by_emp_id: string | null
  paid_by_emp_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by_emp_id: string | null
  delete_reason: string | null
}

const ITEM_COLS =
  "id, tenant_id, run_id, project_id, employee_id, share_mode, share_pct, share_amount, bonus_pool, contract_total, received_total, received_pct, entitled_cumulative, paid_before, amount, overpaid, snapshot, created_at"

type ItemRow = {
  id: string
  tenant_id: string
  run_id: string
  project_id: string
  employee_id: string
  share_mode: string
  share_pct: string | number | null
  share_amount: string | number | null
  bonus_pool: string | number | null
  contract_total: string | number | null
  received_total: string | number
  received_pct: string | number
  entitled_cumulative: string | number
  paid_before: string | number
  amount: string | number
  overpaid: boolean
  snapshot: ItemSnapshot | null
  created_at: string
}

/** 明細列的快照：試算當下的顯示資訊（人名／案名日後改了也不影響已發放批次的可讀性）。 */
export type ItemSnapshot = {
  projectCode?: string | null
  projectName?: string | null
  employeeName?: string | null
  empNo?: string | null
  roleInProject?: string | null
  overpaidBy?: number
  stale?: boolean
}

export type SerializedRun = {
  id: string
  label: string
  asOf: string
  status: BonusRunStatus
  paidOn: string | null
  totals: BonusTotals
  note: string | null
  createdByEmpId: string | null
  paidByEmpId: string | null
  createdAt: string
  updatedAt: string
}

export type SerializedItem = {
  id: string | null
  runId: string | null
  projectId: string
  projectCode: string | null
  projectName: string | null
  employeeId: string
  employeeName: string | null
  empNo: string | null
  roleInProject: string | null
  shareMode: string
  sharePct: number | null
  shareAmount: number | null
  bonusPool: number | null
  contractTotal: number | null
  receivedTotal: number
  receivedPct: number
  entitledCumulative: number
  paidBefore: number
  amount: number
  overpaid: boolean
  overpaidBy: number
}

export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

const RANGE_PAGE_SIZE = 1000

/**
 * 共用分頁 fetcher：正式庫 PostgREST 設定 max-rows=1000，單次 `.select()` 超過
 * 這個數字會被「靜默」截斷（不是 error，`data` 就是只剩 1000 列）。任何筆數
 * 會隨資料量長大的查詢（跨專案／跨批次彙總，不是單一 run 的明細）都要繞過這
 * 個上限——樣板同 routes/disbursement-reports.ts 的 loadYearPaidDisbursements：
 * 用 `.range(offset, offset+999)` 一頁一頁撈，回傳 < 1000 列才算撈完。
 *
 * `build` 必須自己下穩定的 `.order()`（沒有明確排序，跨頁 `.range()` 不保證
 * 涵蓋所有列）＋`.range(from, to)`；這裡只負責分頁迴圈與錯誤訊息前綴
 * （context，方便看是哪個呼叫端出錯）。
 */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  context: string,
): Promise<T[]> {
  const rows: T[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await build(offset, offset + RANGE_PAGE_SIZE - 1)
    if (error) throw new Error(`${context}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < RANGE_PAGE_SIZE) break
    offset += RANGE_PAGE_SIZE
  }
  return rows
}

const EMPTY_TOTALS: BonusTotals = {
  amount: 0,
  entitledCumulative: 0,
  paidBefore: 0,
  itemCount: 0,
  employeeCount: 0,
  projectCount: 0,
  overpaidCount: 0,
  skipped: [],
}

function serializeRun(row: RunRow): SerializedRun {
  const t = (row.totals ?? {}) as Partial<BonusTotals>
  return {
    id: row.id,
    label: row.label,
    asOf: row.as_of,
    status: row.status as BonusRunStatus,
    paidOn: row.paid_on,
    totals: { ...EMPTY_TOTALS, ...t, skipped: Array.isArray(t.skipped) ? t.skipped : [] },
    note: row.note,
    createdByEmpId: row.created_by_emp_id,
    paidByEmpId: row.paid_by_emp_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isStale(row: ItemRow): boolean {
  return row.snapshot?.stale === true
}

function serializeItem(row: ItemRow): SerializedItem {
  const s = row.snapshot ?? {}
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    projectCode: s.projectCode ?? null,
    projectName: s.projectName ?? null,
    employeeId: row.employee_id,
    employeeName: s.employeeName ?? null,
    empNo: s.empNo ?? null,
    roleInProject: s.roleInProject ?? null,
    shareMode: row.share_mode,
    sharePct: num(row.share_pct),
    shareAmount: num(row.share_amount),
    bonusPool: num(row.bonus_pool),
    contractTotal: num(row.contract_total),
    receivedTotal: num(row.received_total) ?? 0,
    receivedPct: num(row.received_pct) ?? 0,
    entitledCumulative: num(row.entitled_cumulative) ?? 0,
    paidBefore: num(row.paid_before) ?? 0,
    amount: num(row.amount) ?? 0,
    overpaid: row.overpaid,
    overpaidBy: typeof s.overpaidBy === "number" ? s.overpaidBy : 0,
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 輸入：專案／成員／合約／入帳 → 純函式輸入
 * ────────────────────────────────────────────────────────────────── */

type ProjectMeta = { id: string; code: string | null; name: string }
type EmployeeMeta = { id: string; name: string; emp_no: string | null }

type LoadedInputs = {
  projects: BonusProjectInput[]
  projectMeta: Map<string, ProjectMeta>
  employeeMeta: Map<string, EmployeeMeta>
}

export async function tenantToday(tenantId: string): Promise<string> {
  const tz = await getTenantTimezone(tenantId)
  return todayKey(tz)
}

/**
 * 未封存且有成員的專案，含合約總額（我方承攬合約＋追加減，同 billing-store.contractTotal
 * 口徑）與截至 asOf 的實收合計（received_on ≤ asOf；沒填入帳日但有金額的也算——錢已經
 * 進來了，不能因為日期沒登記就從分母消失）。
 */
async function loadInputs(tenantId: string, asOf: string): Promise<LoadedInputs> {
  const { data: projRows, error: projErr } = await supabaseAdmin
    .from("projects")
    .select("id, code, name, share_mode, bonus_pool")
    .eq("tenant_id", tenantId)
    .is("archived_at", null)
  if (projErr) throw new Error(`bonus-run loadInputs (projects): ${projErr.message}`)
  const projects = (projRows ?? []) as Array<{ id: string; code: string | null; name: string; share_mode: string; bonus_pool: string | null }>
  const projectMeta = new Map<string, ProjectMeta>(projects.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]))
  if (projects.length === 0) return { projects: [], projectMeta, employeeMeta: new Map() }
  const ids = projects.map((p) => p.id)

  type MemberRow = { project_id: string; employee_id: string; role_in_project: string | null; share_pct: string | number | null; share_amount: string | number | null }
  const memberRows = await fetchAll<MemberRow>(
    (from, to) =>
      supabaseAdmin
        .from("project_members")
        .select("project_id, employee_id, role_in_project, share_pct, share_amount")
        .eq("tenant_id", tenantId)
        .in("project_id", ids)
        .order("id", { ascending: true })
        .range(from, to),
    "bonus-run loadInputs (members)",
  )
  const membersByProject = new Map<string, Array<{ employeeId: string; roleInProject: string | null; sharePct: number | null; shareAmount: number | null }>>()
  for (const m of memberRows) {
    const arr = membersByProject.get(m.project_id) ?? []
    arr.push({
      employeeId: m.employee_id,
      roleInProject: m.role_in_project ?? null,
      sharePct: num(m.share_pct),
      shareAmount: num(m.share_amount),
    })
    membersByProject.set(m.project_id, arr)
  }
  const withMembers = projects.filter((p) => (membersByProject.get(p.id) ?? []).length > 0)
  if (withMembers.length === 0) return { projects: [], projectMeta, employeeMeta: new Map() }
  const scopedIds = withMembers.map((p) => p.id)

  type ContractRow = { project_id: string; doc_type: string; amount: string | number | null }
  const contractRows = await fetchAll<ContractRow>(
    (from, to) =>
      supabaseAdmin
        .from("contracts")
        .select("project_id, doc_type, amount")
        .eq("tenant_id", tenantId)
        .in("project_id", scopedIds)
        .in("our_role", OUR_CONTRACT_ROLES)
        .in("doc_type", ["contract", "change_order"])
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    "bonus-run loadInputs (contracts)",
  )
  const contractTotal = new Map<string, number>()
  for (const c of contractRows) {
    contractTotal.set(c.project_id, (contractTotal.get(c.project_id) ?? 0) + (num(c.amount) ?? 0))
  }

  type BillingRow = { project_id: string; received_amount: string | number | null; received_on: string | null }
  const billingRows = await fetchAll<BillingRow>(
    (from, to) =>
      supabaseAdmin
        .from("project_billings")
        .select("project_id, received_amount, received_on")
        .eq("tenant_id", tenantId)
        .in("project_id", scopedIds)
        .is("deleted_at", null)
        .not("received_amount", "is", null)
        .or(`received_on.is.null,received_on.lte.${asOf}`)
        .order("id", { ascending: true })
        .range(from, to),
    "bonus-run loadInputs (billings)",
  )
  const receivedTotal = new Map<string, number>()
  for (const b of billingRows) {
    receivedTotal.set(b.project_id, (receivedTotal.get(b.project_id) ?? 0) + (num(b.received_amount) ?? 0))
  }

  const empIds = [...new Set(memberRows.map((m) => m.employee_id))]
  const { data: empRows, error: eErr } = await supabaseAdmin
    .from("employees")
    .select("id, name, emp_no")
    .eq("tenant_id", tenantId)
    .in("id", empIds)
  if (eErr) throw new Error(`bonus-run loadInputs (employees): ${eErr.message}`)
  const employeeMeta = new Map<string, EmployeeMeta>(
    ((empRows ?? []) as EmployeeMeta[]).map((e) => [e.id, { id: e.id, name: e.name, emp_no: e.emp_no ?? null }]),
  )

  const inputs: BonusProjectInput[] = withMembers.map((p) => ({
    projectId: p.id,
    shareMode: p.share_mode,
    bonusPool: num(p.bonus_pool),
    contractTotal: contractTotal.has(p.id) ? (contractTotal.get(p.id) as number) : null,
    receivedTotal: receivedTotal.get(p.id) ?? 0,
    members: membersByProject.get(p.id) ?? [],
  }))
  return { projects: inputs, projectMeta, employeeMeta }
}

/** 先前 paid 且未刪的 runs 裡，同 (project, employee) 的 amount 合計。重算 draft 時排除自己。 */
export async function loadPaidBefore(tenantId: string, excludeRunId?: string | null): Promise<Map<string, number>> {
  let q = supabaseAdmin.from("bonus_runs").select("id").eq("tenant_id", tenantId).eq("status", "paid").is("deleted_at", null)
  if (excludeRunId) q = q.neq("id", excludeRunId)
  const { data: runs, error } = await q
  if (error) throw new Error(`bonus-run loadPaidBefore (runs): ${error.message}`)
  const runIds = (runs ?? []).map((r) => r.id as string)
  const map = new Map<string, number>()
  if (runIds.length === 0) return map
  type PaidBeforeItemRow = { run_id: string; project_id: string; employee_id: string; amount: string | number | null }
  const items = await fetchAll<PaidBeforeItemRow>(
    (from, to) =>
      supabaseAdmin
        .from("bonus_run_items")
        .select("run_id, project_id, employee_id, amount")
        .eq("tenant_id", tenantId)
        .in("run_id", runIds)
        .order("id", { ascending: true })
        .range(from, to),
    "bonus-run loadPaidBefore (items)",
  )
  for (const it of items) {
    const key = paidBeforeKey(it.project_id, it.employee_id)
    map.set(key, (map.get(key) ?? 0) + (num(it.amount) ?? 0))
  }
  return map
}

/* ──────────────────────────────────────────────────────────────────
 * 試算（不寫入）
 * ────────────────────────────────────────────────────────────────── */

export type PreviewResult = {
  asOf: string
  items: SerializedItem[]
  totals: BonusTotals
  /** 試算輸入的專案層快照（含被跳過的案），供追溯。 */
  snapshot: Record<string, unknown>
  /** 內部：寫入用的計算列。 */
  calc: BonusItemCalc[]
  projectMeta: Map<string, ProjectMeta>
  employeeMeta: Map<string, EmployeeMeta>
}

export async function previewRun(tenantId: string, asOf: string, excludeRunId?: string | null): Promise<PreviewResult> {
  const [inputs, paidBefore] = await Promise.all([loadInputs(tenantId, asOf), loadPaidBefore(tenantId, excludeRunId)])
  const { items, totals } = computeBonusRun(inputs.projects, paidBefore)
  const skippedIds = new Set(totals.skipped.map((s) => s.projectId))
  const snapshot = {
    asOf,
    excludeRunId: excludeRunId ?? null,
    projects: inputs.projects.map((p) => {
      const meta = inputs.projectMeta.get(p.projectId)
      return {
        projectId: p.projectId,
        code: meta?.code ?? null,
        name: meta?.name ?? null,
        shareMode: p.shareMode,
        bonusPool: p.bonusPool,
        contractTotal: p.contractTotal,
        receivedTotal: p.receivedTotal,
        memberCount: p.members.length,
        skipped: skippedIds.has(p.projectId),
      }
    }),
    skipped: totals.skipped.map((s) => ({
      ...s,
      code: inputs.projectMeta.get(s.projectId)?.code ?? null,
      name: inputs.projectMeta.get(s.projectId)?.name ?? null,
    })),
  }
  const serialized: SerializedItem[] = items.map((i) => {
    const p = inputs.projectMeta.get(i.projectId)
    const e = inputs.employeeMeta.get(i.employeeId)
    return {
      id: null,
      runId: null,
      projectId: i.projectId,
      projectCode: p?.code ?? null,
      projectName: p?.name ?? null,
      employeeId: i.employeeId,
      employeeName: e?.name ?? null,
      empNo: e?.emp_no ?? null,
      roleInProject: i.roleInProject,
      shareMode: i.shareMode,
      sharePct: i.sharePct,
      shareAmount: i.shareAmount,
      bonusPool: i.bonusPool,
      contractTotal: i.contractTotal,
      receivedTotal: i.receivedTotal,
      receivedPct: i.receivedPct,
      entitledCumulative: i.entitledCumulative,
      paidBefore: i.paidBefore,
      amount: i.amount,
      overpaid: i.overpaid,
      overpaidBy: i.overpaidBy,
    }
  })
  serialized.sort(compareItems)
  return { asOf, items: serialized, totals, snapshot, calc: items, projectMeta: inputs.projectMeta, employeeMeta: inputs.employeeMeta }
}

function compareItems(a: SerializedItem, b: SerializedItem): number {
  return (
    (a.projectCode ?? "").localeCompare(b.projectCode ?? "") ||
    (a.projectName ?? "").localeCompare(b.projectName ?? "") ||
    (a.empNo ?? "").localeCompare(b.empNo ?? "") ||
    (a.employeeName ?? "").localeCompare(b.employeeName ?? "")
  )
}

function itemRowsOf(tenantId: string, runId: string, preview: PreviewResult) {
  return preview.calc.map((i) => {
    const p = preview.projectMeta.get(i.projectId)
    const e = preview.employeeMeta.get(i.employeeId)
    const snapshot: ItemSnapshot = {
      projectCode: p?.code ?? null,
      projectName: p?.name ?? null,
      employeeName: e?.name ?? null,
      empNo: e?.emp_no ?? null,
      roleInProject: i.roleInProject,
      overpaidBy: i.overpaidBy,
      stale: false,
    }
    return {
      tenant_id: tenantId,
      run_id: runId,
      project_id: i.projectId,
      employee_id: i.employeeId,
      share_mode: i.shareMode,
      share_pct: i.sharePct,
      share_amount: i.shareAmount,
      bonus_pool: i.bonusPool,
      contract_total: i.contractTotal,
      received_total: i.receivedTotal,
      received_pct: i.receivedPct,
      entitled_cumulative: i.entitledCumulative,
      paid_before: i.paidBefore,
      amount: i.amount,
      overpaid: i.overpaid,
      snapshot,
    }
  })
}

/* ──────────────────────────────────────────────────────────────────
 * 讀取
 * ────────────────────────────────────────────────────────────────── */

export async function loadRun(tenantId: string, id: string): Promise<RunRow | null> {
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .select(RUN_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`bonus-run loadRun: ${error.message}`)
  return (data as RunRow | null) ?? null
}

async function loadItemRows(tenantId: string, runId: string): Promise<ItemRow[]> {
  const { data, error } = await supabaseAdmin
    .from("bonus_run_items")
    .select(ITEM_COLS)
    .eq("tenant_id", tenantId)
    .eq("run_id", runId)
  if (error) throw new Error(`bonus-run loadItemRows: ${error.message}`)
  return (data ?? []) as ItemRow[]
}

export async function listRuns(tenantId: string): Promise<SerializedRun[]> {
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .select(RUN_COLS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("as_of", { ascending: false })
    .order("created_at", { ascending: false })
  if (error) throw new Error(`bonus-run listRuns: ${error.message}`)
  return ((data ?? []) as RunRow[]).map(serializeRun)
}

export type RunDetail = { run: SerializedRun; items: SerializedItem[]; snapshot: Record<string, unknown> | null }

export async function getRun(tenantId: string, id: string): Promise<RunDetail | null> {
  const row = await loadRun(tenantId, id)
  if (!row) return null
  const items = (await loadItemRows(tenantId, id)).filter((r) => !isStale(r)).map(serializeItem)
  items.sort(compareItems)
  return { run: serializeRun(row), items, snapshot: row.snapshot }
}

/* ──────────────────────────────────────────────────────────────────
 * 寫入：建立 draft／重算／發放／軟刪
 * ────────────────────────────────────────────────────────────────── */

export type CreateRunInput = { label: string; asOf: string; note?: string | null }

export async function createRun(tenantId: string, actor: Actor, input: CreateRunInput): Promise<RunDetail> {
  const preview = await previewRun(tenantId, input.asOf, null)
  const { data: run, error } = await supabaseAdmin
    .from("bonus_runs")
    .insert({
      tenant_id: tenantId,
      label: input.label,
      as_of: input.asOf,
      status: "draft",
      totals: preview.totals,
      snapshot: preview.snapshot,
      note: input.note ?? null,
      created_by_emp_id: actor.empId,
    })
    .select(RUN_COLS)
    .single()
  if (error || !run) {
    if (isUniqueViolation(error)) throw new BonusRunError(409, "label_exists", { label: input.label })
    throw new Error(`bonus-run createRun: ${error?.message}`)
  }
  const runRow = run as RunRow
  const rows = itemRowsOf(tenantId, runRow.id, preview)
  if (rows.length > 0) {
    const { error: iErr } = await supabaseAdmin.from("bonus_run_items").insert(rows)
    if (iErr) {
      // 明細寫失敗：run 不能留成半成品。正式租戶不能實體刪（no_hard_delete），一律軟刪。
      await supabaseAdmin
        .from("bonus_runs")
        .update({ deleted_at: new Date().toISOString(), deleted_by_emp_id: actor.empId, delete_reason: `items insert failed: ${iErr.message}` })
        .eq("id", runRow.id)
      throw new Error(`bonus-run createRun (items): ${iErr.message}`)
    }
  }
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: runRow.id,
    action: "INSERT",
    newRow: { label: input.label, as_of: input.asOf, note: input.note ?? null, totals: preview.totals, item_count: rows.length },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs",
  })
  return (await getRun(tenantId, runRow.id))!
}

export type UpdateRunInput = { label?: string; asOf?: string; note?: string | null }

/** draft 才能改；asOf／label 變動或明確要求 recompute 時重算明細（見檔頭 stale 說明）。 */
export async function updateRun(
  tenantId: string,
  actor: Actor,
  id: string,
  input: UpdateRunInput,
  opts: { recompute?: boolean } = {},
): Promise<RunDetail | null> {
  const current = await loadRun(tenantId, id)
  if (!current) return null
  if (current.status !== "draft") throw new BonusRunError(409, "not_draft", { status: current.status })

  const asOf = input.asOf ?? current.as_of
  const label = input.label ?? current.label
  const recompute = opts.recompute === true || input.asOf !== undefined
  const patch: Record<string, unknown> = { label, as_of: asOf }
  if (input.note !== undefined) patch.note = input.note

  if (recompute) {
    const preview = await previewRun(tenantId, asOf, id)
    const rows = itemRowsOf(tenantId, id, preview)
    if (rows.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("bonus_run_items")
        .upsert(rows, { onConflict: "run_id,project_id,employee_id" })
      if (upErr) throw new Error(`bonus-run updateRun (upsert items): ${upErr.message}`)
    }
    // 不在新結果裡的舊列：正式租戶刪不掉（no_hard_delete），就地歸零＋標 stale。
    const keep = new Set(rows.map((r) => paidBeforeKey(r.project_id, r.employee_id)))
    const existing = await loadItemRows(tenantId, id)
    const staleRows = existing.filter((r) => !keep.has(paidBeforeKey(r.project_id, r.employee_id)) && !isStale(r))
    for (const r of staleRows) {
      const { error: sErr } = await supabaseAdmin
        .from("bonus_run_items")
        .update({
          received_total: 0,
          received_pct: 0,
          entitled_cumulative: 0,
          paid_before: 0,
          amount: 0,
          overpaid: false,
          snapshot: { ...(r.snapshot ?? {}), overpaidBy: 0, stale: true },
        })
        .eq("id", r.id)
      if (sErr) throw new Error(`bonus-run updateRun (stale item): ${sErr.message}`)
    }
    patch.totals = preview.totals
    patch.snapshot = preview.snapshot
  }

  const { error } = await supabaseAdmin.from("bonus_runs").update(patch).eq("tenant_id", tenantId).eq("id", id)
  if (error) {
    if (isUniqueViolation(error)) throw new BonusRunError(409, "label_exists", { label })
    throw new Error(`bonus-run updateRun: ${error.message}`)
  }
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { label: current.label, as_of: current.as_of, note: current.note, totals: current.totals },
    newRow: { ...patch, recomputed: recompute },
    actorEmpId: actor.empId,
    context: "PATCH /bonus-runs/:id",
  })
  return getRun(tenantId, id)
}

/** draft → paid（凍結）。pay 前重抓 paid_before 逐列比對，不一致 → 409 stale_paid_before。 */
export async function payRun(tenantId: string, actor: Actor, id: string, paidOn: string): Promise<RunDetail | null> {
  const current = await loadRun(tenantId, id)
  if (!current) return null
  if (current.status !== "draft") throw new BonusRunError(409, "not_draft", { status: current.status })

  const items = (await loadItemRows(tenantId, id)).filter((r) => !isStale(r))
  const paidBefore = await loadPaidBefore(tenantId, id)
  const mismatched = items.filter((r) => (num(r.paid_before) ?? 0) !== Math.round(paidBefore.get(paidBeforeKey(r.project_id, r.employee_id)) ?? 0))
  if (mismatched.length > 0) {
    throw new BonusRunError(409, "stale_paid_before", {
      items: mismatched.map((r) => ({ projectId: r.project_id, employeeId: r.employee_id })),
    })
  }

  // 原子更新：WHERE 帶 status='draft' 且用 .select() 拿回受影響列數，取代先前的
  // 「check-then-update」——兩個併發 pay 都通過前面的 current.status 檢查後，
  // 只有先落地的那個真的把列從 draft 改成 paid；另一個的 WHERE 子句因為列已經
  // 不是 draft 而完全不命中，Postgres 回 0 列、不是 error（DB trigger
  // forbid_paid_bonus_mutation 也不會被觸發——它只在「有列被改」時才跑），
  // 舊碼沒檢查受影響列數，等於讓後到的那個併發請求也拿到 200、重複記一次
  // audit log。回 0 列視同「已經不是 draft」，一律 409 not_draft。
  const { data: updated, error } = await supabaseAdmin
    .from("bonus_runs")
    .update({ status: "paid", paid_on: paidOn, paid_by_emp_id: actor.empId })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", "draft")
    .select("id")
  if (error) throw new Error(`bonus-run payRun: ${error.message}`)
  if (!updated || updated.length === 0) {
    throw new BonusRunError(409, "not_draft", { status: "paid" })
  }
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: "draft", paid_on: null },
    newRow: { status: "paid", paid_on: paidOn, paid_by_emp_id: actor.empId, totals: current.totals },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/pay",
  })
  return getRun(tenantId, id)
}

/** draft 軟刪（paid → 409 not_draft）。 */
export async function deleteRun(tenantId: string, actor: Actor, id: string, reason: string): Promise<boolean> {
  const current = await loadRun(tenantId, id)
  if (!current) return false
  if (current.status !== "draft") throw new BonusRunError(409, "not_draft", { status: current.status })
  const deletedAt = new Date().toISOString()
  const { error } = await supabaseAdmin
    .from("bonus_runs")
    .update({ deleted_at: deletedAt, deleted_by_emp_id: actor.empId, delete_reason: reason })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", "draft")
  if (error) throw new Error(`bonus-run deleteRun: ${error.message}`)
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "DELETE",
    oldRow: { label: current.label, as_of: current.as_of, status: current.status, totals: current.totals },
    newRow: { deleted_at: deletedAt, delete_reason: reason },
    actorEmpId: actor.empId,
    context: "DELETE /bonus-runs/:id",
  })
  return true
}

/* ──────────────────────────────────────────────────────────────────
 * 歷年彙總／ESS 個人紀錄（只看 paid 且未刪的批次）
 * ────────────────────────────────────────────────────────────────── */

async function loadPaidRunsWithItems(tenantId: string, employeeId?: string | null): Promise<{ runs: RunRow[]; items: ItemRow[] }> {
  const { data: runRows, error } = await supabaseAdmin
    .from("bonus_runs")
    .select(RUN_COLS)
    .eq("tenant_id", tenantId)
    .eq("status", "paid")
    .is("deleted_at", null)
    .order("as_of", { ascending: true })
  if (error) throw new Error(`bonus-run loadPaidRuns: ${error.message}`)
  const runs = (runRows ?? []) as RunRow[]
  if (runs.length === 0) return { runs, items: [] }
  const runIds = runs.map((r) => r.id)
  const itemRows = await fetchAll<ItemRow>(
    (from, to) => {
      let q = supabaseAdmin.from("bonus_run_items").select(ITEM_COLS).eq("tenant_id", tenantId).in("run_id", runIds)
      if (employeeId) q = q.eq("employee_id", employeeId)
      return q.order("id", { ascending: true }).range(from, to)
    },
    "bonus-run loadPaidRuns (items)",
  )
  return { runs, items: itemRows.filter((r) => !isStale(r)) }
}

export async function buildSummary(tenantId: string, filter: { year?: number | null; employeeId?: string | null }): Promise<BonusSummary> {
  const { runs, items } = await loadPaidRunsWithItems(tenantId, null)
  const runInputs: SummaryRunInput[] = runs.map((r) => ({ id: r.id, label: r.label, asOf: r.as_of, paidOn: r.paid_on }))
  const itemInputs: SummaryItemInput[] = items.map((r) => ({
    runId: r.run_id,
    projectId: r.project_id,
    employeeId: r.employee_id,
    amount: num(r.amount) ?? 0,
    employeeName: r.snapshot?.employeeName ?? null,
    empNo: r.snapshot?.empNo ?? null,
  }))
  return buildBonusSummary(runInputs, itemInputs, filter)
}

export type MyBonusHistoryRow = SerializedItem & { label: string; asOf: string; paidOn: string | null }

/** ESS：本人在各 paid 批次的明細（最新批次在前）。 */
export async function myBonusHistory(tenantId: string, employeeId: string): Promise<{ rows: MyBonusHistoryRow[]; total: number }> {
  const { runs, items } = await loadPaidRunsWithItems(tenantId, employeeId)
  const runById = new Map(runs.map((r) => [r.id, r]))
  const rows: MyBonusHistoryRow[] = items
    .map((r) => {
      const run = runById.get(r.run_id)!
      return { ...serializeItem(r), label: run.label, asOf: run.as_of, paidOn: run.paid_on }
    })
    .sort((a, b) => (b.paidOn ?? b.asOf).localeCompare(a.paidOn ?? a.asOf) || b.label.localeCompare(a.label) || compareItems(a, b))
  return { rows, total: rows.reduce((s, r) => s + r.amount, 0) }
}
