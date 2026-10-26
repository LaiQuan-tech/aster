import { supabaseAdmin } from "../lib/supabase.js"
import { OUR_CONTRACT_ROLES } from "../lib/contract-role.js"
import { localDateKey, todayKey } from "../lib/tz.js"
import { loadGrossProfitInput, summarizeProjectGrossProfit } from "./project-gross-profit.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { isUniqueViolation } from "./project-code.js"
import { writeAuditLog } from "./audit.js"
import { enqueue } from "./notify.js"
import { loadBossEmpId } from "./late-reports.js"
import { bonusRunsHaveApproval } from "../lib/schema-compat.js"
import {
  AMOUNT_CHANGED_RETURN_REASON,
  amountFingerprint,
  archiveInclusionOf,
  statusAfterRecompute,
  transitionOf,
  BONUS_BASIS_LABEL,
  buildBonusSummary,
  computeBonusRun,
  projectBonusBasisOf,
  type ArchiveInclusion,
  type BonusBasis,
  paidBeforeKey,
  reversalItemsOf,
  reversalTotalsOf,
  type BonusRunKind,
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

const BASE_RUN_COLS =
  "id, tenant_id, label, as_of, status, kind, reverses_run_id, paid_on, totals, snapshot, note, created_by_emp_id, paid_by_emp_id, created_at, updated_at, deleted_at, deleted_by_emp_id, delete_reason"
const APPROVAL_RUN_COLS =
  "submitted_at, submitted_by_emp_id, approved_at, approved_by_emp_id, approved_amount, approved_fingerprint, returned_at, returned_by_emp_id, return_reason"

/** migration 0073 未套時不 select 核准欄位（讀取照常；送審／核准／發放回 409 schema_not_ready）。 */
async function runCols(): Promise<string> {
  return (await bonusRunsHaveApproval()) ? `${BASE_RUN_COLS}, ${APPROVAL_RUN_COLS}` : BASE_RUN_COLS
}

async function requireApprovalSchema(): Promise<void> {
  if (!(await bonusRunsHaveApproval())) throw new BonusRunError(409, "schema_not_ready", { migration: "0073" })
}

type RunRow = {
  id: string
  tenant_id: string
  label: string
  as_of: string
  status: string
  kind: string
  reverses_run_id: string | null
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
  // 0073 起（未套時不存在）
  submitted_at?: string | null
  submitted_by_emp_id?: string | null
  approved_at?: string | null
  approved_by_emp_id?: string | null
  approved_amount?: string | number | null
  approved_fingerprint?: string | null
  returned_at?: string | null
  returned_by_emp_id?: string | null
  return_reason?: string | null
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
  bonusRatePct?: number | null
  previousReceived?: number
  previousReceivedPct?: number
  currentReceived?: number
  currentReceivedPct?: number
  unallocatedPct?: number
  projectNote?: string | null
  overpaidBy?: number
  stale?: boolean
  /** 2026-10-26 起：獎金池基礎與毛利明細（舊批次沒有這些鍵）。 */
  basis?: BonusBasis
  cost?: number
  disbursementCost?: number
  subcontractCost?: number
  grossProfit?: number
  overContractPct?: number | null
}

export type SerializedRun = {
  id: string
  label: string
  asOf: string
  status: BonusRunStatus
  /** regular＝季批次；reversal＝紅字沖銷批次（金額為負）。 */
  kind: BonusRunKind
  /** kind=reversal 時：被沖銷的批次。 */
  reversesRunId: string | null
  /** 這一批被哪個（有效的）沖銷批次沖掉了；含草稿——草稿代表「沖銷中」。 */
  reversedByRunId: string | null
  reversedByStatus: BonusRunStatus | null
  paidOn: string | null
  totals: BonusTotals
  note: string | null
  createdByEmpId: string | null
  paidByEmpId: string | null
  createdAt: string
  updatedAt: string
  // ── 核准（#7）──
  submittedAt: string | null
  submittedByEmpId: string | null
  approvedAt: string | null
  approvedByEmpId: string | null
  /** 核准（送審）當下的本批合計。 */
  approvedAmount: number | null
  /** 最近一次退回草稿（老闆退回或金額變動自動退回）。 */
  returnedAt: string | null
  returnedByEmpId: string | null
  returnReason: string | null
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
  bonusRatePct: number | null
  contractTotal: number | null
  receivedTotal: number
  receivedPct: number
  previousReceived: number
  previousReceivedPct: number
  currentReceived: number
  currentReceivedPct: number
  unallocatedPct: number
  projectNote: string | null
  entitledCumulative: number
  paidBefore: number
  amount: number
  overpaid: boolean
  overpaidBy: number
  /** 獎金池基礎；2026-10-26 前建立的明細為 null。 */
  basis: BonusBasis | null
  /** 累計入帳（＝receivedTotal，未稅）。 */
  revenue: number
  /** 累計已發生專案成本（毛額）；舊明細 null。 */
  cost: number | null
  disbursementCost: number | null
  subcontractCost: number | null
  /** 累計已實現毛利；舊明細 null。 */
  grossProfit: number | null
  /** 入帳超過合約幾 %；沒超過 null。 */
  overContractPct: number | null
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

/**
 * 併發時的 DB 層防線：forbid_paid_bonus_mutation（sql/0034）用 ERRCODE restrict_violation
 * （23001）擋住對已 paid 批次的寫入。updateRun 的「查狀態 → 寫 items → 寫 run」之間若被
 * 另一個 payRun 搶先，items 的寫入會撞到這個 trigger——那不是 500，是「已經不是 draft」。
 */
function isPaidFrozen(err: { code?: string; message?: string } | null | undefined): boolean {
  return err?.code === "23001" || /已發放（paid）/.test(err?.message ?? "")
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
  warnings: [],
}

function serializeRun(row: RunRow, reversedBy?: { id: string; status: string } | null): SerializedRun {
  const t = (row.totals ?? {}) as Partial<BonusTotals>
  return {
    id: row.id,
    label: row.label,
    asOf: row.as_of,
    status: row.status as BonusRunStatus,
    kind: (row.kind === "reversal" ? "reversal" : "regular") as BonusRunKind,
    reversesRunId: row.reverses_run_id,
    reversedByRunId: reversedBy?.id ?? null,
    reversedByStatus: (reversedBy?.status as BonusRunStatus | undefined) ?? null,
    paidOn: row.paid_on,
    totals: { ...EMPTY_TOTALS, ...t, skipped: Array.isArray(t.skipped) ? t.skipped : [], warnings: Array.isArray(t.warnings) ? t.warnings : [] },
    note: row.note,
    createdByEmpId: row.created_by_emp_id,
    paidByEmpId: row.paid_by_emp_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? null,
    submittedByEmpId: row.submitted_by_emp_id ?? null,
    approvedAt: row.approved_at ?? null,
    approvedByEmpId: row.approved_by_emp_id ?? null,
    approvedAmount: num(row.approved_amount),
    returnedAt: row.returned_at ?? null,
    returnedByEmpId: row.returned_by_emp_id ?? null,
    returnReason: row.return_reason ?? null,
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
    bonusRatePct: typeof s.bonusRatePct === "number" ? s.bonusRatePct : null,
    contractTotal: num(row.contract_total),
    receivedTotal: num(row.received_total) ?? 0,
    receivedPct: num(row.received_pct) ?? 0,
    previousReceived: typeof s.previousReceived === "number" ? s.previousReceived : 0,
    previousReceivedPct: typeof s.previousReceivedPct === "number" ? s.previousReceivedPct : 0,
    currentReceived: typeof s.currentReceived === "number" ? s.currentReceived : (num(row.received_total) ?? 0),
    currentReceivedPct: typeof s.currentReceivedPct === "number" ? s.currentReceivedPct : (num(row.received_pct) ?? 0),
    unallocatedPct: typeof s.unallocatedPct === "number" ? s.unallocatedPct : 0,
    projectNote: typeof s.projectNote === "string" ? s.projectNote : null,
    entitledCumulative: num(row.entitled_cumulative) ?? 0,
    paidBefore: num(row.paid_before) ?? 0,
    amount: num(row.amount) ?? 0,
    overpaid: row.overpaid,
    overpaidBy: typeof s.overpaidBy === "number" ? s.overpaidBy : 0,
    basis: s.basis ?? null,
    revenue: num(row.received_total) ?? 0,
    cost: typeof s.cost === "number" ? s.cost : null,
    disbursementCost: typeof s.disbursementCost === "number" ? s.disbursementCost : null,
    subcontractCost: typeof s.subcontractCost === "number" ? s.subcontractCost : null,
    grossProfit: typeof s.grossProfit === "number" ? s.grossProfit : null,
    overContractPct: typeof s.overContractPct === "number" ? s.overContractPct : null,
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
  /** 封存專案的納入判斷（未封存的也會有一筆 active）；估算服務（archiveRule='all'）為空。 */
  archiveInclusion: Map<string, ArchiveInclusion>
}

export async function tenantToday(tenantId: string): Promise<string> {
  const tz = await getTenantTimezone(tenantId)
  return todayKey(tz)
}

type ProjectRow = {
  id: string
  code: string | null
  name: string
  description: string | null
  share_mode: string
  bonus_pool: string | null
  bonus_rate_pct: string | null
  archived_at: string | null
  archive_reason: string | null
}

export type LoadInputsOptions = {
  /** 只算這幾個專案（估算服務用）；省略＝租戶全部。 */
  projectIds?: readonly string[]
  /**
   * 'bonus_run'（預設）：套封存規則（bonus-run.ts archiveInclusionOf——複製取代的原案排除、
   * 其他封存案封存後有新入帳／成本才納入）。'all'：指定的專案一律納入（估算服務：P2 問哪個案就算哪個）。
   */
  archiveRule?: "bonus_run" | "all"
}

/**
 * 有成員的專案（依封存規則篩），含合約總額（我方承攬合約＋追加減，同 billing-store.contractTotal
 * 口徑）、截至 asOf 的實收合計（received_on ≤ asOf；沒填入帳日但有金額的也算——錢已經進來了，
 * 不能因為日期沒登記就從分母消失）與累計已發生專案成本（services/project-gross-profit.ts）。
 */
export async function loadInputs(tenantId: string, asOf: string, opts: LoadInputsOptions = {}): Promise<LoadedInputs> {
  const archiveRule = opts.archiveRule ?? "bonus_run"
  const cols = "id, code, name, description, share_mode, bonus_pool, bonus_rate_pct, archived_at, archive_reason"
  let projects: ProjectRow[]
  if (opts.projectIds) {
    const ids = [...new Set(opts.projectIds)]
    if (ids.length === 0) return { projects: [], projectMeta: new Map(), employeeMeta: new Map(), archiveInclusion: new Map() }
    const { data, error } = await supabaseAdmin.from("projects").select(cols).eq("tenant_id", tenantId).in("id", ids)
    if (error) throw new Error(`bonus-run loadInputs (projects): ${error.message}`)
    projects = (data ?? []) as ProjectRow[]
  } else {
    projects = await fetchAll<ProjectRow>(
      (from, to) =>
        supabaseAdmin.from("projects").select(cols).eq("tenant_id", tenantId).order("id", { ascending: true }).range(from, to),
      "bonus-run loadInputs (projects)",
    )
  }
  const projectMeta = new Map<string, ProjectMeta>(projects.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]))
  const archiveInclusion = new Map<string, ArchiveInclusion>()
  if (projects.length === 0) return { projects: [], projectMeta, employeeMeta: new Map(), archiveInclusion }
  const ids = projects.map((p) => p.id)

  type MemberRow = { project_id: string; employee_id: string; role_in_project: string | null; share_pct: string | number | null; share_amount: string | number | null }
  const memberRows: MemberRow[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    memberRows.push(
      ...(await fetchAll<MemberRow>(
        (from, to) =>
          supabaseAdmin
            .from("project_members")
            .select("project_id, employee_id, role_in_project, share_pct, share_amount")
            .eq("tenant_id", tenantId)
            .in("project_id", chunk)
            .order("id", { ascending: true })
            .range(from, to),
        "bonus-run loadInputs (members)",
      )),
    )
  }
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
  // 試算只看有成員的案；估算服務（指定 projectIds）沒有成員也要回專案層數字。
  const candidates = opts.projectIds ? projects : projects.filter((p) => (membersByProject.get(p.id) ?? []).length > 0)
  // 複製取代的原案不必撈金額（一律排除）。
  const tz = archiveRule === "bonus_run" && candidates.some((p) => p.archived_at) ? await getTenantTimezone(tenantId) : null
  const archivedOn = (p: ProjectRow): string | null => (p.archived_at ? localDateKey(p.archived_at, tz ?? "Asia/Taipei") : null)
  const needMoney = candidates.filter((p) => archiveRule === "all" || archiveInclusionOf(archivedOn(p), p.archive_reason, null, asOf).reason !== "duplicate_replaced")
  if (needMoney.length === 0) {
    for (const p of candidates) archiveInclusion.set(p.id, archiveInclusionOf(archivedOn(p), p.archive_reason, null, asOf))
    return { projects: [], projectMeta, employeeMeta: new Map(), archiveInclusion }
  }
  const moneyIds = needMoney.map((p) => p.id)
  const gp = summarizeProjectGrossProfit(moneyIds, await loadGrossProfitInput(tenantId, moneyIds, asOf))

  const scoped = archiveRule === "all"
    ? needMoney
    : candidates.filter((p) => {
        const inc = archiveInclusionOf(archivedOn(p), p.archive_reason, gp.get(p.id)?.lastActivityOn ?? null, asOf)
        archiveInclusion.set(p.id, inc)
        return inc.include
      })
  if (scoped.length === 0) return { projects: [], projectMeta, employeeMeta: new Map(), archiveInclusion }
  const scopedIds = scoped.map((p) => p.id)

  type ContractRow = { project_id: string; doc_type: string; amount: string | number | null }
  const contractRows: ContractRow[] = []
  for (let i = 0; i < scopedIds.length; i += 100) {
    const chunk = scopedIds.slice(i, i + 100)
    contractRows.push(
      ...(await fetchAll<ContractRow>(
        (from, to) =>
          supabaseAdmin
            .from("contracts")
            .select("project_id, doc_type, amount")
            .eq("tenant_id", tenantId)
            .in("project_id", chunk)
            .in("our_role", OUR_CONTRACT_ROLES)
            .in("doc_type", ["contract", "change_order"])
            .is("deleted_at", null)
            .order("id", { ascending: true })
            .range(from, to),
        "bonus-run loadInputs (contracts)",
      )),
    )
  }
  const contractTotal = new Map<string, number>()
  for (const c of contractRows) {
    contractTotal.set(c.project_id, (contractTotal.get(c.project_id) ?? 0) + (num(c.amount) ?? 0))
  }

  const empIds = [...new Set(scoped.flatMap((p) => (membersByProject.get(p.id) ?? []).map((m) => m.employeeId)))]
  let employeeMeta = new Map<string, EmployeeMeta>()
  if (empIds.length > 0) {
    const { data: empRows, error: eErr } = await supabaseAdmin
      .from("employees")
      .select("id, name, emp_no")
      .eq("tenant_id", tenantId)
      .in("id", empIds)
    if (eErr) throw new Error(`bonus-run loadInputs (employees): ${eErr.message}`)
    employeeMeta = new Map<string, EmployeeMeta>(
      ((empRows ?? []) as EmployeeMeta[]).map((e) => [e.id, { id: e.id, name: e.name, emp_no: e.emp_no ?? null }]),
    )
  }

  const inputs: BonusProjectInput[] = scoped.map((p) => {
    const money = gp.get(p.id)
    return {
      projectId: p.id,
      shareMode: p.share_mode,
      bonusPool: num(p.bonus_pool),
      bonusRatePct: num(p.bonus_rate_pct),
      projectNote: p.description,
      contractTotal: contractTotal.has(p.id) ? (contractTotal.get(p.id) as number) : null,
      receivedTotal: money?.revenue ?? 0,
      cost: money?.cost ?? 0,
      disbursementCost: money?.disbursementCost ?? 0,
      subcontractCost: money?.subcontractCost ?? 0,
      members: membersByProject.get(p.id) ?? [],
    }
  })
  return { projects: inputs, projectMeta, employeeMeta, archiveInclusion }
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

/** 各專案最近一個已發放 regular 批次的凍結累計收款，供「之前／本次請領」拆分。 */
export async function loadPreviousReceived(tenantId: string, asOf: string, excludeRunId?: string | null): Promise<Map<string, number>> {
  let q = supabaseAdmin
    .from("bonus_runs")
    .select("id, paid_on, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "paid")
    .eq("kind", "regular")
    .lte("as_of", asOf)
    .is("deleted_at", null)
    .order("paid_on", { ascending: false })
    .order("created_at", { ascending: false })
  if (excludeRunId) q = q.neq("id", excludeRunId)
  const { data: runs, error } = await q
  if (error) throw new Error(`bonus-run loadPreviousReceived (runs): ${error.message}`)
  const runIds = (runs ?? []).map((run) => run.id as string)
  if (runIds.length === 0) return new Map()
  type PreviousItemRow = { run_id: string; project_id: string; received_total: string | number }
  const rows = await fetchAll<PreviousItemRow>(
    (from, to) => supabaseAdmin
      .from("bonus_run_items")
      .select("run_id, project_id, received_total")
      .eq("tenant_id", tenantId)
      .in("run_id", runIds)
      .order("id", { ascending: true })
      .range(from, to),
    "bonus-run loadPreviousReceived (items)",
  )
  const rank = new Map(runIds.map((id, index) => [id, index]))
  const selectedRank = new Map<string, number>()
  const result = new Map<string, number>()
  for (const row of rows) {
    const candidateRank = rank.get(row.run_id) ?? Number.MAX_SAFE_INTEGER
    if ((selectedRank.get(row.project_id) ?? Number.MAX_SAFE_INTEGER) <= candidateRank) continue
    selectedRank.set(row.project_id, candidateRank)
    result.set(row.project_id, num(row.received_total) ?? 0)
  }
  return result
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
  const [inputs, paidBefore, previousReceived] = await Promise.all([
    loadInputs(tenantId, asOf),
    loadPaidBefore(tenantId, excludeRunId),
    loadPreviousReceived(tenantId, asOf, excludeRunId),
  ])
  const { items, totals } = computeBonusRun(inputs.projects, paidBefore, previousReceived)
  const skippedIds = new Set(totals.skipped.map((s) => s.projectId))
  const metaOf = (projectId: string) => inputs.projectMeta.get(projectId)
  const snapshot = {
    asOf,
    excludeRunId: excludeRunId ?? null,
    projects: inputs.projects.map((p) => {
      const meta = metaOf(p.projectId)
      const b = projectBonusBasisOf(p)
      return {
        projectId: p.projectId,
        code: meta?.code ?? null,
        name: meta?.name ?? null,
        shareMode: p.shareMode,
        basis: b.basis,
        basisLabel: BONUS_BASIS_LABEL[b.basis],
        bonusPool: p.bonusPool,
        effectivePool: b.pool,
        bonusRatePct: p.bonusRatePct,
        projectNote: p.projectNote,
        contractTotal: p.contractTotal,
        receivedTotal: p.receivedTotal,
        cost: b.cost,
        disbursementCost: b.disbursementCost,
        subcontractCost: b.subcontractCost,
        grossProfit: b.grossProfit,
        overContractPct: b.overContractPct,
        archived: inputs.archiveInclusion.get(p.projectId)?.reason === "archived_with_activity",
        memberCount: p.members.length,
        skipped: skippedIds.has(p.projectId),
      }
    }),
    skipped: totals.skipped.map((s) => ({
      ...s,
      code: metaOf(s.projectId)?.code ?? null,
      name: metaOf(s.projectId)?.name ?? null,
    })),
    /** 封存而不列入的專案（複製取代的原案、封存後沒有新入帳／成本），供 HR 追溯。 */
    excludedArchived: [...inputs.archiveInclusion.entries()]
      .filter(([, inc]) => !inc.include)
      .map(([projectId, inc]) => ({ projectId, reason: inc.reason, code: metaOf(projectId)?.code ?? null, name: metaOf(projectId)?.name ?? null })),
    warnings: (totals.warnings ?? []).map((w) => ({ ...w, code: metaOf(w.projectId)?.code ?? null, name: metaOf(w.projectId)?.name ?? null })),
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
      bonusRatePct: i.bonusRatePct,
      contractTotal: i.contractTotal,
      receivedTotal: i.receivedTotal,
      receivedPct: i.receivedPct,
      previousReceived: i.previousReceived,
      previousReceivedPct: i.previousReceivedPct,
      currentReceived: i.currentReceived,
      currentReceivedPct: i.currentReceivedPct,
      unallocatedPct: i.unallocatedPct,
      projectNote: i.projectNote,
      entitledCumulative: i.entitledCumulative,
      paidBefore: i.paidBefore,
      amount: i.amount,
      overpaid: i.overpaid,
      overpaidBy: i.overpaidBy,
      basis: i.basis,
      revenue: i.receivedTotal,
      cost: i.cost,
      disbursementCost: i.disbursementCost,
      subcontractCost: i.subcontractCost,
      grossProfit: i.grossProfit,
      overContractPct: i.overContractPct,
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
      bonusRatePct: i.bonusRatePct,
      previousReceived: i.previousReceived,
      previousReceivedPct: i.previousReceivedPct,
      currentReceived: i.currentReceived,
      currentReceivedPct: i.currentReceivedPct,
      unallocatedPct: i.unallocatedPct,
      projectNote: i.projectNote,
      overpaidBy: i.overpaidBy,
      stale: false,
      basis: i.basis,
      cost: i.cost,
      disbursementCost: i.disbursementCost,
      subcontractCost: i.subcontractCost,
      grossProfit: i.grossProfit,
      overContractPct: i.overContractPct,
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
    .select(await runCols())
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`bonus-run loadRun: ${error.message}`)
  return (data as RunRow | null) ?? null
}

// 單一 run 的明細也走分頁：PostgREST 預設 1000 列上限，超過會**靜默截斷**——
// getRun／updateRun／payRun 都靠這支，截斷等於少發錢還看不出來。
async function loadItemRows(tenantId: string, runId: string): Promise<ItemRow[]> {
  return fetchAll<ItemRow>(
    (from, to) =>
      supabaseAdmin
        .from("bonus_run_items")
        .select(ITEM_COLS)
        .eq("tenant_id", tenantId)
        .eq("run_id", runId)
        .order("id", { ascending: true })
        .range(from, to),
    "bonus-run loadItemRows",
  )
}

export async function listRuns(tenantId: string): Promise<SerializedRun[]> {
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .select(await runCols())
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("as_of", { ascending: false })
    .order("created_at", { ascending: false })
  if (error) throw new Error(`bonus-run listRuns: ${error.message}`)
  const rows = (data ?? []) as unknown as RunRow[]
  const reversedBy = new Map<string, { id: string; status: string }>()
  for (const r of rows) if (r.kind === "reversal" && r.reverses_run_id) reversedBy.set(r.reverses_run_id, { id: r.id, status: r.status })
  return rows.map((r) => serializeRun(r, reversedBy.get(r.id) ?? null))
}

/** 有效的（未軟刪）沖銷批次，指向 runId 的那一筆；沒有回 null。 */
async function reversalOf(tenantId: string, runId: string): Promise<{ id: string; status: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("reverses_run_id", runId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`bonus-run reversalOf: ${error.message}`)
  return data ? { id: data.id as string, status: data.status as string } : null
}

export type RunDetail = { run: SerializedRun; items: SerializedItem[]; snapshot: Record<string, unknown> | null }

export async function getRun(tenantId: string, id: string): Promise<RunDetail | null> {
  const row = await loadRun(tenantId, id)
  if (!row) return null
  const items = (await loadItemRows(tenantId, id)).filter((r) => !isStale(r)).map(serializeItem)
  items.sort(compareItems)
  return { run: serializeRun(row, await reversalOf(tenantId, id)), items, snapshot: row.snapshot }
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
      kind: "regular",
      totals: preview.totals,
      snapshot: preview.snapshot,
      note: input.note ?? null,
      created_by_emp_id: actor.empId,
    })
    .select(await runCols())
    .single()
  if (error || !run) {
    if (isUniqueViolation(error)) throw new BonusRunError(409, "label_exists", { label: input.label })
    throw new Error(`bonus-run createRun: ${error?.message}`)
  }
  const runRow = run as unknown as RunRow
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

/** 未發放（可重算）的狀態。 */
const UNPAID_STATUSES = ["draft", "pending_approval", "approved"] as const

function liveItemsFingerprint(rows: ItemRow[]): string {
  return amountFingerprint(
    rows.filter((r) => !isStale(r)).map((r) => ({ projectId: r.project_id, employeeId: r.employee_id, amount: num(r.amount) ?? 0 })),
  )
}

export type UpdateRunResult = RunDetail & { returnedToDraft: boolean }

/**
 * 未發放（draft／送審中／已核准）才能改；asOf／label 變動或明確要求 recompute 時重算明細（見檔頭 stale 說明）。
 * 送審中／已核准的批次重算後每列金額指紋變了 → 退回 draft（清核准欄位、寫 returned_*），通知送審人（與老闆），
 * 需要重新送審；金額沒變則維持原狀態。
 */
export async function updateRun(
  tenantId: string,
  actor: Actor,
  id: string,
  input: UpdateRunInput,
  opts: { recompute?: boolean } = {},
): Promise<UpdateRunResult | null> {
  const current = await loadRun(tenantId, id)
  if (!current) return null
  if (!(UNPAID_STATUSES as readonly string[]).includes(current.status)) throw new BonusRunError(409, "not_draft", { status: current.status })
  // 沖銷批次的內容是原批取負，不是試算結果：重算會把它覆蓋成一般季批次。只准改備註。
  if (current.kind === "reversal" && (opts.recompute === true || input.asOf !== undefined || input.label !== undefined)) {
    throw new BonusRunError(409, "reversal_not_editable")
  }

  const asOf = input.asOf ?? current.as_of
  const label = input.label ?? current.label
  const recompute = opts.recompute === true || input.asOf !== undefined
  const patch: Record<string, unknown> = { label, as_of: asOf }
  if (input.note !== undefined) patch.note = input.note
  let returnedToDraft = false

  let expectStatus = current.status
  if (recompute) {
    const preview = await previewRun(tenantId, asOf, id)
    // 送審中／已核准：先比金額指紋，變了就**先**把批次原子地退回 draft（WHERE status＝讀到的狀態），
    // 再寫明細。順序不能反：先寫明細的話，併發的 payRun 可能用舊明細比對通過、卻把新金額凍結成已發放。
    // 退回落地後 payRun 的 WHERE status='approved' 必然 0 列；payRun 先落地則這裡 0 列 → 409，明細不動。
    const fp = amountFingerprint(preview.calc.map((i) => ({ projectId: i.projectId, employeeId: i.employeeId, amount: i.amount })))
    const after = statusAfterRecompute(current.status, current.approved_fingerprint ?? null, fp)
    if (after.returned) {
      await transitionRow(tenantId, id, current.status, returnPatch(actor.empId, AMOUNT_CHANGED_RETURN_REASON), "updateRun (return to draft)")
      returnedToDraft = true
      expectStatus = "draft"
    }
    const rows = itemRowsOf(tenantId, id, preview)
    if (rows.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("bonus_run_items")
        .upsert(rows, { onConflict: "run_id,project_id,employee_id" })
      if (upErr) {
        if (isPaidFrozen(upErr)) throw new BonusRunError(409, "not_draft", { status: "paid" })
        throw new Error(`bonus-run updateRun (upsert items): ${upErr.message}`)
      }
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
      if (sErr) {
        if (isPaidFrozen(sErr)) throw new BonusRunError(409, "not_draft", { status: "paid" })
        throw new Error(`bonus-run updateRun (stale item): ${sErr.message}`)
      }
    }
    patch.totals = preview.totals
    patch.snapshot = preview.snapshot
  }

  // 與 payRun 同一套原子更新：WHERE status＝讀到的狀態 ＋ 受影響列數。併發的 payRun／核准先落地時
  // 這裡命中 0 列（不是 error），回 409 not_draft，而不是讓 trigger 丟 500。
  const { data: updated, error } = await supabaseAdmin
    .from("bonus_runs")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", expectStatus)
    .select("id")
  if (error) {
    if (isUniqueViolation(error)) throw new BonusRunError(409, "label_exists", { label })
    if (isPaidFrozen(error)) throw new BonusRunError(409, "not_draft", { status: "paid" })
    throw new Error(`bonus-run updateRun: ${error.message}`)
  }
  if (!updated || updated.length === 0) throw new BonusRunError(409, "not_draft", { status: "changed" })
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { label: current.label, as_of: current.as_of, note: current.note, status: current.status, totals: current.totals },
    newRow: { ...patch, recomputed: recompute, returned_to_draft: returnedToDraft },
    actorEmpId: actor.empId,
    context: "PATCH /bonus-runs/:id",
  })
  if (returnedToDraft) {
    const title = `獎金批次 ${current.label} 金額變動，已退回草稿`
    const body = `${AMOUNT_CHANGED_RETURN_REASON}（原狀態：${current.status === "approved" ? "已核准" : "送審中"}）。`
    if (current.submitted_by_emp_id) {
      await enqueue({ tenantId, employeeIds: [current.submitted_by_emp_id], type: "bonus_run", title, body, payload: { bonusRunId: id, event: "returned", auto: true } })
    }
    // 老闆不一定進得了後台：audience=boss 的通知連到 ESS 簽核頁（apps/web lib/ess-notifications.ts）。
    const boss = await loadBossEmpId(tenantId).catch(() => null)
    if (boss && boss !== current.submitted_by_emp_id) {
      await enqueue({ tenantId, employeeIds: [boss], type: "bonus_run", title, body, payload: { bonusRunId: id, event: "returned", auto: true, audience: "boss" } })
    }
  }
  const detail = await getRun(tenantId, id)
  return detail ? { ...detail, returnedToDraft } : null
}

/** 退回草稿要寫的欄位：清送審／核准，記退回。 */
function returnPatch(returnedByEmpId: string | null, reason: string): Record<string, unknown> {
  return {
    status: "draft",
    submitted_at: null,
    submitted_by_emp_id: null,
    approved_at: null,
    approved_by_emp_id: null,
    approved_amount: null,
    approved_fingerprint: null,
    returned_at: new Date().toISOString(),
    returned_by_emp_id: returnedByEmpId,
    return_reason: reason,
  }
}

function assertTransition(status: string, action: Parameters<typeof transitionOf>[1]): void {
  const t = transitionOf(status, action)
  if (!t.ok) throw new BonusRunError(409, t.code, { status })
}

/** 原子狀態轉移：WHERE status＝from；0 列＝被別人搶先 → 409。 */
async function transitionRow(tenantId: string, id: string, from: string, patch: Record<string, unknown>, context: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", from)
    .select("id")
  if (error) {
    if (isPaidFrozen(error)) throw new BonusRunError(409, "not_draft", { status: "paid" })
    throw new Error(`bonus-run ${context}: ${error.message}`)
  }
  if (!data || data.length === 0) throw new BonusRunError(409, "status_changed", { expected: from })
}

function moneyText(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} 元`
}

/** 老闆：租戶 features.approval.fallbackApproverEmpId；沒設 → 409 boss_not_configured。 */
async function requireBoss(tenantId: string): Promise<string> {
  const boss = await loadBossEmpId(tenantId)
  if (!boss) throw new BonusRunError(409, "boss_not_configured")
  return boss
}

/** 呼叫者是不是老闆（給 ESS 簽核頁／後台決定要不要顯示核准按鈕）。 */
export async function isBonusApprover(tenantId: string, empId: string | null): Promise<boolean> {
  if (!empId) return false
  return (await loadBossEmpId(tenantId)) === empId
}

/** HR 送審：draft → pending_approval，記下金額指紋，通知老闆。 */
export async function submitRun(tenantId: string, actor: Actor, id: string): Promise<RunDetail | null> {
  await requireApprovalSchema()
  const current = await loadRun(tenantId, id)
  if (!current) return null
  assertTransition(current.status, "submit")
  const boss = await requireBoss(tenantId)
  // 送審前先用最新資料重算一次（沖銷批次不重算）：草稿可能是改版前或很久以前算的，
  // 老闆核准的必須是「現在算出來的」金額。
  let latest = current
  if (current.kind !== "reversal") {
    await updateRun(tenantId, actor, id, {}, { recompute: true })
    latest = (await loadRun(tenantId, id)) ?? current
    assertTransition(latest.status, "submit")
  }
  const items = await loadItemRows(tenantId, id)
  const totals = (latest.totals ?? EMPTY_TOTALS) as BonusTotals
  const nowIso = new Date().toISOString()
  await transitionRow(
    tenantId,
    id,
    "draft",
    {
      status: "pending_approval",
      submitted_at: nowIso,
      submitted_by_emp_id: actor.empId,
      approved_at: null,
      approved_by_emp_id: null,
      approved_amount: totals.amount ?? 0,
      approved_fingerprint: liveItemsFingerprint(items),
    },
    "submitRun",
  )
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: "draft" },
    newRow: { status: "pending_approval", submitted_by_emp_id: actor.empId, amount: totals.amount ?? 0 },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/submit",
  })
  await enqueue({
    tenantId,
    employeeIds: [boss],
    type: "bonus_run",
    title: `待核准：獎金批次 ${current.label}${current.kind === "reversal" ? "（沖銷）" : ""}`,
    body: `本批合計 ${moneyText(totals.amount ?? 0)}，${totals.employeeCount ?? 0} 人、${totals.projectCount ?? 0} 案。請至「待我簽核」或後台獎金批次頁核准。`,
    payload: { bonusRunId: id, event: "submitted", submittedByEmpId: actor.empId },
  })
  return getRun(tenantId, id)
}

/** 老闆核准：pending_approval → approved。核准前再比一次金額指紋（送審後若被改過就不能核准）。 */
export async function approveRun(tenantId: string, actor: Actor, id: string): Promise<RunDetail | null> {
  await requireApprovalSchema()
  const current = await loadRun(tenantId, id)
  if (!current) return null
  const boss = await requireBoss(tenantId)
  if (!actor.empId || actor.empId !== boss) throw new BonusRunError(403, "not_approver")
  assertTransition(current.status, "approve")
  const items = await loadItemRows(tenantId, id)
  if (current.approved_fingerprint && liveItemsFingerprint(items) !== current.approved_fingerprint) {
    throw new BonusRunError(409, "amount_changed")
  }
  await transitionRow(
    tenantId,
    id,
    "pending_approval",
    { status: "approved", approved_at: new Date().toISOString(), approved_by_emp_id: actor.empId },
    "approveRun",
  )
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: "pending_approval" },
    newRow: { status: "approved", approved_by_emp_id: actor.empId },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/approve",
  })
  await enqueue({
    tenantId,
    employeeIds: [current.submitted_by_emp_id ?? ""],
    type: "bonus_run",
    title: `獎金批次 ${current.label} 已核准`,
    body: "老闆已核准，可以發放。",
    payload: { bonusRunId: id, event: "approved", approvedByEmpId: actor.empId },
  })
  return getRun(tenantId, id)
}

/** 老闆退回（需原因）：pending_approval／approved → draft，通知送審人。 */
export async function returnRun(tenantId: string, actor: Actor, id: string, reason: string): Promise<RunDetail | null> {
  await requireApprovalSchema()
  const current = await loadRun(tenantId, id)
  if (!current) return null
  const boss = await requireBoss(tenantId)
  if (!actor.empId || actor.empId !== boss) throw new BonusRunError(403, "not_approver")
  assertTransition(current.status, "return")
  await transitionRow(tenantId, id, current.status, returnPatch(actor.empId, reason), "returnRun")
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: current.status },
    newRow: { status: "draft", returned_by_emp_id: actor.empId, return_reason: reason },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/return",
  })
  await enqueue({
    tenantId,
    employeeIds: [current.submitted_by_emp_id ?? ""],
    type: "bonus_run",
    title: `獎金批次 ${current.label} 已退回`,
    body: `退回原因：${reason}`,
    payload: { bonusRunId: id, event: "returned", returnedByEmpId: actor.empId },
  })
  return getRun(tenantId, id)
}

/**
 * HR 撤回送審（需原因）：pending_approval → draft，通知老闆。已核准後 HR 不能撤回（409 not_withdrawable），
 * 只能請老闆退回。退回欄位（returned_*）一併記下，畫面顯示「曾被撤回」。
 */
export async function withdrawRun(tenantId: string, actor: Actor, id: string, reason: string): Promise<RunDetail | null> {
  await requireApprovalSchema()
  const current = await loadRun(tenantId, id)
  if (!current) return null
  assertTransition(current.status, "withdraw")
  const fullReason = `HR 撤回：${reason}`
  await transitionRow(tenantId, id, "pending_approval", returnPatch(actor.empId, fullReason), "withdrawRun")
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: "pending_approval" },
    newRow: { status: "draft", returned_by_emp_id: actor.empId, return_reason: fullReason, withdrawn: true },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/withdraw",
  })
  const boss = await loadBossEmpId(tenantId).catch(() => null)
  if (boss) {
    await enqueue({
      tenantId,
      employeeIds: [boss],
      type: "bonus_run",
      title: `獎金批次 ${current.label} 已由 HR 撤回`,
      body: `撤回原因：${reason}。不需再核准，HR 修正後會重新送審。`,
      payload: { bonusRunId: id, event: "withdrawn", audience: "boss", withdrawnByEmpId: actor.empId },
    })
  }
  return getRun(tenantId, id)
}

/** approved → paid（凍結）。只收已核准；pay 前重抓 paid_before 逐列比對，不一致 → 409 stale_paid_before。 */
export async function payRun(tenantId: string, actor: Actor, id: string, paidOn: string): Promise<RunDetail | null> {
  await requireApprovalSchema()
  const current = await loadRun(tenantId, id)
  if (!current) return null
  assertTransition(current.status, "pay")

  const allItems = await loadItemRows(tenantId, id)
  if (current.approved_fingerprint && liveItemsFingerprint(allItems) !== current.approved_fingerprint) {
    throw new BonusRunError(409, "amount_changed")
  }
  const items = allItems.filter((r) => !isStale(r))
  const paidBefore = await loadPaidBefore(tenantId, id)
  const mismatched = items.filter((r) => (num(r.paid_before) ?? 0) !== Math.round(paidBefore.get(paidBeforeKey(r.project_id, r.employee_id)) ?? 0))
  if (mismatched.length > 0) {
    throw new BonusRunError(409, "stale_paid_before", {
      items: mismatched.map((r) => ({ projectId: r.project_id, employeeId: r.employee_id })),
    })
  }

  // 原子更新：WHERE 帶 status='approved' 且用 .select() 拿回受影響列數，取代先前的
  // 「check-then-update」——兩個併發 pay 都通過前面的 current.status 檢查後，
  // 只有先落地的那個真的把列改成 paid；另一個的 WHERE 子句因為列已經不是 approved
  // 而完全不命中，Postgres 回 0 列、不是 error（DB trigger forbid_paid_bonus_mutation
  // 也不會被觸發——它只在「有列被改」時才跑）。回 0 列一律 409 not_draft。
  const { data: updated, error } = await supabaseAdmin
    .from("bonus_runs")
    .update({ status: "paid", paid_on: paidOn, paid_by_emp_id: actor.empId })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", "approved")
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
    oldRow: { status: "approved", paid_on: null },
    newRow: { status: "paid", paid_on: paidOn, paid_by_emp_id: actor.empId, totals: current.totals },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/pay",
  })
  return getRun(tenantId, id)
}

/**
 * 開一批紅字沖銷（draft）。規則：
 *   • 原批必須是 paid 的 regular（draft 直接刪就好；沖銷批不能再被沖銷）
 *   • 一批只能被有效沖銷一次（DB partial unique 兜底，這裡先給明確錯誤）
 *   • 只能沖銷**最新一批** paid regular：後面若已有別批發放，那批的 paid_before
 *     是建立在原批之上的，回頭沖掉前一批會讓後批的數字失真——要沖就從最新的往回沖
 * 建好是 draft，走既有的 pay 才生效（pay 前的 stale_paid_before 檢查照樣保護）。
 */
export async function createReversalRun(tenantId: string, actor: Actor, runId: string, reason: string): Promise<RunDetail | null> {
  const original = await loadRun(tenantId, runId)
  if (!original) return null
  if (original.status !== "paid") throw new BonusRunError(409, "not_paid", { status: original.status })
  if (original.kind === "reversal") throw new BonusRunError(409, "reversal_of_reversal")
  const existing = await reversalOf(tenantId, runId)
  if (existing) throw new BonusRunError(409, "already_reversed", { runId: existing.id, status: existing.status })

  const { data: later, error: laterErr } = await supabaseAdmin
    .from("bonus_runs")
    .select("id, label, paid_on")
    .eq("tenant_id", tenantId)
    .eq("status", "paid")
    .eq("kind", "regular")
    .is("deleted_at", null)
    .neq("id", runId)
    .or(`paid_on.gt.${original.paid_on},and(paid_on.eq.${original.paid_on},created_at.gt.${original.created_at})`)
    .limit(1)
  if (laterErr) throw new Error(`bonus-run createReversalRun (later): ${laterErr.message}`)
  if (later && later.length > 0) {
    throw new BonusRunError(409, "not_latest_paid", { laterRunId: later[0].id as string, laterLabel: later[0].label as string })
  }

  const sourceItems = (await loadItemRows(tenantId, runId)).filter((r) => !isStale(r))
  const calc = sourceItems.map((r) => ({
    projectId: r.project_id,
    employeeId: r.employee_id,
    roleInProject: (r.snapshot?.roleInProject as string | null | undefined) ?? null,
    shareMode: r.share_mode,
    sharePct: num(r.share_pct),
    shareAmount: num(r.share_amount),
    bonusPool: num(r.bonus_pool),
    bonusRatePct: typeof r.snapshot?.bonusRatePct === "number" ? r.snapshot.bonusRatePct : null,
    contractTotal: num(r.contract_total),
    receivedTotal: num(r.received_total) ?? 0,
    basis: (r.snapshot?.basis ?? (r.share_mode === "fixed_amount" ? "fixed_amount" : "legacy_pool")) as BonusBasis,
    cost: typeof r.snapshot?.cost === "number" ? r.snapshot.cost : 0,
    disbursementCost: typeof r.snapshot?.disbursementCost === "number" ? r.snapshot.disbursementCost : 0,
    subcontractCost: typeof r.snapshot?.subcontractCost === "number" ? r.snapshot.subcontractCost : 0,
    grossProfit: typeof r.snapshot?.grossProfit === "number" ? r.snapshot.grossProfit : (num(r.received_total) ?? 0),
    overContractPct: typeof r.snapshot?.overContractPct === "number" ? r.snapshot.overContractPct : null,
    receivedPct: num(r.received_pct) ?? 0,
    previousReceived: typeof r.snapshot?.previousReceived === "number" ? r.snapshot.previousReceived : 0,
    previousReceivedPct: typeof r.snapshot?.previousReceivedPct === "number" ? r.snapshot.previousReceivedPct : 0,
    currentReceived: typeof r.snapshot?.currentReceived === "number" ? r.snapshot.currentReceived : (num(r.received_total) ?? 0),
    currentReceivedPct: typeof r.snapshot?.currentReceivedPct === "number" ? r.snapshot.currentReceivedPct : (num(r.received_pct) ?? 0),
    unallocatedPct: typeof r.snapshot?.unallocatedPct === "number" ? r.snapshot.unallocatedPct : 0,
    projectNote: typeof r.snapshot?.projectNote === "string" ? r.snapshot.projectNote : null,
    entitledCumulative: num(r.entitled_cumulative) ?? 0,
    paidBefore: num(r.paid_before) ?? 0,
    amount: num(r.amount) ?? 0,
    overpaid: r.overpaid,
    overpaidBy: typeof r.snapshot?.overpaidBy === "number" ? (r.snapshot.overpaidBy as number) : 0,
  }))
  const reversed = reversalItemsOf(calc)
  const totals = reversalTotalsOf((original.totals ?? EMPTY_TOTALS) as BonusTotals, calc)
  const label = `${original.label}-沖銷`

  const { data: run, error } = await supabaseAdmin
    .from("bonus_runs")
    .insert({
      tenant_id: tenantId,
      label,
      as_of: original.as_of,
      status: "draft",
      kind: "reversal",
      reverses_run_id: runId,
      totals,
      snapshot: { reversalOf: runId, reversalOfLabel: original.label, reason, originalPaidOn: original.paid_on },
      note: reason,
      created_by_emp_id: actor.empId,
    })
    .select(await runCols())
    .single()
  if (error || !run) {
    if (error && isUniqueViolation(error)) {
      // 撞到 bonus_runs_reverses_uq（併發重複沖銷）或 label 唯一
      throw new BonusRunError(409, "already_reversed", { label })
    }
    throw new Error(`bonus-run createReversalRun: ${error?.message}`)
  }
  const newRunId = (run as unknown as RunRow).id
  const rows = reversed.map((i, idx) => ({
    tenant_id: tenantId,
    run_id: newRunId,
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
    overpaid: false,
    snapshot: { ...(sourceItems[idx].snapshot ?? {}), overpaidBy: 0, stale: false, reversalOfItemId: sourceItems[idx].id },
  }))
  if (rows.length > 0) {
    const { error: iErr } = await supabaseAdmin.from("bonus_run_items").insert(rows)
    if (iErr) {
      await supabaseAdmin
        .from("bonus_runs")
        .update({ deleted_at: new Date().toISOString(), deleted_by_emp_id: actor.empId, delete_reason: `reversal items insert failed: ${iErr.message}` })
        .eq("id", newRunId)
      throw new Error(`bonus-run createReversalRun (items): ${iErr.message}`)
    }
  }
  await writeAuditLog({
    tenantId,
    tableName: "bonus_runs",
    recordId: newRunId,
    action: "INSERT",
    newRow: { kind: "reversal", reverses_run_id: runId, label, reason, totals },
    actorEmpId: actor.empId,
    context: "POST /bonus-runs/:id/reverse",
  })
  return getRun(tenantId, newRunId)
}

/** draft 軟刪（paid → 409 not_draft）。 */
export async function deleteRun(tenantId: string, actor: Actor, id: string, reason: string): Promise<boolean> {
  const current = await loadRun(tenantId, id)
  if (!current) return false
  assertTransition(current.status, "delete")
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
    .select(await runCols())
    .eq("tenant_id", tenantId)
    .eq("status", "paid")
    .is("deleted_at", null)
    .order("as_of", { ascending: true })
  if (error) throw new Error(`bonus-run loadPaidRuns: ${error.message}`)
  const runs = (runRows ?? []) as unknown as RunRow[]
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

/* ──────────────────────────────────────────────────────────────────
 * M22：入帳後自動重算 draft 批次
 * ────────────────────────────────────────────────────────────────── */

export interface RecomputeDraftRunsResult {
  /** 重算成功的批次 id。 */
  recomputed: string[]
  /** 重算後金額變動、從送審中／已核准退回草稿的批次 id（#7）。 */
  returnedToDraft: string[]
  /** 重算失敗的批次（不擋呼叫端的主流程，只回報）。 */
  failed: Array<{ id: string; error: string }>
}

/**
 * M22：把該租戶所有**未發放**（draft／送審中／已核准）且 kind='regular' 的獎金批次重算一次。
 *
 * 獎金依入帳與成本（毛利制）累計計算，所以每一次入帳／退回入帳、放款付款／作廢、複委託付款、
 * 合約額／追加減／趴數／比例變動都會改變每個人的應得金額；忘記按重算＝依舊資料發錢。
 * 這支在那些事件成功後 best-effort 跑一次，讓未發放批次永遠跟著最新資料走。
 * 送審中／已核准的批次重算後金額變了 → updateRun 會退回草稿（需重新送審）；金額沒變則維持原狀態。
 *
 * 刻意排除：
 *   • paid 批次——已發放就凍結（DB trigger 也會擋），不是這裡的事。
 *   • kind='reversal'——沖銷批次的內容是原批取負，重算會把它蓋成一般季批次
 *     （updateRun 本來就會丟 reversal_not_editable）。
 *
 * 失敗不丟例外：主流程已經寫進 DB 了，不能因為獎金重算失敗就讓它看起來沒成功。
 * 呼叫端把結果放進回應（`bonusRunsRecomputed`）並自行 log。
 */
export async function recomputeDraftRegularRuns(tenantId: string): Promise<RecomputeDraftRunsResult> {
  const statuses = (await bonusRunsHaveApproval()) ? [...UNPAID_STATUSES] : ["draft"]
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("status", statuses)
    .eq("kind", "regular")
    .is("deleted_at", null)
    .order("as_of", { ascending: true })
  if (error) throw new Error(`recomputeDraftRegularRuns (list): ${error.message}`)

  const recomputed: string[] = []
  const returnedToDraft: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const row of (data ?? []) as Array<{ id: string }>) {
    try {
      // actor 留 null：這不是某個人「編輯了批次」，是資料事件連動的系統重算；
      // 誰改了資料由那筆資料自己的 audit 記著。
      const res = await updateRun(tenantId, { empId: null }, row.id, {}, { recompute: true })
      recomputed.push(row.id)
      if (res?.returnedToDraft) returnedToDraft.push(row.id)
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { recomputed, returnedToDraft, failed }
}

/**
 * #3 自動重算（2026-10-26）：某專案的合約額／追加減／成員趴數／獎金比例、或成本（放款付款、
 * 複委託付款）變動後呼叫。
 *
 * 為什麼不是「只重算含這個案的批次」：批次的明細是整個租戶一起算的——專案第一次有成員、
 * 封存案封存後進了尾款，都會讓「本來不在批次裡的案」出現；只挑含該案的批次會漏。所以等同
 * recomputeDraftRegularRuns（租戶全部未發放 regular 批次），projectId 只用於 log／回報。
 * 一般租戶同時只有 0～1 批未發放，成本可以接受。永遠不丟例外（列批次失敗也包成 failed）。
 */
export async function recomputeDraftRunsForProject(tenantId: string, projectId: string): Promise<RecomputeDraftRunsResult & { projectId: string }> {
  try {
    const res = await recomputeDraftRegularRuns(tenantId)
    return { projectId, ...res }
  } catch (err) {
    return { projectId, recomputed: [], returnedToDraft: [], failed: [{ id: "*", error: err instanceof Error ? err.message : String(err) }] }
  }
}

/**
 * 成本／入帳寫入端用的 best-effort 包裝：重算失敗只 log，永遠不丟例外、不改變主流程回應。
 * 回傳重算了哪些批次（呼叫端可放進回應）。
 */
export async function recomputeBonusRunsBestEffort(tenantId: string, projectIds: ReadonlyArray<string | null | undefined>, context: string): Promise<string[]> {
  const ids = [...new Set(projectIds.filter((v): v is string => !!v))]
  if (ids.length === 0) return []
  const res = await recomputeDraftRunsForProject(tenantId, ids[0] as string)
  if (res.failed.length > 0) {
    console.warn(`[bonus-recompute] ${context}: ${res.failed.length} 批重算失敗`, res.failed)
  }
  return res.recomputed
}

/* ──────────────────────────────────────────────────────────────────
 * 老闆的待核准清單（ESS 簽核頁「獎金批次」卡）
 * ────────────────────────────────────────────────────────────────── */

/** 送審中的批次（含明細，舊到新）。只給老闆看（路由先擋）。 */
export async function listPendingApprovals(tenantId: string): Promise<RunDetail[]> {
  if (!(await bonusRunsHaveApproval())) return []
  const { data, error } = await supabaseAdmin
    .from("bonus_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "pending_approval")
    .is("deleted_at", null)
    .order("submitted_at", { ascending: true })
  if (error) throw new Error(`bonus-run listPendingApprovals: ${error.message}`)
  const out: RunDetail[] = []
  for (const row of (data ?? []) as Array<{ id: string }>) {
    const detail = await getRun(tenantId, row.id)
    if (detail) out.push(detail)
  }
  return out
}
