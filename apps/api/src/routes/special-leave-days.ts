import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { addDaysKey, monthRangeKeys, type DateKey } from "../lib/tz.js"
import { writeAuditLog } from "../services/audit.js"
import { assertDateRangeOpen, isPeriodClosed, isRealDateKey, periodsBetween } from "../services/period-lock.js"
import { loadDayTypeResolver } from "../services/day-type.js"
import { settleAttendance } from "../services/settlement.js"
import { loadMonthFacts, loadSheet, rebuildSheet } from "../services/attendance-sheets.js"
import {
  SPECIAL_COLS,
  SPECIAL_SCOPES,
  specialAppliesTo,
  specialDayLabel,
  type SpecialEmployeeInfo,
  type SpecialLeaveDayRow,
} from "../services/special-leave-days.js"

/**
 * 特殊假日（2026-11-17，表 special_leave_days，migration 0110）——後台「打卡紀錄維護」最右邊分頁「特殊假別」。
 * 效果與判斷見 services/special-leave-days.ts 檔頭。
 *
 *   GET    /special-leave-days?year=YYYY      HR：年度清單（含部門／員工名稱、適用人數）
 *   POST   /special-leave-days                HR：新增（單日或區間，最長 31 天）
 *   PATCH  /special-leave-days/:id            HR：修改
 *   DELETE /special-leave-days/:id            HR：軟刪除
 *   GET    /special-leave-days/mine?from&to   任何員工：自己命中的特殊假日（只回工作日；ESS 打卡紀錄顯示用）
 *
 * 寫入：日期碰到已結算月份 → 409 period_closed（不追溯）；寫 audit_logs；成功後自動重算受影響、未結算月份的
 * 結算（attendance_days）與**草稿／退回**的月表（已送出／核准／鎖定的月表不動，回應列出略過數，畫面提示）。
 * 重算失敗不擋寫入，回應 recalc[].status='failed'，畫面提示「請到出勤統計表重算」。
 * 表未建（0110 前）→ 503 special_leave_days_not_migrated。
 */
export const specialLeaveDaysRouter = Router()

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 31

const dateSchema = z.string().regex(DATE_RE, "date must be YYYY-MM-DD").refine(isRealDateKey, "invalid date")

const bodySchema = z.object({
  startDate: dateSchema,
  endDate: dateSchema.optional(),
  name: z.string().trim().min(1).max(40),
  paid: z.boolean(),
  scope: z.enum(SPECIAL_SCOPES as [string, ...string[]]).default("all"),
  departmentIds: z.array(z.string().uuid()).max(200).optional(),
  employeeIds: z.array(z.string().uuid()).max(500).optional(),
  note: z.string().trim().max(500).nullish(),
})

const patchSchema = bodySchema.partial()

const yearSchema = z.object({ year: z.coerce.number().int().min(2000).max(2100) })
const rangeSchema = z.object({ from: dateSchema, to: dateSchema })

function notMigrated(res: Response, err: { code?: string | null; message?: string | null }): boolean {
  if (!isMissingTableError(err)) return false
  res.status(503).json({ error: "special_leave_days_not_migrated", detail: "special_leave_days is not available yet (packages/db migration 0110)" })
  return true
}

function daysInclusive(from: DateKey, to: DateKey): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

interface EmployeeLite extends SpecialEmployeeInfo {
  id: string
  name: string
  status: string
}

async function loadEmployees(tenantId: string): Promise<EmployeeLite[]> {
  const data = await selectAllPages<Record<string, unknown>>(
    (rFrom, rTo) =>
      supabaseAdmin
        .from("employees")
        .select("id, name, dept_id, hire_date, terminated_at, status")
        .eq("tenant_id", tenantId)
        .order("id", { ascending: true })
        .range(rFrom, rTo),
    "special-leave-days (employees)",
  )
  return data.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    status: String(r.status ?? ""),
    inactiveWithoutEnd: !!r.status && r.status !== "active" && !r.terminated_at,
    deptId: (r.dept_id as string | null) ?? null,
    hireDate: r.hire_date ? String(r.hire_date).slice(0, 10) : null,
    terminatedAt: r.terminated_at ? String(r.terminated_at).slice(0, 10) : null,
  }))
}

/**
 * 區間內「至少有一天在職」且在範圍內的員工（逐日以該日是否在職判斷：到職日前、離職日之後不算，離職當天仍算；
 * 停用又沒離職日不算——與 web lib/employee-status.ts、結算 specialAppliesTo 同口徑）。純函式。
 */
export function affectedEmployeeIds(
  row: Pick<SpecialLeaveDayRow, "start_date" | "end_date" | "scope" | "department_ids" | "employee_ids">,
  employees: readonly EmployeeLite[],
): string[] {
  const out: string[] = []
  for (const e of employees) {
    for (let d = row.start_date; d <= row.end_date; d = addDaysKey(d, 1)) {
      if (specialAppliesTo(row, e.id, e, d)) {
        out.push(e.id)
        break
      }
    }
  }
  return out
}

/** 依 scope 清掉不相干的名單、驗證部門／員工都屬本租戶。回錯誤碼或正規化後的列內容。 */
async function normalizeTargets(
  tenantId: string,
  scope: string,
  departmentIds: string[] | undefined,
  employeeIds: string[] | undefined,
): Promise<{ error: string; ids?: string[] } | { department_ids: string[]; employee_ids: string[] }> {
  const deps = [...new Set(departmentIds ?? [])]
  const emps = [...new Set(employeeIds ?? [])]
  if (scope === "departments") {
    if (deps.length === 0) return { error: "departments_required" }
    const { data, error } = await supabaseAdmin.from("departments").select("id").eq("tenant_id", tenantId).in("id", deps)
    if (error) throw new Error(`special-leave-days (departments): ${error.message}`)
    const ok = new Set((data ?? []).map((r) => String((r as { id: string }).id)))
    const unknown = deps.filter((id) => !ok.has(id))
    if (unknown.length > 0) return { error: "unknown_departments", ids: unknown }
    return { department_ids: deps, employee_ids: [] }
  }
  if (scope === "employees") {
    if (emps.length === 0) return { error: "employees_required" }
    const { data, error } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).in("id", emps)
    if (error) throw new Error(`special-leave-days (employees): ${error.message}`)
    const ok = new Set((data ?? []).map((r) => String((r as { id: string }).id)))
    const unknown = emps.filter((id) => !ok.has(id))
    if (unknown.length > 0) return { error: "unknown_employees", ids: unknown }
    return { department_ids: [], employee_ids: emps }
  }
  return { department_ids: [], employee_ids: [] }
}

export interface RecalcResult {
  period: string
  status: "done" | "closed" | "failed"
  /** 重算的草稿／退回月表數。 */
  rebuilt?: number
  /** 已送出（含主管已審）未套用的月表數——需退回後重算。 */
  submitted?: number
  /** 已核准／鎖定未套用的月表數——需重開後重算。 */
  approved?: number
  /** 該月未定案（draft）的薪資單數——需重跑薪資。 */
  draftPayslips?: number
  error?: string
}

/**
 * 受影響、未結算月份：重跑結算（attendance_days）＋重建受影響員工的草稿／退回月表。已結算月份不動。
 * `employeeIds` null＝不限（全公司）。`cleanup`＝剛刪除／移出特殊假日，結算要清殘留旗標。
 */
export async function recalcSpecialDayRange(
  tenantId: string,
  ranges: ReadonlyArray<{ from: DateKey; to: DateKey }>,
  employeeIds: readonly string[] | null,
  opts: { cleanup?: boolean } = {},
): Promise<RecalcResult[]> {
  const out: RecalcResult[] = []
  const periods = [...new Set(ranges.flatMap((r) => periodsBetween(r.from.slice(0, 7), r.to.slice(0, 7), 3)))].sort()
  for (const period of periods) {
    try {
      if (await isPeriodClosed(tenantId, period)) {
        out.push({ period, status: "closed" })
        continue
      }
      const range = monthRangeKeys(period)
      const single = employeeIds && employeeIds.length === 1 ? employeeIds[0] : undefined
      if (employeeIds && employeeIds.length === 0) {
        out.push({ period, status: "done", rebuilt: 0, submitted: 0, approved: 0, draftPayslips: 0 })
        continue
      }
      await settleAttendance({ tenantId, from: range.from, to: range.to, employeeId: single, specialCleanup: opts.cleanup })
      let q = supabaseAdmin.from("attendance_sheets").select("id, employee_id, status").eq("tenant_id", tenantId).eq("period", period)
      if (employeeIds) q = q.in("employee_id", [...employeeIds])
      const { data, error } = await q
      let sheets: Array<{ id: string; employee_id: string; status: string }> = []
      if (error) {
        if (!isMissingTableError(error)) throw new Error(error.message)
      } else {
        sheets = (data ?? []) as typeof sheets
      }
      const editable = sheets.filter((s) => s.status === "draft" || s.status === "returned")
      let rebuilt = 0
      let submitted = sheets.filter((s) => s.status === "submitted" || s.status === "manager_reviewed").length
      const approved = sheets.filter((s) => s.status === "approved" || s.status === "locked").length
      if (editable.length > 0) {
        const facts = await loadMonthFacts(tenantId, period, editable.map((s) => s.employee_id))
        for (const s of editable) {
          const sheet = await loadSheet(tenantId, s.id)
          if (await rebuildSheet(tenantId, sheet, facts)) rebuilt += 1
          else submitted += 1 // 讀到之後才被送出
        }
      }
      // 已跑過、還沒定案的薪資單：數字是舊的，要重跑薪資。
      let pq = supabaseAdmin.from("payslips").select("id").eq("tenant_id", tenantId).eq("period", period).neq("status", "finalized")
      if (employeeIds) pq = pq.in("employee_id", [...employeeIds])
      const { data: slips, error: slipErr } = await pq
      if (slipErr && !isMissingTableError(slipErr)) throw new Error(slipErr.message)
      out.push({ period, status: "done", rebuilt, submitted, approved, draftPayslips: (slips ?? []).length })
    } catch (err) {
      out.push({ period, status: "failed", error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/* ---------------------------------------------------------- 重算互斥鎖 --- */

const STALE_LOCK_MS = 10 * 60_000
const memoryLocks = new Set<string>()

export class RecalcBusyError extends Error {
  constructor() {
    super("recalc_in_progress")
    this.name = "RecalcBusyError"
  }
}

/**
 * 每租戶同時只跑一個特殊假日寫入＋重算（N2）：程序內記憶體鎖＋DB 列鎖（special_leave_recalc_locks，tenant_id 唯一；
 * migration 0111）。超過 10 分鐘的殘留 DB 鎖可接手。表未建 → 只靠記憶體鎖。拿不到 → RecalcBusyError（409）。
 */
export async function withRecalcLock<T>(tenantId: string, actorEmpId: string | null, fn: () => Promise<T>): Promise<T> {
  if (memoryLocks.has(tenantId)) throw new RecalcBusyError()
  memoryLocks.add(tenantId)
  const token = crypto.randomUUID()
  let dbLocked = false
  try {
    const now = new Date()
    const { error } = await supabaseAdmin
      .from("special_leave_recalc_locks")
      .insert({ tenant_id: tenantId, token, started_at: now.toISOString(), started_by_emp_id: actorEmpId })
    if (!error) dbLocked = true
    else if (error.code === "23505") {
      const { data: taken, error: takeErr } = await supabaseAdmin
        .from("special_leave_recalc_locks")
        .update({ token, started_at: now.toISOString(), started_by_emp_id: actorEmpId })
        .eq("tenant_id", tenantId)
        .lt("started_at", new Date(now.getTime() - STALE_LOCK_MS).toISOString())
        .select("tenant_id")
      if (takeErr) throw new Error(`special-leave-days (lock): ${takeErr.message}`)
      if (!taken || taken.length === 0) throw new RecalcBusyError()
      dbLocked = true
    } else if (!isMissingTableError(error)) {
      throw new Error(`special-leave-days (lock): ${error.message}`)
    }
    return await fn()
  } finally {
    if (dbLocked) {
      const { error } = await supabaseAdmin.from("special_leave_recalc_locks").delete().eq("tenant_id", tenantId).eq("token", token)
      if (error) console.error(`[special-leave-days] release lock: ${error.message}`)
    }
    memoryLocks.delete(tenantId)
  }
}

function toView(
  row: SpecialLeaveDayRow,
  employees: readonly EmployeeLite[],
  deptNames: Map<string, string>,
) {
  const empName = new Map(employees.map((e) => [e.id, e.name]))
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    days: daysInclusive(row.start_date, row.end_date),
    name: row.name,
    paid: row.paid === true,
    label: specialDayLabel({ name: row.name, paid: row.paid === true }),
    scope: row.scope,
    departmentIds: row.department_ids ?? [],
    departmentNames: (row.department_ids ?? []).map((id) => deptNames.get(id) ?? "（已刪除部門）"),
    employeeIds: row.employee_ids ?? [],
    employeeNames: (row.employee_ids ?? []).map((id) => empName.get(id) ?? "（未知員工）"),
    note: row.note,
    affectedCount: affectedEmployeeIds(row, employees).length,
    createdByName: row.created_by_emp_id ? (empName.get(row.created_by_emp_id) ?? null) : null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

async function loadDeptNames(tenantId: string): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin.from("departments").select("id, name").eq("tenant_id", tenantId)
  if (error) throw new Error(`special-leave-days (departments): ${error.message}`)
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]))
}

/** 新增／修改共用：檢查日期區間。回錯誤（400 body）或 null。 */
function rangeError(start: string, end: string): Record<string, unknown> | null {
  if (end < start) return { error: "invalid_range" }
  if (daysInclusive(start, end) > MAX_DAYS) return { error: "range_too_long", maxDays: MAX_DAYS }
  return null
}

specialLeaveDaysRouter.get(
  "/special-leave-days/mine",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = rangeSchema.safeParse(req.query)
    if (!parsed.success || parsed.data.to < parsed.data.from || daysInclusive(parsed.data.from, parsed.data.to) > 400) {
      res.status(400).json({ error: "invalid_query" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId ?? "")
      if (!self) {
        res.status(403).json({ error: "no_employee" })
        return
      }
      const { from, to } = parsed.data
      const resolver = await loadDayTypeResolver({ tenantId, from, to, employeeIds: [self.id] })
      const days: Array<{ date: string; name: string; paid: boolean; label: string }> = []
      for (let d = from; d <= to; d = addDaysKey(d, 1)) {
        const hit = resolver.specialFor(self.id, d)
        if (hit) days.push({ date: d, name: hit.name, paid: hit.paid, label: specialDayLabel(hit) })
      }
      res.status(200).json({ from, to, days })
    } catch (err) {
      next(err)
    }
  },
)

specialLeaveDaysRouter.get(
  "/special-leave-days",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = yearSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { year } = parsed.data
    try {
      const { data, error } = await supabaseAdmin
        .from("special_leave_days")
        .select(SPECIAL_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .lte("start_date", `${year}-12-31`)
        .gte("end_date", `${year}-01-01`)
        .order("start_date", { ascending: true })
      if (error) {
        if (notMigrated(res, error)) return
        next(new Error(`GET /special-leave-days: ${error.message}`))
        return
      }
      const rows = (data ?? []) as unknown as SpecialLeaveDayRow[]
      const [employees, deptNames] = await Promise.all([loadEmployees(tenantId), loadDeptNames(tenantId)])
      res.status(200).json({ year, days: rows.map((r) => toView(r, employees, deptNames)) })
    } catch (err) {
      next(err)
    }
  },
)

specialLeaveDaysRouter.post(
  "/special-leave-days",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const b = parsed.data
    const start = b.startDate
    const end = b.endDate ?? b.startDate
    const bad = rangeError(start, end)
    if (bad) {
      res.status(400).json(bad)
      return
    }
    try {
      const lockActor = await resolveSelf(tenantId, req.auth?.userId ?? "")
      await withRecalcLock(tenantId, lockActor?.id ?? null, async () => {
        // 不追溯：碰到已結算月份 → 409 period_closed（全域錯誤處理）。
        await assertDateRangeOpen(tenantId, start, end)
        const targets = await normalizeTargets(tenantId, b.scope, b.departmentIds, b.employeeIds)
        if ("error" in targets) {
          res.status(400).json(targets)
          return
        }
        const actor = await resolveSelf(tenantId, req.auth?.userId ?? "")
        const insert = {
          tenant_id: tenantId,
          start_date: start,
          end_date: end,
          name: b.name,
          paid: b.paid,
          scope: b.scope,
          department_ids: targets.department_ids,
          employee_ids: targets.employee_ids,
          note: b.note ?? null,
          created_by_emp_id: actor?.id ?? null,
          updated_by_emp_id: actor?.id ?? null,
        }
        const { data, error } = await supabaseAdmin.from("special_leave_days").insert(insert).select(SPECIAL_COLS).single()
        if (error) {
          if (notMigrated(res, error)) return
          next(new Error(`POST /special-leave-days: ${error.message}`))
          return
        }
        const row = data as unknown as SpecialLeaveDayRow
        await writeAuditLog({
          tenantId,
          tableName: "special_leave_days",
          recordId: row.id,
          action: "INSERT",
          newRow: row,
          actorEmpId: actor?.id ?? null,
          context: "POST /special-leave-days",
        })
        const [employees, deptNames] = await Promise.all([loadEmployees(tenantId), loadDeptNames(tenantId)])
        const affected = row.scope === "all" ? null : affectedEmployeeIds(row, employees)
        const recalc = await recalcSpecialDayRange(tenantId, [{ from: start, to: end }], affected)
        res.status(201).json({ day: toView(row, employees, deptNames), recalc })
      })
    } catch (err) {
      if (err instanceof RecalcBusyError) {
        res.status(409).json({ error: "recalc_in_progress", message: "特殊假日重算進行中，請稍後再試" })
        return
      }
      next(err)
    }
  },
)

async function loadOne(tenantId: string, id: string): Promise<{ row: SpecialLeaveDayRow | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await supabaseAdmin
    .from("special_leave_days")
    .select(SPECIAL_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  return { row: (data as unknown as SpecialLeaveDayRow | null) ?? null, error: error ?? null }
}

specialLeaveDaysRouter.patch(
  "/special-leave-days/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id ?? "")
    if (!z.string().uuid().safeParse(id).success) {
      res.status(400).json({ error: "invalid_id" })
      return
    }
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const lockActor = await resolveSelf(tenantId, req.auth?.userId ?? "")
      await withRecalcLock(tenantId, lockActor?.id ?? null, async () => {
        const { row: old, error: loadErr } = await loadOne(tenantId, id)
        if (loadErr) {
          if (notMigrated(res, loadErr)) return
          next(new Error(`PATCH /special-leave-days (load): ${loadErr.message}`))
          return
        }
        if (!old) {
          res.status(404).json({ error: "not_found" })
          return
        }
        const b = parsed.data
        const start = b.startDate ?? old.start_date
        const end = b.endDate ?? (b.startDate && b.startDate > old.end_date ? b.startDate : old.end_date)
        const bad = rangeError(start, end)
        if (bad) {
          res.status(400).json(bad)
          return
        }
        // 舊區間與新區間都不能碰已結算月份（改走就等於追溯）。
        await assertDateRangeOpen(tenantId, old.start_date, old.end_date)
        await assertDateRangeOpen(tenantId, start, end)
        const scope = b.scope ?? old.scope
        const targets = await normalizeTargets(
          tenantId,
          scope,
          b.departmentIds ?? old.department_ids ?? [],
          b.employeeIds ?? old.employee_ids ?? [],
        )
        if ("error" in targets) {
          res.status(400).json(targets)
          return
        }
        const actor = await resolveSelf(tenantId, req.auth?.userId ?? "")
        const patch = {
          start_date: start,
          end_date: end,
          name: b.name ?? old.name,
          paid: b.paid ?? old.paid,
          scope,
          department_ids: targets.department_ids,
          employee_ids: targets.employee_ids,
          note: b.note !== undefined ? (b.note ?? null) : old.note,
          updated_by_emp_id: actor?.id ?? null,
          updated_at: new Date().toISOString(),
        }
        const { data, error } = await supabaseAdmin
          .from("special_leave_days")
          .update(patch)
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .is("deleted_at", null)
          .select(SPECIAL_COLS)
          .maybeSingle()
        if (error) {
          next(new Error(`PATCH /special-leave-days: ${error.message}`))
          return
        }
        if (!data) {
          res.status(404).json({ error: "not_found" })
          return
        }
        const row = data as unknown as SpecialLeaveDayRow
        await writeAuditLog({
          tenantId,
          tableName: "special_leave_days",
          recordId: id,
          action: "UPDATE",
          oldRow: old,
          newRow: row,
          actorEmpId: actor?.id ?? null,
          context: "PATCH /special-leave-days/:id",
        })
        const [employees, deptNames] = await Promise.all([loadEmployees(tenantId), loadDeptNames(tenantId)])
        const affected =
          old.scope === "all" || row.scope === "all"
            ? null
            : [...new Set([...affectedEmployeeIds(old, employees), ...affectedEmployeeIds(row, employees)])]
        const recalc = await recalcSpecialDayRange(
          tenantId,
          [
            { from: old.start_date, to: old.end_date },
            { from: start, to: end },
          ],
          affected,
          { cleanup: true },
        )
        res.status(200).json({ day: toView(row, employees, deptNames), recalc })
      })
    } catch (err) {
      if (err instanceof RecalcBusyError) {
        res.status(409).json({ error: "recalc_in_progress", message: "特殊假日重算進行中，請稍後再試" })
        return
      }
      next(err)
    }
  },
)

specialLeaveDaysRouter.delete(
  "/special-leave-days/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id ?? "")
    if (!z.string().uuid().safeParse(id).success) {
      res.status(400).json({ error: "invalid_id" })
      return
    }
    try {
      const lockActor = await resolveSelf(tenantId, req.auth?.userId ?? "")
      await withRecalcLock(tenantId, lockActor?.id ?? null, async () => {
        const { row: old, error: loadErr } = await loadOne(tenantId, id)
        if (loadErr) {
          if (notMigrated(res, loadErr)) return
          next(new Error(`DELETE /special-leave-days (load): ${loadErr.message}`))
          return
        }
        if (!old) {
          res.status(404).json({ error: "not_found" })
          return
        }
        await assertDateRangeOpen(tenantId, old.start_date, old.end_date)
        const actor = await resolveSelf(tenantId, req.auth?.userId ?? "")
        const now = new Date().toISOString()
        const { data, error } = await supabaseAdmin
          .from("special_leave_days")
          .update({ deleted_at: now, deleted_by_emp_id: actor?.id ?? null, updated_at: now })
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .is("deleted_at", null)
          .select("id")
        if (error) {
          next(new Error(`DELETE /special-leave-days: ${error.message}`))
          return
        }
        if (!data || data.length === 0) {
          res.status(404).json({ error: "not_found" })
          return
        }
        await writeAuditLog({
          tenantId,
          tableName: "special_leave_days",
          recordId: id,
          action: "DELETE",
          oldRow: old,
          actorEmpId: actor?.id ?? null,
          context: "DELETE /special-leave-days/:id",
        })
        const employees = await loadEmployees(tenantId)
        const affected = old.scope === "all" ? null : affectedEmployeeIds(old, employees)
        const recalc = await recalcSpecialDayRange(tenantId, [{ from: old.start_date, to: old.end_date }], affected, {
          cleanup: true,
        })
        res.status(200).json({ deleted: 1, recalc })
      })
    } catch (err) {
      if (err instanceof RecalcBusyError) {
        res.status(409).json({ error: "recalc_in_progress", message: "特殊假日重算進行中，請稍後再試" })
        return
      }
      next(err)
    }
  },
)
