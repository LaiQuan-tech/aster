import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "./audit.js"
import { recomputeBillings } from "./billing-store.js"
import {
  isUniqueViolation,
  nextDuplicateCode,
  parseDupSuffix,
  MAX_CODE_ATTEMPTS,
} from "./project-code.js"
import { summarizeContracts, type ContractLite } from "./project-money.js"
import { CONTRACT_LITE_COLS, batch, compareCode } from "./project-application-store.js"
import {
  computeStampDuty,
  resolveStampDutyRequired,
  DEFAULT_STAMP_DUTY_RATE,
} from "./stamp-duty.js"

/**
 * C2 複製專案（追加減／加做）＋原案自動封存＋變更歷史。
 *
 * ── 為什麼是「複製」而不是「改」 ─────────────────────────────────────
 * 客戶會議的關鍵邏輯：合約變更（1000 萬變 2000 萬）**不能改原案**。原案的
 * 編號印在舊合約、請款單、發票上，改了金額就對不回去。所以：
 *   1. 把原案複製成新案 `{根案 code}-{n}`（`AT-115-013` → `AT-115-013-1`），
 *      帶著業主／現場／工程師／期程結構／副委託結構／成員分潤比例過去；
 *   2. 新案依 `amount` **新建一筆合約**（change → change_order、addition → contract），
 *      不複製原案的任何合約——分母以新案自己的合約為準；
 *   3. 原案 `archived_at=now()`＋`archive_reason='已由 {新 code} 取代：{理由}'`，
 *      年度總表／未收款／應付／總覽都已排除封存案，所以不會重複採計，
 *      但原案還在（`?includeArchived=1`、變更歷史都查得到）。
 *
 * ── 不複製的東西 ─────────────────────────────────────────────────
 * code（另產）、bonus_pool、other_expenses（新案的支出從零起算）、status_*／
 * archived_*／reserved_at（新案是乾淨的進行中案）、contracts（改依 amount 新建）、
 * 期程的 billed／invoiced／received 事件、副委託的付款事件。
 * 這些不是「忘了」，是**新案的錢從零開始**——複製過去會把舊案的請款算成新案的。
 *
 * ── 母案永遠是根 main 案 ────────────────────────────────────────────
 * routes/projects.ts 的 validateParent 規定母案必須是 main（不能疊羅漢），
 * 所以從 `-1` 再複製出 `-2` 時，`-2` 的 parent 仍是根案，不是 `-1`。
 * 變更歷史（loadLineage）就是「根案＋所有掛在根案底下的案」。
 *
 * ── 沒有交易 ──────────────────────────────────────────────────────
 * supabase-js 沒有多語句交易；本檔與 routes/subcontracts.ts、billings.ts 一樣
 * 是逐筆寫。中途失敗會留下一個半成品新案（有 code、缺子表），呼叫端會拿到
 * 500；原案的封存放在**最後一步**，所以半成品不會連帶把原案收掉。
 */

export const DUPLICATE_KINDS = ["change", "addition"] as const
export type DuplicateKind = (typeof DUPLICATE_KINDS)[number]

export type DuplicateCopyOptions = {
  engineers: boolean
  subcontracts: boolean
  billings: boolean
  members: boolean
}

export const DEFAULT_COPY_OPTIONS: DuplicateCopyOptions = {
  engineers: true,
  subcontracts: true,
  billings: true,
  members: true,
}

export type DuplicateProjectInput = {
  tenantId: string
  sourceProjectId: string
  actorEmpId: string
  kind: DuplicateKind
  /** 新案的合約金額（未稅）。 */
  amount: number
  /** 變更理由——寫進原案的 archive_reason 與稽核。 */
  reason: string
  archiveOriginal: boolean
  copy: DuplicateCopyOptions
  /** 新案的開案日（租戶今天）。 */
  openedOn: string
  nowIso?: string
}

export type DuplicateProjectError =
  | "not_found"
  | "reserved_project"
  | "root_code_missing"
  | "code_generation_failed"

export type DuplicateProjectResult =
  | {
      ok: true
      project: {
        id: string
        code: string
        name: string
        kind: DuplicateKind
        parentProjectId: string
        rootCode: string
      }
      archived: { id: string; code: string | null } | null
    }
  | { ok: false; status: number; error: DuplicateProjectError }

// ⚠️ 單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別。
const SOURCE_COLS =
  "id, name, code, fiscal_year, description, status, archived_at, starts_on, ends_on, dept_id, lead_emp_id, share_mode, client_id, parent_project_id, kind, reserved_at, site_address, site_area_m2, design_scope, invoice_type, payment_method, closing_day, payment_day, engineers"

type SourceRow = {
  id: string
  name: string
  code: string | null
  fiscal_year: number | null
  description: string | null
  status: string
  archived_at: string | null
  starts_on: string | null
  ends_on: string | null
  dept_id: string | null
  lead_emp_id: string | null
  share_mode: string
  client_id: string | null
  parent_project_id: string | null
  kind: string
  reserved_at: string | null
  site_address: string | null
  site_area_m2: string | number | null
  design_scope: unknown
  invoice_type: string | null
  payment_method: string | null
  closing_day: string | null
  payment_day: string | null
  engineers: unknown
}

const KIND_LABEL: Record<DuplicateKind, string> = { change: "追加減", addition: "加做" }

/** 複製案名稱的後綴；再複製時先剝掉舊後綴，免得變成「X（追加減 1）（追加減 2）」。 */
const DUP_SUFFIX_RE = /（(?:追加減|加做) \d+）$/u

export function duplicateName(sourceName: string, kind: DuplicateKind, n: number): string {
  const base = sourceName.replace(DUP_SUFFIX_RE, "").trimEnd()
  return `${base}（${KIND_LABEL[kind]} ${n}）`
}

export function archiveReasonFor(newCode: string, reason: string): string {
  return `已由 ${newCode} 取代：${reason}`
}

async function loadSource(tenantId: string, projectId: string): Promise<SourceRow | null> {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select(SOURCE_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`project-duplicate loadSource: ${error.message}`)
  return (data as SourceRow | null) ?? null
}

/**
 * 沿 parent 鏈找根 main 案。validateParent 保證母案是 main，所以正常只有一跳；
 * 迴圈上限只是防資料被手動改壞時無限繞。母案不見了就把自己當根——
 * 這不該發生，但發生時寧可產出 `{自己的 code}-1` 也不要 500。
 */
async function resolveRoot(tenantId: string, source: SourceRow): Promise<SourceRow> {
  let cur = source
  for (let hops = 0; hops < 10; hops++) {
    if ((cur.kind ?? "main") === "main" || !cur.parent_project_id) return cur
    const parent = await loadSource(tenantId, cur.parent_project_id)
    if (!parent) return cur
    cur = parent
  }
  return cur
}

/** 來源案最新一筆（未作廢）合約／報價單的 our_role；一筆都沒有就 contractor。 */
async function latestOurRole(tenantId: string, projectId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select("our_role")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("signed_on", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`project-duplicate latestOurRole: ${error.message}`)
  return (data?.our_role as string | undefined) ?? "contractor"
}

/** 與 routes/contracts.ts 的 tenantStampDutyDefaults 同一份設定（費率凍結在合約列上）。 */
async function tenantStampDutyRate(tenantId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("project_settings")
    .select("stamp_duty_rate")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`project-duplicate stampDutyRate: ${error.message}`)
  return data?.stamp_duty_rate !== null && data?.stamp_duty_rate !== undefined
    ? Number(data.stamp_duty_rate)
    : DEFAULT_STAMP_DUTY_RATE
}

export async function duplicateProject(input: DuplicateProjectInput): Promise<DuplicateProjectResult> {
  const { tenantId, actorEmpId, kind, amount, reason, copy } = input
  const nowIso = input.nowIso ?? new Date().toISOString()

  const source = await loadSource(tenantId, input.sourceProjectId)
  if (!source) return { ok: false, status: 404, error: "not_found" }
  // 預先取號的空列還不是案子，沒有東西可複製。
  if (source.reserved_at) return { ok: false, status: 409, error: "reserved_project" }

  const root = await resolveRoot(tenantId, source)
  const rootCode = root.code
  if (!rootCode) return { ok: false, status: 409, error: "root_code_missing" }

  // ── 1. 新案本體（撞號重試） ──────────────────────────────────────
  const baseRow = {
    tenant_id: tenantId,
    fiscal_year: source.fiscal_year ?? Number(input.openedOn.slice(0, 4)),
    description: source.description,
    dept_id: source.dept_id,
    lead_emp_id: source.lead_emp_id,
    share_mode: source.share_mode,
    bonus_pool: null,
    starts_on: source.starts_on,
    ends_on: source.ends_on,
    opened_on: input.openedOn,
    status: "active",
    client_id: source.client_id,
    parent_project_id: root.id,
    kind,
    site_address: source.site_address,
    site_area_m2: source.site_area_m2,
    design_scope: source.design_scope ?? [],
    invoice_type: source.invoice_type,
    payment_method: source.payment_method,
    closing_day: source.closing_day,
    payment_day: source.payment_day,
    other_expenses: 0,
    engineers: copy.engineers ? (source.engineers ?? {}) : {},
  }

  let inserted: { id: string; code: string; name: string } | null = null
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !inserted; attempt++) {
    const code = await nextDuplicateCode(tenantId, rootCode)
    const name = duplicateName(source.name, kind, parseDupSuffix(rootCode, code) ?? 1)
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ ...baseRow, code, name })
      .select("id, code, name")
      .single()
    if (!error) {
      inserted = { id: data!.id as string, code: data!.code as string, name: data!.name as string }
      break
    }
    if (!isUniqueViolation(error)) throw new Error(`project-duplicate insert: ${error.message}`)
    // 撞號 → 下一圈重算
  }
  if (!inserted) return { ok: false, status: 503, error: "code_generation_failed" }
  const newId = inserted.id

  // ── 2. 合約：依 amount 新建一筆，不複製原案的 ─────────────────────
  const docType = kind === "change" ? "change_order" : "contract"
  const ourRole = await latestOurRole(tenantId, source.id)
  const flag = "auto"
  const dutiable = resolveStampDutyRequired({ docType, ourRole, flag })
  const rate = await tenantStampDutyRate(tenantId)
  const { error: contractErr } = await supabaseAdmin.from("contracts").insert({
    tenant_id: tenantId,
    project_id: newId,
    client_id: source.client_id,
    doc_type: docType,
    our_role: ourRole,
    title: `${kind === "change" ? "追加減帳" : "加做合約"} · 自 ${source.code ?? source.name}`,
    counterparty: null,
    amount,
    signed_on: null,
    copies: 1,
    version: 1,
    stamp_duty_required: flag,
    stamp_duty_rate: dutiable ? rate : null,
    stamp_duty_amount: dutiable ? computeStampDuty({ amount, rate, copies: 1 }) : null,
    created_by_emp_id: actorEmpId,
  })
  if (contractErr) throw new Error(`project-duplicate contract: ${contractErr.message}`)

  // ── 3. 期程：只帶期別結構（期別／kind／百分比／里程碑），事件與覆寫不帶 ──
  if (copy.billings) {
    const { data: bills, error } = await supabaseAdmin
      .from("project_billings")
      .select("installment_no, kind, percentage, milestone")
      .eq("tenant_id", tenantId)
      .eq("project_id", source.id)
      .is("deleted_at", null)
      .order("installment_no", { ascending: true })
    if (error) throw new Error(`project-duplicate billings(load): ${error.message}`)
    if (bills && bills.length > 0) {
      const { error: insErr } = await supabaseAdmin.from("project_billings").insert(
        bills.map((b) => ({
          tenant_id: tenantId,
          project_id: newId,
          installment_no: b.installment_no,
          kind: b.kind ?? "installment",
          percentage: b.percentage,
          milestone: b.milestone,
          created_by_emp_id: actorEmpId,
        })),
      )
      if (insErr) throw new Error(`project-duplicate billings(insert): ${insErr.message}`)
    }
  }
  // 新案有了自己的合約與期程，試算金額要落到 DB（同 contracts.ts 新增合約後的做法）。
  await recomputeBillings(tenantId, newId)

  // ── 4. 副委託：結構（科別／廠商／kind／金額），不帶付款事件與合約參照 ──
  if (copy.subcontracts) {
    const { data: subs, error } = await supabaseAdmin
      .from("project_subcontracts")
      .select(
        "kind, discipline, vendor_id, vendor_name, contact, item, amount, billing_basis, order_type, withholding_rate, withholding_threshold, sort_order, note",
      )
      .eq("tenant_id", tenantId)
      .eq("project_id", source.id)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
    if (error) throw new Error(`project-duplicate subcontracts(load): ${error.message}`)
    if (subs && subs.length > 0) {
      const { error: insErr } = await supabaseAdmin.from("project_subcontracts").insert(
        subs.map((s) => ({
          tenant_id: tenantId,
          project_id: newId,
          kind: s.kind,
          discipline: s.discipline,
          vendor_id: s.vendor_id,
          vendor_name: s.vendor_name,
          contact: s.contact,
          item: s.item,
          amount: s.amount,
          billing_basis: s.billing_basis,
          order_type: s.order_type,
          contract_id: null,
          withholding_rate: s.withholding_rate,
          withholding_threshold: s.withholding_threshold,
          sort_order: s.sort_order,
          note: s.note,
          created_by_emp_id: actorEmpId,
          updated_at: nowIso,
        })),
      )
      if (insErr) throw new Error(`project-duplicate subcontracts(insert): ${insErr.message}`)
    }
  }

  // ── 5. 成員：角色與分潤比例；固定金額不帶（bonus_pool 也不帶，新案的分潤另談） ──
  if (copy.members) {
    const { data: members, error } = await supabaseAdmin
      .from("project_members")
      .select("employee_id, role_in_project, share_pct")
      .eq("tenant_id", tenantId)
      .eq("project_id", source.id)
    if (error) throw new Error(`project-duplicate members(load): ${error.message}`)
    if (members && members.length > 0) {
      const { error: insErr } = await supabaseAdmin.from("project_members").insert(
        members.map((m) => ({
          tenant_id: tenantId,
          project_id: newId,
          employee_id: m.employee_id,
          role_in_project: m.role_in_project ?? "member",
          share_pct: m.share_pct,
          share_amount: null,
        })),
      )
      if (insErr) throw new Error(`project-duplicate members(insert): ${insErr.message}`)
    }
  }

  await writeAuditLog({
    tenantId,
    tableName: "projects",
    recordId: newId,
    action: "INSERT",
    newRow: {
      code: inserted.code,
      kind,
      parent_project_id: root.id,
      duplicated_from: source.id,
      duplicated_from_code: source.code,
      amount,
      reason,
      copy,
      archive_original: input.archiveOriginal,
    },
    actorEmpId,
    context: "POST /projects/:id/duplicate",
  })

  // ── 6. 原案封存（最後一步：前面失敗不會連帶把原案收掉） ────────────
  let archived: { id: string; code: string | null } | null = null
  if (input.archiveOriginal) {
    const patch: Record<string, unknown> = { archive_reason: archiveReasonFor(inserted.code, reason) }
    // 已封存就不覆寫時點——重複封存不該把原本的封存日洗掉（同 project-status.ts）。
    if (!source.archived_at) patch.archived_at = nowIso
    const { error } = await supabaseAdmin
      .from("projects")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("id", source.id)
    if (error) throw new Error(`project-duplicate archive: ${error.message}`)
    archived = { id: source.id, code: source.code }
    await writeAuditLog({
      tenantId,
      tableName: "projects",
      recordId: source.id,
      action: "UPDATE",
      oldRow: { archived_at: source.archived_at },
      newRow: { ...patch, replaced_by: newId },
      actorEmpId,
      context: "POST /projects/:id/duplicate (archive original)",
    })
  }

  return {
    ok: true,
    project: {
      id: newId,
      code: inserted.code,
      name: inserted.name,
      kind,
      parentProjectId: root.id,
      rootCode,
    },
    archived,
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 變更歷史：根案＋所有同源後代
 * ────────────────────────────────────────────────────────────────── */

const LINEAGE_COLS =
  "id, name, code, kind, status, parent_project_id, opened_on, archived_at, archive_reason, created_at"

type LineageRow = {
  id: string
  name: string
  code: string | null
  kind: string
  status: string
  parent_project_id: string | null
  opened_on: string | null
  archived_at: string | null
  archive_reason: string | null
  created_at: string
}

export type LineageEntry = {
  id: string
  code: string | null
  name: string
  kind: string
  status: string
  parentProjectId: string | null
  openedOn: string | null
  archivedAt: string | null
  archiveReason: string | null
  /** 合約總額（我方承攬的合約＋追加減，未稅）；非 finance 或沒合約時 null。 */
  contractTotal: number | null
  createdAt: string
}

export type Lineage = {
  rootId: string
  projects: LineageEntry[]
}

async function loadLineageRow(tenantId: string, projectId: string): Promise<LineageRow | null> {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select(LINEAGE_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`loadLineage(root): ${error.message}`)
  return (data as LineageRow | null) ?? null
}

/**
 * 從任一案出發：先沿 parent 鏈到根，再把掛在根底下的案全撈回來
 * （validateParent 只允許一層，BFS 只是防手動改壞的資料）。依編號排序
 * （application-store 的 compareCode：`-2` 排在 `-10` 前面）。
 * `finance=false` 時不帶合約總額——變更歷史是基本資料，金額才是 finance 段。
 */
export async function loadLineage(
  tenantId: string,
  projectId: string,
  opts: { finance: boolean },
): Promise<Lineage | null> {
  const start = await loadLineageRow(tenantId, projectId)
  if (!start) return null

  let root = start
  for (let hops = 0; hops < 10; hops++) {
    if ((root.kind ?? "main") === "main" || !root.parent_project_id) break
    const parent = await loadLineageRow(tenantId, root.parent_project_id)
    if (!parent) break
    root = parent
  }

  const rows = new Map<string, LineageRow>([[root.id, root]])
  let frontier = [root.id]
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const children = await batch<LineageRow>("projects", LINEAGE_COLS, tenantId, frontier, "parent_project_id", false)
    frontier = []
    for (const c of children) {
      if (rows.has(c.id)) continue
      rows.set(c.id, c)
      frontier.push(c.id)
    }
  }
  // 起點若因資料異常不在樹裡，也要看得到自己。
  if (!rows.has(start.id)) rows.set(start.id, start)

  const totals = new Map<string, number | null>()
  if (opts.finance) {
    const contracts = await batch<ContractLite & { project_id: string }>(
      "contracts",
      CONTRACT_LITE_COLS,
      tenantId,
      [...rows.keys()],
      "project_id",
      true,
    )
    const byProject = new Map<string, ContractLite[]>()
    for (const c of contracts) {
      const arr = byProject.get(c.project_id)
      if (arr) arr.push(c)
      else byProject.set(c.project_id, [c])
    }
    for (const id of rows.keys()) totals.set(id, summarizeContracts(byProject.get(id) ?? []).total)
  }

  const projects: LineageEntry[] = [...rows.values()]
    .sort((a, b) => compareCode(a.code, b.code) || a.created_at.localeCompare(b.created_at))
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind ?? "main",
      status: r.status,
      parentProjectId: r.parent_project_id,
      openedOn: r.opened_on,
      archivedAt: r.archived_at,
      archiveReason: r.archive_reason,
      contractTotal: opts.finance ? (totals.get(r.id) ?? null) : null,
      createdAt: r.created_at,
    }))

  return { rootId: root.id, projects }
}
