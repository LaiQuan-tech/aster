import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import {
  activeFixedAllowancesForPeriod,
  insurableFixedAllowanceTotal,
  resolvePensionWage,
  resolvePensionWageLevels,
  sameNameOverlaps,
} from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { columnsExist, isMissingTableError } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { writeAuditLog } from "../services/audit.js"
import { loadRuleConfigFor, salarySelectCols, toSalaryStructure, type SalaryRow } from "../services/payroll-inputs.js"
import {
  fixedAllowanceSelectCols,
  OVERTIME_BASE_COL,
  loadFixedAllowanceRows,
  staleDraftPayslipsSafe,
  toFixedAllowanceView,
  type FixedAllowanceRow,
  type FixedAllowanceView,
} from "../services/fixed-allowances.js"

/**
 * 員工固定津貼（2026-11-08）——HR 專用（requireHrAdmin，與 /salary/:employeeId 同一層權限），tenant 隔離。
 *
 *   GET    /salary/:employeeId/fixed-allowances   該員工的所有（未刪除）津貼 ＋ `summary`（今天所屬月份有效的合計、計入投保合計）
 *   POST   /salary/:employeeId/fixed-allowances   新增 { name, amount, insurable?, taxType?, effectiveFrom, effectiveTo?, note? }
 *   PATCH  /fixed-allowances/:id                  修改上述任一欄（員工不能改，要換人就刪掉重建）
 *   DELETE /fixed-allowances/:id                  軟刪除（deleted_at；薪資執行與列表都排除）
 *
 * 金額：整數元、0–9,999,999。taxType：taxable 應稅／meal_exempt 伙食費（每月合計在免稅額內免稅——規則參數，預設 3,000——超過應稅）。
 * insurable：是否計入投保薪資——勞健保級距**不自動改**（只提示，見 insuredSalaryReview）；勞退月提繳工資留空時，自動計算會含這筆。
 *
 * 回應附帶的提醒（2026-11-08 第二輪）：
 *   • warnings：[{ code: "same_name_overlap", name, months, message }]——同名津貼的有效期間落在同一個月（整月帶入 → 重複給付）
 *   • stalePeriods：這位員工有哪些**草稿**薪資單內嵌的津貼跟現在不一致（要重新執行薪資作業；定案會被擋 409 fixed_allowances_stale）
 * GET 另回 summary.pension：勞退月提繳工資自動計算值（本月適用的分級表）、目前手填值、是否適用新制、國籍提示（只建議，不自動判斷）。
 *
 * 已產生的薪資單內嵌當時的津貼明細（payslips.breakdown.fixedAllowances），之後改津貼不會回溯改寫已定案／已結算的薪資單：
 * 薪資執行本來就跳過已定案的薪資單、已結算的月份整批 409 period_closed（routes/payroll.ts）。草稿薪資單要重新執行才會跟上。
 *
 * supabaseAdmin 繞過 RLS，每個查詢的 tenant_id 過濾就是隔離的那一道；別租戶的員工或津貼 id 一律 404。
 * 資料表尚未套用（migration 0086）→ GET 回空清單、寫入回 503 `fixed_allowances_unavailable`。
 */
export const fixedAllowancesRouter = Router()

const TABLE = "employee_fixed_allowances"
const MAX_AMOUNT = 9_999_999

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, "invalid date")
const nameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .refine((v) => [...v].length <= 50, "name 最多 50 字")
const amountSchema = z.number().int("amount 必須是整數元").min(0).max(MAX_AMOUNT)
const taxTypeSchema = z.enum(["taxable", "meal_exempt"])
const noteSchema = z.string().trim().max(500)

const createSchema = z.object({
  name: nameSchema,
  amount: amountSchema,
  insurable: z.boolean().optional(),
  taxType: taxTypeSchema.optional(),
  // 計入加班費時薪基數（月薪制，2026-11-08）；預設 true。
  overtimeBase: z.boolean().optional(),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
  note: noteSchema.nullable().optional(),
})

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    amount: amountSchema.optional(),
    insurable: z.boolean().optional(),
    taxType: taxTypeSchema.optional(),
    overtimeBase: z.boolean().optional(),
    effectiveFrom: dateSchema.optional(),
    effectiveTo: dateSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const uuidSchema = z.string().uuid()

async function callerEmpId(req: Request, tenantId: string): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

/** 員工屬於本租戶？（別租戶的 id 一律當作不存在） */
async function employeeInTenant(tenantId: string, employeeId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`fixed-allowances (employee): ${error.message}`)
  return !!data
}

function datesError(from: string, to: string | null | undefined): string | null {
  if (to && to < from) return "生效迄日不可早於生效起日"
  return null
}

/** 同名津貼同月重疊的提醒（只看這位員工未刪除的列）。 */
function overlapWarnings(rows: FixedAllowanceRow[]) {
  return sameNameOverlaps(rows).map((o) => ({
    code: "same_name_overlap" as const,
    name: o.name,
    ids: o.ids,
    months: o.months,
    message: `「${o.name}」有兩筆在 ${o.months.join("、")} 同時有效：薪資執行是當月整月帶入，這幾個月會重複給付。請調整起迄日（例：舊的迄日設在上個月底）或手動以加減項調整。`,
  }))
}

/** CRUD 之後：同名重疊提醒＋草稿過期的期別。 */
async function afterWrite(tenantId: string, employeeId: string) {
  const rows = await loadFixedAllowanceRows(tenantId, [employeeId])
  // 寫入已成功：過期檢查出錯只記 log、不回 stalePeriods，不可讓請求變 500（staleDraftPayslipsSafe）。
  const stale = await staleDraftPayslipsSafe(tenantId, [employeeId])
  return { warnings: overlapWarnings(rows), stalePeriods: [...new Set(stale.map((s) => s.period))] }
}

const FOREIGN_HINT_RE = /中華民國|臺灣|台灣|taiwan|^roc$|r\.o\.c|^tw$/i

/** 員工薪資資料頁的勞退提示：自動計算的提繳工資、手填值、新制旗標、國籍建議。失敗不擋（回 null）。 */
async function pensionSummary(tenantId: string, employeeId: string, period: string, rows: FixedAllowanceRow[]) {
  try {
    const { rules } = await loadRuleConfigFor(tenantId, period)
    const { data: sal } = await supabaseAdmin
      .from("salary_structures")
      .select(await salarySelectCols())
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .maybeSingle()
    const row = sal as unknown as SalaryRow | null
    const active = activeFixedAllowancesForPeriod(rows, period)
    const structure = row ? toSalaryStructure(row) : {}
    // 時薪／日薪制的自動值要看當月本俸（執行薪資時才知道），這裡算不出來就回 null，畫面說明「依當月本俸自動算」。
    const auto = resolvePensionWage({ ...structure, pensionWage: undefined }, active, rules, period)
    const levels = resolvePensionWageLevels(rules, `${period}-01`)
    let nationality: string | null = null
    const prof = await supabaseAdmin
      .from("employee_profiles")
      .select("nationality")
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .maybeSingle()
    if (!prof.error) nationality = ((prof.data as { nationality?: string | null } | null)?.nationality ?? null) || null
    const foreign = !!nationality && !FOREIGN_HINT_RE.test(nationality.trim())
    return {
      autoWage: auto?.wage ?? null,
      levelsEffectiveFrom: levels.effectiveFrom,
      // 分級表全部級距：畫面判斷手填值「不在分級表級距上」用（非級距值允許，只提醒）。
      levels: levels.levels,
      manualWage: row?.pension_wage != null && Number(row.pension_wage) > 0 ? Number(row.pension_wage) : null,
      newSystem: row?.pension_new_system !== false,
      method: row?.method ?? null,
      nationality,
      nationalityHint: foreign
        ? `國籍為「${nationality}」：外籍員工須取得永久居留（或與本國人結婚取得居留）才適用勞退新制，請確認後再決定是否取消「適用勞退新制」。系統不會自動判斷。`
        : null,
    }
  } catch {
    return null
  }
}

/**
 * migration 0087 未套用時的「計入加班費基數」：沒帶或帶 true → 照常（欄位不存在＝一律計入）；帶 false → 409，
 * 因為存不進去、又不能假裝成功。回傳 null＝可繼續（otColumn 表示欄位存不存在）。
 */
async function overtimeBaseGuard(res: Response, value: boolean | undefined): Promise<{ otColumn: boolean } | null> {
  const otColumn = await columnsExist(TABLE, OVERTIME_BASE_COL)
  if (!otColumn && value === false) {
    res.status(409).json({ error: "migration_required", message: "「計入加班費基數」欄位尚未套用（migration 0087）" })
    return null
  }
  return { otColumn }
}

function auditShape(v: FixedAllowanceView) {
  return {
    employee_id: v.employeeId,
    name: v.name,
    amount: v.amount,
    insurable: v.insurable,
    tax_type: v.taxType,
    overtime_base: v.overtimeBase,
    effective_from: v.effectiveFrom,
    effective_to: v.effectiveTo,
    note: v.note,
  }
}

// GET /salary/:employeeId/fixed-allowances
fixedAllowancesRouter.get(
  "/salary/:employeeId/fixed-allowances",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    if (!uuidSchema.safeParse(employeeId).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const rows = await loadFixedAllowanceRows(tenantId, [employeeId])
      const period = todayKey(await getTenantTimezone(tenantId)).slice(0, 7)
      const active = activeFixedAllowancesForPeriod(rows, period)
      const stale = await staleDraftPayslipsSafe(tenantId, [employeeId])
      res.status(200).json({
        fixedAllowances: rows.map(toFixedAllowanceView),
        summary: {
          period,
          activeTotal: active.reduce((acc, a) => acc + a.amount, 0),
          activeInsurableTotal: insurableFixedAllowanceTotal(active),
          pension: await pensionSummary(tenantId, employeeId, period, rows),
        },
        warnings: overlapWarnings(rows),
        stalePeriods: [...new Set(stale.map((s) => s.period))],
      })
    } catch (err) {
      next(err)
    }
  },
)

// POST /salary/:employeeId/fixed-allowances
fixedAllowancesRouter.post(
  "/salary/:employeeId/fixed-allowances",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const employeeId = String(req.params.employeeId)
    if (!uuidSchema.safeParse(employeeId).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data
    const dErr = datesError(body.effectiveFrom, body.effectiveTo)
    if (dErr) {
      res.status(400).json({ error: "invalid_dates", message: dErr })
      return
    }
    try {
      if (!(await employeeInTenant(tenantId, employeeId))) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const guard = await overtimeBaseGuard(res, body.overtimeBase)
      if (!guard) return
      const { otColumn } = guard
      const actorEmpId = await callerEmpId(req, tenantId)
      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          name: body.name,
          amount: body.amount,
          insurable: body.insurable ?? true,
          tax_type: body.taxType ?? "taxable",
          ...(body.overtimeBase !== undefined && otColumn ? { overtime_base: body.overtimeBase } : {}),
          effective_from: body.effectiveFrom,
          effective_to: body.effectiveTo ?? null,
          note: body.note ? body.note : null,
          created_by_emp_id: actorEmpId,
        })
        .select(await fixedAllowanceSelectCols())
        .single()
      if (error || !data) {
        if (isMissingTableError(error)) {
          res.status(503).json({ error: "fixed_allowances_unavailable", message: "固定津貼資料表尚未套用（migration 0086）" })
          return
        }
        next(new Error(`POST /salary/${employeeId}/fixed-allowances: ${error?.message}`))
        return
      }
      const view = toFixedAllowanceView(data as unknown as FixedAllowanceRow)
      await writeAuditLog({
        tenantId,
        tableName: TABLE,
        recordId: view.id,
        action: "INSERT",
        newRow: auditShape(view),
        actorEmpId,
        context: "POST /salary/:employeeId/fixed-allowances — 新增員工固定津貼",
      })
      res.status(201).json({ fixedAllowance: view, ...(await afterWrite(tenantId, employeeId)) })
    } catch (err) {
      next(err)
    }
  },
)

/** 本租戶、未刪除的那一筆；找不到（含別租戶）回 null。 */
async function loadOne(tenantId: string, id: string): Promise<FixedAllowanceRow | null | "missing_table"> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(await fixedAllowanceSelectCols())
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return "missing_table"
    throw new Error(`fixed-allowances (load ${id}): ${error.message}`)
  }
  return (data as unknown as FixedAllowanceRow | null) ?? null
}

// PATCH /fixed-allowances/:id
fixedAllowancesRouter.patch(
  "/fixed-allowances/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidSchema.safeParse(id).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const body = parsed.data
    try {
      const existing = await loadOne(tenantId, id)
      if (existing === "missing_table" || !existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const before = toFixedAllowanceView(existing)
      const from = body.effectiveFrom ?? before.effectiveFrom
      const to = body.effectiveTo !== undefined ? body.effectiveTo : before.effectiveTo
      const dErr = datesError(from, to)
      if (dErr) {
        res.status(400).json({ error: "invalid_dates", message: dErr })
        return
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (body.name !== undefined) patch.name = body.name
      if (body.amount !== undefined) patch.amount = body.amount
      if (body.insurable !== undefined) patch.insurable = body.insurable
      if (body.taxType !== undefined) patch.tax_type = body.taxType
      if (body.overtimeBase !== undefined) {
        const guard = await overtimeBaseGuard(res, body.overtimeBase)
        if (!guard) return
        if (guard.otColumn) patch.overtime_base = body.overtimeBase
      }
      if (body.effectiveFrom !== undefined) patch.effective_from = body.effectiveFrom
      if (body.effectiveTo !== undefined) patch.effective_to = body.effectiveTo
      if (body.note !== undefined) patch.note = body.note ? body.note : null

      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select(await fixedAllowanceSelectCols())
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /fixed-allowances/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const view = toFixedAllowanceView(data as unknown as FixedAllowanceRow)
      await writeAuditLog({
        tenantId,
        tableName: TABLE,
        recordId: id,
        action: "UPDATE",
        oldRow: auditShape(before),
        newRow: auditShape(view),
        actorEmpId: await callerEmpId(req, tenantId),
        context: "PATCH /fixed-allowances/:id — 修改員工固定津貼",
      })
      res.status(200).json({ fixedAllowance: view, ...(await afterWrite(tenantId, view.employeeId)) })
    } catch (err) {
      next(err)
    }
  },
)

// DELETE /fixed-allowances/:id（軟刪除）
fixedAllowancesRouter.delete(
  "/fixed-allowances/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = String(req.params.id)
    if (!uuidSchema.safeParse(id).success) {
      res.status(404).json({ error: "not_found" })
      return
    }
    try {
      const existing = await loadOne(tenantId, id)
      if (existing === "missing_table" || !existing) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const now = new Date().toISOString()
      const { error } = await supabaseAdmin
        .from(TABLE)
        .update({ deleted_at: now, updated_at: now })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
      if (error) {
        next(new Error(`DELETE /fixed-allowances/${id}: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: TABLE,
        recordId: id,
        action: "DELETE",
        oldRow: auditShape(toFixedAllowanceView(existing)),
        actorEmpId: await callerEmpId(req, tenantId),
        context: "DELETE /fixed-allowances/:id — 刪除員工固定津貼（軟刪除）",
      })
      res.status(200).json({ ok: true, ...(await afterWrite(tenantId, existing.employee_id)) })
    } catch (err) {
      next(err)
    }
  },
)
