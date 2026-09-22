import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { upsertScheduleAssignments } from "../services/imports/writers.js"

export const schedulesRouter = Router()

// "YYYY-MM-DD".
const dateRe = /^\d{4}-\d{2}-\d{2}$/

const assignmentSchema = z.object({
  employeeId: z.string().uuid("employeeId must be a uuid"),
  workDate: z.string().regex(dateRe, "workDate must be YYYY-MM-DD"),
  shiftId: z.string().uuid().nullish(),
  status: z.string().trim().min(1).optional(),
})

// Accept either a single assignment (flat body) or a batch ({ assignments: [] }).
const createSchema = z.union([
  assignmentSchema,
  z.object({
    assignments: z.array(assignmentSchema).min(1, "assignments must not be empty"),
  }),
])

const querySchema = z.object({
  employeeId: z.string().uuid().optional(),
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
})

type Assignment = z.infer<typeof assignmentSchema>

// 列的形狀與 upsert 都在 services/imports/writers.ts 的 upsertScheduleAssignments
// （xlsx 匯入 POST /imports/schedules 共用）。

// Body for POST /schedules/import — a raw CSV blob (as pasted from a spreadsheet
// export). Header row is required; recognised columns are employeeId/employee_id,
// workDate/work_date, shiftId/shift_id, status. Blank shiftId/status are allowed.
const importSchema = z.object({
  csv: z.string().min(1, "csv is required"),
})

// Map a header cell to our canonical assignment key (or null if unrecognised).
function canonicalHeader(h: string): keyof Assignment | null {
  switch (h.trim().toLowerCase()) {
    case "employeeid":
    case "employee_id":
      return "employeeId"
    case "workdate":
    case "work_date":
      return "workDate"
    case "shiftid":
    case "shift_id":
      return "shiftId"
    case "status":
      return "status"
    default:
      return null
  }
}

interface ParsedCsv {
  assignments: Assignment[]
  errors: { line: number; error: string }[]
}

/**
 * Parse a schedule CSV into validated assignments. Simple comma split (the fields
 * are uuids / dates / short codes that never contain commas); the first
 * non-empty line is the header. Each data row is validated with assignmentSchema
 * and either collected as an assignment or reported as a per-line error, so one
 * bad row never sinks the whole import.
 */
function parseScheduleCsv(csv: string): ParsedCsv {
  const lines = csv.split(/\r?\n/).map((l) => l.trim())
  const nonEmpty = lines.filter((l) => l.length > 0)
  const result: ParsedCsv = { assignments: [], errors: [] }
  if (nonEmpty.length < 2) {
    result.errors.push({ line: 0, error: "csv needs a header row and at least one data row" })
    return result
  }

  const headers = nonEmpty[0].split(",").map(canonicalHeader)
  nonEmpty.slice(1).forEach((line, i) => {
    const lineNo = i + 2 // 1-based, +1 for the header
    const cells = line.split(",")
    const raw: Record<string, string> = {}
    headers.forEach((key, col) => {
      if (!key) return
      const val = (cells[col] ?? "").trim()
      if (val.length > 0) raw[key] = val
    })
    const parsed = assignmentSchema.safeParse(raw)
    if (!parsed.success) {
      result.errors.push({
        line: lineNo,
        error: parsed.error.issues.map((x) => x.message).join("; "),
      })
      return
    }
    result.assignments.push(parsed.data)
  })
  return result
}

/**
 * POST /schedules — HR-admin assigns shifts. Accepts a single assignment or a
 * batch { assignments: [...] }. Upserts on the (tenant_id, employee_id,
 * work_date) unique index so re-assigning the same employee+date updates the
 * existing row instead of erroring. Tenant-scoped via res.locals.tenantId.
 *
 * Note: employeeId values are trusted to belong to this tenant via the FK +
 * the fact that the tenant_id we write is always the caller's own; a cross
 * tenant employeeId would still be written under THIS tenant_id, so it cannot
 * leak another tenant's data (and would orphan harmlessly).
 */
schedulesRouter.post(
  "/schedules",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const assignments: Assignment[] =
      "assignments" in parsed.data ? parsed.data.assignments : [parsed.data]

    try {
      const { ids } = await upsertScheduleAssignments(tenantId, assignments, "POST /schedules")
      res.status(201).json({ ids, count: ids.length })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /schedules/import — HR-admin bulk-imports a roster from CSV (班表匯入).
 * The body is { csv }; each valid row is upserted on the same (tenant_id,
 * employee_id, work_date) key as POST /schedules, so re-importing an overlapping
 * roster updates in place. Returns { imported, count, errors } — invalid rows are
 * reported per-line and skipped rather than failing the whole batch.
 */
schedulesRouter.post(
  "/schedules/import",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = importSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const { assignments, errors } = parseScheduleCsv(parsed.data.csv)
    if (assignments.length === 0) {
      // Nothing importable — surface the parse errors with a 400 so the caller
      // knows the file was rejected wholesale.
      res.status(400).json({ error: "no_valid_rows", errors })
      return
    }

    try {
      const { ids } = await upsertScheduleAssignments(tenantId, assignments, "POST /schedules/import")
      res.status(201).json({ imported: ids, count: ids.length, errors })
    } catch (err) {
      next(err)
    }
  },
)

// Shared handler for the two 班表審核 decisions an employee makes on their own
// assigned schedule row: acknowledge (→ 'confirmed') or dispute (→ 'disputed').
async function reviewSchedule(
  decision: "confirmed" | "disputed",
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  const scheduleId = req.params.id

  try {
    // Who is the caller in this tenant?
    const { data: me, error: meErr } = await supabaseAdmin
      .from("employees")
      .select("id, role")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle()
    if (meErr) {
      next(new Error(`POST /schedules/${scheduleId}/review (me): ${meErr.message}`))
      return
    }
    if (!me) {
      res.status(403).json({ error: "not_an_employee" })
      return
    }
    const isHr = ["hr_admin", "platform_admin"].includes(me.role)

    // Load the target row (tenant-scoped).
    const { data: row, error: rowErr } = await supabaseAdmin
      .from("schedules")
      .select("id, employee_id, status")
      .eq("tenant_id", tenantId)
      .eq("id", scheduleId)
      .maybeSingle()
    if (rowErr) {
      next(new Error(`POST /schedules/${scheduleId}/review (load): ${rowErr.message}`))
      return
    }
    if (!row) {
      res.status(404).json({ error: "not_found" })
      return
    }
    // Only the owning employee (or HR) may review a schedule.
    if (!isHr && row.employee_id !== me.id) {
      res.status(403).json({ error: "not_your_schedule" })
      return
    }

    const { error: upErr } = await supabaseAdmin
      .from("schedules")
      .update({ status: decision })
      .eq("id", scheduleId)
      .eq("tenant_id", tenantId)
    if (upErr) {
      next(new Error(`POST /schedules/${scheduleId}/review (update): ${upErr.message}`))
      return
    }
    res.status(200).json({ id: scheduleId, status: decision })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /schedules/:id/acknowledge — the assigned employee (or HR) confirms their
 * roster row (status → 'confirmed'). 404 if the row is not in this tenant; 403 if
 * the caller is neither the row's employee nor an HR admin.
 */
schedulesRouter.post(
  "/schedules/:id/acknowledge",
  requireAuth,
  requireTenant,
  (req: Request, res: Response, next: NextFunction) => reviewSchedule("confirmed", req, res, next),
)

/**
 * POST /schedules/:id/dispute — the assigned employee (or HR) flags a roster row
 * as contested (status → 'disputed'). Same 403/404 guards as acknowledge.
 */
schedulesRouter.post(
  "/schedules/:id/dispute",
  requireAuth,
  requireTenant,
  (req: Request, res: Response, next: NextFunction) => reviewSchedule("disputed", req, res, next),
)

/**
 * GET /schedules?employeeId=&from=&to= — list schedules.
 *
 * Role-based scoping (in addition to the always-on tenant filter):
 *   • HR admin / platform admin → may see the whole tenant; honours an optional
 *     employeeId filter.
 *   • Any other role → forced to their OWN employee row(s) regardless of the
 *     employeeId query param (so passing someone else's id reveals nothing).
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters here are the
 * load-bearing guard.
 */
schedulesRouter.get(
  "/schedules",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { employeeId, from, to } = parsed.data

    try {
      // Resolve the caller's own employee identity + role in this tenant.
      const { data: me, error: meErr } = await supabaseAdmin
        .from("employees")
        .select("id, role")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle()
      if (meErr) {
        next(new Error(`GET /schedules (me): ${meErr.message}`))
        return
      }

      const isHr = !!me && ["hr_admin", "platform_admin"].includes(me.role)

      let query = supabaseAdmin
        .from("schedules")
        .select("id, tenant_id, employee_id, work_date, shift_id, status, created_at")
        .eq("tenant_id", tenantId)

      if (isHr) {
        // HR may optionally narrow to one employee.
        if (employeeId) query = query.eq("employee_id", employeeId)
      } else {
        // Non-HR: always pinned to self. If they have no employee row, they get
        // an impossible filter → empty result (never another user's data).
        query = query.eq("employee_id", me?.id ?? "00000000-0000-0000-0000-000000000000")
      }

      if (from) query = query.gte("work_date", from)
      if (to) query = query.lte("work_date", to)

      const { data, error } = await query.order("work_date", { ascending: true })
      if (error) {
        next(new Error(`GET /schedules: ${error.message}`))
        return
      }
      res.status(200).json({ schedules: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)
