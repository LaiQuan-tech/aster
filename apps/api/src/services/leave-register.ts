import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey, zonedTimeToUtc } from "../lib/tz.js"
import { loadRuleConfigFor } from "./payroll-inputs.js"

export interface LeaveRegisterType {
  id: string
  code: string
  name: string
}

export interface LeaveRegisterRequest {
  leave_type_id: string | null
  start_at: string
  end_at: string
  hours: number | string | null
  segments: unknown
}

export interface LeaveRegisterMonth {
  month: number
  hoursByType: Record<string, number>
  totalHours: number
  totalDays: number
}

export interface LeaveRegisterTotals {
  hoursByType: Record<string, number>
  totalHours: number
  totalDays: number
}

export interface LeaveRegister {
  year: number
  dailyRegularHours: number
  leaveTypes: LeaveRegisterType[]
  months: LeaveRegisterMonth[]
  totals: LeaveRegisterTotals
}

type DatedSegment = { date?: unknown; hours?: unknown }

function roundHours(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function dateKey(value: string): string | null {
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function daysBetweenInclusive(start: string, end: string): string[] {
  if (start > end) return []
  const cursor = new Date(`${start}T00:00:00.000Z`)
  const last = new Date(`${end}T00:00:00.000Z`)
  const dates: string[] = []
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function requestAllocations(request: LeaveRegisterRequest, timezone: string): Array<{ date: string; hours: number }> {
  if (Array.isArray(request.segments)) {
    return request.segments.flatMap((raw) => {
      const segment = raw as DatedSegment
      const date = typeof segment.date === "string" ? dateKey(segment.date) : null
      const hours = Number(segment.hours)
      return date && Number.isFinite(hours) && hours >= 0 ? [{ date, hours }] : []
    })
  }

  const start = localDateKey(request.start_at, timezone)
  const end = localDateKey(request.end_at, timezone)
  const hours = request.hours == null ? 0 : Number(request.hours)
  if (!start || !end || !Number.isFinite(hours) || hours <= 0) return []
  const dates = daysBetweenInclusive(start, end)
  if (dates.length === 0) return []
  const dailyHours = hours / dates.length
  return dates.map((date) => ({ date, hours: dailyHours }))
}

/**
 * Builds a 12-month employee leave summary. Approved-only filtering and tenant
 * scoping belong to the data loader; legacy multi-day requests without dated
 * segments are distributed evenly across their inclusive calendar dates.
 */
export function buildLeaveRegister(input: {
  year: number
  dailyRegularHours: number
  leaveTypes: LeaveRegisterType[]
  requests: LeaveRegisterRequest[]
  timezone?: string
}): LeaveRegister {
  const dailyRegularHours = input.dailyRegularHours > 0 ? input.dailyRegularHours : 8
  const timezone = input.timezone ?? "Asia/Taipei"
  const leaveTypes = [...input.leaveTypes]
  const typeIds = new Set(leaveTypes.map((type) => type.id))
  if (input.requests.some((request) => !request.leave_type_id || !typeIds.has(request.leave_type_id))) {
    leaveTypes.push({ id: "unspecified", code: "unspecified", name: "未指定" })
  }

  const hoursByType = Object.fromEntries(leaveTypes.map((type) => [type.id, 0])) as Record<string, number>
  const months = Array.from({ length: 12 }, (_, index): LeaveRegisterMonth => ({
    month: index + 1,
    hoursByType: { ...hoursByType },
    totalHours: 0,
    totalDays: 0,
  }))

  for (const request of input.requests) {
    const typeId = request.leave_type_id && typeIds.has(request.leave_type_id)
      ? request.leave_type_id
      : "unspecified"
    for (const allocation of requestAllocations(request, timezone)) {
      const [year, month] = allocation.date.split("-").map(Number)
      if (year !== input.year || month < 1 || month > 12) continue
      const row = months[month - 1]
      row.hoursByType[typeId] += allocation.hours
    }
  }

  for (const row of months) {
    for (const type of leaveTypes) row.hoursByType[type.id] = roundHours(row.hoursByType[type.id])
    row.totalHours = roundHours(Object.values(row.hoursByType).reduce((sum, value) => sum + value, 0))
    row.totalDays = roundHours(row.totalHours / dailyRegularHours)
  }

  const totalsByType = Object.fromEntries(leaveTypes.map((type) => [
    type.id,
    roundHours(months.reduce((sum, row) => sum + row.hoursByType[type.id], 0)),
  ])) as Record<string, number>
  const totalHours = roundHours(Object.values(totalsByType).reduce((sum, value) => sum + value, 0))
  return {
    year: input.year,
    dailyRegularHours,
    leaveTypes,
    months,
    totals: {
      hoursByType: totalsByType,
      totalHours,
      totalDays: roundHours(totalHours / dailyRegularHours),
    },
  }
}

export interface EmployeeLeaveRegister {
  employee: { id: string; name: string; empNo: string | null; hireDate: string | null }
  register: LeaveRegister
}

/** Tenant-scoped loader. Only approved leave requests contribute to the register. */
export async function getEmployeeLeaveRegister(
  tenantId: string,
  employeeId: string,
  year: number,
): Promise<EmployeeLeaveRegister | null> {
  const { data: employee, error: employeeError } = await supabaseAdmin
    .from("employees")
    .select("id, name, emp_no, hire_date")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (employeeError) throw new Error(`getEmployeeLeaveRegister (employee): ${employeeError.message}`)
  if (!employee) return null

  const [timezone, config] = await Promise.all([
    getTenantTimezone(tenantId),
    loadRuleConfigFor(tenantId, `${year}-01`),
  ])
  const yearStart = zonedTimeToUtc(`${year}-01-01`, 0, 0, timezone).toISOString()
  const nextYearStart = zonedTimeToUtc(`${year + 1}-01-01`, 0, 0, timezone).toISOString()

  const [typeResult, requestResult] = await Promise.all([
    supabaseAdmin
      .from("leave_types")
      .select("id, code, name")
      .eq("tenant_id", tenantId)
      .order("code", { ascending: true }),
    supabaseAdmin
      .from("leave_requests")
      .select("leave_type_id, start_at, end_at, hours, segments")
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .eq("kind", "leave")
      .eq("status", "approved")
      .is("deleted_at", null)
      .lt("start_at", nextYearStart)
      .gte("end_at", yearStart),
  ])
  if (typeResult.error) throw new Error(`getEmployeeLeaveRegister (leave types): ${typeResult.error.message}`)
  if (requestResult.error) throw new Error(`getEmployeeLeaveRegister (requests): ${requestResult.error.message}`)

  const leaveTypes = (typeResult.data ?? []).map((type) => ({
    id: type.id as string,
    code: type.code as string,
    name: type.name as string,
  }))
  const requests: LeaveRegisterRequest[] = (requestResult.data ?? []).map((request) => ({
    leave_type_id: request.leave_type_id as string | null,
    start_at: request.start_at as string,
    end_at: request.end_at as string,
    hours: request.hours as number | string | null,
    segments: request.segments,
  }))

  return {
    employee: {
      id: employee.id as string,
      name: employee.name as string,
      empNo: employee.emp_no as string | null,
      hireDate: employee.hire_date as string | null,
    },
    register: buildLeaveRegister({
      year,
      dailyRegularHours: Number(config.rules.payroll.dailyRegularHours),
      leaveTypes,
      requests,
      timezone,
    }),
  }
}
