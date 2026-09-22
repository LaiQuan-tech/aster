import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { writeAuditLog } from "../services/audit.js"
import { datesBetween, generateRoster, workingDaysIn } from "../services/duty-roster.js"

/**
 * 值日生／總機輪播排班（M8；表 `duty_rosters`）。
 *
 *   POST   /duty-rosters/generate   HR：選參與者與起訖日，一鍵輪播（只排工作日）
 *   GET    /duty-rosters?from&to&dutyType   HR：月曆格資料
 *   PATCH  /duty-rosters/:id        HR：點格子換人
 *   DELETE /duty-rosters/:id        HR：清掉某一天
 *   GET    /duty-rosters/today      任何員工：ESS 首頁「今日值日／總機」卡
 *
 * 「只排工作日」與既有出勤引擎同一個判準：`tenant_calendar_days` 有覆寫就聽它，
 * 沒有就週末為非工作日（同 `services/settlement.ts` 的 dayTypeFor）。輪播順序是
 * 純函式（services/duty-roster.ts），可重現也好驗。
 */
export const dutyRostersRouter = Router()

const DUTY_TYPES = ["duty", "reception"] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COLS = "id, duty_type, work_date, employee_id, batch_id, note, created_at"

const generateSchema = z.object({
  dutyType: z.enum(DUTY_TYPES),
  /** 有序參與者：輪播就照這個順序繞。 */
  participantEmpIds: z.array(z.string().uuid()).min(1).max(200),
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
  /** true＝先清掉區間內同職務的舊排班再產生；false（預設）＝已排的日子跳過。 */
  replaceExisting: z.boolean().optional(),
  /** 從名單第幾位開始（預設 0）。 */
  startIndex: z.number().int().min(0).max(200).optional(),
  /** 或直接指定從誰開始（優先於 startIndex）。 */
  startEmpId: z.string().uuid().optional(),
})

const patchSchema = z.object({
  employeeId: z.string().uuid().optional(),
  note: z.string().trim().max(200).nullish(),
})

interface RosterRow {
  id: string
  duty_type: string
  work_date: string
  employee_id: string
  batch_id: string | null
  note: string | null
  created_at: string
}

async function namesOf(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return new Map()
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", unique)
  if (error) throw new Error(`duty rosters (names): ${error.message}`)
  return new Map((data ?? []).map((r) => [r.id as string, (r.name as string) ?? ""]))
}

/** 區間內的 `tenant_calendar_days` 覆寫（date → day_type）。表還沒建就當作沒覆寫。 */
async function calendarOf(tenantId: string, from: string, to: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const { data, error } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, day_type")
    .eq("tenant_id", tenantId)
    .gte("date", from)
    .lte("date", to)
  if (error) {
    console.warn(`[duty-rosters] calendar unavailable, falling back to weekends: ${error.message}`)
    return map
  }
  for (const row of data ?? []) map.set(row.date as string, row.day_type as string)
  return map
}

/**
 * POST /duty-rosters/generate — 產生一段區間的輪播排班（HR）。
 *
 * `replaceExisting` 為 false 時，已經排過的日子**跳過而不是覆蓋**：HR 手動換過
 * 的那幾天不該被重跑的產生器洗掉。要整段重來就明示 replaceExisting。
 */
dutyRostersRouter.post(
  "/duty-rosters/generate",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = generateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { dutyType, from, to } = parsed.data
    if (to < from) {
      res.status(400).json({ error: "invalid_range" })
      return
    }
    if (datesBetween(from, to).length === 0) {
      res.status(400).json({ error: "range_too_long", maxDays: 400 })
      return
    }

    try {
      // 參與者必須是本租戶在職員工（避免排到別租戶或已離職的人）。
      const { data: emps, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
        .in("id", parsed.data.participantEmpIds)
      if (empErr) {
        next(new Error(`POST /duty-rosters/generate (employees): ${empErr.message}`))
        return
      }
      const validIds = new Set((emps ?? []).map((e) => e.id as string))
      const unknown = parsed.data.participantEmpIds.filter((id) => !validIds.has(id))
      if (unknown.length > 0) {
        res.status(400).json({ error: "unknown_participants", employeeIds: unknown })
        return
      }
      const participants = parsed.data.participantEmpIds.filter((id, i, arr) => arr.indexOf(id) === i)

      const calendar = await calendarOf(tenantId, from, to)
      const workdays = workingDaysIn(from, to, calendar)
      if (workdays.length === 0) {
        res.status(200).json({ batchId: null, created: 0, skipped: 0, replaced: 0, workdays: 0 })
        return
      }

      let replaced = 0
      if (parsed.data.replaceExisting) {
        const { data: removed, error: delErr } = await supabaseAdmin
          .from("duty_rosters")
          .delete()
          .eq("tenant_id", tenantId)
          .eq("duty_type", dutyType)
          .gte("work_date", from)
          .lte("work_date", to)
          .select("id")
        if (delErr) {
          next(new Error(`POST /duty-rosters/generate (replace): ${delErr.message}`))
          return
        }
        replaced = (removed ?? []).length
      }

      const { data: existing, error: exErr } = await supabaseAdmin
        .from("duty_rosters")
        .select("work_date")
        .eq("tenant_id", tenantId)
        .eq("duty_type", dutyType)
        .gte("work_date", from)
        .lte("work_date", to)
      if (exErr) {
        next(new Error(`POST /duty-rosters/generate (existing): ${exErr.message}`))
        return
      }
      const taken = new Set((existing ?? []).map((r) => r.work_date as string))

      const startIndex = parsed.data.startEmpId
        ? Math.max(participants.indexOf(parsed.data.startEmpId), 0)
        : (parsed.data.startIndex ?? 0)
      // 先對「所有工作日」輪播再挑掉已排的日子——這樣跳過幾天不會讓後面的順序整個位移。
      const assignments = generateRoster({ participants, dates: workdays, startIndex })
      const fresh = assignments.filter((a) => !taken.has(a.date))

      const actor = await resolveSelf(tenantId, req.auth?.userId ?? "")
      const batchId = crypto.randomUUID()
      if (fresh.length > 0) {
        const { error: insErr } = await supabaseAdmin.from("duty_rosters").insert(
          fresh.map((a) => ({
            tenant_id: tenantId,
            duty_type: dutyType,
            work_date: a.date,
            employee_id: a.employeeId,
            batch_id: batchId,
            created_by_emp_id: actor?.id ?? null,
          })),
        )
        if (insErr) {
          next(new Error(`POST /duty-rosters/generate (insert): ${insErr.message}`))
          return
        }
      }

      await writeAuditLog({
        tenantId,
        tableName: "duty_rosters",
        recordId: batchId,
        action: "INSERT",
        newRow: {
          dutyType,
          from,
          to,
          participants: participants.length,
          created: fresh.length,
          replaced,
          startIndex,
        },
        actorEmpId: actor?.id ?? null,
        context: "POST /duty-rosters/generate — 輪播排班",
      })

      res.status(201).json({
        batchId: fresh.length > 0 ? batchId : null,
        created: fresh.length,
        skipped: assignments.length - fresh.length,
        replaced,
        workdays: workdays.length,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /duty-rosters/today — 今天的值日／總機（任何員工）。
 * ESS 首頁的卡片用；兩者皆無就兩個 null，前端整張不顯示。
 */
dutyRostersRouter.get(
  "/duty-rosters/today",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const date = todayKey(await getTenantTimezone(tenantId))
      const { data, error } = await supabaseAdmin
        .from("duty_rosters")
        .select("duty_type, employee_id")
        .eq("tenant_id", tenantId)
        .eq("work_date", date)
      if (error) {
        // 表還沒建（正式庫尚未套 0050）不該讓首頁整頁壞掉。
        console.warn(`[duty-rosters] today unavailable: ${error.message}`)
        res.status(200).json({ date, duty: null, reception: null })
        return
      }
      const rows = (data ?? []) as Array<{ duty_type: string; employee_id: string }>
      const names = await namesOf(tenantId, rows.map((r) => r.employee_id))
      const pick = (type: string) => {
        const row = rows.find((r) => r.duty_type === type)
        if (!row) return null
        return { employeeId: row.employee_id, name: names.get(row.employee_id) ?? null }
      }
      res.status(200).json({ date, duty: pick("duty"), reception: pick("reception") })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /duty-rosters?from=&to=&dutyType= — 區間排班（HR；月曆格用）。 */
dutyRostersRouter.get(
  "/duty-rosters",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const from = typeof req.query.from === "string" ? req.query.from : ""
    const to = typeof req.query.to === "string" ? req.query.to : ""
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      res.status(400).json({ error: "from_to_required" })
      return
    }
    try {
      let query = supabaseAdmin
        .from("duty_rosters")
        .select(COLS)
        .eq("tenant_id", tenantId)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: true })
      const dutyType = typeof req.query.dutyType === "string" ? req.query.dutyType : null
      if (dutyType && (DUTY_TYPES as readonly string[]).includes(dutyType)) {
        query = query.eq("duty_type", dutyType)
      }
      const { data, error } = await query
      if (error) {
        next(new Error(`GET /duty-rosters: ${error.message}`))
        return
      }
      const rows = (data ?? []) as RosterRow[]
      const names = await namesOf(tenantId, rows.map((r) => r.employee_id))
      res.status(200).json({
        from,
        to,
        rosters: rows.map((r) => ({ ...r, employeeName: names.get(r.employee_id) ?? null })),
      })
    } catch (err) {
      next(err)
    }
  },
)

/** PATCH /duty-rosters/:id — 換人／改備註（HR）。 */
dutyRostersRouter.patch(
  "/duty-rosters/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success || (parsed.data.employeeId === undefined && parsed.data.note === undefined)) {
      res.status(400).json({ error: "invalid_body" })
      return
    }
    try {
      if (parsed.data.employeeId) {
        const { data: emp, error: empErr } = await supabaseAdmin
          .from("employees")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.data.employeeId)
          .maybeSingle()
        if (empErr) {
          next(new Error(`PATCH /duty-rosters/${id} (employee): ${empErr.message}`))
          return
        }
        if (!emp) {
          res.status(404).json({ error: "employee_not_found" })
          return
        }
      }

      const patch: Record<string, unknown> = {}
      if (parsed.data.employeeId !== undefined) patch.employee_id = parsed.data.employeeId
      if (parsed.data.note !== undefined) patch.note = parsed.data.note

      const { data, error } = await supabaseAdmin
        .from("duty_rosters")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select(COLS)
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /duty-rosters/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const row = data as RosterRow
      const names = await namesOf(tenantId, [row.employee_id])
      res.status(200).json({ roster: { ...row, employeeName: names.get(row.employee_id) ?? null } })
    } catch (err) {
      next(err)
    }
  },
)

/** DELETE /duty-rosters/:id — 清掉某一天（排班表可刪，本表不掛 no_hard_delete）。 */
dutyRostersRouter.delete(
  "/duty-rosters/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    try {
      const { data, error } = await supabaseAdmin
        .from("duty_rosters")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`DELETE /duty-rosters/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id })
    } catch (err) {
      next(err)
    }
  },
)
