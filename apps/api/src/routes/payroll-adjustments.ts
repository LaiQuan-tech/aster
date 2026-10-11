import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { PERIOD_RE, assertPeriodOpen, getPeriodLockState } from "../services/period-lock.js"
import {
  ADJUSTMENT_COLS,
  employeeAdjustmentNotes,
  loadAdjustmentsByEmployee,
  payslipAdjustStates,
  periodPayslipStates,
  toAdjustmentView,
  type AdjustmentRow,
  type AdjustmentView,
  type PayslipAdjustState,
} from "../services/payroll-adjustments.js"

/**
 * 薪資一次性加減項（前期更正；2026-10-11）——HR 專用（requireHrAdmin）。
 *
 * 已匯款的月份不改原薪資單，改在下月薪資補發或扣回：對某位員工、某一期（`period`＝放進哪一期的薪資單）加一行有說明的
 * 加減項（名稱、帶正負號的金額、是否課稅、更正的是哪個月）。薪資執行（POST /payroll/run）時併進該期薪資單：
 *   • 課稅的補發 → 進應發（併入扣繳基礎）  • 不課稅的補發 → 只加在實發  • 扣回 → 進應扣、只減實發（不減 gross，保守）
 * 引擎規則與稅務處理見 packages/rules/src/payroll-engine.ts 檔頭；資料表 packages/db/sql/0055_payroll_adjustments.sql。
 *
 *   GET    /payroll-adjustments?period=YYYY-MM&employeeId=&relatedPeriod=   依月份、依人或依「更正的是哪個月」（至少帶一個）；
 *                                                            每筆附該期薪資單狀態 `payslip: { status: draft|finalized|null, stale }`；
 *                                                            帶 period 時另回 `periodState`、`staleEmployees`（草稿沒跟上加減項的員工，
 *                                                            含加減項已全刪光但草稿還內嵌舊的那種）；`employeeNotes` 是範圍外員工的提醒
 *                                                            （沒有薪資結構＝薪資執行不會產生他的薪資單；已離職／停用＝月結檢查不含他）
 *   POST   /payroll-adjustments                              新增 { employeeId, period, label, amount, taxable?, relatedPeriod?, note? }
 *   PATCH  /payroll-adjustments/:id                          修改 label／amount／taxable／relatedPeriod／note（員工與期別不能改，要換就刪掉重建）
 *   DELETE /payroll-adjustments/:id                          軟刪除（deleted_at；薪資執行與列表都排除）
 *
 * 新增／修改／刪除的限制（一律 409）：
 *   • 該月已發薪鎖定 → `{ error: "period_closed", period }`（services/period-lock.ts；要改先由老闆或老闆指定的人重新開放）
 *   • 該員工該期的薪資單已定稿 → `{ error: "payslip_finalized", period }`（定稿的薪資單不再改；要更正請加在下個月）
 * 非 HR → 403。每次異動寫 audit（DB trigger 之外，應用層補「為什麼」）。
 *
 * ## 草稿薪資單不會自己跟上
 * 薪資單是 POST /payroll/run 算出來存著的草稿，新增／修改／刪除加減項之後要**重新執行薪資作業**才會反映。
 * 回應的 `payslip.stale: true` 就是在提醒這件事；而且草稿過期（stale）時定稿會被擋（409 `adjustments_stale`，routes/payroll.ts），
 * 不會有「補發漏進薪資單、卻已經定稿」的情況（針對有薪資單、在薪資執行範圍內的員工；見 `employeeNotes`）。
 *
 * ## 與定稿同時發生
 * 「檢查有沒有定稿」和「寫入」之間可能剛好有人按了定稿。所以寫入**之後**再查一次：若這時已定稿，把剛才的寫入還原
 * （新增→軟刪除、修改→改回原值、刪除→恢復）並回 409 `payslip_finalized`；定稿那邊（routes/payroll.ts）也在更新之後
 * 再比對一次加減項，不一致就退回草稿——兩邊至少有一邊會發現。
 */
export const payrollAdjustmentsRouter = Router()

/** numeric(12,2) 放得下，但沒有薪資單會有上億的加減項——多打幾個 0 的筆誤在這裡擋。 */
const MAX_ABS_AMOUNT = 99_999_999.99

const periodSchema = z.string().regex(PERIOD_RE, "must be YYYY-MM")
const labelSchema = z
  .string()
  .trim()
  .min(1, "label is required")
  .refine((value) => [...value].length <= 100, "label 最多 100 字")
const amountSchema = z
  .number()
  .finite()
  .refine((n) => n !== 0, "amount 不可為 0")
  .refine((n) => Math.abs(n) <= MAX_ABS_AMOUNT, "amount 超出範圍")
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "amount 最多兩位小數")
const noteSchema = z.string().trim().max(500)

const listQuerySchema = z
  .object({
    period: periodSchema.optional(),
    employeeId: z.string().uuid().optional(),
    /** 更正的是哪個月：重新開放某月時用來看「這個月已經在後續月份補發／扣回過哪些」（避免重算後重複入帳）。 */
    relatedPeriod: periodSchema.optional(),
  })
  .refine((q) => q.period !== undefined || q.employeeId !== undefined || q.relatedPeriod !== undefined, {
    message: "period, employeeId or relatedPeriod is required",
  })

const createSchema = z.object({
  employeeId: z.string().uuid(),
  period: periodSchema,
  label: labelSchema,
  amount: amountSchema,
  taxable: z.boolean().optional(),
  relatedPeriod: periodSchema.nullish(),
  note: noteSchema.nullish(),
})

const updateSchema = z
  .object({
    label: labelSchema.optional(),
    amount: amountSchema.optional(),
    taxable: z.boolean().optional(),
    relatedPeriod: periodSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "no fields to update" })

const idParam = z.string().uuid()

/** 更正的月份不能晚於放進的那一期（更正的是「過去」的月份）。 */
function relatedPeriodError(relatedPeriod: string | null | undefined, period: string): string | null {
  return relatedPeriod && relatedPeriod > period ? "relatedPeriod 不能晚於薪資單所屬月份" : null
}

/** 改動這筆加減項被擋的原因：薪資單已定稿。已發薪鎖定由 assertPeriodOpen 丟 PeriodClosedError（全域處理成 409 period_closed）。 */
async function finalizedBlock(tenantId: string, employeeId: string, period: string): Promise<{ error: "payslip_finalized"; period: string; message: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("payslips")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("period", period)
    .eq("status", "finalized")
    .maybeSingle()
  if (error) throw new Error(`payroll-adjustments (finalized check): ${error.message}`)
  return data
    ? { error: "payslip_finalized", period, message: `${period} 的薪資單已定稿，不能再改加減項；如需更正請加在下個月的薪資` }
    : null
}

/** 異動後該員工該期的薪資單狀態（草稿是否已過期）。 */
async function payslipStateAfter(tenantId: string, employeeId: string, period: string): Promise<PayslipAdjustState> {
  const current = await loadAdjustmentsByEmployee(tenantId, period, [employeeId])
  const states = await payslipAdjustStates(tenantId, period, [employeeId], current)
  return states.get(employeeId) ?? { status: null, stale: false }
}

const auditShape = (row: AdjustmentView) => ({
  employee_id: row.employeeId,
  period: row.period,
  label: row.label,
  amount: row.amount,
  taxable: row.taxable,
  related_period: row.relatedPeriod,
  note: row.note,
})

async function callerEmpId(req: Request, tenantId: string): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

// GET /payroll-adjustments?period=&employeeId=
payrollAdjustmentsRouter.get(
  "/payroll-adjustments",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { period, employeeId, relatedPeriod } = parsed.data
    try {
      let query = supabaseAdmin.from("payroll_adjustments").select(ADJUSTMENT_COLS).eq("tenant_id", tenantId).is("deleted_at", null)
      if (period) query = query.eq("period", period)
      if (employeeId) query = query.eq("employee_id", employeeId)
      if (relatedPeriod) query = query.eq("related_period", relatedPeriod)
      const { data, error } = await query
        .order("period", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(1000)
      if (error) {
        next(new Error(`GET /payroll-adjustments: ${error.message}`))
        return
      }
      const views = ((data ?? []) as unknown as AdjustmentRow[]).map(toAdjustmentView)

      // 每筆附上該期薪資單的狀態：一個月份查一次薪資單，現有加減項就是剛查到的這批。
      const byPeriod = new Map<string, AdjustmentView[]>()
      for (const view of views) byPeriod.set(view.period, [...(byPeriod.get(view.period) ?? []), view])
      const stateOf = new Map<string, PayslipAdjustState>()
      let staleEmployees: string[] | undefined
      // 依「更正月份」查的是資訊用途（重新開放某月前看後續月份補發過什麼），結果只是現有加減項的一個子集，
      // 拿來算薪資單有沒有跟上會誤判——這種查詢不附薪資單狀態。
      for (const [p, list] of relatedPeriod ? [] : byPeriod) {
        const current = new Map<string, AdjustmentView[]>()
        for (const v of list) current.set(v.employeeId, [...(current.get(v.employeeId) ?? []), v])
        if (period && !employeeId && p === period) {
          // 只帶月份：這個月的加減項就是全部，連同「加減項已全刪光、草稿卻還內嵌舊的」過期草稿一次查出來。
          const all = await periodPayslipStates(tenantId, p, current)
          staleEmployees = all.staleEmployeeIds
          for (const [id, state] of all.states) stateOf.set(`${p}|${id}`, state)
        } else {
          const states = await payslipAdjustStates(tenantId, p, [...current.keys()], current)
          for (const [id, state] of states) stateOf.set(`${p}|${id}`, state)
        }
      }
      if (period && !employeeId && !relatedPeriod && staleEmployees === undefined) {
        // 這個月完全沒有加減項：仍要看有沒有過期草稿（內嵌著已被刪光的舊加減項）。
        staleEmployees = (await periodPayslipStates(tenantId, period, new Map())).staleEmployeeIds
      }
      const adjustments = views.map((v) => ({ ...v, payslip: stateOf.get(`${v.period}|${v.employeeId}`) ?? { status: null, stale: false } }))

      // 範圍外員工的提醒（沒有薪資結構、已離職／停用），含過期草稿的員工（畫面要列名字）。
      const noteIds = [...new Set([...views.map((v) => v.employeeId), ...(staleEmployees ?? [])])]
      const notes = await employeeAdjustmentNotes(tenantId, noteIds)

      res.status(200).json({
        adjustments,
        employeeNotes: Object.fromEntries(notes),
        ...(period ? { periodState: await getPeriodLockState(tenantId, period) } : {}),
        ...(staleEmployees ? { staleEmployees } : {}),
      })
    } catch (err) {
      next(err)
    }
  },
)

// POST /payroll-adjustments
payrollAdjustmentsRouter.post(
  "/payroll-adjustments",
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
    const body = parsed.data
    const relatedError = relatedPeriodError(body.relatedPeriod, body.period)
    if (relatedError) {
      res.status(400).json({ error: "invalid_related_period", message: relatedError })
      return
    }
    try {
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", body.employeeId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`POST /payroll-adjustments (employee): ${empErr.message}`))
        return
      }
      if (!emp) {
        res.status(400).json({ error: "invalid_employee", employeeIds: [body.employeeId] })
        return
      }
      await assertPeriodOpen(tenantId, body.period)
      const blocked = await finalizedBlock(tenantId, body.employeeId, body.period)
      if (blocked) {
        res.status(409).json(blocked)
        return
      }

      const actorEmpId = await callerEmpId(req, tenantId)
      const { data: created, error } = await supabaseAdmin
        .from("payroll_adjustments")
        .insert({
          tenant_id: tenantId,
          employee_id: body.employeeId,
          period: body.period,
          label: body.label,
          amount: body.amount,
          taxable: body.taxable ?? true,
          related_period: body.relatedPeriod ?? null,
          note: body.note ? body.note : null,
          created_by_emp_id: actorEmpId,
        })
        .select(ADJUSTMENT_COLS)
        .single()
      if (error || !created) {
        next(new Error(`POST /payroll-adjustments: ${error?.message}`))
        return
      }
      const view = toAdjustmentView(created as unknown as AdjustmentRow)
      // 寫入之後再查一次：剛好在檢查與寫入之間被定稿 → 把這筆還原（軟刪除）並回 409（見檔頭「與定稿同時發生」）。
      const lateBlock = await finalizedBlock(tenantId, view.employeeId, view.period)
      if (lateBlock) {
        const now = new Date().toISOString()
        await supabaseAdmin.from("payroll_adjustments").update({ deleted_at: now, updated_at: now }).eq("tenant_id", tenantId).eq("id", view.id)
        res.status(409).json(lateBlock)
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "payroll_adjustments",
        recordId: view.id,
        action: "INSERT",
        newRow: auditShape(view),
        actorEmpId,
        context: "POST /payroll-adjustments — 新增薪資加減項（前期更正）",
      })
      const warnings = (await employeeAdjustmentNotes(tenantId, [view.employeeId])).get(view.employeeId) ?? []
      res.status(201).json({
        adjustment: view,
        payslip: await payslipStateAfter(tenantId, view.employeeId, view.period),
        ...(warnings.length > 0 ? { warnings } : {}),
      })
    } catch (err) {
      next(err)
    }
  },
)

// PATCH /payroll-adjustments/:id
payrollAdjustmentsRouter.patch(
  "/payroll-adjustments/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = idParam.safeParse(req.params.id)
    if (!id.success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data
    try {
      const { data: existing, error: loadErr } = await supabaseAdmin
        .from("payroll_adjustments")
        .select(ADJUSTMENT_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", id.data)
        .is("deleted_at", null)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`PATCH /payroll-adjustments/${id.data} (load): ${loadErr.message}`))
        return
      }
      if (!existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const before = toAdjustmentView(existing as unknown as AdjustmentRow)
      const relatedError = relatedPeriodError(body.relatedPeriod, before.period)
      if (relatedError) {
        res.status(400).json({ error: "invalid_related_period", message: relatedError })
        return
      }
      await assertPeriodOpen(tenantId, before.period)
      const blocked = await finalizedBlock(tenantId, before.employeeId, before.period)
      if (blocked) {
        res.status(409).json(blocked)
        return
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (body.label !== undefined) patch.label = body.label
      if (body.amount !== undefined) patch.amount = body.amount
      if (body.taxable !== undefined) patch.taxable = body.taxable
      if (body.relatedPeriod !== undefined) patch.related_period = body.relatedPeriod
      if (body.note !== undefined) patch.note = body.note ? body.note : null
      const { data: updated, error } = await supabaseAdmin
        .from("payroll_adjustments")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", before.id)
        .is("deleted_at", null)
        .select(ADJUSTMENT_COLS)
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /payroll-adjustments/${before.id}: ${error.message}`))
        return
      }
      if (!updated) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const view = toAdjustmentView(updated as unknown as AdjustmentRow)
      const lateBlock = await finalizedBlock(tenantId, view.employeeId, view.period)
      if (lateBlock) {
        // 剛好被定稿：改回原值，薪資單才不會和加減項對不起來。
        await supabaseAdmin
          .from("payroll_adjustments")
          .update({
            label: before.label,
            amount: before.amount,
            taxable: before.taxable,
            related_period: before.relatedPeriod,
            note: before.note,
            updated_at: new Date().toISOString(),
          })
          .eq("tenant_id", tenantId)
          .eq("id", view.id)
        res.status(409).json(lateBlock)
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "payroll_adjustments",
        recordId: view.id,
        action: "UPDATE",
        oldRow: auditShape(before),
        newRow: auditShape(view),
        actorEmpId: await callerEmpId(req, tenantId),
        context: "PATCH /payroll-adjustments/:id — 修改薪資加減項",
      })
      res.status(200).json({ adjustment: view, payslip: await payslipStateAfter(tenantId, view.employeeId, view.period) })
    } catch (err) {
      next(err)
    }
  },
)

// DELETE /payroll-adjustments/:id — 軟刪除
payrollAdjustmentsRouter.delete(
  "/payroll-adjustments/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = idParam.safeParse(req.params.id)
    if (!id.success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      const { data: existing, error: loadErr } = await supabaseAdmin
        .from("payroll_adjustments")
        .select(ADJUSTMENT_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", id.data)
        .is("deleted_at", null)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`DELETE /payroll-adjustments/${id.data} (load): ${loadErr.message}`))
        return
      }
      if (!existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const before = toAdjustmentView(existing as unknown as AdjustmentRow)
      await assertPeriodOpen(tenantId, before.period)
      const blocked = await finalizedBlock(tenantId, before.employeeId, before.period)
      if (blocked) {
        res.status(409).json(blocked)
        return
      }

      const now = new Date().toISOString()
      const { data: removed, error } = await supabaseAdmin
        .from("payroll_adjustments")
        .update({ deleted_at: now, updated_at: now })
        .eq("tenant_id", tenantId)
        .eq("id", before.id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`DELETE /payroll-adjustments/${before.id}: ${error.message}`))
        return
      }
      if (!removed) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const lateBlock = await finalizedBlock(tenantId, before.employeeId, before.period)
      if (lateBlock) {
        // 剛好被定稿：恢復這筆。
        await supabaseAdmin.from("payroll_adjustments").update({ deleted_at: null, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", before.id)
        res.status(409).json(lateBlock)
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "payroll_adjustments",
        recordId: before.id,
        action: "DELETE",
        oldRow: auditShape(before),
        actorEmpId: await callerEmpId(req, tenantId),
        context: "DELETE /payroll-adjustments/:id — 刪除薪資加減項（軟刪除）",
      })
      res.status(200).json({ id: before.id, deleted: true, payslip: await payslipStateAfter(tenantId, before.employeeId, before.period) })
    } catch (err) {
      next(err)
    }
  },
)
