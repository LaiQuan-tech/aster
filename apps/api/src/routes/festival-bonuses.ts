import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { FESTIVALS, computeFestivalSuggestion, festivalLabel } from "../services/festival-bonus.js"
import {
  festivalBonusFilename,
  festivalBonusWorkbookBuffer,
  type FestivalBonusXlsxRow,
} from "../lib/xlsx/festival-bonuses.js"

/**
 * 三節／節慶 Cash 獎金（festival_bonuses；M6，2026-09-23）。
 *
 * 流程＝**產生 → 逐人加減 → 一次發放**：
 *   POST /festival-bonuses/prepare {festival, year, referenceDate, baseAmount?}
 *        對全體在職員工 upsert 一列 draft。建議金額由純函式算（去年同節的
 *        final_amount 優先，否則 baseAmount；到職未滿一年按整月數折算），
 *        已經 paid 的列**不動**並列在 skipped。同一組參數重跑是冪等的
 *        （unique (tenant, employee, festival, year)）。
 *   GET   /festival-bonuses?festival=&year=        清單（含姓名／工號／到職日）
 *   PATCH /festival-bonuses/:id {finalAmount?, note?}   只能改 draft
 *   POST  /festival-bonuses/pay {festival, year, paidOn}  該節全部 draft → paid
 *   GET   /festival-bonuses/export.xlsx?festival=&year=
 *
 * 全部 HR（`requireHrAdmin`）——現金給付只有老闆與 HR 看得到，會計角色看不到
 * （與 overtime_settlements 同一條線）。paid 後整列由 DB trigger
 * `forbid_paid_row_mutation` 凍結，API 這邊的 409 只是先把話講清楚。
 *
 * 路由順序：`/prepare`、`/pay`、`/export.xlsx` 這些靜態路徑先註冊，`/:id` 在後，
 * 且 `:id` 不是 uuid 時 `next()`——同 routes/bonus-runs.ts。
 */
export const festivalBonusesRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dateRe = /^\d{4}-\d{2}-\d{2}$/

function isCalendarDate(s: string): boolean {
  if (!dateRe.test(s)) return false
  const [y, m, d] = s.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const dateKey = z.string().refine(isCalendarDate, "須為 YYYY-MM-DD 的有效日期")
const festivalSchema = z.enum(FESTIVALS)
const yearSchema = z.number().int().min(1900).max(2999)

const prepareBody = z.object({
  festival: festivalSchema,
  year: yearSchema,
  referenceDate: dateKey,
  /** 全員共用的基準金額；去年同節有 final_amount 時以去年為準。 */
  baseAmount: z.number().nonnegative().optional(),
})
const patchBody = z
  .object({
    finalAmount: z.number().nonnegative().nullable().optional(),
    note: z.string().trim().max(2000).nullish(),
  })
  .refine((b) => b.finalAmount !== undefined || b.note !== undefined, "至少要有一個欄位")
const payBody = z.object({
  festival: festivalSchema,
  year: yearSchema,
  paidOn: dateKey,
})
const listQuery = z.object({
  festival: festivalSchema.optional(),
  year: z.coerce.number().int().min(1900).max(2999).optional(),
  status: z.enum(["draft", "paid"]).optional(),
})

const SELECT_COLS =
  "id, tenant_id, employee_id, festival, year, reference_date, suggested_amount, prorate_months, final_amount, status, paid_on, note, created_by_emp_id, paid_by_emp_id, created_at, updated_at"

const guards = [requireAuth, requireTenant, requireHrAdmin] as const

interface BonusRow {
  id: string
  employee_id: string
  festival: string
  year: number
  reference_date: string | null
  suggested_amount: string | number | null
  prorate_months: number | null
  final_amount: string | number | null
  status: string
  paid_on: string | null
  note: string | null
}

interface EmployeeLite {
  id: string
  name: string | null
  emp_no: string | null
  hire_date: string | null
}

/** numeric 欄位由 PostgREST 回字串；一律轉 number|null（空字串當 null）。 */
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const x = typeof v === "number" ? v : Number(v)
  return Number.isFinite(x) ? x : null
}

/** 表還沒套遷移（正式庫在全部 WP commit 後才套）→ 503，不要回 500 讓人以為是壞掉。 */
function notMigrated(res: Response, err: unknown): boolean {
  if (!isMissingTableError(err as { code?: string })) return false
  warnSchemaGapOnce("festival_bonuses", err as { code?: string; message?: string })
  res.status(503).json({ error: "not_migrated", message: "festival_bonuses 尚未套用（migration 0050）" })
  return true
}

async function actorEmpId(tenantId: string, req: Request): Promise<string | null> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return self?.id ?? null
}

/** 在職員工（含到職日）——產生名單與清單顯示共用。 */
async function loadActiveEmployees(tenantId: string): Promise<EmployeeLite[]> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name, emp_no, hire_date")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
  if (error) throw new Error(`festival-bonuses (employees): ${error.message}`)
  return (data ?? []) as EmployeeLite[]
}

/** 這個租戶全部員工（含離職）的顯示欄位——清單要能顯示已離職者的既有獎金列。 */
async function loadEmployeeMap(tenantId: string): Promise<Map<string, EmployeeLite>> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name, emp_no, hire_date")
    .eq("tenant_id", tenantId)
  if (error) throw new Error(`festival-bonuses (employee map): ${error.message}`)
  const map = new Map<string, EmployeeLite>()
  for (const e of (data ?? []) as EmployeeLite[]) map.set(e.id, e)
  return map
}

function withEmployee(row: BonusRow, emp: EmployeeLite | undefined) {
  return {
    ...row,
    suggested_amount: num(row.suggested_amount),
    final_amount: num(row.final_amount),
    employee_name: emp?.name ?? null,
    emp_no: emp?.emp_no ?? null,
    hire_date: emp?.hire_date ?? null,
  }
}

// ── POST /festival-bonuses/prepare — 對在職員工 upsert draft ──────────────
festivalBonusesRouter.post(
  "/festival-bonuses/prepare",
  ...guards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = prepareBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { festival, year, referenceDate, baseAmount } = parsed.data

    try {
      const actor = await actorEmpId(tenantId, req)
      const employees = await loadActiveEmployees(tenantId)
      if (employees.length === 0) {
        res.status(200).json({ created: 0, updated: 0, skipped: [], bonuses: [] })
        return
      }

      // 本節既有的列（決定 insert／update／skip）與去年同節的實發金額。
      const existing = await supabaseAdmin
        .from("festival_bonuses")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .eq("festival", festival)
        .eq("year", year)
      if (existing.error) {
        if (notMigrated(res, existing.error)) return
        next(new Error(`POST /festival-bonuses/prepare (existing): ${existing.error.message}`))
        return
      }
      const byEmployee = new Map<string, BonusRow>()
      for (const r of (existing.data ?? []) as BonusRow[]) byEmployee.set(r.employee_id, r)

      const lastYear = await supabaseAdmin
        .from("festival_bonuses")
        .select("employee_id, final_amount, suggested_amount")
        .eq("tenant_id", tenantId)
        .eq("festival", festival)
        .eq("year", year - 1)
      if (lastYear.error && !isMissingTableError(lastYear.error)) {
        next(new Error(`POST /festival-bonuses/prepare (last year): ${lastYear.error.message}`))
        return
      }
      const lastYearByEmployee = new Map<string, number | null>()
      for (const r of (lastYear.data ?? []) as Array<{ employee_id: string; final_amount: string | number | null }>) {
        lastYearByEmployee.set(r.employee_id, num(r.final_amount))
      }

      const skipped: Array<{ employeeId: string; reason: string }> = []
      const inserts: Array<Record<string, unknown>> = []
      const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
      const now = new Date().toISOString()

      for (const emp of employees) {
        const prev = byEmployee.get(emp.id)
        if (prev?.status === "paid") {
          skipped.push({ employeeId: emp.id, reason: "paid" })
          continue
        }
        const { prorateMonths, suggested } = computeFestivalSuggestion({
          lastYearFinal: lastYearByEmployee.get(emp.id) ?? null,
          baseAmount: baseAmount ?? null,
          hireDate: emp.hire_date,
          referenceDate,
        })
        if (prev) {
          updates.push({
            id: prev.id,
            patch: {
              reference_date: referenceDate,
              suggested_amount: suggested,
              prorate_months: prorateMonths,
              // final_amount：老闆已經手調過就不覆蓋，沒調過（null）才帶建議值。
              ...(num(prev.final_amount) === null ? { final_amount: suggested } : {}),
              updated_at: now,
            },
          })
        } else {
          inserts.push({
            tenant_id: tenantId,
            employee_id: emp.id,
            festival,
            year,
            reference_date: referenceDate,
            suggested_amount: suggested,
            prorate_months: prorateMonths,
            final_amount: suggested,
            status: "draft",
            created_by_emp_id: actor,
            updated_at: now,
          })
        }
      }

      if (inserts.length > 0) {
        const { error } = await supabaseAdmin.from("festival_bonuses").insert(inserts)
        if (error) {
          if (notMigrated(res, error)) return
          next(new Error(`POST /festival-bonuses/prepare (insert): ${error.message}`))
          return
        }
      }
      for (const u of updates) {
        const { error } = await supabaseAdmin
          .from("festival_bonuses")
          .update(u.patch)
          .eq("tenant_id", tenantId)
          .eq("id", u.id)
        if (error) {
          next(new Error(`POST /festival-bonuses/prepare (update ${u.id}): ${error.message}`))
          return
        }
      }

      await writeAuditLog({
        tenantId,
        tableName: "festival_bonuses",
        action: "INSERT",
        newRow: { festival, year, referenceDate, baseAmount: baseAmount ?? null, created: inserts.length, updated: updates.length, skipped: skipped.length },
        actorEmpId: actor,
        context: `POST /festival-bonuses/prepare — 產生 ${year} ${festivalLabel(festival)} 獎金草稿`,
      })

      const listed = await listBonuses(tenantId, { festival, year })
      res.status(200).json({ created: inserts.length, updated: updates.length, skipped, bonuses: listed })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /festival-bonuses/pay {festival, year, paidOn} — 該節全部 draft → paid ──
festivalBonusesRouter.post(
  "/festival-bonuses/pay",
  ...guards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = payBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { festival, year, paidOn } = parsed.data
    try {
      const actor = await actorEmpId(tenantId, req)
      const drafts = await supabaseAdmin
        .from("festival_bonuses")
        .select("id, employee_id, final_amount, suggested_amount")
        .eq("tenant_id", tenantId)
        .eq("festival", festival)
        .eq("year", year)
        .eq("status", "draft")
      if (drafts.error) {
        if (notMigrated(res, drafts.error)) return
        next(new Error(`POST /festival-bonuses/pay (select): ${drafts.error.message}`))
        return
      }
      const rows = (drafts.data ?? []) as Array<{ id: string; employee_id: string; final_amount: string | number | null; suggested_amount: string | number | null }>
      if (rows.length === 0) {
        res.status(409).json({ error: "no_draft", message: "這個節日年度沒有可發放的草稿" })
        return
      }

      // final_amount 還沒填的列，發放時以建議金額落地（CHECK 只要求 paid → paid_on）。
      let paid = 0
      for (const r of rows) {
        const amount = num(r.final_amount) ?? num(r.suggested_amount) ?? 0
        const { error } = await supabaseAdmin
          .from("festival_bonuses")
          .update({
            status: "paid",
            paid_on: paidOn,
            final_amount: amount,
            paid_by_emp_id: actor,
            updated_at: new Date().toISOString(),
          })
          .eq("tenant_id", tenantId)
          .eq("id", r.id)
          .eq("status", "draft")
        if (error) {
          next(new Error(`POST /festival-bonuses/pay (update ${r.id}): ${error.message}`))
          return
        }
        paid += 1
      }

      await writeAuditLog({
        tenantId,
        tableName: "festival_bonuses",
        action: "UPDATE",
        oldRow: { status: "draft", count: rows.length },
        newRow: { status: "paid", paid_on: paidOn, count: paid, festival, year },
        actorEmpId: actor,
        context: `POST /festival-bonuses/pay — 發放並凍結 ${year} ${festivalLabel(festival)} 獎金`,
      })

      const listed = await listBonuses(tenantId, { festival, year })
      res.status(200).json({ paid, paidOn, bonuses: listed })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /festival-bonuses/export.xlsx?festival=&year= ─────────────────────
festivalBonusesRouter.get(
  "/festival-bonuses/export.xlsx",
  ...guards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success || !parsed.data.festival || parsed.data.year === undefined) {
      res.status(400).json({ error: "invalid_query", message: "festival 與 year 必填" })
      return
    }
    const { festival, year } = parsed.data
    try {
      const bonuses = await listBonuses(tenantId, { festival, year })
      const rows: FestivalBonusXlsxRow[] = bonuses.map((b) => ({
        empNo: b.emp_no,
        employeeName: b.employee_name,
        hireDate: b.hire_date,
        prorateMonths: b.prorate_months,
        suggestedAmount: b.suggested_amount,
        finalAmount: b.final_amount,
        status: b.status,
        paidOn: b.paid_on,
        note: b.note,
      }))
      const meta = { festival, year, referenceDate: bonuses[0]?.reference_date ?? null }
      const buffer = await festivalBonusWorkbookBuffer(meta, rows)
      res
        .status(200)
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(festivalBonusFilename(meta))}`)
      res.send(buffer)
    } catch (err) {
      if (isMissingTableError(err as { code?: string })) {
        res.status(503).json({ error: "not_migrated" })
        return
      }
      next(err)
    }
  },
)

// ── GET /festival-bonuses?festival=&year=&status= ─────────────────────────
festivalBonusesRouter.get(
  "/festival-bonuses",
  ...guards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const bonuses = await listBonuses(tenantId, parsed.data)
      res.status(200).json({ bonuses })
    } catch (err) {
      if (isMissingTableError(err as { code?: string })) {
        warnSchemaGapOnce("festival_bonuses", err as { code?: string })
        res.status(503).json({ error: "not_migrated" })
        return
      }
      next(err)
    }
  },
)

// ── PATCH /festival-bonuses/:id {finalAmount?, note?} — 只能改 draft ──────
festivalBonusesRouter.patch(
  "/festival-bonuses/:id",
  ...guards,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    if (!UUID_RE.test(id)) {
      next()
      return
    }
    const parsed = patchBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const existing = await supabaseAdmin
        .from("festival_bonuses")
        .select("id, status, final_amount, note")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (existing.error) {
        if (notMigrated(res, existing.error)) return
        next(new Error(`PATCH /festival-bonuses/${id} (select): ${existing.error.message}`))
        return
      }
      if (!existing.data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (existing.data.status === "paid") {
        res.status(409).json({ error: "already_paid", message: "已發放的獎金列已凍結" })
        return
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (parsed.data.finalAmount !== undefined) patch.final_amount = parsed.data.finalAmount
      if (parsed.data.note !== undefined) patch.note = parsed.data.note ?? null

      const { data, error } = await supabaseAdmin
        .from("festival_bonuses")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .eq("status", "draft")
        .select(SELECT_COLS)
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /festival-bonuses/${id}: ${error.message}`))
        return
      }
      if (!data) {
        // draft → paid 的競態（或 DB trigger 擋下）。
        res.status(409).json({ error: "already_paid" })
        return
      }
      const row = data as BonusRow
      await writeAuditLog({
        tenantId,
        tableName: "festival_bonuses",
        recordId: id,
        action: "UPDATE",
        oldRow: { final_amount: num(existing.data.final_amount as string | number | null), note: existing.data.note },
        newRow: { final_amount: num(row.final_amount), note: row.note },
        actorEmpId: await actorEmpId(tenantId, req),
        context: "PATCH /festival-bonuses/:id — 老闆調整實發金額／備註",
      })
      res.status(200).json({ bonus: withEmployee(row, (await loadEmployeeMap(tenantId)).get(row.employee_id)) })
    } catch (err) {
      next(err)
    }
  },
)

/** 清單（含姓名／工號／到職日），依工號→姓名排序。 */
async function listBonuses(
  tenantId: string,
  filter: { festival?: string; year?: number; status?: string },
): Promise<Array<ReturnType<typeof withEmployee>>> {
  let query = supabaseAdmin.from("festival_bonuses").select(SELECT_COLS).eq("tenant_id", tenantId)
  if (filter.festival) query = query.eq("festival", filter.festival)
  if (filter.year !== undefined) query = query.eq("year", filter.year)
  if (filter.status) query = query.eq("status", filter.status)
  const { data, error } = await query
  if (error) throw Object.assign(new Error(`festival-bonuses list: ${error.message}`), { code: error.code })

  const employees = await loadEmployeeMap(tenantId)
  return ((data ?? []) as BonusRow[])
    .map((r) => withEmployee(r, employees.get(r.employee_id)))
    .sort((a, b) => (a.emp_no ?? "").localeCompare(b.emp_no ?? "") || (a.employee_name ?? "").localeCompare(b.employee_name ?? ""))
}
