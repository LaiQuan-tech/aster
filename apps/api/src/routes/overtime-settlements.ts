import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { addDaysKey, monthRangeKeys, todayKey } from "../lib/tz.js"
import { loadRuleConfigFor } from "../services/payroll-inputs.js"
import { capMinutesFor, otMinutesInPeriod } from "../services/overtime-cap.js"
import { resolveOvertimeMonthlyAlertHours } from "@hr/rules"
import {
  overtimeSettlementsFilename,
  overtimeSettlementsWorkbookBuffer,
} from "../lib/xlsx/overtime-settlements.js"

/**
 * 加班超額另計（overtime_settlements；M1，2026-09-22 業主決策 1）。
 *
 * 合法替代版 C 單：出勤月表與薪資單維持合規版——加班費只算到
 * `overtime.monthlyCapHours`（預設 40 小時）為止；超過的分鐘在月表核准時自動落成
 * 本表一列 `source='beyond_cap'`（services/attendance-sheets.ts
 * upsertBeyondCapSettlement），由老闆／HR 以現金、補休或併薪資另行給付。
 *
 *   GET  /my/overtime-cap?period=                  本人（ESS 首頁「本月加班累計」卡）
 *   GET  /overtime-settlements?period=&status=     HR → `{ settlements: [...], totals }`
 *   GET  /overtime-settlements/export.xlsx?period= HR（period 省略＝全部期別）
 *   POST /overtime-settlements                     HR（source='manual' 手動補一筆）
 *   PATCH /overtime-settlements/:id                HR（僅 draft 可改）
 *   POST /overtime-settlements/:id/pay             HR（draft → paid，之後整列凍結）
 *
 * 守門一律 `requireHrAdmin`：這是「另行給付」的帳，只有老闆與 HR 看得到，
 * **會計看不到**（W4 的 accountant 不在名單內，與薪資／獎金同級）。
 * 表尚未遷移（migration 0050 未套）時讀取端回 503 `overtime_settlements_not_migrated`。
 *
 * 回應形狀與 WP7 的後台頁（`/admin/overtime-settlements`，client 在
 * `apps/web/src/lib/cash-payouts-api.ts`）對齊：列一律是 DB 欄位的 snake_case，
 * 另帶 `employee_name`／`emp_no`；單筆端點回 `{ settlement }`。
 */

export const overtimeSettlementsRouter = Router()

const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/
const dateRe = /^\d{4}-\d{2}-\d{2}$/
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SELECT_COLS =
  "id, tenant_id, employee_id, period, source, minutes, amount, channel, status, paid_on, sheet_id, note, created_by_emp_id, paid_by_emp_id, created_at, updated_at"

const CHANNELS = ["cash", "comp_time", "payroll"] as const

const myCapQuery = z.object({ period: z.string().regex(periodRe, "period must be YYYY-MM").optional() })
const listQuery = z.object({
  period: z.string().regex(periodRe, "period must be YYYY-MM").optional(),
  status: z.enum(["draft", "paid"]).optional(),
  employeeId: z.string().uuid().optional(),
})
const exportQuery = z.object({ period: z.string().regex(periodRe, "period must be YYYY-MM").optional() })

const createBody = z.object({
  employeeId: z.string().uuid(),
  period: z.string().regex(periodRe, "period must be YYYY-MM"),
  minutes: z.number().int().min(0),
  amount: z.number().min(0).nullish(),
  channel: z.enum(CHANNELS).optional(),
  note: z.string().trim().max(2000).nullish(),
})

const patchBody = z
  .object({
    minutes: z.number().int().min(0).optional(),
    amount: z.number().min(0).nullish(),
    channel: z.enum(CHANNELS).optional(),
    note: z.string().trim().max(2000).nullish(),
  })
  .refine(
    (b) => b.minutes !== undefined || b.amount !== undefined || b.channel !== undefined || b.note !== undefined,
    "至少要有一個欄位",
  )

const payBody = z.object({
  paidOn: z.string().regex(dateRe, "paidOn must be YYYY-MM-DD").optional(),
  channel: z.enum(CHANNELS).optional(),
  amount: z.number().min(0).nullish(),
})

// ─────────────────────────────────────────────────────────────────────────────
// Row shape / serialisation
// ─────────────────────────────────────────────────────────────────────────────

interface SettlementRow {
  id: string
  tenant_id: string
  employee_id: string
  period: string
  source: string
  minutes: number
  amount: string | number | null
  channel: string
  status: string
  paid_on: string | null
  sheet_id: string | null
  note: string | null
  created_by_emp_id: string | null
  paid_by_emp_id: string | null
  created_at: string
  updated_at: string
}

/**
 * 回應形狀：**DB 欄位原樣 snake_case**，只把 numeric 轉成 number，另外補
 * `employee_name`／`emp_no`（與 WP7 的 `apps/web/src/lib/cash-payouts-api.ts`
 * ＋ `/admin/overtime-settlements` 頁面同一份契約；節慶獎金端點也是這個風格）。
 */
export interface SerializedSettlement {
  id: string
  employee_id: string
  period: string
  source: string
  minutes: number
  amount: number | null
  channel: string
  status: string
  paid_on: string | null
  sheet_id: string | null
  note: string | null
  created_at: string
  updated_at: string
  employee_name: string | null
  emp_no: string | null
}

function serialize(row: SettlementRow, emp?: { name: string; empNo: string | null }): SerializedSettlement {
  return {
    id: row.id,
    employee_id: row.employee_id,
    period: row.period,
    source: row.source,
    minutes: Number(row.minutes) || 0,
    amount: row.amount == null || row.amount === "" ? null : Number(row.amount),
    channel: row.channel,
    status: row.status,
    paid_on: row.paid_on,
    sheet_id: row.sheet_id,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    employee_name: emp?.name ?? null,
    emp_no: emp?.empNo ?? null,
  }
}

/** employee_id → {name, empNo}（清單顯示用；查不到就留 null）。 */
async function loadEmployees(
  tenantId: string,
  ids: string[],
): Promise<Map<string, { name: string; empNo: string | null }>> {
  const map = new Map<string, { name: string; empNo: string | null }>()
  if (ids.length === 0) return map
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name, emp_no")
    .eq("tenant_id", tenantId)
    .in("id", Array.from(new Set(ids)))
  if (error) throw new Error(`overtime-settlements (employees): ${error.message}`)
  for (const e of (data ?? []) as Array<{ id: string; name: string; emp_no: string | null }>) {
    map.set(e.id, { name: e.name, empNo: e.emp_no ?? null })
  }
  return map
}

/** 表未遷移 → 503；其餘丟給 express 的錯誤處理。 */
function notMigrated(err: { code?: string | null; message?: string | null }, res: Response): boolean {
  if (!isMissingTableError(err)) return false
  warnSchemaGapOnce("overtime_settlements", err)
  res.status(503).json({ error: "overtime_settlements_not_migrated" })
  return true
}

function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

async function loadRow(tenantId: string, id: string): Promise<SettlementRow | null> {
  const { data, error } = await supabaseAdmin
    .from("overtime_settlements")
    .select(SELECT_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as SettlementRow | null) ?? null
}

const hrGuards = [requireAuth, requireTenant, requireHrAdmin] as const

// ─────────────────────────────────────────────────────────────────────────────
// GET /my/overtime-cap?period= — 本人本月加班累計 / 上限 / 超額
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ESS 首頁「本月加班累計 X／40 小時」卡的資料來源。
 *   settledMinutes        已結算的加班分鐘（attendance_days.overtime_minutes 當月合計）
 *   approvedRequestMinutes 已核准加班單分鐘（月上限的判準，與送單時的 beyondCapCheck 同源）
 *   pendingRequestMinutes 待簽加班單分鐘（送單時的超額判定會把它併入累計基準；卡片下方小字）
 *   beyondCapMinutes      settled／approved 取大者超過上限的部分（先看到警示，不必等月結；待簽不計）
 *   alertHours            法定警示門檻 [36, 40, 46]，前端決定顏色
 */
overtimeSettlementsRouter.get(
  "/my/overtime-cap",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = myCapQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const tz = await getTenantTimezone(tenantId)
      const period = parsed.data.period ?? todayKey(tz).slice(0, 7)
      const { rules } = await loadRuleConfigFor(tenantId, period)
      const capMinutes = capMinutesFor(rules)
      const { from, to } = monthRangeKeys(period)

      const { data, error } = await supabaseAdmin
        .from("attendance_days")
        .select("overtime_minutes")
        .eq("tenant_id", tenantId)
        .eq("employee_id", self.id)
        .gte("work_date", from)
        .lt("work_date", addDaysKey(to, 1))
      if (error) throw new Error(`overtime-cap (attendance_days): ${error.message}`)
      let settledMinutes = 0
      for (const r of (data ?? []) as Array<{ overtime_minutes: number | null }>) {
        settledMinutes += Number(r.overtime_minutes) || 0
      }

      const otRequests = await otMinutesInPeriod(tenantId, self.id, period, { statuses: ["approved", "pending"] })
      const approvedRequestMinutes = otRequests.approvedMinutes
      const pendingRequestMinutes = otRequests.pendingMinutes
      const usedMinutes = Math.max(settledMinutes, approvedRequestMinutes)
      res.status(200).json({
        period,
        capMinutes,
        settledMinutes,
        approvedRequestMinutes,
        pendingRequestMinutes,
        beyondCapMinutes: Math.max(0, usedMinutes - capMinutes),
        alertHours: [...resolveOvertimeMonthlyAlertHours(rules)],
      })
    } catch (err) {
      next(err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// GET /overtime-settlements/export.xlsx?period= — 必須排在 /:id 之前
// ─────────────────────────────────────────────────────────────────────────────

overtimeSettlementsRouter.get(
  "/overtime-settlements/export.xlsx",
  ...hrGuards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = exportQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const period = parsed.data.period
    try {
      let query = supabaseAdmin
        .from("overtime_settlements")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .order("period", { ascending: false })
        .order("created_at", { ascending: true })
      if (period) query = query.eq("period", period)
      const { data, error } = await query
      if (error) {
        if (notMigrated(error, res)) return
        throw new Error(`overtime-settlements (export): ${error.message}`)
      }
      const rows = (data ?? []) as unknown as SettlementRow[]
      const emps = await loadEmployees(tenantId, rows.map((r) => r.employee_id))
      const serialized = rows.map((r) => serialize(r, emps.get(r.employee_id)))
      const buffer = await overtimeSettlementsWorkbookBuffer(period, serialized)
      sendXlsx(res, buffer, overtimeSettlementsFilename(period))
    } catch (err) {
      next(err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// GET /overtime-settlements?period=&status=&employeeId=
// ─────────────────────────────────────────────────────────────────────────────

overtimeSettlementsRouter.get(
  "/overtime-settlements",
  ...hrGuards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { period, status, employeeId } = parsed.data
    try {
      let query = supabaseAdmin
        .from("overtime_settlements")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .order("period", { ascending: false })
        .order("created_at", { ascending: true })
      if (period) query = query.eq("period", period)
      if (status) query = query.eq("status", status)
      if (employeeId) query = query.eq("employee_id", employeeId)
      const { data, error } = await query
      if (error) {
        if (notMigrated(error, res)) return
        throw new Error(`overtime-settlements (list): ${error.message}`)
      }
      const rows = (data ?? []) as unknown as SettlementRow[]
      const emps = await loadEmployees(tenantId, rows.map((r) => r.employee_id))
      const settlements = rows.map((r) => serialize(r, emps.get(r.employee_id)))
      // `settlements` 是 WP7 頁面唯一會讀的鍵；`totals` 是附加的彙總（可忽略）。
      res.status(200).json({
        settlements,
        totals: {
          count: settlements.length,
          minutes: settlements.reduce((acc, r) => acc + r.minutes, 0),
          amount: settlements.reduce((acc, r) => acc + (r.amount ?? 0), 0),
          draftCount: settlements.filter((r) => r.status === "draft").length,
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// POST /overtime-settlements — HR 手動補一筆（source='manual'）
// ─────────────────────────────────────────────────────────────────────────────

overtimeSettlementsRouter.post(
  "/overtime-settlements",
  ...hrGuards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const parsed = createBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data
    try {
      const self = userId ? await resolveSelf(tenantId, userId) : null
      // 員工必須是同租戶的（FK 只保證存在，不保證同家公司）。
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", body.employeeId)
        .maybeSingle()
      if (empErr) throw new Error(`overtime-settlements (employee): ${empErr.message}`)
      if (!emp) {
        res.status(400).json({ error: "invalid_employee" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("overtime_settlements")
        .insert({
          tenant_id: tenantId,
          employee_id: body.employeeId,
          period: body.period,
          source: "manual",
          minutes: body.minutes,
          amount: body.amount ?? null,
          channel: body.channel ?? "cash",
          status: "draft",
          note: body.note ?? null,
          created_by_emp_id: self?.id ?? null,
        })
        .select(SELECT_COLS)
        .single()
      if (error) {
        if (notMigrated(error, res)) return
        throw new Error(`overtime-settlements (create): ${error.message}`)
      }
      const emps = await loadEmployees(tenantId, [body.employeeId])
      res.status(201).json({ settlement: serialize(data as unknown as SettlementRow, emps.get(body.employeeId)) })
    } catch (err) {
      next(err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /overtime-settlements/:id — 只有 draft 可改
// ─────────────────────────────────────────────────────────────────────────────

overtimeSettlementsRouter.patch(
  "/overtime-settlements/:id",
  ...hrGuards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    if (!uuidRe.test(id)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = patchBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const row = await loadRow(tenantId, id)
      if (!row) {
        res.status(404).json({ error: "not_found" })
        return
      }
      // 已付款＝凍結（DB trigger forbid_paid_row_mutation 也會擋，這裡先給乾淨的 409）。
      if (row.status === "paid") {
        res.status(409).json({ error: "settlement_paid" })
        return
      }
      const patch: Record<string, unknown> = {}
      if (parsed.data.minutes !== undefined) patch.minutes = parsed.data.minutes
      if (parsed.data.amount !== undefined) patch.amount = parsed.data.amount ?? null
      if (parsed.data.channel !== undefined) patch.channel = parsed.data.channel
      if (parsed.data.note !== undefined) patch.note = parsed.data.note ?? null

      const { data, error } = await supabaseAdmin
        .from("overtime_settlements")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select(SELECT_COLS)
        .single()
      if (error) throw new Error(`overtime-settlements (patch): ${error.message}`)
      const emps = await loadEmployees(tenantId, [row.employee_id])
      res.status(200).json({ settlement: serialize(data as unknown as SettlementRow, emps.get(row.employee_id)) })
    } catch (err) {
      if (err && typeof err === "object" && notMigrated(err as { code?: string }, res)) return
      next(err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// POST /overtime-settlements/:id/pay {paidOn?, channel?, amount?}
// ─────────────────────────────────────────────────────────────────────────────

overtimeSettlementsRouter.post(
  "/overtime-settlements/:id/pay",
  ...hrGuards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const id = req.params.id as string
    if (!uuidRe.test(id)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = payBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const row = await loadRow(tenantId, id)
      if (!row) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (row.status === "paid") {
        res.status(409).json({ error: "settlement_paid" })
        return
      }
      const self = userId ? await resolveSelf(tenantId, userId) : null
      const tz = await getTenantTimezone(tenantId)
      const patch: Record<string, unknown> = {
        status: "paid",
        paid_on: parsed.data.paidOn ?? todayKey(tz),
        paid_by_emp_id: self?.id ?? null,
      }
      if (parsed.data.channel !== undefined) patch.channel = parsed.data.channel
      if (parsed.data.amount !== undefined) patch.amount = parsed.data.amount ?? null

      const { data, error } = await supabaseAdmin
        .from("overtime_settlements")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select(SELECT_COLS)
        .single()
      if (error) throw new Error(`overtime-settlements (pay): ${error.message}`)
      const emps = await loadEmployees(tenantId, [row.employee_id])
      res.status(200).json({ settlement: serialize(data as unknown as SettlementRow, emps.get(row.employee_id)) })
    } catch (err) {
      if (err && typeof err === "object" && notMigrated(err as { code?: string }, res)) return
      next(err)
    }
  },
)
