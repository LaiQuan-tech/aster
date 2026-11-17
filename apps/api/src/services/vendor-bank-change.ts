import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { isBossOrPlatformAdmin, loadConfiguredBossEmpId, bossNotificationRecipients } from "../lib/boss.js"
import { actorIsInactive } from "../lib/actor-status.js"
import { isHrRole } from "../middleware/scope.js"
import { writeAuditLogStrict } from "./audit.js"
import { enqueue } from "./notify.js"

/**
 * 廠商收款帳戶變更雙人覆核（2026-11-17 業主決定；packages/db migration 0103 ＝ sql/0093）。
 *
 * - 廠商有未付期款（services/vendor-unpaid.ts）時，名冊改帳戶（代碼／銀行名／帳號／戶名）不直接生效，
 *   改建一筆 vendor_bank_change_requests（status pending）；同一廠商同時只能一筆（partial unique index）。
 *   未匯款放款單照舊硬擋（routes/vendors.ts），不會走到這裡。
 * - 覆核者：在職的老闆（lib/boss.ts isBossOrPlatformAdmin：設定的老闆或 platform_admin）或 HR（isHrRole），且不是申請人本人。
 * - 核准／退回／取消一律走 DB 函式 decide_vendor_bank_change（同一交易：鎖列、舊值樂觀檢查、套用、寫稽核）。
 * - 廠商有 pending 變更時，該廠商的放款單送審／核准／付款 409 vendor_bank_change_pending（services/disbursements.ts）。
 * - 0103 尚未套用（表不存在）：pending 查詢一律當「沒有」、建立申請回 409 migration_required（不會默默直接改帳戶）。
 */

export const BANK_CHANGE_TABLE = "vendor_bank_change_requests"
export const BANK_CHANGE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const
export type BankChangeStatus = (typeof BANK_CHANGE_STATUSES)[number]

export type BankFields = {
  bank_code: string | null
  bank_name: string | null
  bank_account: string | null
  account_holder: string | null
}

export type BankChangeRow = {
  id: string
  tenant_id: string
  vendor_id: string
  requested_by_emp_id: string | null
  old_bank_code: string | null
  old_bank_name: string | null
  old_bank_account: string | null
  old_account_holder: string | null
  new_bank_code: string | null
  new_bank_name: string | null
  new_bank_account: string | null
  new_account_holder: string | null
  reason: string | null
  status: BankChangeStatus
  decided_by_emp_id: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
}

const COLS =
  "id, tenant_id, vendor_id, requested_by_emp_id, old_bank_code, old_bank_name, old_bank_account, old_account_holder, new_bank_code, new_bank_name, new_bank_account, new_account_holder, reason, status, decided_by_emp_id, decided_at, decision_note, created_at"

export class BankChangeError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = "BankChangeError"
  }
}

/** 帳號只露末 4 碼（取開頭帳號段的數字；沒有數字回「****」；空值回 null）。核准放款的畫面一律用這個，完整帳號不送到核准者前端。 */
export function maskBankAccount(account: string | null | undefined): string | null {
  if (account == null) return null
  const raw = String(account).trim()
  if (!raw) return null
  // 放款單快照是「帳號 戶名」：只取開頭的帳號段（數字／空白／連字號），免得戶名裡的數字混進末 4 碼。
  const lead = (raw.match(/^[\d\s\-－‐–—]+/)?.[0] ?? "").replace(/\D/g, "")
  const digits = lead || raw.replace(/\D/g, "")
  return `****${digits.slice(-4)}`
}

/** 表不存在（0103 未套）→ true 並記一次 log。 */
function tableMissing(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (isMissingTableError(err) || isMissingColumnError(err)) {
    warnSchemaGapOnce("vendor_bank_change_requests(0103)", err)
    return true
  }
  return false
}

/** 這些廠商中有待覆核帳戶變更的（小寫 id）。表未套用 → 空集合。 */
export async function vendorsWithPendingBankChange(tenantId: string, vendorIds: ReadonlyArray<string | null | undefined>): Promise<Set<string>> {
  const ids = [...new Set(vendorIds.filter((v): v is string => !!v))]
  const out = new Set<string>()
  if (ids.length === 0) return out
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from(BANK_CHANGE_TABLE)
      .select("vendor_id")
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .in("vendor_id", ids.slice(i, i + 100))
    if (error) {
      if (tableMissing(error)) return out
      throw new Error(`vendorsWithPendingBankChange: ${error.message}`)
    }
    for (const r of (data ?? []) as Array<{ vendor_id: string }>) out.add(String(r.vendor_id).toLowerCase())
  }
  return out
}

export async function vendorHasPendingBankChange(tenantId: string, vendorId: string): Promise<boolean> {
  return (await vendorsWithPendingBankChange(tenantId, [vendorId])).has(vendorId.toLowerCase())
}

/** 覆核資格：在職的老闆／platform_admin 或 HR（不含申請人本人的判斷，見 decide）。 */
export async function canReviewBankChange(
  tenantId: string,
  self: { id?: string | null; role?: string | null; active?: boolean | null } | null | undefined,
): Promise<boolean> {
  if (!self?.id || actorIsInactive(self)) return false
  if (isHrRole(self.role)) return true
  const boss = await loadConfiguredBossEmpId(tenantId)
  return isBossOrPlatformAdmin(boss, self)
}

/** 覆核通知收件人：老闆＋在職 platform_admin＋在職 hr_admin，排除申請人。 */
async function reviewerRecipients(tenantId: string, requesterEmpId: string | null): Promise<string[]> {
  const boss = await loadConfiguredBossEmpId(tenantId).catch(() => null)
  const bossAndAdmins = await bossNotificationRecipients(tenantId, boss, [requesterEmpId])
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("role", "hr_admin")
    .eq("status", "active")
  const hr = error ? [] : ((data ?? []) as Array<{ id: string }>).map((r) => r.id.toLowerCase())
  const skip = requesterEmpId?.toLowerCase()
  return [...new Set([...bossAndAdmins, ...hr])].filter((id) => id !== skip)
}

/**
 * 建立待覆核申請（呼叫端已確認：帳戶有變、有未付期款、沒有未匯款放款單、名稱沒同時改）。
 * 先寫嚴格稽核（寫不進去就不建），再 insert；同廠商已有 pending → 409 vendor_bank_change_pending。
 */
export async function createBankChangeRequest(params: {
  tenantId: string
  vendorId: string
  vendorName: string
  requestedByEmpId: string | null
  before: BankFields
  after: BankFields
  reason: string | null
}): Promise<BankChangeRow> {
  const { tenantId, vendorId } = params
  if (await vendorHasPendingBankChange(tenantId, vendorId)) {
    throw new BankChangeError(409, "vendor_bank_change_pending", { message: "此廠商已有一筆收款帳戶變更待覆核，請等覆核完成或取消後再改" })
  }
  const id = crypto.randomUUID()
  const row = {
    id,
    tenant_id: tenantId,
    vendor_id: vendorId,
    requested_by_emp_id: params.requestedByEmpId,
    old_bank_code: params.before.bank_code,
    old_bank_name: params.before.bank_name,
    old_bank_account: params.before.bank_account,
    old_account_holder: params.before.account_holder,
    new_bank_code: params.after.bank_code,
    new_bank_name: params.after.bank_name,
    new_bank_account: params.after.bank_account,
    new_account_holder: params.after.account_holder,
    reason: params.reason ? params.reason.slice(0, 500) : null,
    status: "pending",
  }
  await writeAuditLogStrict({
    tenantId,
    tableName: BANK_CHANGE_TABLE,
    recordId: id,
    action: "INSERT",
    oldRow: { vendor_id: vendorId, ...params.before },
    newRow: { vendor_id: vendorId, ...params.after, status: "pending", reason: row.reason },
    actorEmpId: params.requestedByEmpId,
    context: "PATCH /vendors/:id 更改收款帳戶（有未付期款）→ 送雙人覆核",
  })
  const { data, error } = await supabaseAdmin.from(BANK_CHANGE_TABLE).insert(row).select(COLS).single()
  if (error) {
    if (tableMissing(error)) {
      throw new BankChangeError(409, "migration_required", { message: "帳戶變更覆核尚未套用資料庫更新（migration 0103），此廠商有未付期款，暫時不能改收款帳戶" })
    }
    if (error.code === "23505") {
      throw new BankChangeError(409, "vendor_bank_change_pending", { message: "此廠商已有一筆收款帳戶變更待覆核，請等覆核完成或取消後再改" })
    }
    throw new Error(`createBankChangeRequest: ${error.message}`)
  }
  try {
    const recipients = await reviewerRecipients(tenantId, params.requestedByEmpId)
    await enqueue({
      tenantId,
      employeeIds: recipients,
      type: "vendor_bank_change_request",
      title: `待覆核：廠商收款帳戶變更（${params.vendorName}）`,
      body: `新帳號 ${maskBankAccount(params.after.bank_account) ?? "—"}${params.reason ? `\n原因：${params.reason}` : ""}`,
      payload: { requestId: id, vendorId, event: "submitted" },
    })
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), tenantId }, "vendor bank change: notify reviewers failed")
  }
  return data as unknown as BankChangeRow
}

export type SerializedBankChange = {
  id: string
  vendorId: string
  vendorName: string | null
  status: BankChangeStatus
  reason: string | null
  requestedByEmpId: string | null
  requestedByName: string | null
  decidedByEmpId: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  createdAt: string
  old: { bankCode: string | null; bankName: string | null; bankAccount: string | null; accountHolder: string | null }
  new: { bankCode: string | null; bankName: string | null; bankAccount: string | null; accountHolder: string | null }
  /** 呼叫者能不能核准／退回（覆核者且不是申請人）。 */
  canDecide: boolean
  /** 呼叫者能不能取消（申請人本人或 HR）。 */
  canCancel: boolean
}

/** 列表（預設只看 pending）。表未套用 → 空陣列。完整新舊帳號只給覆核者與財務角色（route 判權限）。 */
export async function listBankChangeRequests(
  tenantId: string,
  viewer: { id: string | null; role: string | null; isReviewer: boolean },
  opts: { status?: BankChangeStatus | "all"; vendorId?: string } = {},
): Promise<SerializedBankChange[]> {
  let q = supabaseAdmin.from(BANK_CHANGE_TABLE).select(COLS).eq("tenant_id", tenantId)
  const status = opts.status ?? "pending"
  if (status !== "all") q = q.eq("status", status)
  if (opts.vendorId) q = q.eq("vendor_id", opts.vendorId)
  const { data, error } = await q.order("created_at", { ascending: false }).limit(200)
  if (error) {
    if (tableMissing(error)) return []
    throw new Error(`listBankChangeRequests: ${error.message}`)
  }
  const rows = (data ?? []) as unknown as BankChangeRow[]
  if (rows.length === 0) return []
  const vendorIds = [...new Set(rows.map((r) => r.vendor_id))]
  const empIds = [...new Set(rows.flatMap((r) => [r.requested_by_emp_id, r.decided_by_emp_id]).filter((v): v is string => !!v))]
  const [{ data: vendors }, { data: emps }] = await Promise.all([
    supabaseAdmin.from("vendors").select("id, name").eq("tenant_id", tenantId).in("id", vendorIds),
    empIds.length > 0
      ? supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", empIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string | null }> }),
  ])
  const vName = new Map(((vendors ?? []) as Array<{ id: string; name: string | null }>).map((v) => [v.id, v.name]))
  const eName = new Map(((emps ?? []) as Array<{ id: string; name: string | null }>).map((e) => [e.id, e.name]))
  const me = viewer.id?.toLowerCase() ?? null
  return rows.map((r) => {
    const mine = !!me && r.requested_by_emp_id?.toLowerCase() === me
    return {
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: vName.get(r.vendor_id) ?? null,
      status: r.status,
      reason: r.reason,
      requestedByEmpId: r.requested_by_emp_id,
      requestedByName: r.requested_by_emp_id ? (eName.get(r.requested_by_emp_id) ?? null) : null,
      decidedByEmpId: r.decided_by_emp_id,
      decidedByName: r.decided_by_emp_id ? (eName.get(r.decided_by_emp_id) ?? null) : null,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
      old: { bankCode: r.old_bank_code, bankName: r.old_bank_name, bankAccount: r.old_bank_account, accountHolder: r.old_account_holder },
      new: { bankCode: r.new_bank_code, bankName: r.new_bank_name, bankAccount: r.new_bank_account, accountHolder: r.new_account_holder },
      canDecide: r.status === "pending" && viewer.isReviewer && !mine,
      canCancel: r.status === "pending" && (mine || isHrRole(viewer.role)),
    }
  })
}

const RPC_ERRORS: Array<[string, number, string]> = [
  ["vendor_bank_change_not_found", 404, "找不到這筆帳戶變更申請"],
  ["vendor_bank_change_not_pending", 409, "這筆帳戶變更已處理過"],
  ["vendor_bank_change_self_review", 403, "不能覆核自己提出的帳戶變更"],
  ["vendor_not_found", 404, "找不到這家廠商（可能已刪除）"],
  ["vendor_has_open_disbursements", 409, "此廠商仍有未匯款的放款單，請先作廢或匯款後再核准帳戶變更"],
  ["vendor_bank_change_stale", 409, "名冊上的收款帳戶在申請後已被改過，這筆申請已過期，請退回後重新申請"],
]

/**
 * 核准／退回／取消（權限在這裡判，交易與不變式在 DB 函式）：
 * - approve／reject：覆核者（canReviewBankChange）且不是申請人本人；
 * - cancel：申請人本人或 HR。
 */
export async function decideBankChange(params: {
  tenantId: string
  requestId: string
  actor: { id: string | null; role: string | null; active?: boolean }
  action: "approve" | "reject" | "cancel"
  note?: string | null
}): Promise<{ id: string; vendorId: string; status: BankChangeStatus; decidedAt: string }> {
  const { tenantId, requestId, actor, action } = params
  if (!actor.id) throw new BankChangeError(403, "forbidden")
  const { data: cur, error: curErr } = await supabaseAdmin
    .from(BANK_CHANGE_TABLE)
    .select("id, requested_by_emp_id, status")
    .eq("tenant_id", tenantId)
    .eq("id", requestId)
    .maybeSingle()
  if (curErr) {
    if (tableMissing(curErr)) throw new BankChangeError(404, "vendor_bank_change_not_found")
    throw new Error(`decideBankChange (load): ${curErr.message}`)
  }
  if (!cur) throw new BankChangeError(404, "vendor_bank_change_not_found", { message: "找不到這筆帳戶變更申請" })
  const mine = !!(cur as { requested_by_emp_id: string | null }).requested_by_emp_id &&
    (cur as { requested_by_emp_id: string }).requested_by_emp_id.toLowerCase() === actor.id.toLowerCase()
  if (action === "cancel") {
    if (!mine && !(isHrRole(actor.role) && actor.active !== false)) {
      throw new BankChangeError(403, "forbidden", { message: "只有申請人本人或 HR 可以取消" })
    }
  } else {
    if (!(await canReviewBankChange(tenantId, actor))) {
      throw new BankChangeError(403, "not_bank_change_reviewer", { message: "只有老闆或 HR 可以覆核廠商收款帳戶變更" })
    }
    if (mine) throw new BankChangeError(403, "vendor_bank_change_self_review", { message: "不能覆核自己提出的帳戶變更" })
  }
  const note = typeof params.note === "string" ? params.note.trim().slice(0, 500) : null
  if (action === "reject" && !note) throw new BankChangeError(400, "decision_note_required", { message: "退回請填寫理由" })
  const { data, error } = await supabaseAdmin.rpc("decide_vendor_bank_change", {
    p_tenant_id: tenantId,
    p_request_id: requestId,
    p_actor_emp_id: actor.id,
    p_action: action,
    p_note: note || null,
  })
  if (error) {
    const msg = error.message ?? ""
    for (const [code, status, message] of RPC_ERRORS) {
      if (msg.includes(code)) throw new BankChangeError(status, code, { message })
    }
    throw new Error(`decide_vendor_bank_change: ${msg}`)
  }
  const out = (data ?? {}) as { id?: string; vendor_id?: string; status?: BankChangeStatus; decided_at?: string }
  try {
    const requester = (cur as { requested_by_emp_id: string | null }).requested_by_emp_id
    if (requester && !mine && out.status) {
      await enqueue({
        tenantId,
        employeeIds: [requester],
        type: "vendor_bank_change_request",
        title: out.status === "approved" ? "廠商收款帳戶變更已核准生效" : out.status === "rejected" ? "廠商收款帳戶變更被退回" : "廠商收款帳戶變更已取消",
        body: note ? `說明：${note}` : null,
        payload: { requestId, vendorId: out.vendor_id ?? null, event: out.status },
      })
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), tenantId }, "vendor bank change: notify requester failed")
  }
  return { id: out.id ?? requestId, vendorId: out.vendor_id ?? "", status: out.status ?? "pending", decidedAt: out.decided_at ?? new Date().toISOString() }
}
