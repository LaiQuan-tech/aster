import { getTenantTimezone } from "../../lib/tenant-tz.js"
import { zonedTimeToUtc } from "../../lib/tz.js"
import { supabaseAdmin } from "../../lib/supabase.js"
import { isPlatformAdminEmail } from "../../middleware/platform.js"
import { belongsToTenant, bulkInviteFromCsv, findAuthUserByEmail, type BulkInviteSummary } from "../auth-invite.js"
import {
  EMPLOYMENT_TYPE_LABELS,
  PUNCH_TYPE_LABELS,
  ROLE_LABELS,
  SCHEDULE_STATUS_LABELS,
  type ImportKind,
} from "./kinds.js"
import { normalizeToken, type ParsedImportRow } from "./parse.js"
import { loadDepartments, loadShifts, NameResolver, resolveEmployees, type EmployeeRef } from "./resolve.js"
import {
  generateTenantCalendar,
  importManualPunches,
  insertOnboardings,
  insertSalaryAdjustments,
  upsertScheduleAssignments,
  type HolidayInput,
  type ManualPunchRecord,
  type OnboardingInput,
  type PunchType,
  type SalaryAdjustmentInput,
  type ScheduleAssignment,
} from "./writers.js"

/**
 * 批次匯入的執行半邊：parse.ts 吐出的列（中文表頭、工號／姓名、當地日期時間）→ 逐列
 * 驗證、換成既有 service 函式吃的形狀（employeeId、ISO 時間、shiftId…）→ dryRun 只
 * 驗證不寫，否則只寫沒錯的列（跟現有 CSV 匯入一致）。回應形狀見 batch-import-contract.md：
 *
 *   { kind, dryRun, total, valid, errors: [{ line, message }], imported?, result? }
 *
 *   • total  = 資料列數（不含表頭、空列；範例列沒刪的列算在內並回報）
 *   • valid  = 通過驗證、可匯入的列數
 *   • errors = 每列一則，line 是 Excel 列號；web 端顯示成「第 {line} 列：{message}」，
 *              所以 message 不要再帶列號
 *   • imported = 非 dryRun 時實際寫入筆數
 *   • result = kind 專屬：employees → BulkInviteSummary（列號已換成 Excel 列號）；
 *              holidays → { year, generated, imported, skipped }
 */

export interface ImportRowError {
  line: number
  message: string
}

export interface ImportRunResult {
  kind: ImportKind
  dryRun: boolean
  total: number
  valid: number
  errors: ImportRowError[]
  imported?: number
  result?: unknown
}

export interface RunImportOptions {
  dryRun: boolean
  options?: Record<string, unknown>
  /** 呼叫者的 employees.id（employees kind 的稽核用）。 */
  actorEmpId?: string | null
  /** parse 階段的提醒（範例列未刪），併入 errors、算進 total。 */
  warnings?: ImportRowError[]
}

/* ── 小工具：日期／時間／數字／允許值 ─────────────────────────────── */

const DATE_RE = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/
const TIME_RE = /^(\d{1,2})[:：時](\d{1,2})(?:[:：分](\d{1,2})秒?)?$/
const TIME_COMPACT_RE = /^(\d{2})(\d{2})$/

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** 「2026-09-15」「2026/9/15」「2026.09.15」「2026-09-15 09:00」→ { date: 'YYYY-MM-DD', time?: 'HH:MM' }；不合法 → null。 */
export function parseDateInput(raw: string): { date: string; time?: string } | null {
  const s = raw.trim()
  if (!s) return null
  const [datePart, ...rest] = s.split(/\s+/)
  const m = DATE_RE.exec(datePart)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  const date = `${String(y).padStart(4, "0")}-${pad2(mo)}-${pad2(d)}`
  const timePart = rest.join("")
  if (!timePart) return { date }
  const time = parseTimeInput(timePart)
  return time ? { date, time } : null
}

/** 「9:00」「09:00」「09:00:00」「0900」→ 'HH:MM'；不合法 → null。 */
export function parseTimeInput(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let hh: number
  let mm: number
  const m = TIME_RE.exec(s)
  if (m) {
    hh = Number(m[1])
    mm = Number(m[2])
  } else {
    const c = TIME_COMPACT_RE.exec(s)
    if (!c) return null
    hh = Number(c[1])
    mm = Number(c[2])
  }
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return `${pad2(hh)}:${pad2(mm)}`
}

/** 「45,000」「NT$45000」「45000.5」→ number（≥ 0）；不合法 → null。 */
export function parseAmountInput(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "").replace(/^(NT\$|NTD|TWD|\$|元)/i, "").replace(/元$/, "")
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 中文標籤與英文代碼都接受：{ regular: "正職" } → { 正職→regular, regular→regular }。 */
function enumMap(labels: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [code, label] of Object.entries(labels)) {
    m.set(normalizeToken(label), code)
    m.set(normalizeToken(code), code)
  }
  return m
}

const PUNCH_TYPES = enumMap(PUNCH_TYPE_LABELS)
const EMPLOYMENT_TYPES = enumMap(EMPLOYMENT_TYPE_LABELS)
const ROLES = enumMap(ROLE_LABELS)
const SCHEDULE_STATUSES = enumMap(SCHEDULE_STATUS_LABELS)

function allowed(labels: Record<string, string>): string {
  return Object.values(labels).join("／")
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 每個 kind 共用的「一列的結論」。 */
type RowOutcome<T> = { ok: true; value: T } | { ok: false; message: string }

function fail<T>(message: string): RowOutcome<T> {
  return { ok: false, message }
}

/** 逐列驗證 + 同檔重複偵測，回 valid 列與 errors。 */
function validateRows<T>(
  rows: ParsedImportRow[],
  validate: (values: Record<string, string>, line: number) => RowOutcome<T>,
  dedupeKey?: (value: T) => string,
  duplicateMessage = "與第 {line} 列重複",
): { valid: Array<{ line: number; value: T }>; errors: ImportRowError[] } {
  const valid: Array<{ line: number; value: T }> = []
  const errors: ImportRowError[] = []
  const seen = new Map<string, number>()
  for (const row of rows) {
    const outcome = validate(row.values, row.line)
    if (!outcome.ok) {
      errors.push({ line: row.line, message: outcome.message })
      continue
    }
    if (dedupeKey) {
      const key = dedupeKey(outcome.value)
      const firstLine = seen.get(key)
      if (firstLine !== undefined) {
        errors.push({ line: row.line, message: duplicateMessage.replace("{line}", String(firstLine)) })
        continue
      }
      seen.set(key, row.line)
    }
    valid.push({ line: row.line, value: outcome.value })
  }
  return { valid, errors }
}

function requireDate(raw: string, label: string): RowOutcome<string> {
  if (!raw.trim()) return fail(`「${label}」必填`)
  const parsed = parseDateInput(raw)
  if (!parsed) return fail(`「${label}」格式錯誤（${raw.trim()}），請用 YYYY-MM-DD`)
  return { ok: true, value: parsed.date }
}

function optionalDate(raw: string, label: string): RowOutcome<string | null> {
  if (!raw.trim()) return { ok: true, value: null }
  const r = requireDate(raw, label)
  return r.ok ? { ok: true, value: r.value } : r
}

/* ── punches ──────────────────────────────────────────────────────── */

async function runPunches(tenantId: string, rows: ParsedImportRow[], dryRun: boolean) {
  const [resolver, tz] = await Promise.all([resolveEmployees(tenantId), getTenantTimezone(tenantId)])
  const { valid, errors } = validateRows<ManualPunchRecord>(
    rows,
    (v, line) => {
      const emp = resolver.resolve(v.empNo, v.name)
      if (!emp.ok) return fail(emp.message)
      const date = parseDateInput(v.date)
      if (!v.date.trim()) return fail("「日期」必填")
      if (!date) return fail(`「日期」格式錯誤（${v.date}），請用 YYYY-MM-DD`)
      // 時間欄空白但日期儲存格本身帶時間（Excel 的日期時間格式）→ 用它。
      const timeRaw = v.time.trim() || date.time || ""
      if (!timeRaw) return fail("「時間」必填")
      const time = parseTimeInput(timeRaw)
      if (!time) return fail(`「時間」格式錯誤（${timeRaw}），請用 24 小時制 HH:MM`)
      const type = PUNCH_TYPES.get(normalizeToken(v.type))
      if (!v.type.trim()) return fail("「類型」必填")
      if (!type) return fail(`「類型」須為 ${allowed(PUNCH_TYPE_LABELS)}（填的是「${v.type}」）`)
      const [hh, mm] = time.split(":").map(Number)
      const punchAt = zonedTimeToUtc(date.date, hh, mm, tz).toISOString()
      return { ok: true, value: { line, employeeId: emp.employee.id, punchAt, type: type as PunchType } }
    },
    (r) => `${r.employeeId}|${r.punchAt}|${r.type}`,
    "與第 {line} 列重複（同一人、同一時間、同一類型）",
  )
  const out: Partial<ImportRunResult> = { valid: valid.length, errors }
  if (!dryRun) {
    const { ids, errors: writeErrors } = await importManualPunches(
      tenantId,
      valid.map((r) => r.value),
      "POST /imports/punches",
    )
    for (const e of writeErrors) errors.push({ line: e.line, message: "找不到員工（可能剛被刪除）" })
    out.valid = valid.length - writeErrors.length
    out.imported = ids.length
  }
  return out
}

/* ── schedules ────────────────────────────────────────────────────── */

async function runSchedules(tenantId: string, rows: ParsedImportRow[], dryRun: boolean) {
  const [resolver, shifts] = await Promise.all([resolveEmployees(tenantId), loadShifts(tenantId)])
  const shiftByName = new NameResolver(shifts)
  const { valid, errors } = validateRows<ScheduleAssignment>(
    rows,
    (v) => {
      const emp = resolver.resolve(v.empNo, v.name)
      if (!emp.ok) return fail(emp.message)
      const date = requireDate(v.date, "日期")
      if (!date.ok) return date
      let shiftId: string | null = null
      if (v.shift.trim()) {
        shiftId = shiftByName.get(v.shift)
        if (!shiftId) return fail(`找不到班別「${v.shift.trim()}」（見範本的「班別清單」）`)
      }
      let status = "scheduled"
      if (v.status.trim()) {
        const mapped = SCHEDULE_STATUSES.get(normalizeToken(v.status))
        if (!mapped) return fail(`「狀態」須為 ${allowed(SCHEDULE_STATUS_LABELS)}（填的是「${v.status}」）`)
        status = mapped
      }
      return { ok: true, value: { employeeId: emp.employee.id, workDate: date.value, shiftId, status } }
    },
    (a) => `${a.employeeId}|${a.workDate}`,
    "同一位員工同一天在第 {line} 列已經出現過",
  )
  const out: Partial<ImportRunResult> = { valid: valid.length, errors }
  if (!dryRun) {
    const { ids } = await upsertScheduleAssignments(
      tenantId,
      valid.map((r) => r.value),
      "POST /imports/schedules",
    )
    out.imported = ids.length
  }
  return out
}

/* ── salary-adjustments ───────────────────────────────────────────── */

async function runSalaryAdjustments(tenantId: string, rows: ParsedImportRow[], dryRun: boolean) {
  const resolver = await resolveEmployees(tenantId)
  const { valid, errors } = validateRows<SalaryAdjustmentInput>(
    rows,
    (v) => {
      const emp = resolver.resolve(v.empNo, v.name)
      if (!emp.ok) return fail(emp.message)
      const date = requireDate(v.effectiveDate, "生效日")
      if (!date.ok) return date
      if (!v.newSalary.trim()) return fail("「新薪資」必填")
      const amount = parseAmountInput(v.newSalary)
      if (amount === null) return fail(`「新薪資」須為不小於 0 的數字（填的是「${v.newSalary}」）`)
      return {
        ok: true,
        value: { employeeId: emp.employee.id, effectiveDate: date.value, newSalary: amount, reason: v.reason.trim() || null },
      }
    },
    (a) => `${a.employeeId}|${a.effectiveDate}`,
    "同一位員工同一個生效日在第 {line} 列已經出現過",
  )
  const out: Partial<ImportRunResult> = { valid: valid.length, errors }
  if (!dryRun) {
    const { ids } = await insertSalaryAdjustments(
      tenantId,
      valid.map((r) => r.value),
      "POST /imports/salary-adjustments",
    )
    out.imported = ids.length
  }
  return out
}

/* ── onboardings ──────────────────────────────────────────────────── */

async function runOnboardings(tenantId: string, rows: ParsedImportRow[], dryRun: boolean) {
  const [resolver, departments] = await Promise.all([resolveEmployees(tenantId), loadDepartments(tenantId)])
  const deptByName = new NameResolver(departments)
  const { valid, errors } = validateRows<OnboardingInput>(rows, (v) => {
    const name = v.name.trim()
    if (!name) return fail("「姓名」必填")
    const reportDate = optionalDate(v.reportDate, "報到日")
    if (!reportDate.ok) return reportDate
    let employmentType = "regular"
    if (v.employmentType.trim()) {
      const mapped = EMPLOYMENT_TYPES.get(normalizeToken(v.employmentType))
      if (!mapped) return fail(`「僱用類型」須為 ${allowed(EMPLOYMENT_TYPE_LABELS)}（填的是「${v.employmentType}」）`)
      employmentType = mapped
    }
    let deptId: string | null = null
    if (v.deptName.trim()) {
      deptId = deptByName.get(v.deptName)
      if (!deptId) return fail(`找不到部門「${v.deptName.trim()}」（見範本的「部門清單」）`)
    }
    let managerEmpId: string | null = null
    if (v.managerEmpNo.trim()) {
      const mgr = resolver.byEmpNoOnly(v.managerEmpNo)
      if (!mgr.ok) return fail(`主管：${mgr.message}`)
      managerEmpId = mgr.employee.id
    }
    return {
      ok: true,
      value: {
        name,
        reportDate: reportDate.value,
        identityType: v.identityType.trim() || null,
        region: v.region.trim() || null,
        employmentType,
        deptId,
        managerEmpId,
      },
    }
  })
  const out: Partial<ImportRunResult> = { valid: valid.length, errors }
  if (!dryRun) {
    const { ids } = await insertOnboardings(
      tenantId,
      valid.map((r) => r.value),
      "POST /imports/onboardings",
    )
    out.imported = ids.length
  }
  return out
}

/* ── employees（批次建立帳號 → bulkInviteFromCsv） ─────────────────── */

interface EmployeeInviteRow {
  name: string
  email: string
  empNo: string
  deptName: string
  employmentType: string
  hireDate: string
  role: string
}

function csvCell(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * dryRun 用：照 bulkInviteFromCsv 的規則預判這一列會綁到哪一列／會不會被拒
 * （工號→唯一未綁列；沒工號→唯一同名在職未綁列；已綁／同名多人 → 錯誤）。
 * `claimed` 記住同一份檔案裡已被前面的列認領的員工，第二列就會被拒。
 */
function previewBindTarget(
  employees: EmployeeRef[],
  empNo: string,
  name: string,
  claimed: Set<string>,
): { ok: true; targetId: string | null } | { ok: false; message: string } {
  const free = (e: EmployeeRef) => !e.hasUser && !claimed.has(e.id)
  if (empNo) {
    const hits = employees.filter((e) => e.empNo === empNo)
    const freeHits = hits.filter(free)
    if (freeHits.length === 1) return { ok: true, targetId: freeHits[0].id }
    if (freeHits.length > 1) return { ok: false, message: `工號 ${empNo} 有 ${freeHits.length} 列未綁帳號的員工，請先整理` }
    if (hits.length > 0) return { ok: false, message: `工號 ${empNo} 的員工已有登入帳號` }
  }
  const sameName = employees.filter((e) => e.name === name && e.status === "active" && free(e))
  if (sameName.length === 1) return { ok: true, targetId: sameName[0].id }
  if (sameName.length > 1) return { ok: false, message: `有 ${sameName.length} 位同名且未綁帳號的員工，請補工號` }
  return { ok: true, targetId: null }
}

/** dryRun 用：這個 Email 現在能不能拿來建／綁帳號（無副作用，不產生任何 token）。 */
async function previewEmailStatus(tenantId: string, email: string): Promise<string | null> {
  if (isPlatformAdminEmail(email)) return "此 Email 已屬於其他公司的帳號"
  const found = await findAuthUserByEmail(email)
  if (!found) return null
  if (!belongsToTenant(found, tenantId)) return "此 Email 已屬於其他公司的帳號"
  const { data: bound, error } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("user_id", found.id)
    .maybeSingle()
  if (error) throw new Error(`POST /imports/employees (bound): ${error.message}`)
  if (bound) return `此 Email 已綁定員工「${bound.name as string}」`
  return null
}

async function runEmployees(
  tenantId: string,
  rows: ParsedImportRow[],
  dryRun: boolean,
  options: Record<string, unknown>,
  actorEmpId: string | null | undefined,
) {
  const resolver = await resolveEmployees(tenantId)
  const { valid, errors } = validateRows<EmployeeInviteRow>(
    rows,
    (v) => {
      const name = v.name.trim()
      if (!name) return fail("「姓名」必填")
      const email = v.email.trim().toLowerCase()
      if (!email) return fail("「Email」必填")
      if (!EMAIL_RE.test(email)) return fail(`「Email」格式錯誤（${v.email.trim()}）`)
      const hireDate = optionalDate(v.hireDate, "到職日")
      if (!hireDate.ok) return hireDate
      let employmentType = ""
      if (v.employmentType.trim()) {
        const mapped = EMPLOYMENT_TYPES.get(normalizeToken(v.employmentType))
        if (!mapped) return fail(`「僱用類型」須為 ${allowed(EMPLOYMENT_TYPE_LABELS)}（填的是「${v.employmentType}」）`)
        employmentType = mapped
      }
      let role = ""
      if (v.role.trim()) {
        const mapped = ROLES.get(normalizeToken(v.role))
        if (!mapped) return fail(`「角色」須為 ${allowed(ROLE_LABELS)}（填的是「${v.role}」）`)
        role = mapped
      }
      return {
        ok: true,
        value: {
          name,
          email,
          empNo: v.empNo.trim(),
          deptName: v.deptName.trim(),
          employmentType,
          hireDate: hireDate.value ?? "",
          role,
        },
      }
    },
    (r) => r.email,
    "Email 與第 {line} 列重複",
  )

  if (dryRun) {
    // 只驗證：照 bulkInviteFromCsv 的規則預判綁定對象與 Email 狀態，不建帳號、不產 token。
    const claimed = new Set<string>()
    const survivors: typeof valid = []
    for (const row of valid) {
      const bind = previewBindTarget(resolver.all, row.value.empNo, row.value.name, claimed)
      if (!bind.ok) {
        errors.push({ line: row.line, message: bind.message })
        continue
      }
      const emailProblem = await previewEmailStatus(tenantId, row.value.email)
      if (emailProblem) {
        errors.push({ line: row.line, message: emailProblem })
        continue
      }
      if (bind.targetId) claimed.add(bind.targetId)
      survivors.push(row)
    }
    return { valid: survivors.length, errors } as Partial<ImportRunResult>
  }

  if (valid.length === 0) return { valid: 0, errors, imported: 0 } as Partial<ImportRunResult>

  // 組成 CSV 交給既有的 bulkInviteFromCsv（欄位用引號包住，逗號／引號都安全）。
  // CSV 第 1 列是表頭，第 k 列（k ≥ 2）對應 valid[k-2]，之後把 summary 的列號換回 Excel 列號。
  const header = ["name", "email", "empNo", "deptName", "employmentType", "hireDate", "role"]
  const lines = [header.join(",")]
  for (const row of valid) {
    const r = row.value
    lines.push([r.name, r.email, r.empNo, r.deptName, r.employmentType, r.hireDate, r.role].map(csvCell).join(","))
  }
  const summary = await bulkInviteFromCsv({
    tenantId,
    csv: lines.join("\n"),
    dryRun: options.dryRunInvite === true,
    actorEmpId: actorEmpId ?? null,
    context: "POST /imports/employees",
  })
  const excelLine = (csvLine: number): number => valid[csvLine - 2]?.line ?? csvLine
  const remapped: BulkInviteSummary = {
    ...summary,
    errors: summary.errors.map((e) => ({ line: excelLine(e.line), error: e.error })),
    rows: summary.rows.map((r) => ({ ...r, line: excelLine(r.line) })),
  }
  for (const e of remapped.errors) errors.push({ line: e.line, message: e.error })
  return {
    valid: valid.length,
    errors,
    imported: summary.created + summary.bound,
    result: remapped,
  } as Partial<ImportRunResult>
}

/* ── holidays（→ generateTenantCalendar） ─────────────────────────── */

async function runHolidays(tenantId: string, rows: ParsedImportRow[], dryRun: boolean) {
  let year: number | null = null
  const { valid, errors } = validateRows<HolidayInput>(
    rows,
    (v) => {
      const date = requireDate(v.date, "日期")
      if (!date.ok) return date
      const label = v.label.trim()
      if (label.length > 120) return fail("「名稱」最多 120 字")
      const y = Number(date.value.slice(0, 4))
      if (year === null) year = y
      else if (y !== year) return fail(`年份與第一筆（${year} 年）不同，一個檔案只能含同一年的日期`)
      return { ok: true, value: { date: date.value, label: label || null } }
    },
    (h) => h.date,
    "日期與第 {line} 列重複",
  )
  const out: Partial<ImportRunResult> = { valid: valid.length, errors }
  if (!dryRun) {
    if (valid.length === 0 || year === null) {
      out.imported = 0
      return out
    }
    const result = await generateTenantCalendar(
      tenantId,
      year,
      valid.map((r) => r.value),
      "POST /imports/holidays",
    )
    out.imported = result.imported
    out.result = result
  }
  return out
}

/* ── 入口 ─────────────────────────────────────────────────────────── */

export async function runImport(
  kind: ImportKind,
  tenantId: string,
  rows: ParsedImportRow[],
  opts: RunImportOptions,
): Promise<ImportRunResult> {
  const dryRun = !!opts.dryRun
  const options = opts.options ?? {}
  let partial: Partial<ImportRunResult>
  switch (kind) {
    case "punches":
      partial = await runPunches(tenantId, rows, dryRun)
      break
    case "schedules":
      partial = await runSchedules(tenantId, rows, dryRun)
      break
    case "salary-adjustments":
      partial = await runSalaryAdjustments(tenantId, rows, dryRun)
      break
    case "onboardings":
      partial = await runOnboardings(tenantId, rows, dryRun)
      break
    case "employees":
      partial = await runEmployees(tenantId, rows, dryRun, options, opts.actorEmpId)
      break
    case "holidays":
      partial = await runHolidays(tenantId, rows, dryRun)
      break
    default: {
      const never: never = kind
      throw new Error(`runImport: unknown kind ${String(never)}`)
    }
  }
  const warnings = opts.warnings ?? []
  const errors = [...(partial.errors ?? []), ...warnings].sort((a, b) => a.line - b.line)
  const result: ImportRunResult = {
    kind,
    dryRun,
    total: rows.length + warnings.length,
    valid: partial.valid ?? 0,
    errors,
  }
  if (partial.imported !== undefined) result.imported = partial.imported
  if (partial.result !== undefined) result.result = partial.result
  return result
}
