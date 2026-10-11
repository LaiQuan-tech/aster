import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { lunchFitsShift } from "@hr/rules"

export const shiftsRouter = Router()

// "HH:MM" 24-hour clock (00:00–23:59).
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 午休開始（shifts.break_start，2026-10-11）：'HH:MM' 或 null／空字串（＝清掉，改由規則推：
 * 涵蓋 12:00 的班別用 12:00，其他沿用舊推算——見 @hr/rules lunch-window）。格式與 DB 的
 * shifts_break_start_fmt_chk 相同。
 */
const breakStartSchema = z.union([
  z.literal("").transform(() => null),
  z.string().regex(timeRe, "breakStart must be HH:MM"),
  z.null(),
])

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  startTime: z.string().regex(timeRe, "startTime must be HH:MM"),
  endTime: z.string().regex(timeRe, "endTime must be HH:MM"),
  breakMinutes: z.number().int().min(0).optional(),
  breakStart: breakStartSchema.optional(),
  isNightShift: z.boolean().optional(),
})

// PATCH allows any subset; at least one field must be present.
const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    startTime: z.string().regex(timeRe, "startTime must be HH:MM").optional(),
    endTime: z.string().regex(timeRe, "endTime must be HH:MM").optional(),
    breakMinutes: z.number().int().min(0).optional(),
    breakStart: breakStartSchema.optional(),
    isNightShift: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const SHIFT_COLS = "id, tenant_id, name, start_time, end_time, break_minutes, break_start, is_night_shift, created_at"
const SHIFT_COLS_LEGACY = "id, tenant_id, name, start_time, end_time, break_minutes, is_night_shift, created_at"

/** 明設的午休要整段落在上班時間內（不然結算會扣不到、或扣到班外）；沒設 → 不檢查。 */
function breakOutsideShift(shift: { start: string; end: string; breakMinutes: number; breakStart: string | null }): boolean {
  return shift.breakStart != null && !lunchFitsShift(shift)
}

const BREAK_OUTSIDE_SHIFT = {
  error: "invalid_body",
  details: { formErrors: [], fieldErrors: { breakStart: ["午休要整段落在上班時間內"] } },
} as const

/** 舊庫還沒有 shifts.break_start（migration 0060）卻要設午休開始 → 明確告知，不回 500。 */
const BREAK_START_NOT_MIGRATED = { error: "schema_not_migrated", column: "shifts.break_start" } as const

/**
 * 寫入 shifts；舊庫缺 break_start 欄位（PGRST204）時：要寫的值是 null（＝沒設）就拿掉這欄
 * 重試一次（班別頁永遠會帶 breakStart，舊庫也要能新增／編輯）；有值 → 回 null 由呼叫端回 503。
 */
async function writeShift<T>(
  payload: Record<string, unknown>,
  run: (row: Record<string, unknown>) => PromiseLike<{ data: T | null; error: { code?: string | null; message: string } | null }>,
  /** 拿掉 break_start 後沒有欄位可寫（PATCH 只送了 breakStart:null）時改跑這個（例：確認列存在）。 */
  onEmpty?: () => PromiseLike<{ data: T | null; error: { code?: string | null; message: string } | null }>,
): Promise<{ data: T | null; error: { code?: string | null; message: string } | null; notMigrated: boolean }> {
  const first = await run(payload)
  if (!first.error || !isMissingColumnError(first.error) || !("break_start" in payload)) {
    return { ...first, notMigrated: false }
  }
  warnSchemaGapOnce("shifts.break_start", first.error)
  if (payload.break_start != null) return { data: null, error: null, notMigrated: true }
  const { break_start: _dropped, ...rest } = payload
  if (Object.keys(rest).length === 0 && onEmpty) return { ...(await onEmpty()), notMigrated: false }
  return { ...(await run(rest)), notMigrated: false }
}

/**
 * Shift WRITE routes are HR-admin-only and tenant-scoped. As with departments,
 * the tenant boundary is the load-bearing guard: every query is forced to
 * res.locals.tenantId (from the JWT) so an HR admin can only ever touch their
 * own tenant's shifts, even though supabaseAdmin bypasses RLS.
 */

// GET /shifts — list this tenant's shifts. Readable by ANY tenant member
// (matches the shifts_tenant_read RLS policy): the ESS leave form reads the
// default shift (個人班表 was removed 2026-10-11).
shiftsRouter.get(
  "/shifts",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const list = (cols: string) =>
        supabaseAdmin.from("shifts").select(cols).eq("tenant_id", tenantId).order("created_at", { ascending: true })
      let { data, error } = await list(SHIFT_COLS)
      if (error && isMissingColumnError(error)) {
        // 舊庫還沒有 shifts.break_start（migration 0060）→ 不回這欄（前端當作沒設）。
        warnSchemaGapOnce("shifts.break_start", error)
        ;({ data, error } = await list(SHIFT_COLS_LEGACY))
      }

      if (error) {
        next(new Error(`GET /shifts: ${error.message}`))
        return
      }
      res.status(200).json({ shifts: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// POST /shifts — create a shift under this tenant.
shiftsRouter.post(
  "/shifts",
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
    const breakStart = parsed.data.breakStart ?? null
    if (
      breakOutsideShift({
        start: parsed.data.startTime,
        end: parsed.data.endTime,
        breakMinutes: parsed.data.breakMinutes ?? 0,
        breakStart,
      })
    ) {
      res.status(400).json(BREAK_OUTSIDE_SHIFT)
      return
    }
    try {
      const { data, error, notMigrated } = await writeShift<{ id: string }>(
        {
          tenant_id: tenantId,
          name: parsed.data.name,
          start_time: parsed.data.startTime,
          end_time: parsed.data.endTime,
          break_minutes: parsed.data.breakMinutes ?? 0,
          // 沒帶就不寫這欄。
          ...(parsed.data.breakStart !== undefined ? { break_start: breakStart } : {}),
          is_night_shift: parsed.data.isNightShift ?? false,
        },
        (row) => supabaseAdmin.from("shifts").insert(row).select("id").single(),
      )
      if (notMigrated) {
        res.status(503).json(BREAK_START_NOT_MIGRATED)
        return
      }

      if (error || !data) {
        next(new Error(`POST /shifts: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /shifts/:id — update fields (this tenant only). 404 when not in tenant.
shiftsRouter.patch(
  "/shifts/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const patch: Record<string, unknown> = {}
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.startTime !== undefined) patch.start_time = parsed.data.startTime
    if (parsed.data.endTime !== undefined) patch.end_time = parsed.data.endTime
    if (parsed.data.breakMinutes !== undefined) patch.break_minutes = parsed.data.breakMinutes
    if (parsed.data.breakStart !== undefined) patch.break_start = parsed.data.breakStart
    if (parsed.data.isNightShift !== undefined) patch.is_night_shift = parsed.data.isNightShift

    try {
      // 動到時段／休息／午休 → 與現有值合併後檢查午休仍在班內（只改名稱或夜班旗標不必查）。
      const touchesTiming =
        parsed.data.startTime !== undefined ||
        parsed.data.endTime !== undefined ||
        parsed.data.breakMinutes !== undefined ||
        parsed.data.breakStart !== undefined
      if (touchesTiming) {
        const current = await supabaseAdmin
          .from("shifts")
          .select(SHIFT_COLS)
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .maybeSingle()
        if (current.error && !isMissingColumnError(current.error)) {
          next(new Error(`PATCH /shifts/${id} (load): ${current.error.message}`))
          return
        }
        const row = (current.data ?? null) as {
          start_time: string
          end_time: string
          break_minutes: number | null
          break_start?: string | null
        } | null
        if (!current.error && !row) {
          res.status(404).json({ error: "not_found" })
          return
        }
        if (row) {
          const merged = {
            start: parsed.data.startTime ?? row.start_time,
            end: parsed.data.endTime ?? row.end_time,
            breakMinutes: parsed.data.breakMinutes ?? row.break_minutes ?? 0,
            breakStart: parsed.data.breakStart !== undefined ? parsed.data.breakStart : (row.break_start ?? null),
          }
          if (breakOutsideShift(merged)) {
            res.status(400).json(BREAK_OUTSIDE_SHIFT)
            return
          }
        }
      }

      const { data, error, notMigrated } = await writeShift<{ id: string }>(
        patch,
        (row) => supabaseAdmin.from("shifts").update(row).eq("tenant_id", tenantId).eq("id", id).select("id").maybeSingle(),
        // 舊庫只送 breakStart:null（＝本來就沒設）→ 沒有東西要改，確認班別存在就回 200。
        () => supabaseAdmin.from("shifts").select("id").eq("tenant_id", tenantId).eq("id", id).maybeSingle(),
      )
      if (notMigrated) {
        res.status(503).json(BREAK_START_NOT_MIGRATED)
        return
      }

      if (error) {
        next(new Error(`PATCH /shifts/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// DELETE /shifts/:id — remove a shift (this tenant only). Any schedules that
// referenced it keep their row with shift_id set to NULL (the FK is ON DELETE
// no action, so we null out references first to avoid a constraint violation).
shiftsRouter.delete(
  "/shifts/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { id } = req.params
    try {
      // Detach any schedules pointing at this shift (within the tenant) so the
      // delete cannot fail on the shift_id FK.
      const { error: detachErr } = await supabaseAdmin
        .from("schedules")
        .update({ shift_id: null })
        .eq("tenant_id", tenantId)
        .eq("shift_id", id)
      if (detachErr) {
        next(new Error(`DELETE /shifts/${id} (detach): ${detachErr.message}`))
        return
      }

      const { data, error } = await supabaseAdmin
        .from("shifts")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`DELETE /shifts/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
