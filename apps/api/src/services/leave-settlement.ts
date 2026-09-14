import ExcelJS from "exceljs"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { dayWindowUtc, localDateKey, monthRangeKeys } from "../lib/tz.js"
import { applyHeaderStyle, workbookToBuffer } from "../lib/xlsx/index.js"
import { leaveDeductRate } from "./settlement.js"
import { writeAuditLog } from "./audit.js"

/**
 * B8 假單人資月底核銷 — 第二階段。
 *
 * 背景：主管核准假單時 services/ledger.ts 已經扣假；扣薪則在月底薪資結算／
 * 出勤月表流程。但假單一核准就沒有人資這一關的把關——這裡補上：人資每月
 * 月底看一份清單、核對憑證、對每筆假單標記「已核銷」。
 *
 * 設計決定：不新增 leave_requests.status='settled'（codebase 十幾處用 status
 * 做 map/switch，加新值會到處炸）。改用三個獨立欄位：settled_at /
 * settled_by_emp_id / settled_period（packages/db 已 migrate，含
 * (tenant_id, settled_period) index）。
 *
 * 這個 service 的資料底層永遠固定是 leave_requests.kind='leave' 且
 * status='approved'——「核銷狀態」（settled_at 是否為 null）是另一回事，
 * 跟 leave_requests.status 的 pending/approved/rejected 不要混淆。
 *
 * 「哪個月」的判斷：leave_requests 的**起日**（start_at 的租戶當地日期）落在
 * 該月就算該月的（跨月的假單以起日歸屬，不管結束日）。
 *
 * 查詢風格比照 services/attendance-sheets.ts / services/settlement.ts：
 * supabaseAdmin 直查、每句自帶 tenant_id 過濾、批次抓關聯資料後在記憶體
 * 用 Map 組裝（同 routes/requests.ts 的 pending-approvals 作法），不用
 * supabase-js 的巢狀 select join。
 */

export type SettlementStatusFilter = "unsettled" | "settled" | "all"

export interface LeaveSettlementFilter {
  /** 'YYYY-MM'。 */
  period: string
  deptId?: string
  status: SettlementStatusFilter
}

export interface LeaveSettlementEmployee {
  id: string
  name: string
  employeeNo: string | null
  departmentName: string | null
}

export interface LeaveSettlementLeaveType {
  id: string
  name: string
  deductRate: number
}

export interface LeaveSettlementItem {
  id: string
  employee: LeaveSettlementEmployee
  leaveType: LeaveSettlementLeaveType
  startDate: string
  endDate: string
  hours: number
  requiresAttachment: boolean
  attachmentCount: number
  settledAt: string | null
  settledBy: { id: string; name: string } | null
}

export interface LeaveSettlementSummary {
  totalCount: number
  settledCount: number
  unsettledCount: number
  hoursByLeaveType: Array<{ leaveTypeId: string; leaveTypeName: string; totalHours: number }>
}

export interface LeaveSettlementListResult {
  period: string
  summary: LeaveSettlementSummary
  items: LeaveSettlementItem[]
}

interface LeaveRequestRow {
  id: string
  employee_id: string
  leave_type_id: string | null
  start_at: string
  end_at: string
  hours: string | number | null
  settled_at: string | null
  settled_by_emp_id: string | null
}

interface LeaveTypeFullRow {
  id: string
  code: string
  name: string
  paid: boolean
  deduct_rate: string | number | null
  requires_attachment: boolean
}

interface EmployeeNameRow {
  id: string
  name: string
  emp_no: string | null
  dept_id: string | null
}

const EMPTY_LIST_RESULT = (period: string): LeaveSettlementListResult => ({
  period,
  summary: { totalCount: 0, settledCount: 0, unsettledCount: 0, hoursByLeaveType: [] },
  items: [],
})

/**
 * listLeaveSettlement — GET /leave-settlement 的資料層。`filter.status` 只影響
 * 回傳的 `items`；`summary`（含 hoursByLeaveType）永遠反映**該期間全部** approved
 * 假單（不受 status 篩選影響），讓 HR 畫面能同時顯示「已核銷 / 未核銷 / 共計」
 * 三個數字，不因為切換分頁篩選就跟著變動。
 */
export async function listLeaveSettlement(tenantId: string, filter: LeaveSettlementFilter): Promise<LeaveSettlementListResult> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = monthRangeKeys(filter.period)
  const rangeStart = dayWindowUtc(from, tz).startIso
  const rangeEnd = dayWindowUtc(to, tz).endIso

  let deptEmployeeIds: string[] | null = null
  if (filter.deptId) {
    const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("dept_id", filter.deptId)
    if (error) throw new Error(`listLeaveSettlement (dept employees): ${error.message}`)
    deptEmployeeIds = (data ?? []).map((e) => e.id as string)
    if (deptEmployeeIds.length === 0) return EMPTY_LIST_RESULT(filter.period)
  }

  let query = supabaseAdmin
    .from("leave_requests")
    .select("id, employee_id, leave_type_id, start_at, end_at, hours, settled_at, settled_by_emp_id")
    .eq("tenant_id", tenantId)
    .eq("kind", "leave")
    .eq("status", "approved")
    .is("deleted_at", null)
    .gte("start_at", rangeStart)
    .lt("start_at", rangeEnd)
    .order("start_at", { ascending: true })
  if (deptEmployeeIds) query = query.in("employee_id", deptEmployeeIds)

  const { data, error } = await query
  if (error) throw new Error(`listLeaveSettlement (leave_requests): ${error.message}`)
  const allRows = (data ?? []) as LeaveRequestRow[]
  if (allRows.length === 0) return EMPTY_LIST_RESULT(filter.period)

  const totalCount = allRows.length
  const settledCount = allRows.filter((r) => r.settled_at != null).length
  const unsettledCount = totalCount - settledCount
  const filteredRows =
    filter.status === "all" ? allRows : filter.status === "settled" ? allRows.filter((r) => r.settled_at != null) : allRows.filter((r) => r.settled_at == null)

  const leaveTypeIds = Array.from(new Set(allRows.map((r) => r.leave_type_id).filter((v): v is string => !!v)))
  const employeeIds = Array.from(new Set(filteredRows.map((r) => r.employee_id)))
  const settledByIds = Array.from(new Set(filteredRows.map((r) => r.settled_by_emp_id).filter((v): v is string => !!v)))
  const empLookupIds = Array.from(new Set([...employeeIds, ...settledByIds]))
  const requestIds = filteredRows.map((r) => r.id)

  const [ltRes, empRes, deptRes, attRes] = await Promise.all([
    leaveTypeIds.length > 0
      ? supabaseAdmin.from("leave_types").select("id, code, name, paid, deduct_rate, requires_attachment").eq("tenant_id", tenantId).in("id", leaveTypeIds)
      : Promise.resolve({ data: [] as LeaveTypeFullRow[], error: null }),
    empLookupIds.length > 0
      ? supabaseAdmin.from("employees").select("id, name, emp_no, dept_id").eq("tenant_id", tenantId).in("id", empLookupIds)
      : Promise.resolve({ data: [] as EmployeeNameRow[], error: null }),
    supabaseAdmin.from("departments").select("id, name").eq("tenant_id", tenantId),
    requestIds.length > 0
      ? supabaseAdmin.from("request_attachments").select("request_id").eq("tenant_id", tenantId).in("request_id", requestIds)
      : Promise.resolve({ data: [] as Array<{ request_id: string }>, error: null }),
  ])
  for (const r of [ltRes, empRes, deptRes, attRes]) {
    if (r.error) throw new Error(`listLeaveSettlement (enrich): ${r.error.message}`)
  }

  const ltById = new Map(((ltRes.data ?? []) as LeaveTypeFullRow[]).map((t) => [t.id, t]))
  const empById = new Map(((empRes.data ?? []) as EmployeeNameRow[]).map((e) => [e.id, e]))
  const deptNameById = new Map(((deptRes.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]))
  const attachmentCountById = new Map<string, number>()
  for (const a of (attRes.data ?? []) as Array<{ request_id: string }>) {
    attachmentCountById.set(a.request_id, (attachmentCountById.get(a.request_id) ?? 0) + 1)
  }

  const hoursByTypeMap = new Map<string, number>()
  for (const r of allRows) {
    if (!r.leave_type_id) continue
    const h = r.hours != null ? Number(r.hours) : 0
    hoursByTypeMap.set(r.leave_type_id, (hoursByTypeMap.get(r.leave_type_id) ?? 0) + h)
  }
  const hoursByLeaveType = Array.from(hoursByTypeMap.entries()).map(([leaveTypeId, totalHours]) => ({
    leaveTypeId,
    leaveTypeName: ltById.get(leaveTypeId)?.name ?? "",
    totalHours,
  }))

  const items: LeaveSettlementItem[] = filteredRows.map((r) => {
    const lt = r.leave_type_id ? ltById.get(r.leave_type_id) : undefined
    const emp = empById.get(r.employee_id)
    const settledByEmp = r.settled_by_emp_id ? empById.get(r.settled_by_emp_id) : undefined
    return {
      id: r.id,
      employee: {
        id: r.employee_id,
        name: emp?.name ?? "",
        employeeNo: emp?.emp_no ?? null,
        departmentName: emp?.dept_id ? (deptNameById.get(emp.dept_id) ?? null) : null,
      },
      leaveType: {
        id: r.leave_type_id ?? "",
        name: lt?.name ?? "",
        deductRate: leaveDeductRate(lt ? { id: lt.id, code: lt.code, paid: lt.paid, deduct_rate: lt.deduct_rate } : undefined),
      },
      startDate: localDateKey(r.start_at, tz),
      endDate: localDateKey(r.end_at, tz),
      hours: r.hours != null ? Number(r.hours) : 0,
      requiresAttachment: lt?.requires_attachment ?? false,
      attachmentCount: attachmentCountById.get(r.id) ?? 0,
      settledAt: r.settled_at ?? null,
      settledBy: r.settled_by_emp_id ? { id: r.settled_by_emp_id, name: settledByEmp?.name ?? "" } : null,
    }
  })

  return {
    period: filter.period,
    summary: { totalCount, settledCount, unsettledCount, hoursByLeaveType },
    items,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// settle / unsettle
// ─────────────────────────────────────────────────────────────────────────────

export type SettleSkipReason = "not_approved" | "already_settled" | "attachment_missing"

export interface SettleLeaveInput {
  period: string
  ids: string[]
  force?: boolean
}

export interface SettleLeaveResult {
  settled: number
  skipped: Array<{ id: string; reason: SettleSkipReason }>
}

interface SettleCandidateRow {
  id: string
  kind: string
  status: string
  settled_at: string | null
  leave_type_id: string | null
}

/**
 * settleLeaveRequests — POST /leave-settlement/settle。逐筆判斷（見檔頭
 * 註解的規則），可核銷的一次 UPDATE 批次寫入（同一批 ids 共用同一個
 * settled_at/settled_period），每筆成功核銷各寫一筆 audit log。
 */
export async function settleLeaveRequests(tenantId: string, actorEmpId: string | null, input: SettleLeaveInput): Promise<SettleLeaveResult> {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id, kind, status, settled_at, leave_type_id")
    .eq("tenant_id", tenantId)
    .in("id", input.ids)
  if (error) throw new Error(`settleLeaveRequests (load): ${error.message}`)
  const byId = new Map(((data ?? []) as SettleCandidateRow[]).map((r) => [r.id, r]))

  // 只有「status=approved 且尚未核銷」的才需要進一步查假別／附件；其餘（不存在、
  // 非 leave、非 approved、已核銷）在下面第二輪迴圈就直接判定，不用查。
  const candidates = input.ids
    .map((id) => byId.get(id))
    .filter((r): r is SettleCandidateRow => !!r && r.kind === "leave" && r.status === "approved" && r.settled_at == null)
  const leaveTypeIds = Array.from(new Set(candidates.map((r) => r.leave_type_id).filter((v): v is string => !!v)))
  const candidateIds = candidates.map((r) => r.id)

  const [ltRes, attRes] = await Promise.all([
    leaveTypeIds.length > 0
      ? supabaseAdmin.from("leave_types").select("id, requires_attachment").eq("tenant_id", tenantId).in("id", leaveTypeIds)
      : Promise.resolve({ data: [] as Array<{ id: string; requires_attachment: boolean }>, error: null }),
    candidateIds.length > 0
      ? supabaseAdmin.from("request_attachments").select("request_id").eq("tenant_id", tenantId).in("request_id", candidateIds)
      : Promise.resolve({ data: [] as Array<{ request_id: string }>, error: null }),
  ])
  if (ltRes.error) throw new Error(`settleLeaveRequests (leave_types): ${ltRes.error.message}`)
  if (attRes.error) throw new Error(`settleLeaveRequests (attachments): ${attRes.error.message}`)
  const requiresAttachmentById = new Map(((ltRes.data ?? []) as Array<{ id: string; requires_attachment: boolean }>).map((t) => [t.id, !!t.requires_attachment]))
  const attachmentCountById = new Map<string, number>()
  for (const a of (attRes.data ?? []) as Array<{ request_id: string }>) {
    attachmentCountById.set(a.request_id, (attachmentCountById.get(a.request_id) ?? 0) + 1)
  }

  const toSettle: string[] = []
  const forcedNoAttachment = new Set<string>()
  const skipped: SettleLeaveResult["skipped"] = []
  for (const id of input.ids) {
    const row = byId.get(id)
    if (!row || row.kind !== "leave" || row.status !== "approved") {
      skipped.push({ id, reason: "not_approved" })
      continue
    }
    if (row.settled_at != null) {
      skipped.push({ id, reason: "already_settled" })
      continue
    }
    const requiresAttachment = row.leave_type_id ? (requiresAttachmentById.get(row.leave_type_id) ?? false) : false
    const attachmentCount = attachmentCountById.get(id) ?? 0
    if (requiresAttachment && attachmentCount === 0) {
      if (!input.force) {
        skipped.push({ id, reason: "attachment_missing" })
        continue
      }
      forcedNoAttachment.add(id)
    }
    toSettle.push(id)
  }

  if (toSettle.length > 0) {
    const nowIso = new Date().toISOString()
    const { error: updErr } = await supabaseAdmin
      .from("leave_requests")
      .update({ settled_at: nowIso, settled_by_emp_id: actorEmpId, settled_period: input.period })
      .eq("tenant_id", tenantId)
      .in("id", toSettle)
    if (updErr) throw new Error(`settleLeaveRequests (update): ${updErr.message}`)

    await Promise.all(
      toSettle.map((id) =>
        writeAuditLog({
          tenantId,
          tableName: "leave_requests",
          recordId: id,
          action: "UPDATE",
          oldRow: { settledAt: null },
          newRow: forcedNoAttachment.has(id)
            ? {
                settledAt: nowIso,
                settledByEmpId: actorEmpId,
                settledPeriod: input.period,
                forced: true,
                note: "假別需附件但無附件，人資強制核銷",
              }
            : { settledAt: nowIso, settledByEmpId: actorEmpId, settledPeriod: input.period },
          actorEmpId: actorEmpId ?? undefined,
          context: "POST /leave-settlement/settle",
        }),
      ),
    )
  }

  return { settled: toSettle.length, skipped }
}

export interface UnsettleLeaveInput {
  ids: string[]
  reason: string
}

export interface UnsettleLeaveResult {
  unsettled: number
}

/**
 * unsettleLeaveRequests — POST /leave-settlement/unsettle。只處理目前真的處於
 * 已核銷狀態的 id（其餘靜默略過，不算錯誤，也不計入回傳筆數），三欄清空後
 * 每筆各寫一筆 audit log（reason 存進 newRow，比照 codebase 既有 writeAuditLog
 * 呼叫慣例：context 放路由、業務欄位放 newRow，見 routes/advances.ts）。
 */
export async function unsettleLeaveRequests(tenantId: string, actorEmpId: string | null, input: UnsettleLeaveInput): Promise<UnsettleLeaveResult> {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id, settled_at, settled_by_emp_id, settled_period")
    .eq("tenant_id", tenantId)
    .in("id", input.ids)
    .not("settled_at", "is", null)
  if (error) throw new Error(`unsettleLeaveRequests (load): ${error.message}`)
  const targets = (data ?? []) as Array<{ id: string; settled_at: string | null; settled_by_emp_id: string | null; settled_period: string | null }>
  if (targets.length === 0) return { unsettled: 0 }
  const ids = targets.map((r) => r.id)

  const { error: updErr } = await supabaseAdmin
    .from("leave_requests")
    .update({ settled_at: null, settled_by_emp_id: null, settled_period: null })
    .eq("tenant_id", tenantId)
    .in("id", ids)
  if (updErr) throw new Error(`unsettleLeaveRequests (update): ${updErr.message}`)

  await Promise.all(
    targets.map((r) =>
      writeAuditLog({
        tenantId,
        tableName: "leave_requests",
        recordId: r.id,
        action: "UPDATE",
        oldRow: { settledAt: r.settled_at, settledByEmpId: r.settled_by_emp_id, settledPeriod: r.settled_period },
        newRow: { settledAt: null, settledByEmpId: null, settledPeriod: null, reason: input.reason },
        actorEmpId: actorEmpId ?? undefined,
        context: "POST /leave-settlement/unsettle",
      }),
    ),
  )

  return { unsettled: ids.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// xlsx export
// ─────────────────────────────────────────────────────────────────────────────

/** 檔名：`假單核銷-{period}.xlsx`。 */
export function leaveSettlementFilename(period: string): string {
  return `假單核銷-${period}.xlsx`
}

/**
 * leaveSettlementWorkbookBuffer — GET /leave-settlement/export.xlsx。刻意只有
 * 「表頭 1 列 + 每筆一列」，不加合計列：呼叫端要能拿列數直接比對
 * `items.length`（見 __tests__/leave-settlement-live.test.ts）。
 */
export async function leaveSettlementWorkbookBuffer(result: LeaveSettlementListResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "aster-hr"
  const ws = wb.addWorksheet("假單核銷", { views: [{ state: "frozen", ySplit: 1 }] })

  const headers = ["員工姓名", "工號", "部門", "假別", "起日", "迄日", "時數", "需附件", "附件數", "核銷狀態", "核銷時間", "核銷人"]
  const headerRow = ws.getRow(1)
  headers.forEach((h, i) => {
    headerRow.getCell(i + 1).value = h
  })
  applyHeaderStyle(headerRow)
  const widths = [12, 10, 14, 12, 12, 12, 8, 8, 8, 10, 20, 12]
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w
  })

  let r = 2
  for (const item of result.items) {
    const row = ws.getRow(r)
    row.getCell(1).value = item.employee.name
    row.getCell(2).value = item.employee.employeeNo ?? ""
    row.getCell(3).value = item.employee.departmentName ?? ""
    row.getCell(4).value = item.leaveType.name
    row.getCell(5).value = item.startDate
    row.getCell(6).value = item.endDate
    row.getCell(7).value = item.hours
    row.getCell(8).value = item.requiresAttachment ? "是" : "否"
    row.getCell(9).value = item.attachmentCount
    row.getCell(10).value = item.settledAt ? "已核銷" : "未核銷"
    row.getCell(11).value = item.settledAt ?? ""
    row.getCell(12).value = item.settledBy?.name ?? ""
    r += 1
  }

  return workbookToBuffer(wb)
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared with routes/attendance-sheets.ts (approve gate) and
// services/attendance-sheets.ts (unsettled_leave_in_period 月級異常) — B8。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * tenants.features.attendance.blockApproveOnUnsettledLeave（見 routes/tenant.ts
 * 的 zod schema）。未設定或非 true 一律視為 false（維持現行「只 warn 不擋」）。
 */
export async function tenantBlocksApproveOnUnsettledLeave(tenantId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`tenantBlocksApproveOnUnsettledLeave: ${error.message}`)
  const attendanceFeature = ((data?.features as Record<string, unknown> | null)?.attendance ?? null) as
    | { blockApproveOnUnsettledLeave?: unknown }
    | null
  return attendanceFeature?.blockApproveOnUnsettledLeave === true
}

/**
 * 該員工在 [rangeStartIso, rangeEndIso) 內是否還有已核准但未核銷的假單
 * （overlap 語意：start_at < rangeEnd 且 end_at > rangeStart，與
 * services/attendance-sheets.ts 的 pending_leave_in_period／
 * unsettled_leave_in_period 月級異常一致）。
 *
 * 給 routes/attendance-sheets.ts 的 approve 409 檢查用：即時查詢，刻意不讀
 * sheet.month_anomalies 那個快照欄位——核銷動作可能發生在該月表最後一次
 * recompute 之後，approve 前必須看當下真值，不能被快取的異常清單騙到。
 */
export async function hasUnsettledApprovedLeaveOverlapping(
  tenantId: string,
  employeeId: string,
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("kind", "leave")
    .eq("status", "approved")
    .is("settled_at", null)
    .is("deleted_at", null)
    .lt("start_at", rangeEndIso)
    .gt("end_at", rangeStartIso)
    .limit(1)
  if (error) throw new Error(`hasUnsettledApprovedLeaveOverlapping: ${error.message}`)
  return (data ?? []).length > 0
}
