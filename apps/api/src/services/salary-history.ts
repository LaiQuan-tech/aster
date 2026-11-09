import { supabaseAdmin } from "../lib/supabase.js"
import { columnsExist, isMissingColumnError, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"

/**
 * 員工薪資分頁「調薪歷程」＋「勞健保調整歷程」（2026-11-10，migration 0088 ＝ sql/0078）。
 * **只是紀錄**：不參與任何薪資計算（薪資計算仍讀 salary_structures 的目前值）。
 *
 *   • 調薪歷程：重用既有 salary_adjustments（生效日 effective_date、新本薪 new_salary、原因 reason、
 *     登錄人 changed_by_emp_id），0088 加 prev_salary（調薪前本薪）。欄位未套用 → 讀寫都不帶 prev_salary。
 *   • 勞健保調整歷程：insured_salary_changes（勞保／健保投保薪資、勞退月提繳工資，各存 prev_* 與調整後）。
 *     表未套用 → 列表回空、available=false；寫入回 null（呼叫端決定回 503 或只附警告）。
 */

export const SALARY_ADJ_TABLE = "salary_adjustments"
export const INSURED_TABLE = "insured_salary_changes"
const SALARY_ADJ_BASE_COLS = "id, employee_id, effective_date, new_salary, reason, changed_by_emp_id, created_at"
const INSURED_COLS =
  "id, employee_id, effective_on, labor_insured_salary, health_insured_salary, pension_wage, prev_labor_insured_salary, prev_health_insured_salary, prev_pension_wage, note, created_by_emp_id, created_at"

export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const x = typeof v === "number" ? v : Number(v)
  return Number.isFinite(x) ? x : null
}

/** salary_adjustments.prev_salary（0088）是否已套用。 */
export function salaryAdjustmentsHavePrev(): Promise<boolean> {
  return columnsExist(SALARY_ADJ_TABLE, "prev_salary")
}

export interface SalaryAdjustmentView {
  id: string
  effectiveDate: string
  prevSalary: number | null
  newSalary: number
  /** 新 − 原；沒有原本薪＝null。 */
  diff: number | null
  reason: string | null
  createdByEmpId: string | null
  createdByName: string | null
  createdAt: string
}

export interface InsuredPair {
  prev: number | null
  next: number | null
}

export interface InsuredChangeView {
  id: string
  effectiveOn: string
  labor: InsuredPair
  health: InsuredPair
  pension: InsuredPair
  note: string | null
  createdByEmpId: string | null
  createdByName: string | null
  createdAt: string
}

async function namesOf(tenantId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  const out = new Map<string, string>()
  if (unique.length === 0) return out
  const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", unique)
  if (error) return out // 登錄人名稱只是顯示用，查不到不擋列表
  for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) if (r.name) out.set(r.id, r.name)
  return out
}

/** 該員工的調薪紀錄（生效日新→舊）。 */
export async function listSalaryAdjustments(tenantId: string, employeeId: string): Promise<SalaryAdjustmentView[]> {
  const withPrev = await salaryAdjustmentsHavePrev()
  const { data, error } = await supabaseAdmin
    .from(SALARY_ADJ_TABLE)
    .select(withPrev ? `${SALARY_ADJ_BASE_COLS}, prev_salary` : SALARY_ADJ_BASE_COLS)
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .order("effective_date", { ascending: false })
    .order("created_at", { ascending: false })
  if (error) throw new Error(`salary history (salary_adjustments): ${error.message}`)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const names = await namesOf(tenantId, rows.map((r) => r.changed_by_emp_id as string | null))
  return rows.map((r) => {
    const prev = numOrNull(r.prev_salary)
    const next = numOrNull(r.new_salary) ?? 0
    const by = (r.changed_by_emp_id as string | null) ?? null
    return {
      id: r.id as string,
      effectiveDate: String(r.effective_date).slice(0, 10),
      prevSalary: prev,
      newSalary: next,
      diff: prev === null ? null : next - prev,
      reason: (r.reason as string | null) ?? null,
      createdByEmpId: by,
      createdByName: by ? (names.get(by) ?? null) : null,
      createdAt: String(r.created_at),
    }
  })
}

function toInsuredView(r: Record<string, unknown>, names: Map<string, string>): InsuredChangeView {
  const by = (r.created_by_emp_id as string | null) ?? null
  return {
    id: r.id as string,
    effectiveOn: String(r.effective_on).slice(0, 10),
    labor: { prev: numOrNull(r.prev_labor_insured_salary), next: numOrNull(r.labor_insured_salary) },
    health: { prev: numOrNull(r.prev_health_insured_salary), next: numOrNull(r.health_insured_salary) },
    pension: { prev: numOrNull(r.prev_pension_wage), next: numOrNull(r.pension_wage) },
    note: (r.note as string | null) ?? null,
    createdByEmpId: by,
    createdByName: by ? (names.get(by) ?? null) : null,
    createdAt: String(r.created_at),
  }
}

/** 該員工未刪除的投保調整紀錄（生效日新→舊）；表未套用 → available=false、空清單。 */
export async function listInsuredChanges(
  tenantId: string,
  employeeId: string,
): Promise<{ available: boolean; rows: InsuredChangeView[] }> {
  const { data, error } = await supabaseAdmin
    .from(INSURED_TABLE)
    .select(INSURED_COLS)
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .is("deleted_at", null)
    .order("effective_on", { ascending: false })
    .order("created_at", { ascending: false })
  if (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      warnSchemaGapOnce("insured_salary_changes", error)
      return { available: false, rows: [] }
    }
    throw new Error(`salary history (insured_salary_changes): ${error.message}`)
  }
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const names = await namesOf(tenantId, rows.map((r) => r.created_by_emp_id as string | null))
  return { available: true, rows: rows.map((r) => toInsuredView(r, names)) }
}

export interface SalaryAdjustmentRecord {
  effectiveDate: string
  prevSalary: number | null
  newSalary: number
  reason: string | null
  actorEmpId: string | null
}

/** 寫一筆調薪紀錄（只寫紀錄，不改 salary_structures）。prev_salary 欄位未套用就不帶。 */
export async function insertSalaryAdjustmentRecord(
  tenantId: string,
  employeeId: string,
  rec: SalaryAdjustmentRecord,
): Promise<string> {
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    employee_id: employeeId,
    effective_date: rec.effectiveDate,
    new_salary: rec.newSalary,
    reason: rec.reason,
    changed_by_emp_id: rec.actorEmpId,
  }
  if (await salaryAdjustmentsHavePrev()) row.prev_salary = rec.prevSalary
  const { data, error } = await supabaseAdmin.from(SALARY_ADJ_TABLE).insert(row).select("id").single()
  if (error || !data) throw new Error(`salary_adjustments insert: ${error?.message}`)
  return data.id as string
}

export interface InsuredValues {
  labor: number | null
  health: number | null
  pension: number | null
}

export interface InsuredChangeRecord {
  effectiveOn: string
  prev: InsuredValues
  next: InsuredValues
  note: string | null
  actorEmpId: string | null
}

/** 寫一筆投保調整紀錄；表未套用回 null（不丟錯）。 */
export async function insertInsuredChangeRecord(
  tenantId: string,
  employeeId: string,
  rec: InsuredChangeRecord,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from(INSURED_TABLE)
    .insert({
      tenant_id: tenantId,
      employee_id: employeeId,
      effective_on: rec.effectiveOn,
      labor_insured_salary: rec.next.labor,
      health_insured_salary: rec.next.health,
      pension_wage: rec.next.pension,
      prev_labor_insured_salary: rec.prev.labor,
      prev_health_insured_salary: rec.prev.health,
      prev_pension_wage: rec.prev.pension,
      note: rec.note,
      created_by_emp_id: rec.actorEmpId,
    })
    .select("id")
    .single()
  if (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      warnSchemaGapOnce("insured_salary_changes", error)
      return null
    }
    throw new Error(`insured_salary_changes insert: ${error.message}`)
  }
  return (data?.id as string | undefined) ?? null
}

/** 整數化（投保薪資都是整數元）；null／0 以下以外照原值四捨五入。 */
function intOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v)
}

/** 本薪有沒有變（null 與 0 視為相同＝未設定）。 */
export function baseSalaryChanged(prev: number | null, next: number | null): boolean {
  return (prev ?? 0) !== (next ?? 0)
}

/** 三項投保值任一有變？ */
export function insuredChanged(prev: InsuredValues, next: InsuredValues): boolean {
  return (
    intOrNull(prev.labor) !== intOrNull(next.labor) ||
    intOrNull(prev.health) !== intOrNull(next.health) ||
    intOrNull(prev.pension) !== intOrNull(next.pension)
  )
}

export interface SaveHistoryResult {
  salaryAdjustmentId: string | null
  insuredChangeId: string | null
  warnings: string[]
}

/**
 * PUT /salary/:employeeId 存檔成功後呼叫：本薪有變寫調薪紀錄、投保三項任一有變寫投保調整紀錄。
 * 薪資資料已存成功 → 這裡任何失敗只記 log ＋ 回 warnings，不讓請求失敗。
 */
export async function recordSalarySaveHistory(opts: {
  tenantId: string
  employeeId: string
  effectiveDate: string
  reason: string | null
  note: string | null
  actorEmpId: string | null
  prevBase: number | null
  nextBase: number | null
  prevInsured: InsuredValues
  nextInsured: InsuredValues
}): Promise<SaveHistoryResult | null> {
  const salaryMoved = baseSalaryChanged(opts.prevBase, opts.nextBase)
  const insuredMoved = insuredChanged(opts.prevInsured, opts.nextInsured)
  if (!salaryMoved && !insuredMoved) return null
  const out: SaveHistoryResult = { salaryAdjustmentId: null, insuredChangeId: null, warnings: [] }
  if (salaryMoved) {
    try {
      out.salaryAdjustmentId = await insertSalaryAdjustmentRecord(opts.tenantId, opts.employeeId, {
        effectiveDate: opts.effectiveDate,
        prevSalary: opts.prevBase,
        newSalary: opts.nextBase ?? 0,
        reason: opts.reason,
        actorEmpId: opts.actorEmpId,
      })
    } catch (err) {
      logger.warn({ err, tenantId: opts.tenantId, employeeId: opts.employeeId }, "salary history: 調薪紀錄寫入失敗")
      out.warnings.push("薪資資料已儲存，但調薪紀錄寫入失敗，請用「補登調薪紀錄」補上。")
    }
  }
  if (insuredMoved) {
    const p = opts.prevInsured
    const n = opts.nextInsured
    try {
      out.insuredChangeId = await insertInsuredChangeRecord(opts.tenantId, opts.employeeId, {
        effectiveOn: opts.effectiveDate,
        prev: { labor: intOrNull(p.labor), health: intOrNull(p.health), pension: intOrNull(p.pension) },
        next: { labor: intOrNull(n.labor), health: intOrNull(n.health), pension: intOrNull(n.pension) },
        note: opts.note,
        actorEmpId: opts.actorEmpId,
      })
      if (!out.insuredChangeId) out.warnings.push("投保調整歷程資料表尚未套用（migration 0088），這次調整沒有留下歷程。")
    } catch (err) {
      logger.warn({ err, tenantId: opts.tenantId, employeeId: opts.employeeId }, "salary history: 投保調整紀錄寫入失敗")
      out.warnings.push("薪資資料已儲存，但投保調整紀錄寫入失敗，請用「補登投保調整」補上。")
    }
  }
  return out
}

/**
 * 出勤統計表表尾「投保薪資調整」：生效日 ≤ asOf、有勞保投保薪資的紀錄，取最近 3 筆、依生效日舊→新。
 * 表未套用或查詢失敗 → 空陣列（報表照常）。
 */
export async function loadInsuredAdjustmentsForStatement(
  tenantId: string,
  employeeId: string,
  asOf: string,
  limit = 3,
): Promise<Array<{ effectiveOn: string; laborInsuredSalary: number }>> {
  try {
    const { data, error } = await supabaseAdmin
      .from(INSURED_TABLE)
      .select("effective_on, labor_insured_salary, prev_labor_insured_salary, created_at")
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .is("deleted_at", null)
      .lte("effective_on", asOf)
      .order("effective_on", { ascending: false })
      .order("created_at", { ascending: false })
    if (error) return []
    return pickStatementAdjustments((data ?? []) as Array<Record<string, unknown>>, asOf, limit)
  } catch {
    return []
  }
}

/** 純函式：只看勞保投保薪資真的有變的紀錄（只改健保／勞退的不列）；同一生效日只取最新登錄的一筆，取最近 limit 筆，回傳舊→新。 */
export function pickStatementAdjustments(
  rows: Array<Record<string, unknown>>,
  asOf: string,
  limit = 3,
): Array<{ effectiveOn: string; laborInsuredSalary: number }> {
  const sorted = rows
    .map((r) => ({
      effectiveOn: String(r.effective_on).slice(0, 10),
      labor: numOrNull(r.labor_insured_salary),
      prevLabor: numOrNull(r.prev_labor_insured_salary),
      createdAt: String(r.created_at ?? ""),
    }))
    .filter((r) => r.labor !== null && r.labor > 0 && r.labor !== r.prevLabor && r.effectiveOn <= asOf)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.createdAt.localeCompare(a.createdAt))
  const seen = new Set<string>()
  const picked: Array<{ effectiveOn: string; laborInsuredSalary: number }> = []
  for (const r of sorted) {
    if (seen.has(r.effectiveOn)) continue
    seen.add(r.effectiveOn)
    picked.push({ effectiveOn: r.effectiveOn, laborInsuredSalary: r.labor as number })
    if (picked.length >= limit) break
  }
  return picked.reverse()
}
