import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { writeAuditLog } from "../services/audit.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { dayWindowUtc, todayKey } from "../lib/tz.js"
import { checkPunchCooldown, cooldownSeconds, statusFromRecords } from "../services/punch-guard.js"

export const punchRouter = Router()

// "YYYY-MM-DD".
const dateRe = /^\d{4}-\d{2}-\d{2}$/

const punchSchema = z.object({
  // type is optional — when omitted we infer it from the employee's last punch
  // today (none / last 'out' → 'in'; last 'in' → 'out').
  // Work in/out plus 休息/外出 pairs. Inference (omitted type) only
  // applies to work in/out; break/outing must be explicit.
  type: z.enum(["in", "out", "break_in", "break_out", "outing_in", "outing_out"]).optional(),
  source: z.enum(["gps", "web", "line"]).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  deviceId: z.string().trim().min(1).optional(),
  // NOTE: we deliberately do NOT read employeeId from the body. The punch is
  // always recorded for the token owner (anti-proxy-punch). Any employeeId a
  // client sends is ignored — kept lax here so a stray field doesn't 400.
})

const querySchema = z.object({
  employeeId: z.string().uuid().optional(),
  deptId: z.string().uuid().optional(),
  type: z.enum(["in", "out", "break_in", "break_out", "outing_in", "outing_out"]).optional(),
  source: z.enum(["gps", "web", "line", "manual"]).optional(),
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
})

const SELECT_COLS = "id, tenant_id, employee_id, punch_at, type, source, lat, lng, device_id"

// [start, end) UTC instants covering "today" on the TENANT's clock
// (tenants.timezone, default Asia/Taipei) — used to scope today's punches and
// to infer the next in/out. Deterministic regardless of the host timezone.
async function todayWindow(tenantId: string): Promise<{ start: string; end: string }> {
  const tz = await getTenantTimezone(tenantId)
  const { startIso, endIso } = dayWindowUtc(todayKey(tz), tz)
  return { start: startIso, end: endIso }
}

// Resolve the caller's own employee row (id + role) in this tenant, or null.
async function resolveSelf(
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`resolve self employee: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && ["hr_admin", "platform_admin"].includes(role)
}

/**
 * POST /punch — the authenticated employee clocks in/out for THEMSELVES.
 *
 * Anti-proxy-punch: the employee_id written is always derived from the token
 * (req.auth.userId → employees row in this tenant); any employeeId in the body
 * is ignored. A caller with no employee row in this tenant gets 403.
 *
 * If `type` is omitted it is inferred from the employee's last punch today:
 * no punch yet / last was 'out' → 'in'; last was 'in' → 'out'. Optional
 * source/lat/lng/deviceId are stored as given (source defaults to 'web').
 *
 * Cooldown（連按防呆）: before inferring or writing anything we load the
 * employee's most recent punch (any type, any day). If it is younger than
 * `PUNCH_COOLDOWN_SECONDS` (default 60; see services/punch-guard.ts) the
 * request is refused with
 *   409 { error: "punch_too_soon", retryAfterSeconds, last: { id, type, punchAt } }
 * so a double tap on the front page yields exactly one row. HR back-fills
 * (`/punch/manual`, `/punch/manual/import`) are NOT subject to the cooldown.
 *
 * 201 body: `{ id, type, punchAt, source, lat, lng, deviceId, record }` —
 * the original three fields keep their names and types; `record` is the full
 * stored row (snake_case, as `GET /punch/today` lists it) so the client can
 * optimistically append it without a refetch.
 */
punchRouter.post(
  "/punch",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = punchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { type, source, lat, lng, deviceId } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        // No employee identity in this tenant → cannot punch (and definitely
        // cannot punch for anyone else).
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      // Cooldown check against the employee's most recent punch of ANY type on
      // ANY day (a double tap does not care about the tenant's day boundary).
      // Runs before inference so a refused request never reads as "out".
      // Skipped entirely when the window is 0 (disabled / test setup).
      const seconds = cooldownSeconds()
      if (seconds > 0) {
        const { data: recent, error: recentErr } = await supabaseAdmin
          .from("punch_records")
          .select("id, type, punch_at")
          .eq("tenant_id", tenantId)
          .eq("employee_id", self.id)
          .order("punch_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (recentErr) {
          next(new Error(`POST /punch (cooldown): ${recentErr.message}`))
          return
        }
        const guard = checkPunchCooldown(
          recent ? { punch_at: recent.punch_at as string } : null,
          new Date(),
          seconds,
        )
        if (!guard.ok && recent) {
          res.set("Retry-After", String(guard.retryAfterSeconds))
          res.status(409).json({
            error: "punch_too_soon",
            retryAfterSeconds: guard.retryAfterSeconds,
            last: { id: recent.id, type: recent.type, punchAt: recent.punch_at },
          })
          return
        }
      }

      // Infer in/out from today's last punch when the client didn't specify.
      let resolvedType = type
      if (!resolvedType) {
        const { start, end } = await todayWindow(tenantId)
        const { data: last, error: lastErr } = await supabaseAdmin
          .from("punch_records")
          .select("type")
          .eq("tenant_id", tenantId)
          .eq("employee_id", self.id)
          .in("type", ["in", "out"]) // break/outing punches don't flip work state
          .gte("punch_at", start)
          .lt("punch_at", end)
          .order("punch_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (lastErr) {
          next(new Error(`POST /punch (infer): ${lastErr.message}`))
          return
        }
        resolvedType = last?.type === "in" ? "out" : "in"
      }

      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .insert({
          tenant_id: tenantId,
          employee_id: self.id,
          type: resolvedType,
          source: source ?? "web",
          lat: lat ?? null,
          lng: lng ?? null,
          device_id: deviceId ?? null,
        })
        .select("*")
        .single()

      if (error || !data) {
        next(new Error(`POST /punch: ${error?.message}`))
        return
      }
      res.status(201).json({
        id: data.id,
        type: data.type,
        punchAt: data.punch_at,
        source: data.source,
        lat: data.lat,
        lng: data.lng,
        deviceId: data.device_id,
        record: data,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /punch/today — the caller's own punches for today (chronological) plus a
 * derived status: 'working' if the most recent work in/out punch today was
 * 'in', else 'off'. break_* / outing_* punches are ignored for the status
 * (see statusFromRecords) so a break never reads as "已下班" on the front
 * page. A caller with no employee row returns an empty list and status 'off'.
 */
punchRouter.get(
  "/punch/today",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(200).json({ records: [], status: "off" })
        return
      }

      const { start, end } = await todayWindow(tenantId)
      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .eq("employee_id", self.id)
        .gte("punch_at", start)
        .lt("punch_at", end)
        .order("punch_at", { ascending: true })

      if (error) {
        next(new Error(`GET /punch/today: ${error.message}`))
        return
      }
      const records = data ?? []
      const status = statusFromRecords(records as Array<{ type: string }>)
      res.status(200).json({ records, status })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /punch?employeeId=&from=&to= — list punch records.
 *
 * Role-based scoping (on top of the always-on tenant filter):
 *   • HR admin / platform admin → may see the whole tenant; honours an optional
 *     employeeId filter and from/to (YYYY-MM-DD) date window.
 *   • Any other role → forced to their OWN employee row regardless of the
 *     employeeId param (passing someone else's id reveals nothing).
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters are the load-bearing
 * guard. from/to are inclusive calendar days on the tenant's clock (`to` is
 * expanded to the end of that local day).
 */
punchRouter.get(
  "/punch",
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
    const { employeeId, deptId, type, source, from, to } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      let query = supabaseAdmin.from("punch_records").select(SELECT_COLS).eq("tenant_id", tenantId)

      if (isHr) {
        if (employeeId) query = query.eq("employee_id", employeeId)
        if (deptId) {
          const { data: deptEmployees, error: deptErr } = await supabaseAdmin
            .from("employees")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("dept_id", deptId)
          if (deptErr) {
            next(new Error(`GET /punch (dept employees): ${deptErr.message}`))
            return
          }
          const ids = (deptEmployees ?? []).map((employee) => employee.id as string)
          query = ids.length > 0 ? query.in("employee_id", ids) : query.eq("employee_id", "00000000-0000-0000-0000-000000000000")
        }
      } else {
        // Non-HR: always pinned to self. No employee row → impossible filter →
        // empty result (never another user's data).
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }

      if (type) query = query.eq("type", type)
      if (source) query = query.eq("source", source)
      if (from || to) {
        const tz = await getTenantTimezone(tenantId)
        if (from) query = query.gte("punch_at", dayWindowUtc(from, tz).startIso)
        if (to) query = query.lt("punch_at", dayWindowUtc(to, tz).endIso)
      }

      const { data, error } = await query.order("punch_at", { ascending: true })
      if (error) {
        next(new Error(`GET /punch: ${error.message}`))
        return
      }
      res.status(200).json({ records: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// 補登 body — HR back-fills a punch for an employee (打卡紀錄維護的
// 批次打卡補登/忘打卡補登). Explicit employeeId + timestamp + type.
const manualSchema = z.object({
  employeeId: z.string().uuid(),
  punchAt: z.string().datetime(),
  type: z.enum(["in", "out", "break_in", "break_out", "outing_in", "outing_out"]),
})

const manualImportSchema = z.object({
  csv: z.string().min(1, "csv is required"),
})

type ManualPunchInput = z.infer<typeof manualSchema>

function canonicalManualHeader(h: string): keyof ManualPunchInput | null {
  switch (h.trim().toLowerCase()) {
    case "employeeid":
    case "employee_id":
      return "employeeId"
    case "punchat":
    case "punch_at":
      return "punchAt"
    case "type":
      return "type"
    default:
      return null
  }
}

function parseManualPunchCsv(csv: string): {
  records: ManualPunchInput[]
  errors: { line: number; error: string }[]
} {
  const lines = csv.split(/\r?\n/).map((line) => line.trim())
  const nonEmpty = lines.filter((line) => line.length > 0)
  const result: { records: ManualPunchInput[]; errors: { line: number; error: string }[] } = {
    records: [],
    errors: [],
  }
  if (nonEmpty.length < 2) {
    result.errors.push({ line: 0, error: "csv needs a header row and at least one data row" })
    return result
  }

  const headers = nonEmpty[0].split(",").map(canonicalManualHeader)
  nonEmpty.slice(1).forEach((line, i) => {
    const lineNo = i + 2
    const cells = line.split(",")
    const raw: Record<string, string> = {}
    headers.forEach((key, col) => {
      if (!key) return
      const val = (cells[col] ?? "").trim()
      if (val.length > 0) raw[key] = val
    })
    const parsed = manualSchema.safeParse(raw)
    if (!parsed.success) {
      result.errors.push({
        line: lineNo,
        error: parsed.error.issues.map((issue) => issue.message).join("; "),
      })
      return
    }
    result.records.push(parsed.data)
  })
  return result
}

/**
 * POST /punch/manual/import — HR-admin bulk back-fills manual punch records from
 * CSV. Header row: employeeId,punchAt,type. Invalid lines are skipped and
 * returned in errors so HR can fix only the failed rows.
 */
punchRouter.post(
  "/punch/manual/import",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = manualImportSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const { records, errors } = parseManualPunchCsv(parsed.data.csv)
    if (records.length === 0) {
      res.status(400).json({ error: "no_valid_rows", errors })
      return
    }

    try {
      const employeeIds = Array.from(new Set(records.map((record) => record.employeeId)))
      const { data: employees, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .in("id", employeeIds)
      if (empErr) {
        next(new Error(`POST /punch/manual/import (employees): ${empErr.message}`))
        return
      }

      const validEmployees = new Set((employees ?? []).map((employee) => employee.id as string))
      const rows = records
        .map((record, index) => ({ record, line: index + 2 }))
        .filter(({ record, line }) => {
          if (validEmployees.has(record.employeeId)) return true
          errors.push({ line, error: "employee_not_found" })
          return false
        })
        .map(({ record }) => ({
          tenant_id: tenantId,
          employee_id: record.employeeId,
          punch_at: record.punchAt,
          type: record.type,
          source: "manual",
        }))

      if (rows.length === 0) {
        res.status(400).json({ error: "no_valid_rows", errors })
        return
      }

      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .insert(rows)
        .select("id")
      if (error) {
        next(new Error(`POST /punch/manual/import: ${error.message}`))
        return
      }
      res.status(201).json({
        imported: (data ?? []).map((record) => record.id),
        count: data?.length ?? 0,
        errors,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /punch/manual — HR-admin creates a punch record on someone's behalf
 * (source='manual' so audits can tell back-fills from real punches). The target
 * employee must belong to this tenant → otherwise 404.
 */
punchRouter.post(
  "/punch/manual",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = manualSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, punchAt, type } = parsed.data
    try {
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", employeeId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`POST /punch/manual (employee): ${empErr.message}`))
        return
      }
      if (!emp) {
        res.status(404).json({ error: "employee_not_found" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          punch_at: punchAt,
          type,
          source: "manual",
        })
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`POST /punch/manual: ${error?.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "punch_records",
        recordId: data.id as string,
        action: "INSERT",
        newRow: { employee_id: employeeId, punch_at: punchAt, type, source: "manual" },
        context: "POST /punch/manual — HR 補登打卡",
      })
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
