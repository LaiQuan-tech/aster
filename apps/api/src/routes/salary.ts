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
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { logger } from "../lib/logger.js"
import { loadRuleConfigFor, SALARY_PENSION_COLS } from "../services/payroll-inputs.js"
import { columnsExist } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { monthRangeKeys, todayKey } from "../lib/tz.js"
import { getRequestContext } from "../lib/request-context.js"
import { resolveSelf } from "../middleware/scope.js"
import { recordSalarySaveHistory, type SaveHistoryResult } from "../services/salary-history.js"
import {
  SALARY_STRUCTURE_ISSUE_LABELS,
  SALARY_STRUCTURE_ISSUE_MESSAGES,
  engineRejects,
  salaryStructureIssue,
  type SalaryStructureIssue,
} from "../services/salary-completeness.js"

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

/** 手填勞退月提繳工資上限＝分級表最高級。 */
export const PENSION_WAGE_MANUAL_MAX = 150_000

const SELECT_COLS =
  "id, tenant_id, employee_id, method, base_salary, daily_wage, hourly_wage, allowances, labor_insured_salary, health_insured_salary, pension_voluntary_rate, agreed_hours_per_week, agreed_days_per_week, created_at"

/** 0086 的勞退兩欄已套用才 select（沒套用時 select 不存在的欄位 PostgREST 會 500）。 */
async function selectCols(): Promise<string> {
  return (await columnsExist("salary_structures", SALARY_PENSION_COLS)) ? `${SELECT_COLS}, ${SALARY_PENSION_COLS}` : SELECT_COLS
}

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
    // 2026-11-08（migration 0086）：勞退月提繳工資（整數元；null＝依分級表以本薪＋計入投保固定津貼自動算）、
    // 是否適用勞退新制（false → 雇主提撥與勞工自提都 0，例：無永久居留的外籍員工）。
    // 上限 150,000＝勞退月提繳分級表最高級（114／115 年版皆同）；引擎另依該月分級表最高級再夾一次。
    pensionWage: z.number().int().positive().max(PENSION_WAGE_MANUAL_MAX).nullable().optional(),
    pensionNewSystem: z.boolean().optional(),
    // 2026-11-10 調薪／投保調整歷程：本薪或勞健保投保薪資／勞退月提繳工資有變時寫一筆紀錄的生效日與原因。
    // 只影響紀錄，不影響存進 salary_structures 的值。沒帶生效日＝租戶今天。
    change: z
      .object({
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        reason: z.string().trim().max(500).nullable().optional(),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== "change"), { message: "no fields to update" })
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
        .select(await selectCols())
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

export interface IncompleteSalaryEntry {
  employeeId: string
  name: string
  empNo: string | null
  method: string
  issue: SalaryStructureIssue
  /** 短標籤（月薪制缺本薪…）。 */
  label: string
  /** 缺本薪或時薪（時薪制缺時薪、其他制本薪與時薪都沒有）→ 執行薪資時引擎拒算，會被跳過（hourly_wage_missing）。 */
  skippedByPayroll: boolean
}

/**
 * 該員工在 [from, to]（薪資月份）期間內是否仍在職：有離職日 → 離職日 ≥ 月初才算（月中離職的人當月仍要算薪）；
 * 沒離職日 → status 不是 active（停用）不算；到職日晚於月底不算。
 */
export function employedDuring(
  e: { status?: string | null; terminated_at?: string | null; hire_date?: string | null },
  range: { from: string; to: string },
): boolean {
  if (e.hire_date && String(e.hire_date).slice(0, 10) > range.to) return false
  if (e.terminated_at) return String(e.terminated_at).slice(0, 10) >= range.from
  return !e.status || e.status === "active"
}

/**
 * 純函式：薪資結構列 ＋ 員工 → 設定不完整的名單（只列該薪資月份期間內仍在職的人；依員編、姓名排序）。
 * 判準同 PUT 存檔驗證（services/salary-completeness.ts）。
 */
export function incompleteSalaryEntries(
  salaries: Array<{ employee_id: string; method: string | null; base_salary: unknown; daily_wage: unknown; hourly_wage: unknown }>,
  employees: Array<{ id: string; name: string | null; emp_no: string | null; status?: string | null; terminated_at?: string | null; hire_date?: string | null }>,
  range: { from: string; to: string },
): IncompleteSalaryEntry[] {
  const empById = new Map(employees.map((e) => [e.id, e] as const))
  const out: IncompleteSalaryEntry[] = []
  for (const s of salaries) {
    const e = empById.get(s.employee_id)
    if (!e) continue
    if (!employedDuring(e, range)) continue
    const input = {
      method: s.method,
      baseSalary: numOrNull(s.base_salary),
      dailyWage: numOrNull(s.daily_wage),
      hourlyWage: numOrNull(s.hourly_wage),
    }
    const issue = salaryStructureIssue(input)
    if (!issue) continue
    out.push({
      employeeId: e.id,
      name: e.name ?? "",
      empNo: e.emp_no ?? null,
      method: s.method ?? "monthly",
      issue,
      label: SALARY_STRUCTURE_ISSUE_LABELS[issue],
      skippedByPayroll: engineRejects(input),
    })
  }
  return out.sort((a, b) => (a.empNo ?? "\uffff").localeCompare(b.empNo ?? "\uffff") || a.name.localeCompare(b.name))
}

// GET /salary-structures/incomplete?period=YYYY-MM — 薪資設定不完整、該月仍在職的員工（2026-11-17；HR／平台管理員／會計）。
// period 省略＝租戶當月。只回姓名、員編、計薪方式與缺哪一欄，不回金額。
salaryRouter.get(
  "/salary-structures/incomplete",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const rawPeriod = typeof req.query.period === "string" ? req.query.period : undefined
    if (rawPeriod !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawPeriod)) {
      res.status(400).json({ error: "invalid_period", message: "period 格式須為 YYYY-MM" })
      return
    }
    try {
      const { data: sal, error: salErr } = await supabaseAdmin
        .from("salary_structures")
        .select("employee_id, method, base_salary, daily_wage, hourly_wage")
        .eq("tenant_id", tenantId)
      if (salErr) throw new Error(`GET /salary-structures/incomplete (salary_structures): ${salErr.message}`)
      const salaries = (sal ?? []) as Array<{ employee_id: string; method: string | null; base_salary: unknown; daily_wage: unknown; hourly_wage: unknown }>
      const ids = salaries.map((r) => r.employee_id)
      let employees: Array<{ id: string; name: string | null; emp_no: string | null; status?: string | null; terminated_at?: string | null; hire_date?: string | null }> = []
      if (ids.length > 0) {
        const { data: emps, error: empErr } = await supabaseAdmin
          .from("employees")
          .select("id, name, emp_no, status, terminated_at, hire_date")
          .eq("tenant_id", tenantId)
          .in("id", ids)
        if (empErr) throw new Error(`GET /salary-structures/incomplete (employees): ${empErr.message}`)
        employees = (emps ?? []) as typeof employees
      }
      const period = rawPeriod ?? todayKey(await getTenantTimezone(tenantId)).slice(0, 7)
      const entries = incompleteSalaryEntries(salaries, employees, monthRangeKeys(period))
      res.status(200).json({ period, count: entries.length, employees: entries })
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
      res.status(400).json({
        error: hourlyWageMissing ? "hourly_wage_required" : "invalid_body",
        ...(hourlyWageMissing ? { message: SALARY_STRUCTURE_ISSUE_MESSAGES.hourly_wage_required } : {}),
        details: parsed.error.flatten(),
      })
      return
    }

    // 2026-11-17 薪資設定完整度：這次有動到計薪方式／本薪／日薪／時薪 → 以「存檔後」的整組值檢查
    //（月薪制本薪 > 0、時薪制時薪 > 0、按出勤天數制日薪 > 0 且有時薪或本薪當基準）。只擋新存檔；
    // 沒碰這四欄的 PUT（只改投保、勞退…）照存，既有資料不動。
    const touchesWage =
      parsed.data.method !== undefined ||
      parsed.data.baseSalary !== undefined ||
      parsed.data.dailyWage !== undefined ||
      parsed.data.hourlyWage !== undefined
    if (touchesWage) {
      let pw: Record<string, unknown> | null
      try {
        const { data: prevWage, error: prevWageErr } = await supabaseAdmin
          .from("salary_structures")
          .select("method, base_salary, daily_wage, hourly_wage")
          .eq("tenant_id", tenantId)
          .eq("employee_id", employeeId)
          .maybeSingle()
        if (prevWageErr) throw new Error(`PUT /salary/${employeeId} (wage check): ${prevWageErr.message}`)
        pw = (prevWage as Record<string, unknown> | null) ?? null
      } catch (err) {
        next(err)
        return
      }
      const issue = salaryStructureIssue({
        method: parsed.data.method ?? ((pw?.method as string | null | undefined) ?? null),
        baseSalary: parsed.data.baseSalary !== undefined ? parsed.data.baseSalary : numOrNull(pw?.base_salary),
        dailyWage: parsed.data.dailyWage !== undefined ? parsed.data.dailyWage : numOrNull(pw?.daily_wage),
        hourlyWage: parsed.data.hourlyWage !== undefined ? parsed.data.hourlyWage : numOrNull(pw?.hourly_wage),
      })
      if (issue) {
        res.status(400).json({ error: issue, message: SALARY_STRUCTURE_ISSUE_MESSAGES[issue] })
        return
      }
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
    if (parsed.data.pensionWage !== undefined || parsed.data.pensionNewSystem !== undefined) {
      if (!(await columnsExist("salary_structures", SALARY_PENSION_COLS))) {
        res.status(409).json({ error: "migration_required", message: "勞退月提繳工資／適用勞退新制欄位尚未套用（migration 0086）" })
        return
      }
      if (parsed.data.pensionWage !== undefined) row.pension_wage = parsed.data.pensionWage
      if (parsed.data.pensionNewSystem !== undefined) row.pension_new_system = parsed.data.pensionNewSystem
    }

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

    // 2026-11-10 歷程：存檔前的本薪／投保三項（存檔後比對，有變才寫紀錄）。讀不到不擋存檔。
    const pensionCols = await columnsExist("salary_structures", SALARY_PENSION_COLS)
    let before: Record<string, unknown> | null = null
    try {
      const { data: prevRow } = await supabaseAdmin
        .from("salary_structures")
        .select(`base_salary, labor_insured_salary, health_insured_salary${pensionCols ? ", pension_wage" : ""}`)
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .maybeSingle()
      before = (prevRow as Record<string, unknown> | null) ?? null
    } catch {
      before = null
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
      // 歷程（只是紀錄）：upsert 只改有帶的欄位，沒帶的沿用存檔前的值。
      let history: SaveHistoryResult | null = null
      try {
        const pick = (col: string) => (col in row ? numOrNull(row[col]) : numOrNull(before?.[col]))
        const change = parsed.data.change
        history = await recordSalarySaveHistory({
          tenantId,
          employeeId: String(employeeId),
          effectiveDate: change?.effectiveDate ?? todayKey(await getTenantTimezone(tenantId)),
          reason: change?.reason?.trim() || null,
          note: change?.note?.trim() || null,
          actorEmpId:
            getRequestContext()?.actorEmpId ??
            (req.auth?.userId ? ((await resolveSelf(tenantId, req.auth.userId))?.id ?? null) : null),
          prevBase: numOrNull(before?.base_salary),
          nextBase: pick("base_salary"),
          prevInsured: {
            labor: numOrNull(before?.labor_insured_salary),
            health: numOrNull(before?.health_insured_salary),
            pension: pensionCols ? numOrNull(before?.pension_wage) : null,
          },
          nextInsured: {
            labor: pick("labor_insured_salary"),
            health: pick("health_insured_salary"),
            pension: pensionCols ? pick("pension_wage") : null,
          },
        })
      } catch (err) {
        logger.warn({ err, tenantId, employeeId }, "salary: 歷程紀錄失敗（薪資資料已存）")
      }
      res.status(200).json({ id: data.id, ...(insuredSuggested ? { insuredSuggested } : {}), ...(history ? { history } : {}) })
    } catch (err) {
      next(err)
    }
  },
)
