import type { DayType, ShiftDef } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { columnsExist, isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import type { DateKey } from "../lib/tz.js"

/**
 * 員工某天「用哪個班別」——遲到判斷（打卡當下）、settleAttendance、月表 facts、缺卡掃描四處共用
 * （2026-10-13：員工個人設定）。優先序：
 *   1. 當天有 schedules 列且班別還在 → 該班（班表功能已移除，只剩歷史資料）。
 *   2. 工作日、在職期間內（hire_date ≤ 當天 ≤ terminated_at，欄位空＝不限）、員工有
 *      `employees.default_shift_id`（個人預設班別，例：14:30–22:30）→ 該班。
 *   3. 以上皆無 → null（呼叫端走公司規則：工作日＝彈性上班 attendance.flex，例假日＝整天不扣午休）。
 * 個人預設班別只套**工作日**：例假日／國定假日沒有「應上班時間」，來加班照沒排班的規則算（整天、不扣午休），
 * 才不會把週末出勤套成平日班別而算出遲到。
 */

export type DayShiftSource = "schedule" | "default"

export interface ResolvedDayShift {
  shift: ShiftDef | null
  /** schedule＝排班列；default＝員工個人預設班別；null＝走公司規則。 */
  source: DayShiftSource | null
}

export interface EmploymentWindow {
  /** 到職日 'YYYY-MM-DD'；null＝沒填（不限）。 */
  hireDate: string | null
  /** 離職日 'YYYY-MM-DD'（當天仍算在職）；null＝在職中。 */
  terminatedAt: string | null
}

/** 純函式：`date` 在不在職期間內（到職日當天起、離職日當天止；欄位空＝不限）。 */
export function withinEmployment(date: DateKey, employment: EmploymentWindow | null | undefined): boolean {
  if (!employment) return true
  if (employment.hireDate && date < employment.hireDate) return false
  if (employment.terminatedAt && date > employment.terminatedAt) return false
  return true
}

/** 純函式：排班 → 個人預設班別（只限工作日、在職期間）→ null。 */
export function resolveDayShift(input: {
  scheduledShift: ShiftDef | null | undefined
  defaultShift: ShiftDef | null | undefined
  dayType: DayType
  date?: DateKey
  employment?: EmploymentWindow | null
}): ResolvedDayShift {
  if (input.scheduledShift) return { shift: input.scheduledShift, source: "schedule" }
  const employed = input.date ? withinEmployment(input.date, input.employment) : true
  if (input.dayType === "workday" && input.defaultShift && employed) return { shift: input.defaultShift, source: "default" }
  return { shift: null, source: null }
}

interface ShiftRow {
  id: string
  start_time: string
  end_time: string
  break_minutes: number | null
  /** migration 0060；舊庫沒有這欄 → undefined。 */
  break_start?: string | null
}

function toShiftDef(row: ShiftRow): ShiftDef {
  return {
    start: row.start_time,
    end: row.end_time,
    breakMinutes: row.break_minutes ?? 0,
    breakStart: row.break_start ?? null,
  }
}

/** employees.default_shift_id ＋ features（migration 0068）是否已套。 */
export function employeesHavePersonalSettings(): Promise<boolean> {
  return columnsExist("employees", "default_shift_id, features")
}

export interface ShiftResolver {
  /** 某員工某天的班別（見 resolveDayShift）。 */
  forDay(employeeId: string, date: DateKey, dayType: DayType): ResolvedDayShift
  /**
   * 當天的 schedules 列：undefined＝沒有列；null＝有列但 shift_id 空或班別已刪（舊行為仍算「有排班」）；
   * 否則＝該班。
   */
  scheduleOf(employeeId: string, date: DateKey): ShiftDef | null | undefined
  /** 區間內有 schedules 列的 `${employeeId}|${date}`（settleAttendance 要結算的日子之一）。 */
  scheduledKeys(): string[]
  /** 有個人預設班別的員工 id。 */
  employeesWithDefault(): string[]
  /** 某員工的個人預設班別（沒有 → null）。 */
  defaultShiftOf(employeeId: string): ShiftDef | null
  /** 有個人預設班別的員工的在職期間（其他員工 → null，不需要）。 */
  employmentOf(employeeId: string): EmploymentWindow | null
}

/**
 * 一次載入 [from, to] 的 schedules、員工的 default_shift_id 與兩者用到的 shifts，回傳查詢器。
 * `employeeIds` 省略＝本租戶全部員工（缺卡掃描、整租戶結算）。
 * 欄位缺漏容錯：0068 未套 → 沒有個人預設班別；shifts.break_start 未套 → 不帶午休起點。
 */
export async function loadShiftResolver(opts: {
  tenantId: string
  from: DateKey
  to: DateKey
  employeeIds?: string[]
  /** true＝個人預設班別只認 status='active' 的員工（缺卡掃描用：離職的人不該收到忘打卡通知）。 */
  activeOnly?: boolean
}): Promise<ShiftResolver> {
  const { tenantId, from, to, employeeIds, activeOnly } = opts

  let schedQuery = supabaseAdmin
    .from("schedules")
    .select("employee_id, work_date, shift_id")
    .eq("tenant_id", tenantId)
    .gte("work_date", from)
    .lte("work_date", to)
  if (employeeIds) schedQuery = schedQuery.in("employee_id", employeeIds)
  const { data: schedData, error: schedErr } = await schedQuery
  if (schedErr) throw new Error(`loadShiftResolver (schedules): ${schedErr.message}`)
  const schedules = (schedData ?? []) as Array<{ employee_id: string; work_date: string; shift_id: string | null }>

  const defaultShiftIdByEmp = new Map<string, string>()
  const employmentByEmp = new Map<string, EmploymentWindow>()
  if (await employeesHavePersonalSettings()) {
    let empQuery = supabaseAdmin
      .from("employees")
      .select("id, default_shift_id, hire_date, terminated_at")
      .eq("tenant_id", tenantId)
      .not("default_shift_id", "is", null)
    if (employeeIds) empQuery = empQuery.in("id", employeeIds)
    if (activeOnly) empQuery = empQuery.eq("status", "active")
    const { data: empData, error: empErr } = await empQuery
    if (empErr) throw new Error(`loadShiftResolver (employees): ${empErr.message}`)
    for (const e of (empData ?? []) as Array<{
      id: string
      default_shift_id: string | null
      hire_date: string | null
      terminated_at: string | null
    }>) {
      if (!e.default_shift_id) continue
      defaultShiftIdByEmp.set(e.id, e.default_shift_id)
      employmentByEmp.set(e.id, { hireDate: e.hire_date ?? null, terminatedAt: e.terminated_at ?? null })
    }
  }

  const shiftIds = Array.from(
    new Set([
      ...schedules.map((s) => s.shift_id).filter((id): id is string => !!id),
      ...defaultShiftIdByEmp.values(),
    ]),
  )
  const shiftById = new Map<string, ShiftDef>()
  if (shiftIds.length > 0) {
    const loadShifts = (cols: string) =>
      supabaseAdmin.from("shifts").select(cols).eq("tenant_id", tenantId).in("id", shiftIds)
    let shiftRes = await loadShifts("id, start_time, end_time, break_minutes, break_start")
    if (shiftRes.error && isMissingColumnError(shiftRes.error)) {
      warnSchemaGapOnce("shifts.break_start", shiftRes.error)
      shiftRes = await loadShifts("id, start_time, end_time, break_minutes")
    }
    if (shiftRes.error) throw new Error(`loadShiftResolver (shifts): ${shiftRes.error.message}`)
    for (const row of (shiftRes.data ?? []) as unknown as ShiftRow[]) shiftById.set(row.id, toShiftDef(row))
  }

  const scheduledByKey = new Map<string, ShiftDef | null>()
  for (const s of schedules) {
    scheduledByKey.set(`${s.employee_id}|${s.work_date}`, s.shift_id ? (shiftById.get(s.shift_id) ?? null) : null)
  }
  const defaultOf = (employeeId: string): ShiftDef | null => {
    const id = defaultShiftIdByEmp.get(employeeId)
    return id ? (shiftById.get(id) ?? null) : null
  }

  return {
    forDay(employeeId, date, dayType) {
      return resolveDayShift({
        scheduledShift: scheduledByKey.get(`${employeeId}|${date}`) ?? null,
        defaultShift: defaultOf(employeeId),
        dayType,
        date,
        employment: employmentByEmp.get(employeeId) ?? null,
      })
    },
    scheduleOf: (employeeId, date) => {
      const key = `${employeeId}|${date}`
      return scheduledByKey.has(key) ? (scheduledByKey.get(key) ?? null) : undefined
    },
    scheduledKeys: () => Array.from(scheduledByKey.keys()),
    employeesWithDefault: () => Array.from(defaultShiftIdByEmp.keys()).filter((id) => !!defaultOf(id)),
    defaultShiftOf: defaultOf,
    employmentOf: (employeeId) => employmentByEmp.get(employeeId) ?? null,
  }
}
