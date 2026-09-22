import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import {
  PENSION_VOLUNTARY_RATE_MAX,
  bracketFor,
  resolveInsuranceBrackets,
  type InsuranceBracketSet,
} from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { logger } from "../lib/logger.js"
import { loadRuleConfigFor } from "../services/payroll-inputs.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"

export const salaryRouter = Router()

/* ── M12 勞健保級距自動選（2026-09-23）────────────────────────────────
 * HR 存薪資時**沒填**投保薪資，而規則有 `insurance.brackets`（含生效日）→ 以
 * 「投保基數」自動選級距寫入，並把選到的值回給前端顯示（`insuredSuggested`）。
 * 基數：月薪制＝本薪；時薪制＝時薪 × 每週約定時數 × 52 ÷ 12（把週薪年化再攤回月）。
 * 明示帶了 `laborInsuredSalary`／`healthInsuredSalary`（含帶 null 清空）就完全不碰，
 * 老闆／HR 的手動覆寫永遠優先。
 */

/** 計薪方式＋薪資欄位 → 投保基數（月）；資料不足回 null（＝不自動選）。 */
export function insuredBaseFor(s: {
  method?: string | null
  baseSalary?: number | null
  hourlyWage?: number | null
  agreedHoursPerWeek?: number | null
}): number | null {
  if (s.method === "hourly") {
    const wage = s.hourlyWage ?? 0
    const hours = s.agreedHoursPerWeek ?? 0
    if (wage <= 0 || hours <= 0) return null
    return Math.round((wage * hours * 52) / 12)
  }
  const base = s.baseSalary ?? 0
  return base > 0 ? base : null
}

export interface InsuredSuggestion {
  /** 投保基數（月）。 */
  base: number
  /** 勞保級距（空清單／無級距表 → null）。 */
  labor: number | null
  /** 健保級距。 */
  health: number | null
  /** 採用的級距表生效日。 */
  effectiveFrom: string
}

/** 純函式：基數 ＋ 某日適用的級距表 → 勞／健保級距。 */
export function suggestInsured(base: number, set: InsuranceBracketSet): InsuredSuggestion {
  return {
    base,
    labor: bracketFor(base, set.labor),
    health: bracketFor(base, set.health),
    effectiveFrom: set.effectiveFrom,
  }
}

/** PostgREST 的 numeric 欄位回字串；空值一律 null。 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const x = typeof v === "number" ? v : Number(v)
  return Number.isFinite(x) ? x : null
}

const SELECT_COLS =
  "id, tenant_id, employee_id, method, base_salary, daily_wage, hourly_wage, allowances, labor_insured_salary, health_insured_salary, pension_voluntary_rate, agreed_hours_per_week, agreed_days_per_week, created_at"

// Numeric columns are returned by PostgREST as strings; the client coerces.
const upsertSchema = z
  .object({
    method: z.enum(["monthly", "by_attendance_days", "hourly"]).optional(),
    baseSalary: z.number().nullable().optional(),
    dailyWage: z.number().nullable().optional(),
    hourlyWage: z.number().optional(),
    allowances: z.record(z.unknown()).optional(),
    laborInsuredSalary: z.number().nullable().optional(),
    healthInsuredSalary: z.number().nullable().optional(),
    // 勞退自提比例 (0–0.06)，以比例而非百分比儲存，與引擎 SalaryStructure 一致。
    pensionVoluntaryRate: z
      .number()
      .min(0)
      .max(PENSION_VOLUNTARY_RATE_MAX)
      .nullable()
      .optional(),
    // 工讀生時薪制(C5)的約定每週工時／工天數；可空，無關聯限制(不要求兩者同填)。
    agreedHoursPerWeek: z.number().nonnegative().nullable().optional(),
    agreedDaysPerWeek: z.number().nonnegative().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })
  // C5：時薪制的本俸基準就是 hourlyWage，引擎對 hourlyWage<=0 直接丟錯（不猜）。
  // 在 API 層就擋：改成 hourly 的那次 PUT 必須同時帶 >0 的時薪，否則存進去的是
  // 一個結算時必炸的設定。錯誤碼由 handler 轉成 400 hourly_wage_required。
  .refine((b) => b.method !== "hourly" || (typeof b.hourlyWage === "number" && b.hourlyWage > 0), {
    message: "hourly_wage_required",
    path: ["hourlyWage"],
  })

/**
 * Salary structures are HR-admin-only and tenant-scoped. The tenant filter on
 * every query is the load-bearing guard (supabaseAdmin bypasses RLS), so an HR
 * admin can only ever read/write salaries inside their own tenant. The
 * employeeId is taken from the path and always written under THIS tenant_id, so
 * a cross-tenant id cannot leak another tenant's data.
 */

// GET /salary/:employeeId — this tenant's structure for the employee, or 404.
salaryRouter.get(
  "/salary/:employeeId",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { employeeId } = req.params
    try {
      const { data, error } = await supabaseAdmin
        .from("salary_structures")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .maybeSingle()

      if (error) {
        next(new Error(`GET /salary/${employeeId}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ salary: data })
    } catch (err) {
      next(err)
    }
  },
)

// PUT /salary/:employeeId — upsert the structure (one per tenant+employee).
salaryRouter.put(
  "/salary/:employeeId",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const { employeeId } = req.params
    const parsed = upsertSchema.safeParse(req.body)
    if (!parsed.success) {
      const hourlyWageMissing = parsed.error.issues.some((i) => i.message === "hourly_wage_required")
      res.status(400).json({ error: hourlyWageMissing ? "hourly_wage_required" : "invalid_body", details: parsed.error.flatten() })
      return
    }

    const row: Record<string, unknown> = {
      tenant_id: tenantId,
      employee_id: employeeId,
    }
    if (parsed.data.method !== undefined) row.method = parsed.data.method
    if (parsed.data.baseSalary !== undefined) row.base_salary = parsed.data.baseSalary
    if (parsed.data.dailyWage !== undefined) row.daily_wage = parsed.data.dailyWage
    if (parsed.data.hourlyWage !== undefined) row.hourly_wage = parsed.data.hourlyWage
    if (parsed.data.allowances !== undefined) row.allowances = parsed.data.allowances
    if (parsed.data.laborInsuredSalary !== undefined)
      row.labor_insured_salary = parsed.data.laborInsuredSalary
    if (parsed.data.healthInsuredSalary !== undefined)
      row.health_insured_salary = parsed.data.healthInsuredSalary
    if (parsed.data.pensionVoluntaryRate !== undefined)
      row.pension_voluntary_rate = parsed.data.pensionVoluntaryRate
    if (parsed.data.agreedHoursPerWeek !== undefined)
      row.agreed_hours_per_week = parsed.data.agreedHoursPerWeek
    if (parsed.data.agreedDaysPerWeek !== undefined)
      row.agreed_days_per_week = parsed.data.agreedDaysPerWeek

    // M12：沒帶投保薪資 → 以今日適用的級距表自動選（選不出來就維持原樣，不擋存檔）。
    let insuredSuggested: InsuredSuggestion | null = null
    const autoLabor = parsed.data.laborInsuredSalary === undefined
    const autoHealth = parsed.data.healthInsuredSalary === undefined
    if (autoLabor || autoHealth) {
      try {
        const today = todayKey(await getTenantTimezone(tenantId))
        const { rules } = await loadRuleConfigFor(tenantId, today.slice(0, 7))
        const set = resolveInsuranceBrackets(rules, today)
        if (set) {
          const prev = await supabaseAdmin
            .from("salary_structures")
            .select("method, base_salary, hourly_wage, agreed_hours_per_week")
            .eq("tenant_id", tenantId)
            .eq("employee_id", employeeId)
            .maybeSingle()
          const p = prev.data as Record<string, unknown> | null
          const base = insuredBaseFor({
            method: parsed.data.method ?? ((p?.method as string | null) ?? null),
            baseSalary: parsed.data.baseSalary !== undefined ? parsed.data.baseSalary : numOrNull(p?.base_salary),
            hourlyWage: parsed.data.hourlyWage !== undefined ? parsed.data.hourlyWage : numOrNull(p?.hourly_wage),
            agreedHoursPerWeek:
              parsed.data.agreedHoursPerWeek !== undefined
                ? parsed.data.agreedHoursPerWeek
                : numOrNull(p?.agreed_hours_per_week),
          })
          if (base !== null) {
            insuredSuggested = suggestInsured(base, set)
            if (autoLabor && insuredSuggested.labor !== null) row.labor_insured_salary = insuredSuggested.labor
            if (autoHealth && insuredSuggested.health !== null) row.health_insured_salary = insuredSuggested.health
          }
        }
      } catch (err) {
        logger.warn({ err, tenantId, employeeId }, "salary: 投保級距自動選失敗，維持原值")
      }
    }

    try {
      const { data, error } = await supabaseAdmin
        .from("salary_structures")
        .upsert(row, { onConflict: "tenant_id,employee_id" })
        .select("id")
        .single()

      if (error || !data) {
        next(new Error(`PUT /salary/${employeeId}: ${error?.message}`))
        return
      }
      // 稽核（應用層）：這次 PUT 送進來的欄位（去掉鍵值 tenant_id／employee_id）；整列前後值由 trigger 記。
      const { tenant_id: _t, employee_id: _e, ...changed } = row
      await writeAuditLog({
        tenantId,
        tableName: "salary_structures",
        recordId: data.id as string,
        action: "UPDATE",
        newRow: changed,
        context: "PUT /salary/:employeeId — 儲存薪資結構",
      })
      res.status(200).json({ id: data.id, ...(insuredSuggested ? { insuredSuggested } : {}) })
    } catch (err) {
      next(err)
    }
  },
)
