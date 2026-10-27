/**
 * 假別時數手動調整（2026-10-27 業主：「點進內頁後可以手動增減假的時數」）。
 *
 * 資料怎麼存：
 *   • 調整直接加減在餘額桶的 `leave_balances.entitled`（＝本期給假），所以既有的讀點
 *     （ESS 我的假別額度、請假表單剩餘時數、ledger 扣假、年度請假表）全部自動反映，
 *     不必每個讀點都多加一欄。
 *   • 每次調整另寫一筆 `leave_balance_adjustments`（migration 0081）：增減、調整前後的
 *     本期給假、原因（必填）、操作者——這是歷程，也是稽核依據。
 *
 * 不可為負：調整後「剩餘＝entitled＋deferred−used」不得 < 0，除非呼叫端明確
 * `allowNegative: true`（前端會先提示再送）。entitled 本身也不得 < 0（避免奇怪的負額度）。
 *
 * 併發：update 帶 `.eq("entitled", 調整前值)` 做樂觀鎖，同時有人改 → 409 conflict。
 * 歷程寫失敗 → 把 entitled 改回原值再報錯（不留下沒有歷程的調整）。
 * 表未套用（PGRST205／42P01）→ 先探測，**在動餘額之前**就回 409 migration_required。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { leaveBalancesHavePeriod } from "./annual-leave.js"

export class LeaveAdjustmentError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export interface AdjustmentRow {
  id: string
  tenant_id: string
  employee_id: string
  leave_type_id: string
  balance_id: string | null
  delta_hours: number | string
  entitled_before: number | string
  entitled_after: number | string
  reason: string
  created_by_emp_id: string | null
  created_by_name?: string | null
  created_at: string
}

const ADJ_COLS =
  "id, tenant_id, employee_id, leave_type_id, balance_id, delta_hours, entitled_before, entitled_after, reason, created_by_emp_id, created_at"

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** 調整歷程表是否已套用；表不在回 false，其他錯誤往上丟。 */
export async function adjustmentsTableReady(): Promise<boolean> {
  const { error } = await supabaseAdmin.from("leave_balance_adjustments").select("id").limit(1)
  if (!error) return true
  if (isMissingTableError(error)) return false
  throw new Error(`probe leave_balance_adjustments: ${error.message}`)
}

export async function listAdjustments(
  tenantId: string,
  employeeId: string,
): Promise<{ available: boolean; adjustments: AdjustmentRow[] }> {
  const { data, error } = await supabaseAdmin
    .from("leave_balance_adjustments")
    .select(ADJ_COLS)
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .order("created_at", { ascending: false })
  if (error) {
    if (isMissingTableError(error)) return { available: false, adjustments: [] }
    throw new Error(`list leave_balance_adjustments: ${error.message}`)
  }
  const rows = (data ?? []) as unknown as AdjustmentRow[]
  const actorIds = [...new Set(rows.map((r) => r.created_by_emp_id).filter((x): x is string => !!x))]
  if (actorIds.length > 0) {
    const { data: actors } = await supabaseAdmin
      .from("employees")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", actorIds)
    const nameOf = new Map(((actors ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]))
    for (const r of rows) r.created_by_name = r.created_by_emp_id ? (nameOf.get(r.created_by_emp_id) ?? null) : null
  }
  return { available: true, adjustments: rows }
}

export interface AdjustInput {
  tenantId: string
  actorEmpId: string | null
  employeeId: string
  leaveTypeId: string
  balanceId?: string
  deltaHours: number
  reason: string
  allowNegative?: boolean
  /** 找不到可用的桶時，新開桶用的曆年（＝今天的年份）。 */
  today: string
}

export interface AdjustResult {
  adjustment: AdjustmentRow
  balance: { id: string; entitled: number; deferred: number; used: number; remaining: number }
  createdBalance: boolean
  negative: boolean
}

interface BucketRow {
  id: string
  employee_id: string
  leave_type_id: string
  entitled: number | string
  deferred: number | string
  used: number | string
  period_start?: string | null
  period_end?: string | null
}

export async function adjustLeaveBalance(input: AdjustInput): Promise<AdjustResult> {
  const reason = input.reason.trim()
  if (!reason) throw new LeaveAdjustmentError(400, "reason_required", "請填寫調整原因")
  if (!Number.isFinite(input.deltaHours) || input.deltaHours === 0) {
    throw new LeaveAdjustmentError(400, "invalid_delta", "調整時數不可為 0")
  }
  const delta = round2(input.deltaHours)

  if (!(await adjustmentsTableReady())) {
    throw new LeaveAdjustmentError(
      409,
      "migration_required",
      "調整歷程表 leave_balance_adjustments 尚未建立（請先套用 docs/套用-2026-10-29-假別時數調整歷程.sql）",
    )
  }

  // 員工與假別都必須屬於這個租戶（不信任 body 的 id）。
  const [{ data: emp, error: empErr }, { data: type, error: typeErr }] = await Promise.all([
    supabaseAdmin.from("employees").select("id").eq("tenant_id", input.tenantId).eq("id", input.employeeId).maybeSingle(),
    supabaseAdmin.from("leave_types").select("id").eq("tenant_id", input.tenantId).eq("id", input.leaveTypeId).maybeSingle(),
  ])
  if (empErr) throw new Error(`adjust: employee: ${empErr.message}`)
  if (typeErr) throw new Error(`adjust: leave_type: ${typeErr.message}`)
  if (!emp) throw new LeaveAdjustmentError(404, "employee_not_found", "找不到這位員工")
  if (!type) throw new LeaveAdjustmentError(404, "leave_type_not_found", "找不到這個假別")

  const hasPeriod = await leaveBalancesHavePeriod()
  const cols = hasPeriod
    ? "id, employee_id, leave_type_id, entitled, deferred, used, period_start, period_end"
    : "id, employee_id, leave_type_id, entitled, deferred, used"

  let bucket: BucketRow | null = null
  if (input.balanceId) {
    const { data, error } = await supabaseAdmin
      .from("leave_balances")
      .select(cols)
      .eq("tenant_id", input.tenantId)
      .eq("id", input.balanceId)
      .maybeSingle()
    if (error) throw new Error(`adjust: bucket: ${error.message}`)
    const row = data as unknown as BucketRow | null
    if (!row || row.employee_id !== input.employeeId || row.leave_type_id !== input.leaveTypeId) {
      throw new LeaveAdjustmentError(404, "balance_not_found", "找不到這個餘額桶（員工或假別不符）")
    }
    bucket = row
  } else {
    // 沒指定桶：取期間包含今天的桶；沒有就取期間起日最新的一個。
    const { data, error } = await supabaseAdmin
      .from("leave_balances")
      .select(cols)
      .eq("tenant_id", input.tenantId)
      .eq("employee_id", input.employeeId)
      .eq("leave_type_id", input.leaveTypeId)
    if (error) throw new Error(`adjust: buckets: ${error.message}`)
    const rows = (data ?? []) as unknown as BucketRow[]
    const active = rows.filter(
      (r) => r.period_start && r.period_end && r.period_start <= input.today && input.today <= r.period_end,
    )
    const pool = active.length > 0 ? active : rows
    bucket =
      [...pool].sort((a, b) => ((a.period_start ?? "") < (b.period_start ?? "") ? 1 : -1))[0] ?? null
  }

  let createdBalance = false
  const entitledBefore = bucket ? num(bucket.entitled) : 0
  const deferred = bucket ? num(bucket.deferred) : 0
  const used = bucket ? num(bucket.used) : 0
  const entitledAfter = round2(entitledBefore + delta)
  const remainingAfter = round2(entitledAfter + deferred - used)

  if (entitledAfter < 0) {
    throw new LeaveAdjustmentError(409, "entitled_negative", "減少後本期給假會小於 0，請改調整較少的時數", {
      entitledBefore,
      maxDecrease: entitledBefore,
    })
  }
  if (remainingAfter < 0 && !input.allowNegative) {
    throw new LeaveAdjustmentError(409, "would_be_negative", "減少後剩餘時數會變成負數", {
      remainingBefore: round2(entitledBefore + deferred - used),
      remainingAfter,
    })
  }

  const nowIso = new Date().toISOString()
  if (!bucket) {
    // 該假別還沒有任何桶：只能「增加」（減少在上面已被 entitled_negative 擋掉）。
    const year = Number(input.today.slice(0, 4))
    const row: Record<string, unknown> = {
      tenant_id: input.tenantId,
      employee_id: input.employeeId,
      leave_type_id: input.leaveTypeId,
      year,
      entitled: entitledAfter,
      used: 0,
      deferred: 0,
    }
    if (hasPeriod) {
      row.period_start = `${year}-01-01`
      row.period_end = `${year}-12-31`
      row.source = "manual"
      row.note = `手動調整：${reason}`.slice(0, 500)
    }
    const { data, error } = await supabaseAdmin.from("leave_balances").insert(row).select("id").single()
    if (error || !data) throw new Error(`adjust: insert bucket: ${error?.message}`)
    bucket = { id: (data as { id: string }).id, employee_id: input.employeeId, leave_type_id: input.leaveTypeId, entitled: entitledAfter, deferred: 0, used: 0 }
    createdBalance = true
  } else {
    const { data, error } = await supabaseAdmin
      .from("leave_balances")
      .update({ entitled: entitledAfter, updated_at: nowIso })
      .eq("tenant_id", input.tenantId)
      .eq("id", bucket.id)
      .eq("entitled", bucket.entitled)
      .select("id")
    if (error) throw new Error(`adjust: update bucket: ${error.message}`)
    if (!data || (data as unknown[]).length === 0) {
      throw new LeaveAdjustmentError(409, "conflict", "這筆餘額剛被其他人修改，請重新整理後再試")
    }
  }

  const log = {
    tenant_id: input.tenantId,
    employee_id: input.employeeId,
    leave_type_id: input.leaveTypeId,
    balance_id: bucket.id,
    delta_hours: delta,
    entitled_before: entitledBefore,
    entitled_after: entitledAfter,
    reason: reason.slice(0, 500),
    created_by_emp_id: input.actorEmpId,
  }
  const { data: logRow, error: logErr } = await supabaseAdmin
    .from("leave_balance_adjustments")
    .insert(log)
    .select(ADJ_COLS)
    .single()
  if (logErr || !logRow) {
    // 補償：不留下沒有歷程的調整。
    if (createdBalance) {
      await supabaseAdmin.from("leave_balances").delete().eq("tenant_id", input.tenantId).eq("id", bucket.id)
    } else {
      await supabaseAdmin
        .from("leave_balances")
        .update({ entitled: entitledBefore, updated_at: new Date().toISOString() })
        .eq("tenant_id", input.tenantId)
        .eq("id", bucket.id)
    }
    if (logErr && isMissingTableError(logErr)) {
      throw new LeaveAdjustmentError(409, "migration_required", "調整歷程表 leave_balance_adjustments 尚未建立")
    }
    throw new Error(`adjust: insert log: ${logErr?.message}`)
  }

  return {
    adjustment: logRow as unknown as AdjustmentRow,
    balance: { id: bucket.id, entitled: entitledAfter, deferred, used, remaining: remainingAfter },
    createdBalance,
    negative: remainingAfter < 0,
  }
}
