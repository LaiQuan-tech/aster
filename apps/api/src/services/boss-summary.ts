import { supabaseAdmin } from "../lib/supabase.js"
import { isEmployedOn } from "./employment-status.js"
import { logger } from "../lib/logger.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { addDaysKey, monthRangeKeys } from "../lib/tz.js"
import { defaultCompanyOf, loadTenantCompanies, type CompanyLite } from "./project-company.js"
import { buildReceivables, loadP3Settings } from "./project-application-store.js"
import { overdueDays, type OverdueBasis } from "./project-money.js"

/**
 * 後台首頁（老闆看板）的彙總端點 GET /dashboard/boss-summary（2026-10-25 業主核准）。
 * 首頁「待處理」「人事」兩區要的數字一次回傳，免得首頁打十幾支 API；「集團總覽」區沿用 GET /group-overview，
 * 這裡只補它沒有的「各公司逾期應收」。
 *
 * ── 角色裁切（bossSummaryScope）────────────────────────────────────────
 *   • hr_admin／platform_admin：全部。
 *   • accountant：比照後台導覽（web lib/admin-nav.ts roleNavOf：tenants.features.roles.accountant 覆蓋，
 *     沒設＝ACCOUNTANT_DEFAULT_NAV）——放款待簽核看「財務 → 放款」分頁、出勤異常／合規警示看「出勤 → 出勤月表」分頁。
 *     假單待簽（HR 全租戶口徑）、加班超額另計（薪資級，API 本身 requireHrAdmin）、人事（/dashboard/headcount
 *     requireHrAdmin）、各公司逾期應收（集團總覽是 hrOnly）一律不給。
 *   看不到的區塊回 null，`scope` 告訴前端哪些是「沒權限」、哪些是「查詢失敗」。
 *
 * ── 失敗降級 ──────────────────────────────────────────────────────────
 *   每個子查詢各自 try/catch（settle）：失敗只讓該欄為 null 並寫 warn log，整支不回 500。
 *
 * ── 口徑 ──────────────────────────────────────────────────────────────
 *   • 期間＝租戶當地「本月」（period＝YYYY-MM）。
 *   • 假單待簽：leave_requests status=pending、未刪除（與 GET /requests?status=pending&countOnly=1 的 HR 口徑相同）。
 *   • 放款待簽：disbursements status=pending_approval（＝/disbursements/pending-approvals?scope=all 的母體），另回金額合計。
 *   • 出勤異常：本月出勤月表（attendance_sheets＋attendance_sheet_days.anomalies＋month_anomalies）的 error／warn 件數，
 *     **不含**下面五個合規碼（另列，不重複計）；anomalySheets＝有任何 error／warn 的月表張數（＝月表頁「只看異常」的筆數）。
 *     本月月表還沒產生時 sheetCount＝0，數字都是 0，前端顯示「本月月表尚未產生」。
 *   • 合規警示（10/17 月表異常碼）：seven_day_rule／regular_leave_work／daily_over_12h／monthly_ot_over_46h 逐件計數。
 *   • 加班超上限人數：本月月表有 overtime_beyond_cap(_unapproved) 異常的人數（M1 月加班上限，預設 40h）。
 *   • 待發加班另計：overtime_settlements status=draft 全部期別（分頁讀完）的筆數與金額合計（金額未填的另計 missingAmount 筆）；
 *     首頁連到另計頁「未付款＋所有月份」（?status=draft&all=1）。
 *   • 人事：在職＝到職日 ≤ 今天且（未離職或離職日 ≥ 今天）；本月新進／離職＝到職日／離職日落在本月
 *     （與 /dashboard/headcount 同一套欄位：沒填到職日視為一直在職）。
 *   • 各公司逾期應收：與 /projects/receivables 同一份 buildReceivables＋租戶逾期起算基準，取 overdueDays > 0 的期別，
 *     依專案承接公司（projects.company_id，null＝預設公司）加總未收金額；查不到的公司歸「（未歸屬公司）」。
 */

export const UNASSIGNED_COMPANY_ID = "unassigned"
export const UNASSIGNED_COMPANY_NAME = "（未歸屬公司）"

/** PostgREST max-rows＝1000：可能超過的查詢一律分頁。 */
const PAGE_SIZE = 1000

/* ──────────────────────────────────────────────────────────────────
 * 角色裁切
 * ────────────────────────────────────────────────────────────────── */

export type BossScope = {
  leaveApprovals: boolean
  disbursementApprovals: boolean
  attendance: boolean
  overtime: boolean
  people: boolean
  receivablesByCompany: boolean
}

/** 會計預設可見範圍——與 web lib/admin-nav.ts ACCOUNTANT_DEFAULT_NAV 同步（這裡只需要用到的兩個分頁）。 */
const ACCOUNTANT_DEFAULT_SECTIONS: readonly string[] = ["home", "finance", "attendance", "payroll", "people", "settings"]
const ACCOUNTANT_DEFAULT_TABS: Readonly<Record<string, readonly string[]>> = {
  finance: ["projects", "overview", "receivables", "disbursements", "reports", "directory"],
  attendance: ["sheets"],
  payroll: ["expenses", "advances"],
  people: ["employees"],
  settings: ["optionLists"],
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/**
 * 會計能不能看某個後台分頁（web roleNavOf＋sanitizeRoleNav 的鏡像）：
 * features.roles.accountant 不是物件 → 預設範圍；是物件 → sections 有陣列就用它（否則預設），
 * tabs 只看覆蓋值本身（分區沒列＝該區全部分頁）。
 */
export function accountantTabAllowed(features: unknown, section: string, tab: string): boolean {
  const roles = isRecord(features) ? features.roles : null
  const raw = isRecord(roles) ? roles.accountant : null
  if (!isRecord(raw)) {
    return ACCOUNTANT_DEFAULT_SECTIONS.includes(section) && (ACCOUNTANT_DEFAULT_TABS[section]?.includes(tab) ?? true)
  }
  const sections = Array.isArray(raw.sections)
    ? raw.sections.filter((s): s is string => typeof s === "string")
    : ACCOUNTANT_DEFAULT_SECTIONS
  if (!sections.includes(section)) return false
  const tabs = isRecord(raw.tabs) ? raw.tabs[section] : undefined
  if (!Array.isArray(tabs)) return true
  return tabs.includes(tab)
}

export function bossSummaryScope(role: string | null | undefined, features: unknown): BossScope {
  if (role === "hr_admin" || role === "platform_admin") {
    return { leaveApprovals: true, disbursementApprovals: true, attendance: true, overtime: true, people: true, receivablesByCompany: true }
  }
  if (role === "accountant") {
    return {
      leaveApprovals: false,
      disbursementApprovals: accountantTabAllowed(features, "finance", "disbursements"),
      attendance: accountantTabAllowed(features, "attendance", "sheets"),
      overtime: false,
      people: false,
      receivablesByCompany: false,
    }
  }
  return { leaveApprovals: false, disbursementApprovals: false, attendance: false, overtime: false, people: false, receivablesByCompany: false }
}

/* ──────────────────────────────────────────────────────────────────
 * 純函式：金額與彙總
 * ────────────────────────────────────────────────────────────────── */

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

/** 金額加總：以「分」整數累加再除回元（避免浮點誤差）；null／非數字略過。 */
export function sumMoney(values: Iterable<unknown>): number {
  let cents = 0
  for (const v of values) {
    const n = toNum(v)
    if (n !== null) cents += Math.round(n * 100)
  }
  return cents / 100
}

export const COMPLIANCE_CODES = ["seven_day_rule", "regular_leave_work", "daily_over_12h", "monthly_ot_over_46h"] as const
export type ComplianceCode = (typeof COMPLIANCE_CODES)[number]
/** 合規類（含 pto_work）不算進一般「出勤異常」件數，避免重複計。 */
const COMPLIANCE_FAMILY: ReadonlySet<string> = new Set<string>([...COMPLIANCE_CODES, "pto_work"])
const BEYOND_CAP_CODES: ReadonlySet<string> = new Set(["overtime_beyond_cap", "overtime_beyond_cap_unapproved"])

type AnomalyLite = { code?: unknown; severity?: unknown }
export type SheetLite = { id: string; employee_id: string; month_anomalies?: unknown }
export type SheetDayLite = { sheet_id: string; anomalies?: unknown }

export type SheetAnomalyFacts = {
  sheetCount: number
  /** error／warn、非合規碼的件數。 */
  anomalies: number
  /** 有任何 error／warn（含合規碼）的月表張數。 */
  anomalySheets: number
  compliance: {
    total: number
    sevenDayRule: number
    regularLeaveWork: number
    dailyOver12h: number
    monthlyOtOver46h: number
  }
  /** 本月有超過月加班上限分鐘的人數。 */
  overCapPeople: number
}

function anomalyList(v: unknown): AnomalyLite[] {
  return Array.isArray(v) ? (v.filter(isRecord) as AnomalyLite[]) : []
}

export function aggregateSheetAnomalies(sheets: readonly SheetLite[], days: readonly SheetDayLite[]): SheetAnomalyFacts {
  const bySheet = new Map<string, AnomalyLite[]>()
  for (const s of sheets) bySheet.set(s.id, [...anomalyList(s.month_anomalies)])
  for (const d of days) bySheet.get(d.sheet_id)?.push(...anomalyList(d.anomalies))

  const compliance = { total: 0, sevenDayRule: 0, regularLeaveWork: 0, dailyOver12h: 0, monthlyOtOver46h: 0 }
  let anomalies = 0
  let anomalySheets = 0
  const overCap = new Set<string>()
  for (const s of sheets) {
    let flagged = false
    for (const a of bySheet.get(s.id) ?? []) {
      const code = typeof a.code === "string" ? a.code : ""
      const serious = a.severity === "error" || a.severity === "warn"
      if (serious) flagged = true
      if (BEYOND_CAP_CODES.has(code)) overCap.add(s.employee_id)
      switch (code) {
        case "seven_day_rule":
          compliance.sevenDayRule += 1
          break
        case "regular_leave_work":
          compliance.regularLeaveWork += 1
          break
        case "daily_over_12h":
          compliance.dailyOver12h += 1
          break
        case "monthly_ot_over_46h":
          compliance.monthlyOtOver46h += 1
          break
        default:
          if (serious && !COMPLIANCE_FAMILY.has(code)) anomalies += 1
      }
    }
    if (flagged) anomalySheets += 1
  }
  compliance.total = compliance.sevenDayRule + compliance.regularLeaveWork + compliance.dailyOver12h + compliance.monthlyOtOver46h
  return { sheetCount: sheets.length, anomalies, anomalySheets, compliance, overCapPeople: overCap.size }
}

export type SettlementLite = { period: string | null; amount: unknown }
export type DraftSettlementFacts = { count: number; amount: number; missingAmount: number; latestPeriod: string | null }

export function summarizeDraftSettlements(rows: readonly SettlementLite[]): DraftSettlementFacts {
  let missingAmount = 0
  let latestPeriod: string | null = null
  for (const r of rows) {
    if (toNum(r.amount) === null) missingAmount += 1
    if (r.period && (latestPeriod === null || r.period > latestPeriod)) latestPeriod = r.period
  }
  return { count: rows.length, amount: sumMoney(rows.map((r) => r.amount)), missingAmount, latestPeriod }
}

export type EmployeeLite = { hire_date: string | null; terminated_at: string | null }
export type HeadcountFacts = { active: number; hires: number; exits: number }

/** 今天在職、本月新進、本月離職（period＝YYYY-MM、today＝YYYY-MM-DD，皆租戶當地）。 */
export function headcountSnapshot(rows: readonly EmployeeLite[], period: string, today: string): HeadcountFacts {
  const { from, to } = monthRangeKeys(period)
  let active = 0
  let hires = 0
  let exits = 0
  for (const e of rows) {
    const hired = e.hire_date ?? "0000-01-01"
    const term = e.terminated_at ? e.terminated_at.slice(0, 10) : null
    if (isEmployedOn(e, today)) active += 1
    if (e.hire_date && hired >= from && hired <= to) hires += 1
    if (term && term >= from && term <= to) exits += 1
  }
  return { active, hires, exits }
}

export type OverdueRowLite = { projectId: string; unreceived: number | null }
export type CompanyOverdue = { companyId: string; companyName: string; overdueAmount: number; overdueCount: number }

/**
 * 逾期期別依專案承接公司加總。`projectCompany`：專案 id → 存的 company_id（null＝預設公司）。
 * 名冊裡每家公司都回一列（沒有逾期＝0），查不到的公司另成「（未歸屬公司）」列（有金額才出現）。
 */
export function overdueByCompany(
  overdueRows: readonly OverdueRowLite[],
  projectCompany: ReadonlyMap<string, string | null>,
  companies: readonly CompanyLite[],
): CompanyOverdue[] {
  const fallback = defaultCompanyOf(companies)
  const known = new Set(companies.map((c) => c.id))
  const acc = new Map<string, { cents: number; count: number }>()
  for (const r of overdueRows) {
    const stored = projectCompany.get(r.projectId) ?? null
    const companyId = stored ? (known.has(stored) ? stored : UNASSIGNED_COMPANY_ID) : (fallback?.id ?? UNASSIGNED_COMPANY_ID)
    const cur = acc.get(companyId) ?? { cents: 0, count: 0 }
    cur.cents += Math.round((toNum(r.unreceived) ?? 0) * 100)
    cur.count += 1
    acc.set(companyId, cur)
  }
  const out: CompanyOverdue[] = companies.map((c) => {
    const a = acc.get(c.id)
    return { companyId: c.id, companyName: c.name, overdueAmount: (a?.cents ?? 0) / 100, overdueCount: a?.count ?? 0 }
  })
  const un = acc.get(UNASSIGNED_COMPANY_ID)
  if (un) out.push({ companyId: UNASSIGNED_COMPANY_ID, companyName: UNASSIGNED_COMPANY_NAME, overdueAmount: un.cents / 100, overdueCount: un.count })
  return out
}

/* ──────────────────────────────────────────────────────────────────
 * 讀取（每支獨立，失敗由 settle 降級）
 * ────────────────────────────────────────────────────────────────── */

export type BossSummaryCtx = { tenantId: string; period: string; today: string; features: unknown }

async function selectAllPages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, label: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) return out
  }
}

async function loadPendingLeave(ctx: BossSummaryCtx): Promise<number> {
  const rows = await selectAllPages<{ id: string }>(
    (from, to) =>
      supabaseAdmin
        .from("leave_requests")
        .select("id")
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "pending")
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    "boss-summary (leave_requests)",
  )
  return rows.length
}

async function loadPendingDisbursements(ctx: BossSummaryCtx): Promise<{ count: number; amount: number }> {
  const rows = await selectAllPages<{ id: string; amount: unknown }>(
    (from, to) =>
      supabaseAdmin
        .from("disbursements")
        .select("id, amount")
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "pending_approval")
        .order("id", { ascending: true })
        .range(from, to),
    "boss-summary (disbursements)",
  )
  return { count: rows.length, amount: sumMoney(rows.map((r) => r.amount)) }
}

async function loadSheetFacts(ctx: BossSummaryCtx): Promise<SheetAnomalyFacts> {
  const sheets = await selectAllPages<SheetLite>(
    (from, to) =>
      supabaseAdmin
        .from("attendance_sheets")
        .select("id, employee_id, month_anomalies")
        .eq("tenant_id", ctx.tenantId)
        .eq("period", ctx.period)
        .order("id", { ascending: true })
        .range(from, to),
    "boss-summary (attendance_sheets)",
  )
  if (sheets.length === 0) return aggregateSheetAnomalies([], [])
  const { from: monthFrom, to: monthTo } = monthRangeKeys(ctx.period)
  const days = await selectAllPages<SheetDayLite>(
    (from, to) =>
      supabaseAdmin
        .from("attendance_sheet_days")
        .select("sheet_id, anomalies")
        .eq("tenant_id", ctx.tenantId)
        .gte("work_date", monthFrom)
        .lt("work_date", addDaysKey(monthTo, 1))
        .order("id", { ascending: true })
        .range(from, to),
    "boss-summary (attendance_sheet_days)",
  )
  return aggregateSheetAnomalies(sheets, days)
}

async function loadDraftSettlements(ctx: BossSummaryCtx): Promise<DraftSettlementFacts | null> {
  // 草稿不限期別、可能超過 PostgREST max-rows → 分頁讀完；表尚未遷移（0050 未套）→ null。
  const rows: SettlementLite[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("overtime_settlements")
      .select("id, period, amount")
      .eq("tenant_id", ctx.tenantId)
      .eq("status", "draft")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      if (isMissingTableError(error)) return null
      throw new Error(`boss-summary (overtime_settlements): ${error.message}`)
    }
    const page = (data ?? []) as SettlementLite[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return summarizeDraftSettlements(rows)
}

async function loadHeadcount(ctx: BossSummaryCtx): Promise<HeadcountFacts> {
  const rows = await selectAllPages<EmployeeLite>(
    (from, to) =>
      supabaseAdmin
        .from("employees")
        .select("id, hire_date, terminated_at")
        .eq("tenant_id", ctx.tenantId)
        .order("id", { ascending: true })
        .range(from, to),
    "boss-summary (employees)",
  )
  return headcountSnapshot(rows, ctx.period, ctx.today)
}

function overdueBasisOf(features: unknown): OverdueBasis {
  const receivable = isRecord(features) ? features.receivable : null
  return isRecord(receivable) && receivable.overdueBasis === "invoiced" ? "invoiced" : "billed"
}

async function loadOverdueByCompany(ctx: BossSummaryCtx): Promise<CompanyOverdue[]> {
  const basis = overdueBasisOf(ctx.features)
  const [settings, companies] = await Promise.all([loadP3Settings(ctx.tenantId), loadTenantCompanies(ctx.tenantId)])
  const rows = await buildReceivables(ctx.tenantId, { projectIds: null, status: "open", today: ctx.today, settings })
  const overdue = rows.filter((r) => (overdueDays(r.invoicedOn, r.receivedOn, ctx.today, basis, r.billedOn, r.unreceived) ?? 0) > 0)
  const projectCompany = new Map<string, string | null>()
  const projects = await selectAllPages<{ id: string; company_id: string | null }>(
    (from, to) =>
      supabaseAdmin
        .from("projects")
        .select("id, company_id")
        .eq("tenant_id", ctx.tenantId)
        .order("id", { ascending: true })
        .range(from, to),
    "boss-summary (projects)",
  )
  for (const p of projects) projectCompany.set(p.id, p.company_id ?? null)
  return overdueByCompany(overdue, projectCompany, companies)
}

export type BossSummaryLoaders = {
  pendingLeave: (ctx: BossSummaryCtx) => Promise<number>
  pendingDisbursements: (ctx: BossSummaryCtx) => Promise<{ count: number; amount: number }>
  sheetFacts: (ctx: BossSummaryCtx) => Promise<SheetAnomalyFacts>
  draftSettlements: (ctx: BossSummaryCtx) => Promise<DraftSettlementFacts | null>
  headcount: (ctx: BossSummaryCtx) => Promise<HeadcountFacts>
  overdueByCompany: (ctx: BossSummaryCtx) => Promise<CompanyOverdue[]>
}

export const defaultBossSummaryLoaders: BossSummaryLoaders = {
  pendingLeave: loadPendingLeave,
  pendingDisbursements: loadPendingDisbursements,
  sheetFacts: loadSheetFacts,
  draftSettlements: loadDraftSettlements,
  headcount: loadHeadcount,
  overdueByCompany: loadOverdueByCompany,
}

/* ──────────────────────────────────────────────────────────────────
 * 組裝
 * ────────────────────────────────────────────────────────────────── */

export type BossSummary = {
  period: string
  today: string
  scope: BossScope
  approvals: {
    /** 待簽假單（HR 才有；其他角色 null）。 */
    leave: number | null
    /** 送簽中的放款單張數。 */
    disbursements: number | null
    disbursementAmount: number | null
    /** 可見且查得到的兩者合計；兩者都 null → null。 */
    total: number | null
  }
  attendance: {
    sheetCount: number
    anomalies: number
    anomalySheets: number
    compliance: SheetAnomalyFacts["compliance"]
  } | null
  overtime: {
    overCapPeople: number | null
    draftCount: number | null
    draftAmount: number | null
    draftMissingAmount: number | null
    latestDraftPeriod: string | null
  } | null
  people: HeadcountFacts | null
  overdueReceivablesByCompany: CompanyOverdue[] | null
}

async function settle<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (err) {
    logger.warn({ err, part: label }, "boss-summary 子查詢失敗（該欄回 null）")
    return null
  }
}

const skip = Promise.resolve(null)

export async function buildBossSummary(
  input: { tenantId: string; role: string | null | undefined; features: unknown; period: string; today: string },
  loaders: BossSummaryLoaders = defaultBossSummaryLoaders,
): Promise<BossSummary> {
  const scope = bossSummaryScope(input.role, input.features)
  const ctx: BossSummaryCtx = { tenantId: input.tenantId, period: input.period, today: input.today, features: input.features }

  const [leave, disb, sheets, drafts, people, overdue] = await Promise.all([
    scope.leaveApprovals ? settle("pendingLeave", () => loaders.pendingLeave(ctx)) : skip,
    scope.disbursementApprovals ? settle("pendingDisbursements", () => loaders.pendingDisbursements(ctx)) : skip,
    scope.attendance || scope.overtime ? settle("sheetFacts", () => loaders.sheetFacts(ctx)) : skip,
    scope.overtime ? settle("draftSettlements", () => loaders.draftSettlements(ctx)) : skip,
    scope.people ? settle("headcount", () => loaders.headcount(ctx)) : skip,
    scope.receivablesByCompany ? settle("overdueByCompany", () => loaders.overdueByCompany(ctx)) : skip,
  ])

  const visibleCounts = [leave, disb?.count ?? null].filter((n): n is number => n !== null)
  return {
    period: input.period,
    today: input.today,
    scope,
    approvals: {
      leave,
      disbursements: disb?.count ?? null,
      disbursementAmount: disb?.amount ?? null,
      total: visibleCounts.length > 0 ? visibleCounts.reduce((s, n) => s + n, 0) : null,
    },
    attendance:
      scope.attendance && sheets
        ? { sheetCount: sheets.sheetCount, anomalies: sheets.anomalies, anomalySheets: sheets.anomalySheets, compliance: sheets.compliance }
        : null,
    overtime: scope.overtime
      ? {
          overCapPeople: sheets?.overCapPeople ?? null,
          draftCount: drafts?.count ?? null,
          draftAmount: drafts?.amount ?? null,
          draftMissingAmount: drafts?.missingAmount ?? null,
          latestDraftPeriod: drafts?.latestPeriod ?? null,
        }
      : null,
    people: scope.people ? people : null,
    overdueReceivablesByCompany: scope.receivablesByCompany ? overdue : null,
  }
}
