import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { toCsv, type CsvColumn } from "../lib/csv.js"

export const reportsRouter = Router()

// "YYYY-MM-DD" (a calendar date) / "YYYY-MM" (a payroll period).
const dateRe = /^\d{4}-\d{2}-\d{2}$/
const periodRe = /^\d{4}-\d{2}$/

/**
 * All report routes are HR-admin-only and tenant-scoped. The tenant filter on
 * every query (`.eq("tenant_id", res.locals.tenantId)`) is the load-bearing
 * guard — supabaseAdmin bypasses RLS, so a report can only ever read THIS
 * tenant's rows. Every route supports `?format=csv` (UTF-8 BOM + CRLF, so Excel
 * opens CJK correctly); the default is JSON.
 */

// Send either JSON or a CSV download depending on ?format=csv.
function respond(
  req: Request,
  res: Response,
  json: Record<string, unknown>,
  csv: { filename: string; columns: CsvColumn[]; rows: Array<Record<string, unknown>> },
): void {
  if (String(req.query.format).toLowerCase() === "csv") {
    res
      .status(200)
      .type("text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${csv.filename}"`)
    res.send(toCsv(csv.rows, csv.columns))
    return
  }
  res.status(200).json(json)
}

// --- /reports/attendance -----------------------------------------------------

const attendanceQuery = z.object({
  from: z.string().regex(dateRe, "from must be YYYY-MM-DD"),
  to: z.string().regex(dateRe, "to must be YYYY-MM-DD"),
  deptId: z.string().uuid().optional(),
  format: z.string().optional(),
})

interface AttendanceDayRow {
  employee_id: string
  worked_minutes: number
  late_minutes: number
  overtime_minutes: number
  night_minutes: number
}

interface AttendanceAgg {
  employeeId: string
  employeeName: string
  workedMinutes: number
  lateDays: number
  lateMinutes: number
  overtimeMinutes: number
  nightMinutes: number
  presentDays: number
}

/**
 * GET /reports/attendance?from=&to=&deptId= — per-employee attendance rollup for
 * work_date in [from, to] (inclusive). Optional deptId narrows to employees in
 * that department. Aggregated in Node (small data): worked/late/overtime/night
 * minute sums, late-day count (days with late_minutes>0) and present-day count.
 */
reportsRouter.get(
  "/reports/attendance",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = attendanceQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { from, to, deptId } = parsed.data

    try {
      // Employee roster (id → name), optionally filtered by department. This both
      // resolves names and constrains the aggregation to the dept's employees.
      let empQuery = supabaseAdmin
        .from("employees")
        .select("id, name, dept_id")
        .eq("tenant_id", tenantId)
      if (deptId) empQuery = empQuery.eq("dept_id", deptId)
      const { data: emps, error: empErr } = await empQuery
      if (empErr) {
        next(new Error(`GET /reports/attendance (employees): ${empErr.message}`))
        return
      }
      const nameById = new Map<string, string>()
      for (const e of emps ?? []) nameById.set(e.id as string, (e.name as string) ?? "")
      const allowedIds = new Set(nameById.keys())

      let adQuery = supabaseAdmin
        .from("attendance_days")
        .select("employee_id, worked_minutes, late_minutes, overtime_minutes, night_minutes")
        .eq("tenant_id", tenantId)
        .gte("work_date", from)
        .lte("work_date", to)
      if (deptId) adQuery = adQuery.in("employee_id", Array.from(allowedIds))
      const { data: days, error: adErr } = await adQuery
      if (adErr) {
        next(new Error(`GET /reports/attendance (days): ${adErr.message}`))
        return
      }

      const aggById = new Map<string, AttendanceAgg>()
      const getAgg = (employeeId: string): AttendanceAgg => {
        let a = aggById.get(employeeId)
        if (!a) {
          a = {
            employeeId,
            employeeName: nameById.get(employeeId) ?? "",
            workedMinutes: 0,
            lateDays: 0,
            lateMinutes: 0,
            overtimeMinutes: 0,
            nightMinutes: 0,
            presentDays: 0,
          }
          aggById.set(employeeId, a)
        }
        return a
      }

      for (const row of (days ?? []) as AttendanceDayRow[]) {
        // With deptId we already filtered in SQL; without it, every row's
        // employee belongs to this tenant so it is in-scope.
        if (deptId && !allowedIds.has(row.employee_id)) continue
        const a = getAgg(row.employee_id)
        a.workedMinutes += row.worked_minutes ?? 0
        a.lateMinutes += row.late_minutes ?? 0
        a.overtimeMinutes += row.overtime_minutes ?? 0
        a.nightMinutes += row.night_minutes ?? 0
        a.presentDays += 1
        if ((row.late_minutes ?? 0) > 0) a.lateDays += 1
      }

      const rows = Array.from(aggById.values()).sort((x, y) =>
        x.employeeName.localeCompare(y.employeeName),
      )

      respond(req, res, { rows }, {
        filename: `attendance_${from}_${to}.csv`,
        columns: [
          { key: "employeeId", label: "employeeId" },
          { key: "employeeName", label: "姓名" },
          { key: "workedMinutes", label: "工作分鐘" },
          { key: "presentDays", label: "出勤天數" },
          { key: "lateDays", label: "遲到次數" },
          { key: "lateMinutes", label: "遲到分鐘" },
          { key: "overtimeMinutes", label: "加班分鐘" },
          { key: "nightMinutes", label: "夜間分鐘" },
        ],
        rows: rows as unknown as Array<Record<string, unknown>>,
      })
    } catch (err) {
      next(err)
    }
  },
)

// --- /reports/payroll --------------------------------------------------------

const payrollQuery = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  format: z.string().optional(),
})

interface PayslipRow {
  employee_id: string
  base: string | number
  overtime_pay: string | number
  night_pay: string | number
  attendance_bonus: string | number
  gross: string | number
  status: string
  /** 引擎的 PayslipResult 整包；扣項與實發只存在這裡（payslips 表只有應發側欄位）。 */
  breakdown: Record<string, unknown> | null
}

const bdNum = (bd: Record<string, unknown> | null, key: string) =>
  bd && typeof bd[key] === "number" && Number.isFinite(bd[key] as number) ? (bd[key] as number) : 0

/**
 * GET /reports/payroll?period= — per-employee payslip lines for the period plus
 * totals. Numeric columns come back from PostgREST as strings, so they are
 * coerced to numbers for the sums (and the JSON rows expose numbers).
 *
 * 2026-09-14 補扣項側：工資清冊（勞基法 §23 II）要記到「工資各項目計算方式明細」，
 * 只有應發側不算清冊。扣項與實發從 breakdown（引擎 PayslipResult）取，
 * 舊薪資單沒有 breakdown 的欄位一律以 0 呈現。
 */
reportsRouter.get(
  "/reports/payroll",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = payrollQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { period } = parsed.data

    try {
      const { data: emps, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id, name")
        .eq("tenant_id", tenantId)
      if (empErr) {
        next(new Error(`GET /reports/payroll (employees): ${empErr.message}`))
        return
      }
      const nameById = new Map<string, string>()
      for (const e of emps ?? []) nameById.set(e.id as string, (e.name as string) ?? "")

      const { data: slips, error: psErr } = await supabaseAdmin
        .from("payslips")
        .select("employee_id, base, overtime_pay, night_pay, attendance_bonus, gross, status, breakdown")
        .eq("tenant_id", tenantId)
        .eq("period", period)
      if (psErr) {
        next(new Error(`GET /reports/payroll (payslips): ${psErr.message}`))
        return
      }

      const rows = ((slips ?? []) as PayslipRow[]).map((s) => ({
        employeeId: s.employee_id,
        employeeName: nameById.get(s.employee_id) ?? "",
        base: Number(s.base),
        overtimePay: Number(s.overtime_pay),
        nightPay: Number(s.night_pay),
        attendanceBonus: Number(s.attendance_bonus),
        allowances: bdNum(s.breakdown, "allowances"),
        gross: Number(s.gross),
        laborInsurance: bdNum(s.breakdown, "laborInsurance"),
        healthInsurance: bdNum(s.breakdown, "healthInsurance"),
        pensionVoluntary: bdNum(s.breakdown, "pensionVoluntary"),
        advance: bdNum(s.breakdown, "advance"),
        totalDeductions: bdNum(s.breakdown, "totalDeductions"),
        expenses: bdNum(s.breakdown, "expenses"),
        net: s.breakdown && typeof s.breakdown.net === "number" ? (s.breakdown.net as number) : Number(s.gross),
        status: s.status,
      }))
      rows.sort((x, y) => x.employeeName.localeCompare(y.employeeName))

      const sum = (key: keyof (typeof rows)[number]) =>
        rows.reduce((acc, r) => acc + (typeof r[key] === "number" ? (r[key] as number) : 0), 0)
      const total = {
        gross: sum("gross"),
        totalDeductions: sum("totalDeductions"),
        expenses: sum("expenses"),
        net: sum("net"),
      }

      // CSV gets the per-employee rows plus an appended total row.
      const csvRows: Array<Record<string, unknown>> = [
        ...(rows as unknown as Array<Record<string, unknown>>),
        {
          employeeId: "",
          employeeName: "合計",
          base: sum("base"),
          overtimePay: sum("overtimePay"),
          nightPay: sum("nightPay"),
          attendanceBonus: sum("attendanceBonus"),
          allowances: sum("allowances"),
          gross: total.gross,
          laborInsurance: sum("laborInsurance"),
          healthInsurance: sum("healthInsurance"),
          pensionVoluntary: sum("pensionVoluntary"),
          advance: sum("advance"),
          totalDeductions: total.totalDeductions,
          expenses: total.expenses,
          net: total.net,
          status: "",
        },
      ]

      respond(req, res, { rows, total }, {
        filename: `payroll_${period}.csv`,
        columns: [
          { key: "employeeId", label: "employeeId" },
          { key: "employeeName", label: "姓名" },
          { key: "base", label: "本俸" },
          { key: "overtimePay", label: "加班費" },
          { key: "nightPay", label: "夜間加給" },
          { key: "attendanceBonus", label: "全勤獎金" },
          { key: "allowances", label: "定額補貼" },
          { key: "gross", label: "應發合計" },
          { key: "laborInsurance", label: "勞保自付" },
          { key: "healthInsurance", label: "健保自付" },
          { key: "pensionVoluntary", label: "勞退自提" },
          { key: "advance", label: "預支扣回" },
          { key: "totalDeductions", label: "應扣合計" },
          { key: "expenses", label: "代墊支出" },
          { key: "net", label: "實發金額" },
          { key: "status", label: "狀態" },
        ],
        rows: csvRows,
      })
    } catch (err) {
      next(err)
    }
  },
)

// --- /reports/leave ----------------------------------------------------------

const leaveQuery = z.object({
  from: z.string().regex(dateRe, "from must be YYYY-MM-DD"),
  to: z.string().regex(dateRe, "to must be YYYY-MM-DD"),
  format: z.string().optional(),
})

interface LeaveRow {
  employee_id: string
  kind: string
  status: string
  hours: string | number | null
  created_at: string
  start_at: string
  end_at: string
}

/**
 * GET /reports/leave?from=&to= — leave_requests rollup for the window. A request
 * is in-scope if it was created in [from, to] OR its start/end overlaps it. The
 * summary counts by kind × status with summed hours; `details` carries the
 * per-employee matching rows.
 */
reportsRouter.get(
  "/reports/leave",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = leaveQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { from, to } = parsed.data
    // Window as timestamps: [from 00:00, to 24:00) for created/overlap tests.
    const fromTs = `${from}T00:00:00.000Z`
    const toTsExclusive = nextDayUtc(to)

    try {
      const { data: emps, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id, name")
        .eq("tenant_id", tenantId)
      if (empErr) {
        next(new Error(`GET /reports/leave (employees): ${empErr.message}`))
        return
      }
      const nameById = new Map<string, string>()
      for (const e of emps ?? []) nameById.set(e.id as string, (e.name as string) ?? "")

      const { data: reqs, error: lrErr } = await supabaseAdmin
        .from("leave_requests")
        .select("employee_id, kind, status, hours, created_at, start_at, end_at")
        .eq("tenant_id", tenantId)
      if (lrErr) {
        next(new Error(`GET /reports/leave (requests): ${lrErr.message}`))
        return
      }

      // Keep rows created in-window OR whose [start,end] overlaps the window.
      const inWindow = ((reqs ?? []) as LeaveRow[]).filter((r) => {
        const createdIn = r.created_at >= fromTs && r.created_at < toTsExclusive
        const overlaps = r.start_at < toTsExclusive && r.end_at >= fromTs
        return createdIn || overlaps
      })

      // Aggregate by kind × status.
      const aggKey = (k: string, s: string) => `${k} ${s}`
      const aggMap = new Map<string, { kind: string; status: string; count: number; hours: number }>()
      for (const r of inWindow) {
        const key = aggKey(r.kind, r.status)
        let a = aggMap.get(key)
        if (!a) {
          a = { kind: r.kind, status: r.status, count: 0, hours: 0 }
          aggMap.set(key, a)
        }
        a.count += 1
        a.hours += r.hours != null ? Number(r.hours) : 0
      }
      const rows = Array.from(aggMap.values()).sort(
        (x, y) => x.kind.localeCompare(y.kind) || x.status.localeCompare(y.status),
      )

      const details = inWindow.map((r) => ({
        employeeId: r.employee_id,
        employeeName: nameById.get(r.employee_id) ?? "",
        kind: r.kind,
        status: r.status,
        hours: r.hours != null ? Number(r.hours) : 0,
        startAt: r.start_at,
        endAt: r.end_at,
      }))

      respond(req, res, { rows, details }, {
        filename: `leave_${from}_${to}.csv`,
        columns: [
          { key: "kind", label: "類別" },
          { key: "status", label: "狀態" },
          { key: "count", label: "件數" },
          { key: "hours", label: "總時數" },
        ],
        rows: rows as unknown as Array<Record<string, unknown>>,
      })
    } catch (err) {
      next(err)
    }
  },
)

// --- /reports/headcount ------------------------------------------------------

const headcountQuery = z.object({ format: z.string().optional() })

interface EmployeeRow {
  id: string
  status: string
  role: string
  dept_id: string | null
}

/**
 * GET /reports/headcount — workforce snapshot for this tenant: total employees
 * plus counts by status, by department (dept_id, null bucketed), and by role.
 */
reportsRouter.get(
  "/reports/headcount",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = headcountQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }

    try {
      const { data: emps, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id, status, role, dept_id")
        .eq("tenant_id", tenantId)
      if (empErr) {
        next(new Error(`GET /reports/headcount: ${empErr.message}`))
        return
      }

      const byStatus: Record<string, number> = {}
      const byRole: Record<string, number> = {}
      const byDeptMap = new Map<string | null, number>()
      for (const e of (emps ?? []) as EmployeeRow[]) {
        byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
        byRole[e.role] = (byRole[e.role] ?? 0) + 1
        byDeptMap.set(e.dept_id, (byDeptMap.get(e.dept_id) ?? 0) + 1)
      }
      const total = (emps ?? []).length
      const byDept = Array.from(byDeptMap.entries()).map(([deptId, count]) => ({ deptId, count }))

      // CSV flattens the three breakdowns into labelled rows.
      const csvRows: Array<Record<string, unknown>> = [
        { dimension: "total", key: "", count: total },
        ...Object.entries(byStatus).map(([k, c]) => ({ dimension: "status", key: k, count: c })),
        ...Object.entries(byRole).map(([k, c]) => ({ dimension: "role", key: k, count: c })),
        ...byDept.map((d) => ({ dimension: "dept", key: d.deptId ?? "(none)", count: d.count })),
      ]

      respond(req, res, { total, byStatus, byRole, byDept }, {
        filename: `headcount.csv`,
        columns: [
          { key: "dimension", label: "維度" },
          { key: "key", label: "項目" },
          { key: "count", label: "人數" },
        ],
        rows: csvRows,
      })
    } catch (err) {
      next(err)
    }
  },
)

/** 1st instant of the day AFTER `date` (UTC), for an exclusive upper bound. */
function nextDayUtc(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}
