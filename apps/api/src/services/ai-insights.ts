import { supabaseAdmin } from "../lib/supabase.js"
import { computeLateStats, detectAnomalies } from "./detection.js"

const dateRe = /^\d{4}-\d{2}-\d{2}$/

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("gemini_not_configured")
  }
}

export interface AiReportInput {
  from: string
  to: string
  period: string
  deptId?: string
}

export interface AiAskInput {
  question: string
  from: string
  to: string
  period: string
  employeeId?: string
}

interface EmployeeRow {
  id: string
  name: string
  dept_id: string | null
  role: string
  status: string
}

interface DepartmentRow {
  id: string
  name: string
}

interface AttendanceRow {
  employee_id: string
  work_date: string
  worked_minutes: number
  late_minutes: number
  overtime_minutes: number
  night_minutes: number
}

interface LeaveRow {
  employee_id: string
  kind: string
  status: string
  hours: string | number | null
  start_at: string
  end_at: string
  created_at: string
}

interface PayslipRow {
  employee_id: string
  base: string | number
  overtime_pay: string | number
  night_pay: string | number
  attendance_bonus: string | number
  gross: string | number
}

interface NotificationRow {
  employee_id: string | null
  type: string
  status: string
  created_at: string
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  error?: { message?: string }
}

function nextDayUtc(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString()
}

function inc(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by
}

async function loadContext(tenantId: string, input: AiReportInput | AiAskInput) {
  if (!dateRe.test(input.from) || !dateRe.test(input.to)) throw new Error("invalid_date_window")
  const fromTs = `${input.from}T00:00:00.000Z`
  const toTsExclusive = nextDayUtc(input.to)

  let employeeQuery = supabaseAdmin
    .from("employees")
    .select("id, name, dept_id, role, status")
    .eq("tenant_id", tenantId)
  if ("employeeId" in input && input.employeeId) employeeQuery = employeeQuery.eq("id", input.employeeId)
  if ("deptId" in input && input.deptId) employeeQuery = employeeQuery.eq("dept_id", input.deptId)
  const { data: employeeData, error: employeeErr } = await employeeQuery
  if (employeeErr) throw new Error(`ai context employees: ${employeeErr.message}`)
  const employees = (employeeData ?? []) as EmployeeRow[]
  const employeeIds = employees.map((employee) => employee.id)
  const employeeNameById = new Map(employees.map((employee) => [employee.id, employee.name]))

  const { data: departmentData, error: departmentErr } = await supabaseAdmin
    .from("departments")
    .select("id, name")
    .eq("tenant_id", tenantId)
  if (departmentErr) throw new Error(`ai context departments: ${departmentErr.message}`)
  const departmentNameById = new Map(
    ((departmentData ?? []) as DepartmentRow[]).map((department) => [department.id, department.name]),
  )

  let attendanceQuery = supabaseAdmin
    .from("attendance_days")
    .select("employee_id, work_date, worked_minutes, late_minutes, overtime_minutes, night_minutes")
    .eq("tenant_id", tenantId)
    .gte("work_date", input.from)
    .lte("work_date", input.to)
  if (employeeIds.length > 0) attendanceQuery = attendanceQuery.in("employee_id", employeeIds)
  const { data: attendanceData, error: attendanceErr } = await attendanceQuery
  if (attendanceErr) throw new Error(`ai context attendance: ${attendanceErr.message}`)
  const attendanceRows = ((attendanceData ?? []) as AttendanceRow[]).filter((row) =>
    employeeIds.includes(row.employee_id),
  )

  const attendanceByEmployee = new Map<
    string,
    { employeeId: string; employeeName: string; presentDays: number; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; nightMinutes: number }
  >()
  for (const row of attendanceRows) {
    const existing =
      attendanceByEmployee.get(row.employee_id) ??
      {
        employeeId: row.employee_id,
        employeeName: employeeNameById.get(row.employee_id) ?? row.employee_id,
        presentDays: 0,
        workedMinutes: 0,
        lateMinutes: 0,
        overtimeMinutes: 0,
        nightMinutes: 0,
      }
    existing.presentDays += 1
    existing.workedMinutes += row.worked_minutes ?? 0
    existing.lateMinutes += row.late_minutes ?? 0
    existing.overtimeMinutes += row.overtime_minutes ?? 0
    existing.nightMinutes += row.night_minutes ?? 0
    attendanceByEmployee.set(row.employee_id, existing)
  }

  const { data: leaveData, error: leaveErr } = await supabaseAdmin
    .from("leave_requests")
    .select("employee_id, kind, status, hours, start_at, end_at, created_at")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
  if (leaveErr) throw new Error(`ai context leave: ${leaveErr.message}`)
  const leaveRows = ((leaveData ?? []) as LeaveRow[]).filter((row) => {
    if (!employeeIds.includes(row.employee_id)) return false
    const createdIn = row.created_at >= fromTs && row.created_at < toTsExclusive
    const overlaps = row.start_at < toTsExclusive && row.end_at >= fromTs
    return createdIn || overlaps
  })

  const leaveSummary: Record<string, { count: number; hours: number }> = {}
  for (const row of leaveRows) {
    const key = `${row.kind}:${row.status}`
    const existing = leaveSummary[key] ?? { count: 0, hours: 0 }
    existing.count += 1
    existing.hours += row.hours == null ? 0 : Number(row.hours)
    leaveSummary[key] = existing
  }

  let payslipQuery = supabaseAdmin
    .from("payslips")
    .select("employee_id, base, overtime_pay, night_pay, attendance_bonus, gross")
    .eq("tenant_id", tenantId)
    .eq("period", input.period)
  if (employeeIds.length > 0) payslipQuery = payslipQuery.in("employee_id", employeeIds)
  const { data: payslipData, error: payslipErr } = await payslipQuery
  if (payslipErr) throw new Error(`ai context payslips: ${payslipErr.message}`)
  const payrollRows = ((payslipData ?? []) as PayslipRow[])
    .filter((row) => employeeIds.includes(row.employee_id))
    .map((row) => ({
      employeeId: row.employee_id,
      employeeName: employeeNameById.get(row.employee_id) ?? row.employee_id,
      base: Number(row.base),
      overtimePay: Number(row.overtime_pay),
      nightPay: Number(row.night_pay),
      attendanceBonus: Number(row.attendance_bonus),
      gross: Number(row.gross),
    }))

  let notificationQuery = supabaseAdmin
    .from("notifications")
    .select("employee_id, type, status, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", fromTs)
    .lt("created_at", toTsExclusive)
  if ("employeeId" in input && input.employeeId) notificationQuery = notificationQuery.eq("employee_id", input.employeeId)
  const { data: notificationData, error: notificationErr } = await notificationQuery
  if (notificationErr) throw new Error(`ai context notifications: ${notificationErr.message}`)
  const notificationSummary: Record<string, number> = {}
  for (const row of ((notificationData ?? []) as NotificationRow[]).filter(
    (item) => !item.employee_id || employeeIds.includes(item.employee_id),
  )) {
    inc(notificationSummary, `${row.type}:${row.status}`)
  }

  const lateStats = await computeLateStats(tenantId, {
    from: input.from,
    to: input.to,
    ...("deptId" in input && input.deptId ? { deptId: input.deptId } : {}),
  })
  const anomalies = await detectAnomalies(tenantId, { from: input.from, to: input.to, queue: false })
  const filteredAnomalies =
    "employeeId" in input && input.employeeId
      ? anomalies.anomalies.filter((item) => item.employeeId === input.employeeId)
      : anomalies.anomalies.filter((item) => employeeIds.includes(item.employeeId))

  const headcount = {
    total: employees.length,
    byStatus: employees.reduce<Record<string, number>>((acc, employee) => {
      inc(acc, employee.status)
      return acc
    }, {}),
    byRole: employees.reduce<Record<string, number>>((acc, employee) => {
      inc(acc, employee.role)
      return acc
    }, {}),
    byDept: employees.reduce<Record<string, number>>((acc, employee) => {
      inc(acc, employee.dept_id ? departmentNameById.get(employee.dept_id) ?? employee.dept_id : "未分派")
      return acc
    }, {}),
  }

  return {
    scope: "employeeId" in input && input.employeeId ? "self" : "tenant",
    filters: input,
    headcount,
    attendance: {
      totals: {
        presentDays: attendanceRows.length,
        workedMinutes: attendanceRows.reduce((sum, row) => sum + (row.worked_minutes ?? 0), 0),
        lateMinutes: attendanceRows.reduce((sum, row) => sum + (row.late_minutes ?? 0), 0),
        overtimeMinutes: attendanceRows.reduce((sum, row) => sum + (row.overtime_minutes ?? 0), 0),
        nightMinutes: attendanceRows.reduce((sum, row) => sum + (row.night_minutes ?? 0), 0),
      },
      topLate: Array.from(attendanceByEmployee.values())
        .sort((a, b) => b.lateMinutes - a.lateMinutes)
        .slice(0, 8),
      lateStats: lateStats.rows
        .filter((row) => !("employeeId" in input) || !input.employeeId || row.employeeId === input.employeeId)
        .slice(0, 8),
    },
    leave: {
      summary: leaveSummary,
      recentDetails: leaveRows.slice(0, 12).map((row) => ({
        employeeName: employeeNameById.get(row.employee_id) ?? row.employee_id,
        kind: row.kind,
        status: row.status,
        hours: row.hours == null ? 0 : Number(row.hours),
        startAt: row.start_at,
        endAt: row.end_at,
      })),
    },
    payroll: {
      period: input.period,
      count: payrollRows.length,
      totalGross: payrollRows.reduce((sum, row) => sum + row.gross, 0),
      rows: payrollRows.slice(0, 12),
    },
    anomalies: {
      count: filteredAnomalies.length,
      byType: filteredAnomalies.reduce<Record<string, number>>((acc, item) => {
        inc(acc, item.type)
        return acc
      }, {}),
      samples: filteredAnomalies.slice(0, 12).map((item) => ({
        employeeName: employeeNameById.get(item.employeeId) ?? item.employeeId,
        type: item.type,
        detail: item.detail,
      })),
    },
    notifications: notificationSummary,
  }
}

async function generateWithGemini(system: string, prompt: string): Promise<{ text: string; model: string }> {
  const apiKey =
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY
  if (!apiKey) throw new GeminiNotConfiguredError()

  // 2026-09-14：gemini-2.0-flash 已下架，改用浮動別名（同 lib/gemini.ts）
  const model = process.env.GEMINI_MODEL ?? "gemini-flash-latest"
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1400 },
      }),
    },
  )
  const payload = (await response.json().catch(() => ({}))) as GeminiResponse
  if (!response.ok) throw new Error(payload.error?.message ?? `gemini_failed_${response.status}`)
  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? ""
  if (!text) throw new Error("gemini_empty_response")
  return { text, model }
}

function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} 小時`
}

function buildLocalReportSummary(context: Awaited<ReturnType<typeof loadContext>>): string {
  const attendance = context.attendance.totals
  const payroll = context.payroll
  const anomalies = context.anomalies
  const topLate = context.attendance.topLate
    .slice(0, 3)
    .map((row) => `${row.employeeName} ${row.lateMinutes} 分`)
    .join("、")
  return [
    "### 本期重點",
    `- 人力總數 ${context.headcount.total} 人，出勤紀錄 ${attendance.presentDays} 筆，總工時 ${hours(attendance.workedMinutes)}。`,
    `- 薪資期別 ${payroll.period} 共 ${payroll.count} 份薪資單，應發總額 $${payroll.totalGross.toLocaleString("zh-TW")}。`,
    `- 遲到合計 ${attendance.lateMinutes} 分，加班合計 ${hours(attendance.overtimeMinutes)}。`,
    topLate ? `- 遲到較高人員：${topLate}。` : "- 本期沒有明顯遲到排行資料。",
    "",
    "### 風險 / 異常",
    `- 異常偵測 ${anomalies.count} 筆：${Object.entries(anomalies.byType).map(([key, value]) => `${key} ${value}`).join(" / ") || "無"}`,
    `- 通知佇列：${Object.entries(context.notifications).map(([key, value]) => `${key} ${value}`).join(" / ") || "無"}`,
    "",
    "### 建議行動",
    "- 先檢查遲到與加班較高的人員，確認是否為排班、補卡或臨時專案造成。",
    "- Demo 模式提示：目前未偵測到 Gemini key，以上為系統資料 fallback 摘要；設定 `GEMINI_API_KEY` 後會改由 Gemini 產生完整分析。",
  ].join("\n")
}

function buildLocalAnswer(question: string, context: Awaited<ReturnType<typeof loadContext>>): string {
  const attendance = context.attendance.totals
  const payroll = context.payroll
  const leaveSummary = Object.entries(context.leave.summary)
    .map(([key, value]) => `${key} ${value.count} 件/${value.hours} 小時`)
    .join("、")
  const topLate = context.attendance.topLate
    .slice(0, 5)
    .map((row) => `${row.employeeName}：遲到 ${row.lateMinutes} 分、加班 ${hours(row.overtimeMinutes)}`)
    .join("\n")
  return [
    `你問：「${question}」`,
    "",
    "依目前可讀資料摘要如下：",
    `- 查詢範圍：${context.filters.from} ~ ${context.filters.to}，薪資年月 ${context.filters.period}`,
    `- 出勤：${attendance.presentDays} 筆、總工時 ${hours(attendance.workedMinutes)}、遲到 ${attendance.lateMinutes} 分、加班 ${hours(attendance.overtimeMinutes)}。`,
    `- 薪資：${payroll.count} 份薪資單，應發總額 $${payroll.totalGross.toLocaleString("zh-TW")}。`,
    `- 表單：${leaveSummary || "目前沒有表單資料"}`,
    `- 異常：${context.anomalies.count} 筆（${Object.entries(context.anomalies.byType).map(([key, value]) => `${key} ${value}`).join(" / ") || "無"}）。`,
    topLate ? `\n遲到/加班較高名單：\n${topLate}` : "",
    "",
    "Demo 模式提示：目前未偵測到 Gemini key，這是系統資料 fallback 回答；設定 `GEMINI_API_KEY` 後會改由 Gemini 回答。",
  ].filter(Boolean).join("\n")
}

export async function generateAiReportSummary(tenantId: string, input: AiReportInput) {
  const context = await loadContext(tenantId, input)
  let text: string
  let model: string
  try {
    const result = await generateWithGemini(
      "你是台灣 HR SaaS 的資料分析助理。只能根據提供的 JSON 資料回答，用繁體中文，務實、精簡，不臆測未提供的事實。",
      [
        "請產出 HR 月報摘要，格式使用 Markdown：",
        "1. 本期重點（3-5 點）",
        "2. 風險/異常",
        "3. 建議行動",
        "4. 可追蹤指標",
        `資料 JSON：${JSON.stringify(context)}`,
      ].join("\n"),
    )
    text = result.text
    model = result.model
  } catch (err) {
    if (!(err instanceof GeminiNotConfiguredError)) throw err
    text = buildLocalReportSummary(context)
    model = "local-demo-fallback"
  }
  return { summary: text, model, context }
}

export async function answerAiQuestion(tenantId: string, input: AiAskInput) {
  const context = await loadContext(tenantId, input)
  let text: string
  let model: string
  try {
    const result = await generateWithGemini(
      "你是 HR 系統資料問答助理。只能根據提供的 JSON 回答；若資料不足，請明確說資料不足。員工 scope=self 時不得推論或透露其他員工資料。",
      [`問題：${input.question}`, `資料 JSON：${JSON.stringify(context)}`].join("\n\n"),
    )
    text = result.text
    model = result.model
  } catch (err) {
    if (!(err instanceof GeminiNotConfiguredError)) throw err
    text = buildLocalAnswer(input.question, context)
    model = "local-demo-fallback"
  }
  return { answer: text, model, scope: context.scope }
}
