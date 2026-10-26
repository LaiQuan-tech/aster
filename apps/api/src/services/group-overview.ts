import { supabaseAdmin } from "../lib/supabase.js"
import { employeesHaveCompany, isMissingTableError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { isEmployedOn } from "./employment-status.js"
import { defaultCompanyOf, loadTenantCompanies, type CompanyLite } from "./project-company.js"
import { effectiveBillingAmount, pct1 } from "./project-money.js"
import { isVoidedBeyondCapDraft } from "./overtime-void.js"
import { disbursementGrossCents, subcontractPaymentGrossCents } from "./project-gross-profit.js"

/**
 * 集團總覽（2026-10-11 業主拍板第一版）：跨公司彙總入帳收入、放款支出與專案毛利。
 * 2026-10-25 加上人事：各公司在職人數、薪資成本，以及「毛利扣人事成本後」（見下方「人事」）。
 *
 * ── 口徑（業主定案）────────────────────────────────────────────────
 *   • 收入（主）＝實際入帳金額，依**入帳日**（project_billings.received_on）歸月，一律**未稅**。
 *   • 已開票（應收，參考）＝依**開票日**（invoiced_on）歸月的開票金額，也是未稅；不併入收入。
 *   • 支出＝已匯款的放款：`disbursements.status='paid'`，依**匯款日**（paid_on）歸月，取**代扣前的毛額**
 *     （`amount`＋`withheld_amount`）。放款單是支出的唯一來源——下包期款經放款單付出的不另計，
 *     草稿／送簽中／已核准未付／作廢一律不計。
 *     2026-10-26 起另計**舊路徑複委託已付款**：手動標記已付、沒有經放款單的下包期款
 *     （project_subcontract_payments.disbursement_id 為空、paid_on 在期間內），毛額＝實付＋代扣
 *     （services/project-gross-profit.ts subcontractPaymentGrossCents，與獎金池毛利同口徑），依付款日歸月；
 *     公司歸期款的 paying_company_id，沒填 → 專案承接公司；關係企業看下包廠商。
 *   • 專案毛利＝入帳收入－放款支出；毛利率＝毛利÷入帳收入（收入 0 → null，畫面顯示「—」）。不含人事成本。
 *     單一專案的累計已實現毛利（獎金池用，2026-10-26）在 services/project-gross-profit.ts：同一個放款毛額口徑，
 *     依 disbursement_allocations 落到專案，另計舊路徑（沒經放款單）已付的複委託期款。
 *
 * ── 未稅怎麼查證的（不必換算）────────────────────────────────────────
 *   `project_billings` 沒有含稅欄位，全表金額都是未稅，開票時才另外加 5% 營業稅、系統不存稅額：
 *   • `POST /billings/:id/receive`：沒帶 receivedAmount 時預設＝該期有效金額（未稅），見 routes/billings.ts；
 *   • 未收款＝有效金額（未稅）－ received_amount（services/project-money.ts computeMoney、
 *     project-application-store.ts），received_amount 與合約額（未稅）直接相減；
 *   • 獎金試算 received_pct＝Σ received_amount ÷ 未稅合約額（services/bonus-run.ts、bonus-run-store.ts loadInputs）；
 *   • 開票沒有自己的金額欄：開的是這一期的有效金額 ＝ 已請款金額 ?? 覆寫金額 ?? 試算金額
 *     （project-money.ts effectiveBillingAmount，與 /projects/:id/billings 的 invoicedTotal 同一條規則）。
 *   所以這裡把入帳金額與開票的有效金額**原樣加總**，不乘 1.05 也不除 1.05。
 *
 * ── 公司歸屬 ──────────────────────────────────────────────────────
 *   • 收入／開票歸專案的承接公司 `projects.company_id`；null 視為租戶預設公司（`companies.is_default`，
 *     舊專案一律是 null，所以讀取時解析、不回頭 backfill）。
 *   • 放款歸 `disbursements.paying_company_id`。
 *   • 存的公司 id 不在本租戶名冊裡（FK 擋不了跨租戶，但寫入路徑都驗過，理論上不會發生）、或租戶一家
 *     預設公司都沒有時，金額歸「（未歸屬公司）」這一列——寧可多一列，也不讓錢從合計裡無聲消失。
 *
 * ── 關係企業剔除 ──────────────────────────────────────────────────
 *   `clients.is_affiliate`／`vendors.is_affiliate`（0062）。**只影響集團合計**：各公司自己的數字照常包含，
 *   另外回報「其中關係企業往來」；集團合計＝納入公司各自（數字－關係企業往來）的總和。
 *     收入／開票：專案客戶是關係企業；放款：收款廠商是關係企業。
 *
 * ── 資料品質提醒（dataQuality）────────────────────────────────────
 *   「依入帳日歸月、一律未稅」有兩個前提靠人工輸入守住，這裡不猜、不改數字，只把可疑的列攤出來讓人核對：
 *   • `undatedReceived`：有 received_amount 卻沒有 received_on 的期別（DB 只擋「有日期沒金額」，反過來擋不住；
 *     bonus-run-store.ts 把這種列算成已收）——沒有入帳日就無法歸月，所以不在任何一個月的收入裡（租戶全部期別）。
 *   • `receivedOverEffective`：該年入帳的期別中，實收大於該期有效金額（未稅）超過 1 元者——典型症狀是把銀行入帳的
 *     含稅金額（未稅×1.05）當成未稅填進去，收入會因此灌水 5%。部分入帳（實收較少）、剛好收足都不算。
 *
 * ── 人事（2026-10-25，員工所屬公司 employees.company_id，migration 0072）────────────
 *   • 在職人數（headcount）＝今天（租戶當地）在職：到職日 ≤ 今天且（沒有離職日或離職日 ≥ 今天），與後台首頁人事區
 *     （services/boss-summary.ts）同一個 helper（services/employment-status.ts isEmployedOn）；依員工**目前**的所屬公司歸屬，
 *     換年度／月份不變。
 *   • 人事成本（payrollCost）＝**應發（gross）口徑**：期間內（payslips.period 'YYYY-MM' 落在年度／月份）已產生的薪資單
 *     應發合計，草稿與已定稿都算（畫面附註草稿張數）。gross **未扣**請假／遲到早退扣款、**不含**雇主負擔（勞健保、勞退
 *     雇主提繳——payslips 沒有這些欄位）、**不含**加班超額另計（overtime_settlements）與各種獎金（獎金試算、三節獎金）。
 *     同樣依員工**目前**的所屬公司歸屬，離職員工的薪資單照算。口徑文字在 PAYROLL_BASIS_NOTE（API 回應 payroll.basisNote）。
 *   • 補充（頁面以 gross 為主、這兩個只做補充顯示）：
 *       payrollCostNet          ＝ gross −（breakdown.leaveDeduction ＋ breakdown.lateEarlyDeduction）；舊薪資單沒有這兩鍵當 0。
 *       overtimeSettlementCost  ＝ 同期間 overtime_settlements（status draft／paid）的 amount 合計，依員工所屬公司歸屬；
 *                                 amount 為空（補休或未定案）不計、張數另報。表不存在 → null。
 *   • monthly[] 每個月另有 payrollCost（依 payslip period；那個月整個租戶沒有任何薪資單 → null），首頁「本月」可直接取。
 *   • company_id 為 NULL（未指派）、指到不在本租戶名冊的公司、或 0072 還沒套 → 列在「未指派」
 *     （group.unassignedHeadcount／unassignedPayrollCost），**不分攤**到任何公司。
 *   • 各公司「扣人事成本後」＝毛利－該公司人事成本（gross）。集團合計的人事成本＝納入合計的公司＋未指派（集團整體真的付出去的錢），
 *     集團「扣人事成本後」＝集團毛利－集團人事成本。
 *   • 期間內一張薪資單都沒有（例如正式庫還沒跑過薪資）→ payrollCost／payrollCostNet／扣人事成本後一律 null
 *     （畫面顯示「尚無薪資資料」），不用 0 假裝「人事成本是零」。
 *
 * ── 計算方式 ──────────────────────────────────────────────────────
 *   一次撈整年的事件（入帳／開票／匯款）→ 在記憶體裡依「公司×月」加總，月份、公司排除、關係企業剔除都只是
 *   對同一份事件換切法；查詢次數與公司家數無關。金額以「分」為單位的整數加總，最後才除回元，避免浮點累加誤差。
 *   日期欄位是 DB 的 date（'YYYY-MM-DD'），月份直接切字串，不建 Date、不看時區。
 */

/** 查不到歸屬公司時的假列 id／名稱（見檔頭「公司歸屬」）。 */
export const UNASSIGNED_COMPANY_ID = "unassigned"
export const UNASSIGNED_COMPANY_NAME = "（未歸屬公司）"

/** 下鑽列表最多回幾筆（依金額排序，超過的只算在 total／count 裡）。 */
export const DETAIL_LIMIT = 50

/** PostgREST max-rows＝1000：單次 select 超過會被靜默截斷，筆數會隨資料量長大的查詢一律用 `.range()` 分頁。 */
const PAGE_SIZE = 1000
/** `.in()` 的 id 清單分批大小（網址長度上限）。 */
const ID_CHUNK = 100

const ALL_MONTHS: readonly number[] = Array.from({ length: 12 }, (_, i) => i + 1)

/* ──────────────────────────────────────────────────────────────────
 * 輸入列（PostgREST 回來的形狀）
 * ────────────────────────────────────────────────────────────────── */

type Numeric = number | string | null

export type BillingInputRow = {
  id: string
  project_id: string
  installment_no?: number | null
  billed_on: string | null
  billed_amount: Numeric
  override_amount: Numeric
  calculated_amount: Numeric
  invoiced_on: string | null
  received_on: string | null
  received_amount: Numeric
}

/** 有入帳金額卻沒有入帳日的期別（見檔頭「資料品質提醒」）。 */
export type UndatedReceivedRow = {
  id: string
  project_id: string
  installment_no?: number | null
  received_amount: Numeric
}

export type ProjectInputRow = {
  id: string
  code: string | null
  name: string
  company_id: string | null
  client_id: string | null
}

export type ClientInputRow = {
  id: string
  name: string
  short_name?: string | null
  is_affiliate: boolean | null
}

export type DisbursementInputRow = {
  id: string
  status: string
  paid_on: string | null
  paying_company_id: string | null
  vendor_id: string | null
  payee_kind?: string | null
  payee_name: string | null
  amount: Numeric
  withheld_amount: Numeric
}

/** 舊路徑（沒經放款單）已付的複委託期款，已併上所屬副委託的專案與廠商。 */
export type LegacySubcontractPaymentInputRow = {
  id: string
  paid_on: string | null
  paid_amount: Numeric
  withheld_amount: Numeric
  paying_company_id: string | null
  project_id: string | null
  vendor_id: string | null
  vendor_name: string | null
}

export type VendorInputRow = {
  id: string
  name: string
  short_name?: string | null
  is_affiliate: boolean | null
}

/** 員工（人事歸屬用）；company_id 在 0072 未套時不存在。 */
export type EmployeeInputRow = {
  id: string
  status?: string | null
  hire_date?: string | null
  terminated_at?: string | null
  company_id?: string | null
}

/** 期間內的薪資單（payslips）。 */
export type PayslipInputRow = {
  employee_id: string
  /** 'YYYY-MM'。 */
  period: string
  gross: Numeric
  status: string | null
  /** 引擎完整輸出（只讀 leaveDeduction／lateEarlyDeduction）。 */
  breakdown?: unknown
}

/** 期間內的加班超額另計（overtime_settlements，status draft／paid）。 */
export type OvertimeSettlementInputRow = {
  employee_id: string
  /** 'YYYY-MM'。 */
  period: string
  amount: Numeric
  status: string | null
  /** 作廢判斷用（overtime-void.ts isVoidedBeyondCapDraft）：月表重開時作廢的草稿不計筆數。省略＝視為有效。 */
  source?: string | null
  minutes?: Numeric
  note?: string | null
}

/** 人事成本的口徑說明（API 回應 payroll.basisNote、頁面照抄）。 */
export const PAYROLL_BASIS_NOTE = "應發（gross）口徑：未扣請假／遲到扣款、不含雇主負擔、加班另計與獎金"

export type GroupOverviewData = {
  year: number
  /** 本租戶全部公司主體（含停用）。 */
  companies: CompanyLite[]
  /** 該年有入帳或開票的期別（兩條查詢的聯集，已去重）。 */
  billings: BillingInputRow[]
  /** 租戶全部「有入帳金額、沒入帳日」的期別（正常是空的）。 */
  undatedReceived: UndatedReceivedRow[]
  projects: ProjectInputRow[]
  clients: ClientInputRow[]
  /** 該年匯款日、status='paid' 的放款單。 */
  disbursements: DisbursementInputRow[]
  /** 該年付款日、沒經放款單的已付複委託期款（2026-10-26 起計入支出）；省略＝沒有。 */
  legacySubcontractPayments?: LegacySubcontractPaymentInputRow[]
  vendors: VendorInputRow[]
  /** 本租戶全部員工（含離職：離職員工的薪資單仍要歸到公司）。省略＝沒有人事資料。 */
  employees?: EmployeeInputRow[]
  /** 該年的薪資單。 */
  payslips?: PayslipInputRow[]
  /** employees.company_id（0072）已套；false＝全部人列在未指派。省略視為 true。 */
  companyAssignmentReady?: boolean
  /** 該年的加班超額另計；null＝表不存在（未套 sql/0040）；省略＝沒有資料。 */
  overtimeSettlements?: OvertimeSettlementInputRow[] | null
  /** 租戶當地今天（'YYYY-MM-DD'），在職人數用；省略取 UTC 今天。 */
  today?: string
}

/* ──────────────────────────────────────────────────────────────────
 * 小工具
 * ────────────────────────────────────────────────────────────────── */

function toNumber(v: Numeric | undefined): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** 元 → 分（整數）。numeric(14,2) 最多兩位小數，所以不會失真。 */
function toCents(v: Numeric | undefined): number {
  return Math.round(toNumber(v) * 100)
}

function fromCents(cents: number): number {
  return cents / 100
}

function uniq(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((v): v is string => !!v))]
}

/**
 * 'YYYY-MM-DD' → 這一年的月份（1–12）；不是這一年或格式不對回 null。
 * 純字串切，不建 Date：入帳日落在月底（9/30）與下月初（10/1）時不會被時區推到隔天。
 */
export function monthOfDate(dateKey: string | null | undefined, year: number): number | null {
  if (!dateKey) return null
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(dateKey)
  if (!m) return null
  if (Number(m[1]) !== year) return null
  const month = Number(m[2])
  return month >= 1 && month <= 12 ? month : null
}

export type OverviewPeriod = { year: number; month: number | null; from: string; to: string }

/** 期間：整年或單月（from／to 皆含）。 */
export function periodOf(year: number, month: number | null): OverviewPeriod {
  if (month === null) return { year, month: null, from: `${year}-01-01`, to: `${year}-12-31` }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, "0")
  return { year, month, from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}` }
}

/** `?year=`：省略取 fallback（租戶當地今年）；純西元 4 位數字，2000–2100。不合法回 null（呼叫端回 400）。 */
export function parseOverviewYear(v: unknown, fallbackYear: number): number | null {
  if (v === undefined) return fallbackYear
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) return null
  const y = Number(v)
  return y >= 2000 && y <= 2100 ? y : null
}

/** `?month=`：省略／空字串＝全年（null）；1–12（可帶前導 0）。不合法回 undefined（呼叫端回 400）。 */
export function parseOverviewMonth(v: unknown): number | null | undefined {
  if (v === undefined || v === "") return null
  if (typeof v !== "string" || !/^\d{1,2}$/.test(v)) return undefined
  const m = Number(v)
  return m >= 1 && m <= 12 ? m : undefined
}

/** `?exclude=a,b`（也收重複的 `exclude=a&exclude=b`）：去空白、去重、最多 100 個；不認得的 id 之後直接忽略。 */
export function parseExcludeIds(v: unknown): Set<string> {
  const parts = Array.isArray(v) ? v : v === undefined ? [] : [v]
  const out = new Set<string>()
  for (const part of parts) {
    if (typeof part !== "string") continue
    for (const token of part.split(",")) {
      const id = token.trim()
      if (id) out.add(id)
      if (out.size >= 100) return out
    }
  }
  return out
}

/* ──────────────────────────────────────────────────────────────────
 * 載入（IO）：每個資料表只查一輪，與公司家數無關
 * ────────────────────────────────────────────────────────────────── */

const BILLING_COLS =
  "id, project_id, installment_no, billed_on, billed_amount, override_amount, calculated_amount, invoiced_on, received_on, received_amount"
const DISBURSEMENT_COLS = "id, status, paid_on, paying_company_id, vendor_id, payee_kind, payee_name, amount, withheld_amount"

/** 一頁一頁撈到撈完（`build` 要自己下穩定的 `.order()` 與 `.range(from, to)`）。 */
async function fetchAllRows<T>(
  context: string,
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await build(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`${context}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return rows
}

/** 依 id 清單分批撈（名冊表；軟刪的也要撈——已被引用的客戶／廠商刪了仍要 join 回名字與關係企業標記）。 */
async function fetchByIds<T>(table: string, cols: string, tenantId: string, ids: string[]): Promise<T[]> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK))
  const parts = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await supabaseAdmin.from(table).select(cols).eq("tenant_id", tenantId).in("id", chunk)
      if (error) throw new Error(`group-overview ${table}: ${error.message}`)
      return (data ?? []) as unknown as T[]
    }),
  )
  return parts.flat()
}

/**
 * 撈一個年度的全部原料：
 *   公司名冊 ＋ 該年入帳的期別 ＋ 該年開票的期別（兩條查詢、以 id 去重）＋ 有入帳金額卻沒入帳日的期別
 *   （資料品質提醒用，正常是空的）＋ 該年已匯款的放款單，再依這些列補專案、客戶（關係企業標記）、廠商（關係企業標記）。
 */
export async function loadGroupOverviewData(tenantId: string, year: number, today?: string): Promise<GroupOverviewData> {
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const companyAssignmentReady = await employeesHaveCompany()
  const [companies, receivedRows, invoicedRows, undatedReceived, disbursementRows, employees, payslips, overtimeSettlements] = await Promise.all([
    loadTenantCompanies(tenantId),
    fetchAllRows<BillingInputRow>("group-overview billings(received)", (a, b) =>
      supabaseAdmin
        .from("project_billings")
        .select(BILLING_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .gte("received_on", from)
        .lte("received_on", to)
        .order("id", { ascending: true })
        .range(a, b),
    ),
    fetchAllRows<BillingInputRow>("group-overview billings(invoiced)", (a, b) =>
      supabaseAdmin
        .from("project_billings")
        .select(BILLING_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .gte("invoiced_on", from)
        .lte("invoiced_on", to)
        .order("id", { ascending: true })
        .range(a, b),
    ),
    fetchAllRows<UndatedReceivedRow>("group-overview billings(undated received)", (a, b) =>
      supabaseAdmin
        .from("project_billings")
        .select("id, project_id, installment_no, received_amount")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .is("received_on", null)
        .not("received_amount", "is", null)
        .order("id", { ascending: true })
        .range(a, b),
    ),
    fetchAllRows<DisbursementInputRow>("group-overview disbursements", (a, b) =>
      supabaseAdmin
        .from("disbursements")
        .select(DISBURSEMENT_COLS)
        .eq("tenant_id", tenantId)
        .eq("status", "paid")
        .gte("paid_on", from)
        .lte("paid_on", to)
        .order("id", { ascending: true })
        .range(a, b),
    ),
    fetchAllRows<EmployeeInputRow>("group-overview employees", (a, b) =>
      supabaseAdmin
        .from("employees")
        .select(companyAssignmentReady ? "id, status, hire_date, terminated_at, company_id" : "id, status, hire_date, terminated_at")
        .eq("tenant_id", tenantId)
        .order("id", { ascending: true })
        .range(a, b) as unknown as PromiseLike<{ data: EmployeeInputRow[] | null; error: { message: string } | null }>,
    ),
    fetchAllRows<PayslipInputRow>("group-overview payslips", (a, b) =>
      supabaseAdmin
        .from("payslips")
        .select("id, employee_id, period, gross, status, breakdown")
        .eq("tenant_id", tenantId)
        .gte("period", `${year}-01`)
        .lte("period", `${year}-12`)
        .order("id", { ascending: true })
        .range(a, b),
    ),
    loadOvertimeSettlements(tenantId, year),
  ])
  const legacySubcontractPayments = await loadLegacySubcontractPayments(tenantId, from, to)

  // 同一期可能兩條查詢都撈到、offset 分頁遇到並發寫入也可能在頁界重複一列 → 一律以 id 去重。
  const billings = [...new Map([...receivedRows, ...invoicedRows].map((row) => [row.id, row])).values()]
  const disbursements = [...new Map(disbursementRows.map((row) => [row.id, row])).values()]
  const projects = await fetchByIds<ProjectInputRow>(
    "projects",
    "id, code, name, company_id, client_id",
    tenantId,
    uniq([...billings.map((b) => b.project_id), ...undatedReceived.map((u) => u.project_id), ...legacySubcontractPayments.map((p) => p.project_id)]),
  )
  const [clients, vendors] = await Promise.all([
    fetchByIds<ClientInputRow>(
      "clients",
      "id, name, short_name, is_affiliate",
      tenantId,
      uniq(projects.map((p) => p.client_id)),
    ),
    fetchByIds<VendorInputRow>(
      "vendors",
      "id, name, short_name, is_affiliate",
      tenantId,
      uniq([...disbursements.map((d) => d.vendor_id), ...legacySubcontractPayments.map((p) => p.vendor_id)]),
    ),
  ])
  return {
    year,
    companies,
    billings,
    undatedReceived,
    projects,
    clients,
    disbursements,
    legacySubcontractPayments,
    vendors,
    employees: [...new Map(employees.map((row) => [row.id, row])).values()],
    payslips: [...new Map(payslips.map((row) => [`${row.employee_id}|${row.period}`, row])).values()],
    companyAssignmentReady,
    overtimeSettlements,
    today,
  }
}

/** 期間內付款、沒經放款單的已付複委託期款，併上副委託的專案與廠商。 */
async function loadLegacySubcontractPayments(tenantId: string, from: string, to: string): Promise<LegacySubcontractPaymentInputRow[]> {
  type PayRow = { id: string; subcontract_id: string; paid_on: string | null; paid_amount: Numeric; withheld_amount: Numeric; paying_company_id: string | null }
  const pays = await fetchAllRows<PayRow>("group-overview legacy subcontract payments", (a, b) =>
    supabaseAdmin
      .from("project_subcontract_payments")
      .select("id, subcontract_id, paid_on, paid_amount, withheld_amount, paying_company_id")
      .eq("tenant_id", tenantId)
      .is("disbursement_id", null)
      .gte("paid_on", from)
      .lte("paid_on", to)
      .order("id", { ascending: true })
      .range(a, b),
  )
  if (pays.length === 0) return []
  const subs = await fetchByIds<{ id: string; project_id: string | null; vendor_id: string | null; vendor_name: string | null; deleted_at?: string | null }>(
    "project_subcontracts",
    "id, project_id, vendor_id, vendor_name, deleted_at",
    tenantId,
    uniq(pays.map((p) => p.subcontract_id)),
  )
  const subById = new Map(subs.map((s) => [s.id, s]))
  const out: LegacySubcontractPaymentInputRow[] = []
  for (const p of [...new Map(pays.map((row) => [row.id, row])).values()]) {
    const sub = subById.get(p.subcontract_id)
    // 副委託已刪除（軟刪）的期款不計——與獎金池毛利同口徑（project-gross-profit.ts 只看未刪的副委託）。
    if (!sub || sub.deleted_at) continue
    out.push({
      id: p.id,
      paid_on: p.paid_on,
      paid_amount: p.paid_amount,
      withheld_amount: p.withheld_amount,
      paying_company_id: p.paying_company_id,
      project_id: sub.project_id,
      vendor_id: sub.vendor_id,
      vendor_name: sub.vendor_name,
    })
  }
  return out
}

/** 該年的加班超額另計（draft＋paid）；表不存在（未套 sql/0040）→ null。 */
async function loadOvertimeSettlements(tenantId: string, year: number): Promise<OvertimeSettlementInputRow[] | null> {
  const rows: OvertimeSettlementInputRow[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("overtime_settlements")
      .select("id, employee_id, period, amount, status, source, minutes, note")
      .eq("tenant_id", tenantId)
      .in("status", ["draft", "paid"])
      .gte("period", `${year}-01`)
      .lte("period", `${year}-12`)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) {
      if (isMissingTableError(error)) {
        warnSchemaGapOnce("group-overview.overtime_settlements", error)
        return null
      }
      throw new Error(`group-overview overtime_settlements: ${error.message}`)
    }
    const batch = (data ?? []) as unknown as Array<OvertimeSettlementInputRow & { id: string }>
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  // offset 分頁遇到並發寫入可能在頁界重複一列 → 以 id 去重。
  return [...new Map((rows as Array<OvertimeSettlementInputRow & { id: string }>).map((row) => [row.id, row])).values()]
}

/** 薪資單 breakdown 裡的請假＋遲到早退扣款（分）；舊薪資單沒有這兩鍵 → 0。 */
function slipDeductionCents(breakdown: unknown): number {
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) return 0
  const b = breakdown as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === "number" || typeof v === "string" ? toCents(v) : 0)
  return num(b.leaveDeduction) + num(b.lateEarlyDeduction)
}

/** 'YYYY-MM' → 這一年的月份（1–12）；不是這一年或格式不對回 null。 */
export function monthOfPeriod(period: string | null | undefined, year: number): number | null {
  if (!period) return null
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m || Number(m[1]) !== year) return null
  const month = Number(m[2])
  return month >= 1 && month <= 12 ? month : null
}

/* ──────────────────────────────────────────────────────────────────
 * 事件（純函式）：把原料攤平成「哪家公司、幾月、多少分、是不是關係企業」
 * ────────────────────────────────────────────────────────────────── */

type FactKind = "revenue" | "invoiced" | "expense"

type Fact = {
  kind: FactKind
  companyId: string
  /** 1–12。 */
  month: number
  /** 金額（分，整數）；放款是代扣前毛額。 */
  cents: number
  /** 收入／開票：專案客戶是關係企業；放款：收款廠商是關係企業。 */
  affiliate: boolean
  /** revenue／invoiced 才有。 */
  projectId: string | null
  /** expense 才有：廠商 id 或「其他」收款方的名稱（下鑽依它分組）。 */
  vendorKey: string | null
  vendorId: string | null
  payeeName: string | null
}

export type QualityRow = {
  projectId: string
  code: string | null
  name: string
  installmentNo: number | null
  /** 入帳日；沒有入帳日的那類是 null。 */
  receivedOn: string | null
  receivedAmount: number
  /** 該期有效金額（未稅）；算不出來（沒合約也沒金額）是 null。 */
  effectiveAmount: number | null
}

export type DataQuality = {
  /** 有入帳金額但沒有入帳日：無法歸月，不在任何一個月的收入裡（租戶全部期別，不分年度）。 */
  undatedReceived: { count: number; amount: number; sample: QualityRow[] }
  /** 該年入帳的期別中，實收比該期有效金額（未稅）多超過 1 元：可能把含稅金額當未稅填了。excess＝多出來的合計。 */
  receivedOverEffective: { count: number; excess: number; sample: QualityRow[] }
}

/** 資料品質提醒的明細最多列幾筆（依金額由大到小）。 */
export const QUALITY_SAMPLE_LIMIT = 10
/** 實收比有效金額多出多少（分）以上才算「大於」：1 元以內當作四捨五入雜訊。 */
const OVER_RECEIVED_TOLERANCE_CENTS = 100

export type GroupModel = {
  year: number
  /** 名冊全部公司（含停用）：下鑽時用來分辨「公司不存在」與「這年沒活動」。 */
  roster: CompanyLite[]
  /** 要顯示的公司：名冊（停用且該年沒有任何事件的略過）＋「未歸屬」假列（有事件才出現）。 */
  companies: CompanyLite[]
  facts: Fact[]
  projectById: Map<string, ProjectInputRow>
  clientById: Map<string, ClientInputRow>
  vendorById: Map<string, VendorInputRow>
  quality: DataQuality
  people: PeopleModel
}

/** 人事（見檔頭「人事」）：key 是公司 id 或 UNASSIGNED_EMPLOYEES_KEY；每格是 12 個月（分）。 */
export type PeopleModel = {
  companyAssignmentReady: boolean
  headcount: Map<string, number>
  /** 薪資單應發（gross）。 */
  payroll: Map<string, number[]>
  /** 薪資單的請假＋遲到早退扣款。 */
  deductions: Map<string, number[]>
  /** 加班超額另計金額（draft＋paid）。 */
  overtime: Map<string, number[]>
  /** 每月薪資單張數／其中草稿張數（整個租戶）。 */
  slips: number[]
  draftSlips: number[]
  /** 每月加班另計筆數／其中草稿／其中沒有金額。 */
  overtimeRows: number[]
  overtimeDraftRows: number[]
  overtimeNoAmountRows: number[]
  /** overtime_settlements 表存在。 */
  overtimeAvailable: boolean
}

/** 人事歸屬的「未指派」鍵（不是一列公司，只在 group.unassigned* 出現）。 */
const UNASSIGNED_EMPLOYEES_KEY = "__unassigned_employees__"

const UNKNOWN_PAYEE_LABEL = "（未填收款方）"

/** 下鑽分組用的鍵：有廠商用廠商 id；「其他」收款方（無主檔）用名稱。 */
function vendorKeyOf(d: DisbursementInputRow): string {
  if (d.vendor_id) return `v:${d.vendor_id}`
  return `o:${(d.payee_name ?? "").trim() || UNKNOWN_PAYEE_LABEL}`
}

export function buildGroupModel(data: GroupOverviewData): GroupModel {
  const { year } = data
  const roster = data.companies
  const defaultCompany = defaultCompanyOf(roster)
  const known = new Set(roster.map((c) => c.id))
  /** null＝沿用預設公司；不在名冊或沒有預設公司 → 「未歸屬」。 */
  const resolveCompany = (stored: string | null | undefined): string => {
    if (!stored) return defaultCompany?.id ?? UNASSIGNED_COMPANY_ID
    return known.has(stored) ? stored : UNASSIGNED_COMPANY_ID
  }

  const projectById = new Map(data.projects.map((p) => [p.id, p]))
  const clientById = new Map(data.clients.map((c) => [c.id, c]))
  const vendorById = new Map(data.vendors.map((v) => [v.id, v]))

  const facts: Fact[] = []
  const over: Array<{ row: QualityRow; excessCents: number }> = []

  const qualityRow = (
    projectId: string,
    installmentNo: number | null | undefined,
    receivedOn: string | null,
    receivedAmount: Numeric | undefined,
    effective: number | null,
  ): QualityRow => {
    const project = projectById.get(projectId)
    return {
      projectId,
      code: project?.code ?? null,
      name: project?.name ?? "（找不到專案）",
      installmentNo: installmentNo ?? null,
      receivedOn,
      receivedAmount: fromCents(toCents(receivedAmount)),
      effectiveAmount: effective === null ? null : fromCents(toCents(effective)),
    }
  }

  for (const b of data.billings) {
    const project = projectById.get(b.project_id)
    const companyId = resolveCompany(project?.company_id)
    const client = project?.client_id ? clientById.get(project.client_id) : undefined
    const affiliate = client?.is_affiliate === true
    const base = { companyId, affiliate, projectId: b.project_id, vendorKey: null, vendorId: null, payeeName: null }

    // 該期有效金額（已請款 ?? 覆寫 ?? 試算，未稅）：開票金額用它，入帳也拿它檢查「是不是把含稅金額填進來了」。
    const effective = effectiveBillingAmount({
      billed_on: b.billed_on ?? null,
      billed_amount: b.billed_amount ?? null,
      override_amount: b.override_amount ?? null,
      calculated_amount: b.calculated_amount ?? null,
    })

    const receivedMonth = monthOfDate(b.received_on, year)
    if (receivedMonth !== null) {
      // 入帳金額（未稅）原樣加總；DB CHECK 保證有入帳日就有金額。
      const receivedCents = toCents(b.received_amount)
      facts.push({ ...base, kind: "revenue", month: receivedMonth, cents: receivedCents })
      if (effective !== null) {
        const excessCents = receivedCents - toCents(effective)
        if (excessCents > OVER_RECEIVED_TOLERANCE_CENTS) {
          over.push({ row: qualityRow(b.project_id, b.installment_no, b.received_on, b.received_amount, effective), excessCents })
        }
      }
    }
    const invoicedMonth = monthOfDate(b.invoiced_on, year)
    if (invoicedMonth !== null) {
      // 開票沒有自己的金額欄：開的是這一期的有效金額。
      facts.push({ ...base, kind: "invoiced", month: invoicedMonth, cents: toCents(effective) })
    }
  }

  for (const d of data.disbursements) {
    // 只算已匯款：草稿／送簽中／已核准未付／作廢都不是真的給出去的錢（查詢已濾，這裡不假設呼叫端濾乾淨）。
    if (d.status !== "paid") continue
    const month = monthOfDate(d.paid_on, year)
    if (month === null) continue
    const vendor = d.vendor_id ? vendorById.get(d.vendor_id) : undefined
    facts.push({
      kind: "expense",
      companyId: resolveCompany(d.paying_company_id),
      month,
      // 代扣前毛額＝實付淨額＋代扣合計（與專案毛利／獎金池同一支，見 services/project-gross-profit.ts）。
      cents: disbursementGrossCents(d),
      affiliate: vendor?.is_affiliate === true,
      projectId: null,
      vendorKey: vendorKeyOf(d),
      vendorId: d.vendor_id ?? null,
      payeeName: d.payee_name ?? null,
    })
  }

  // 舊路徑（沒經放款單）已付的複委託期款：毛額＝實付＋代扣，依付款日歸月（與獎金池毛利同口徑）。
  for (const p of data.legacySubcontractPayments ?? []) {
    const month = monthOfDate(p.paid_on, year)
    if (month === null) continue
    const project = p.project_id ? projectById.get(p.project_id) : undefined
    const vendor = p.vendor_id ? vendorById.get(p.vendor_id) : undefined
    facts.push({
      kind: "expense",
      companyId: p.paying_company_id ? resolveCompany(p.paying_company_id) : resolveCompany(project?.company_id),
      month,
      cents: subcontractPaymentGrossCents(p),
      affiliate: vendor?.is_affiliate === true,
      projectId: null,
      vendorKey: p.vendor_id ? `v:${p.vendor_id}` : `o:${(p.vendor_name ?? "").trim() || UNKNOWN_PAYEE_LABEL}`,
      vendorId: p.vendor_id ?? null,
      payeeName: p.vendor_name ?? null,
    })
  }

  // 人事：依員工目前的所屬公司；未指派／不在名冊／0072 未套 → 未指派（不分攤）。
  const companyAssignmentReady = data.companyAssignmentReady !== false
  const employeeCompany = new Map<string, string>()
  for (const e of data.employees ?? []) {
    const stored = companyAssignmentReady ? (e.company_id ?? null) : null
    employeeCompany.set(e.id, stored && known.has(stored) ? stored : UNASSIGNED_EMPLOYEES_KEY)
  }
  const zeros = () => ALL_MONTHS.map(() => 0)
  const people: PeopleModel = {
    companyAssignmentReady,
    headcount: new Map(),
    payroll: new Map(),
    deductions: new Map(),
    overtime: new Map(),
    slips: zeros(),
    draftSlips: zeros(),
    overtimeRows: zeros(),
    overtimeDraftRows: zeros(),
    overtimeNoAmountRows: zeros(),
    overtimeAvailable: data.overtimeSettlements !== null,
  }
  const addTo = (map: Map<string, number[]>, key: string, month: number, cents: number) => {
    let cells = map.get(key)
    if (!cells) {
      cells = zeros()
      map.set(key, cells)
    }
    cells[month - 1] = (cells[month - 1] as number) + cents
  }
  const bump = (arr: number[], month: number) => {
    arr[month - 1] = (arr[month - 1] as number) + 1
  }
  // 在職：與首頁人事區同一個口徑（services/employment-status.ts）。
  const today = data.today ?? new Date().toISOString().slice(0, 10)
  for (const e of data.employees ?? []) {
    if (!isEmployedOn(e, today)) continue
    const key = employeeCompany.get(e.id) as string
    people.headcount.set(key, (people.headcount.get(key) ?? 0) + 1)
  }
  for (const slip of data.payslips ?? []) {
    const month = monthOfPeriod(slip.period, year)
    if (month === null) continue
    const key = employeeCompany.get(slip.employee_id) ?? UNASSIGNED_EMPLOYEES_KEY
    addTo(people.payroll, key, month, toCents(slip.gross))
    addTo(people.deductions, key, month, slipDeductionCents(slip.breakdown))
    bump(people.slips, month)
    if (slip.status !== "finalized") bump(people.draftSlips, month)
  }
  for (const ot of data.overtimeSettlements ?? []) {
    if (ot.status !== "draft" && ot.status !== "paid") continue
    // 月表重開時作廢的草稿：不是待發的另計，筆數／未填金額都不算（手動補登的 0 分鐘固定金額照算）。
    if (isVoidedBeyondCapDraft(ot)) continue
    const month = monthOfPeriod(ot.period, year)
    if (month === null) continue
    const key = employeeCompany.get(ot.employee_id) ?? UNASSIGNED_EMPLOYEES_KEY
    bump(people.overtimeRows, month)
    if (ot.status === "draft") bump(people.overtimeDraftRows, month)
    if (ot.amount === null || ot.amount === undefined || ot.amount === "") {
      bump(people.overtimeNoAmountRows, month)
      continue
    }
    addTo(people.overtime, key, month, toCents(ot.amount))
  }

  const active = new Set(facts.map((f) => f.companyId))
  for (const key of [...people.headcount.keys(), ...people.payroll.keys(), ...people.overtime.keys()]) active.add(key)
  const companies: CompanyLite[] = roster.filter((c) => c.isActive || active.has(c.id))
  if (active.has(UNASSIGNED_COMPANY_ID)) {
    companies.push({ id: UNASSIGNED_COMPANY_ID, name: UNASSIGNED_COMPANY_NAME, isDefault: false, isActive: true })
  }

  const undated = data.undatedReceived.map((u) => ({
    row: qualityRow(u.project_id, u.installment_no, null, u.received_amount, null),
    cents: toCents(u.received_amount),
  }))
  const byAmountDesc = <T extends { row: QualityRow }>(amount: (x: T) => number) => (a: T, b: T) =>
    amount(b) - amount(a) || (a.row.code ?? "").localeCompare(b.row.code ?? "", "zh-Hant")
  const quality: DataQuality = {
    undatedReceived: {
      count: undated.length,
      amount: fromCents(undated.reduce((s, u) => s + u.cents, 0)),
      sample: [...undated].sort(byAmountDesc((x) => x.cents)).slice(0, QUALITY_SAMPLE_LIMIT).map((u) => u.row),
    },
    receivedOverEffective: {
      count: over.length,
      excess: fromCents(over.reduce((s, o) => s + o.excessCents, 0)),
      sample: [...over].sort(byAmountDesc((x) => x.excessCents)).slice(0, QUALITY_SAMPLE_LIMIT).map((o) => o.row),
    },
  }
  return { year, roster, companies, facts, projectById, clientById, vendorById, quality, people }
}

/* ──────────────────────────────────────────────────────────────────
 * 總覽
 * ────────────────────────────────────────────────────────────────── */

export type MonthPoint = {
  month: number
  revenue: number
  invoiced: number
  expense: number
  grossProfit: number
  /** 該月薪資單應發合計（依 payslip period、員工所屬公司）；那個月整個租戶沒有任何薪資單 → null。 */
  payrollCost: number | null
}
export type AffiliateAmounts = { revenue: number; invoiced: number; expense: number }

export type CompanyOverview = {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  /** 使用者勾掉的公司：不計入集團合計，列仍照常回傳（畫面灰色顯示）。 */
  excluded: boolean
  /** 入帳收入（未稅、依入帳日）。 */
  revenue: number
  /** 已開票（未稅、依開票日；參考，不併入收入）。 */
  invoiced: number
  /** 放款支出（已匯款、代扣前毛額、依匯款日）。 */
  expense: number
  grossProfit: number
  /** 毛利÷入帳收入（%，一位小數）；收入 0 → null。 */
  grossMarginPct: number | null
  /** 其中關係企業往來：客戶是關係企業的專案收入／開票、付給關係企業廠商的放款（已包含在上面三個數字裡）。 */
  affiliate: AffiliateAmounts
  /** 該年 12 個月（不受 month 篩選影響）；數字照該公司自己的口徑（含關係企業）。 */
  monthly: MonthPoint[]
  /** 目前在職人數（依員工所屬公司）。 */
  headcount: number
  /** 期間內薪資單應發（gross）合計（依員工所屬公司）；期間內沒有任何薪資單 → null（尚無薪資資料）。口徑見 PAYROLL_BASIS_NOTE。 */
  payrollCost: number | null
  /** 補充：gross −（請假＋遲到早退扣款）；沒有薪資資料 → null。 */
  payrollCostNet: number | null
  /** 補充：同期加班超額另計（草稿＋已付）金額合計；表不存在 → null。 */
  overtimeSettlementCost: number | null
  /** 毛利－人事成本（gross）；payrollCost 為 null 時也是 null。 */
  grossProfitAfterPayroll: number | null
}

export type GroupTotals = {
  /** 納入合計的公司 id。 */
  includedCompanyIds: string[]
  revenue: number
  invoiced: number
  expense: number
  grossProfit: number
  grossMarginPct: number | null
  /** 集團合計已剔除的關係企業往來（僅計納入合計的公司）；total＝收入＋放款（兩端各一筆，開票是參考不加總）。 */
  eliminated: AffiliateAmounts & { total: number }
  /** 該年 12 個月：納入公司各自扣掉關係企業往來後的加總。 */
  monthly: MonthPoint[]
  /** 在職人數：納入合計的公司＋未指派。 */
  headcount: number
  /** 人事成本（gross）：納入合計的公司＋未指派；沒有薪資資料 → null。 */
  payrollCost: number | null
  /** 補充：gross −（請假＋遲到早退扣款），納入公司＋未指派；沒有薪資資料 → null。 */
  payrollCostNet: number | null
  /** 補充：加班超額另計，納入公司＋未指派；表不存在 → null。 */
  overtimeSettlementCost: number | null
  /** 未指派公司的在職人數（不分攤到任何公司）。 */
  unassignedHeadcount: number
  /** 未指派公司員工的薪資成本；沒有薪資資料 → null。 */
  unassignedPayrollCost: number | null
  /** 集團毛利－集團薪資成本；沒有薪資資料 → null。 */
  grossProfitAfterPayroll: number | null
}

export type PayrollSummary = {
  /** 期間內有任何薪資單。false＝畫面標示「尚無薪資資料」。 */
  hasData: boolean
  /** 期間內薪資單張數／其中還是草稿（未定稿）的張數。 */
  slipCount: number
  draftSlipCount: number
  /** employees.company_id（0072）已套；false＝全部人列在未指派。 */
  companyAssignmentReady: boolean
  /** 薪資成本是否含雇主負擔（勞健保、勞退雇主提繳）；目前 payslips 沒有這些欄位，固定 false。 */
  employerCostIncluded: false
  /** 人事成本的口徑：固定 "gross"（應發）。 */
  basis: "gross"
  /** 口徑說明文字（PAYROLL_BASIS_NOTE），頁面照抄。 */
  basisNote: string
  /** overtime_settlements 表存在（false → overtimeSettlementCost 全是 null）。 */
  overtimeSettlementAvailable: boolean
  /** 期間內加班另計筆數／其中草稿／其中沒有金額（不計入金額）。 */
  overtimeSettlementCount: number
  overtimeSettlementDraftCount: number
  overtimeSettlementNoAmountCount: number
}

export type GroupOverviewResult = {
  period: OverviewPeriod
  companies: CompanyOverview[]
  group: GroupTotals
  /** 資料品質提醒（見檔頭）；不影響上面任何數字。 */
  dataQuality: DataQuality
  /** 人事資料的狀態（見檔頭「人事」）。 */
  payroll: PayrollSummary
}

/** 一格＝一家公司的一個月（分）；aff* 是其中屬於關係企業的部分。 */
type Cell = { revenue: number; invoiced: number; expense: number; affRevenue: number; affInvoiced: number; affExpense: number }

const emptyCell = (): Cell => ({ revenue: 0, invoiced: 0, expense: 0, affRevenue: 0, affInvoiced: 0, affExpense: 0 })

function cellsByCompany(facts: readonly Fact[]): Map<string, Cell[]> {
  const out = new Map<string, Cell[]>()
  for (const f of facts) {
    let cells = out.get(f.companyId)
    if (!cells) {
      cells = ALL_MONTHS.map(emptyCell)
      out.set(f.companyId, cells)
    }
    const cell = cells[f.month - 1] as Cell
    if (f.kind === "revenue") {
      cell.revenue += f.cents
      if (f.affiliate) cell.affRevenue += f.cents
    } else if (f.kind === "invoiced") {
      cell.invoiced += f.cents
      if (f.affiliate) cell.affInvoiced += f.cents
    } else {
      cell.expense += f.cents
      if (f.affiliate) cell.affExpense += f.cents
    }
  }
  return out
}

function point(month: number, revenue: number, invoiced: number, expense: number, payrollCents: number | null): MonthPoint {
  return {
    month,
    revenue: fromCents(revenue),
    invoiced: fromCents(invoiced),
    expense: fromCents(expense),
    grossProfit: fromCents(revenue - expense),
    payrollCost: payrollCents === null ? null : fromCents(payrollCents),
  }
}

export function summarizeGroupOverview(
  model: GroupModel,
  opts: { month: number | null; excluded: ReadonlySet<string> },
): GroupOverviewResult {
  const cellsOf = cellsByCompany(model.facts)
  const periodMonths = opts.month === null ? ALL_MONTHS : [opts.month]

  const companies: CompanyOverview[] = []
  const groupMonths = ALL_MONTHS.map(emptyCell)
  const includedIds: string[] = []

  const { people } = model
  const slipCount = periodMonths.reduce((s, m) => s + (people.slips[m - 1] as number), 0)
  const draftSlipCount = periodMonths.reduce((s, m) => s + (people.draftSlips[m - 1] as number), 0)
  const hasPayroll = slipCount > 0
  const sumPeriod = (map: Map<string, number[]>, key: string): number => {
    const cells = map.get(key)
    return cells ? periodMonths.reduce((s, m) => s + (cells[m - 1] as number), 0) : 0
  }
  const monthHasSlips = (i: number) => (people.slips[i] as number) > 0
  const payrollMonthly = (key: string): Array<number | null> => {
    const cells = people.payroll.get(key)
    return ALL_MONTHS.map((_, i) => (monthHasSlips(i) ? ((cells?.[i] as number | undefined) ?? 0) : null))
  }
  const unassignedHeadcount = people.headcount.get(UNASSIGNED_EMPLOYEES_KEY) ?? 0
  const unassignedPayroll = sumPeriod(people.payroll, UNASSIGNED_EMPLOYEES_KEY)
  let groupHeadcount = unassignedHeadcount
  let groupPayroll = unassignedPayroll
  let groupDeductions = sumPeriod(people.deductions, UNASSIGNED_EMPLOYEES_KEY)
  let groupOvertime = sumPeriod(people.overtime, UNASSIGNED_EMPLOYEES_KEY)
  const groupPayrollMonths = ALL_MONTHS.map((_, i) => (people.payroll.get(UNASSIGNED_EMPLOYEES_KEY)?.[i] as number | undefined) ?? 0)

  for (const company of model.companies) {
    const cells = cellsOf.get(company.id) ?? ALL_MONTHS.map(emptyCell)
    const period = emptyCell()
    for (const m of periodMonths) {
      const cell = cells[m - 1] as Cell
      period.revenue += cell.revenue
      period.invoiced += cell.invoiced
      period.expense += cell.expense
      period.affRevenue += cell.affRevenue
      period.affInvoiced += cell.affInvoiced
      period.affExpense += cell.affExpense
    }
    const excluded = opts.excluded.has(company.id)
    const headcount = people.headcount.get(company.id) ?? 0
    const payrollCents = sumPeriod(people.payroll, company.id)
    const deductionCents = sumPeriod(people.deductions, company.id)
    const overtimeCents = sumPeriod(people.overtime, company.id)
    const monthlyPayroll = payrollMonthly(company.id)
    if (!excluded) {
      includedIds.push(company.id)
      groupHeadcount += headcount
      groupPayroll += payrollCents
      groupDeductions += deductionCents
      groupOvertime += overtimeCents
      monthlyPayroll.forEach((v, i) => {
        groupPayrollMonths[i] = (groupPayrollMonths[i] as number) + (v ?? 0)
      })
      cells.forEach((cell, i) => {
        const g = groupMonths[i] as Cell
        g.revenue += cell.revenue
        g.invoiced += cell.invoiced
        g.expense += cell.expense
        g.affRevenue += cell.affRevenue
        g.affInvoiced += cell.affInvoiced
        g.affExpense += cell.affExpense
      })
    }
    companies.push({
      id: company.id,
      name: company.name,
      isDefault: company.isDefault,
      isActive: company.isActive,
      excluded,
      revenue: fromCents(period.revenue),
      invoiced: fromCents(period.invoiced),
      expense: fromCents(period.expense),
      grossProfit: fromCents(period.revenue - period.expense),
      grossMarginPct: pct1(period.revenue - period.expense, period.revenue),
      affiliate: {
        revenue: fromCents(period.affRevenue),
        invoiced: fromCents(period.affInvoiced),
        expense: fromCents(period.affExpense),
      },
      monthly: cells.map((cell, i) => point(i + 1, cell.revenue, cell.invoiced, cell.expense, monthlyPayroll[i] ?? null)),
      headcount,
      payrollCost: hasPayroll ? fromCents(payrollCents) : null,
      payrollCostNet: hasPayroll ? fromCents(payrollCents - deductionCents) : null,
      overtimeSettlementCost: people.overtimeAvailable ? fromCents(overtimeCents) : null,
      grossProfitAfterPayroll: hasPayroll ? fromCents(period.revenue - period.expense - payrollCents) : null,
    })
  }

  // 集團合計＝納入公司各自（數字－關係企業往來）。
  let revenue = 0
  let invoiced = 0
  let expense = 0
  let elimRevenue = 0
  let elimInvoiced = 0
  let elimExpense = 0
  for (const m of periodMonths) {
    const g = groupMonths[m - 1] as Cell
    revenue += g.revenue - g.affRevenue
    invoiced += g.invoiced - g.affInvoiced
    expense += g.expense - g.affExpense
    elimRevenue += g.affRevenue
    elimInvoiced += g.affInvoiced
    elimExpense += g.affExpense
  }
  return {
    period: periodOf(model.year, opts.month),
    companies,
    group: {
      includedCompanyIds: includedIds,
      revenue: fromCents(revenue),
      invoiced: fromCents(invoiced),
      expense: fromCents(expense),
      grossProfit: fromCents(revenue - expense),
      grossMarginPct: pct1(revenue - expense, revenue),
      eliminated: {
        revenue: fromCents(elimRevenue),
        invoiced: fromCents(elimInvoiced),
        expense: fromCents(elimExpense),
        total: fromCents(elimRevenue + elimExpense),
      },
      monthly: groupMonths.map((g, i) =>
        point(i + 1, g.revenue - g.affRevenue, g.invoiced - g.affInvoiced, g.expense - g.affExpense, monthHasSlips(i) ? (groupPayrollMonths[i] as number) : null),
      ),
      headcount: groupHeadcount,
      payrollCost: hasPayroll ? fromCents(groupPayroll) : null,
      payrollCostNet: hasPayroll ? fromCents(groupPayroll - groupDeductions) : null,
      overtimeSettlementCost: people.overtimeAvailable ? fromCents(groupOvertime) : null,
      unassignedHeadcount,
      unassignedPayrollCost: hasPayroll ? fromCents(unassignedPayroll) : null,
      grossProfitAfterPayroll: hasPayroll ? fromCents(revenue - expense - groupPayroll) : null,
    },
    dataQuality: model.quality,
    payroll: {
      hasData: hasPayroll,
      slipCount,
      draftSlipCount,
      companyAssignmentReady: people.companyAssignmentReady,
      employerCostIncluded: false,
      basis: "gross",
      basisNote: PAYROLL_BASIS_NOTE,
      overtimeSettlementAvailable: people.overtimeAvailable,
      overtimeSettlementCount: periodMonths.reduce((s, m) => s + (people.overtimeRows[m - 1] as number), 0),
      overtimeSettlementDraftCount: periodMonths.reduce((s, m) => s + (people.overtimeDraftRows[m - 1] as number), 0),
      overtimeSettlementNoAmountCount: periodMonths.reduce((s, m) => s + (people.overtimeNoAmountRows[m - 1] as number), 0),
    },
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 下鑽
 * ────────────────────────────────────────────────────────────────── */

export type DetailKind = "revenue" | "expense"

export type RevenueDetailRow = {
  projectId: string
  code: string | null
  name: string
  clientName: string | null
  clientShortName: string | null
  /** 客戶是關係企業（集團合計會剔除；公司自己的數字照常含）。 */
  isAffiliate: boolean
  /** 入帳金額（未稅）。 */
  amount: number
}

export type ExpenseDetailRow = {
  /** 分組鍵：`v:<廠商id>` 或 `o:<其他收款方名稱>`。 */
  key: string
  vendorId: string | null
  name: string
  shortName: string | null
  isAffiliate: boolean
  /** 放款金額（已匯款、代扣前毛額）。 */
  amount: number
  /** 匯款筆數。 */
  count: number
}

export type GroupDetailResult =
  | { kind: "revenue"; companyId: string; companyName: string; period: OverviewPeriod; total: number; count: number; truncated: boolean; rows: RevenueDetailRow[] }
  | { kind: "expense"; companyId: string; companyName: string; period: OverviewPeriod; total: number; count: number; truncated: boolean; rows: ExpenseDetailRow[] }

function byAmountThen<T extends { amount: number }>(label: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => b.amount - a.amount || label(a).localeCompare(label(b), "zh-Hant")
}

/**
 * 某公司某期間的下鑽：收入列專案（專案編號、名稱、客戶、入帳金額）、支出列廠商（廠商、放款金額、筆數），
 * 依金額由大到小、最多 `DETAIL_LIMIT` 筆（`total`／`count` 仍是全部）。公司不存在回 null（呼叫端回 404）。
 * 公司自己的數字含關係企業往來，所以這裡也含，只是用 `isAffiliate` 標出來。
 */
export function detailGroupOverview(
  model: GroupModel,
  opts: { companyId: string; month: number | null; kind: DetailKind },
): GroupDetailResult | null {
  const shown = model.companies.find((c) => c.id === opts.companyId)
  const company = shown ?? model.roster.find((c) => c.id === opts.companyId)
  if (!company) return null

  const period = periodOf(model.year, opts.month)
  const wantKind: FactKind = opts.kind
  const picked = model.facts.filter(
    (f) => f.kind === wantKind && f.companyId === opts.companyId && (opts.month === null || f.month === opts.month),
  )

  if (opts.kind === "revenue") {
    const byProject = new Map<string, number>()
    for (const f of picked) {
      const id = f.projectId as string
      byProject.set(id, (byProject.get(id) ?? 0) + f.cents)
    }
    const all: RevenueDetailRow[] = [...byProject.entries()].map(([projectId, cents]) => {
      const project = model.projectById.get(projectId)
      const client = project?.client_id ? model.clientById.get(project.client_id) : undefined
      return {
        projectId,
        code: project?.code ?? null,
        name: project?.name ?? "（找不到專案）",
        clientName: client?.name ?? null,
        clientShortName: client?.short_name ?? null,
        isAffiliate: client?.is_affiliate === true,
        amount: fromCents(cents),
      }
    })
    all.sort(byAmountThen<RevenueDetailRow>((r) => `${r.code ?? ""}${r.name}`))
    return {
      kind: "revenue",
      companyId: company.id,
      companyName: company.name,
      period,
      total: fromCents(picked.reduce((s, f) => s + f.cents, 0)),
      count: all.length,
      truncated: all.length > DETAIL_LIMIT,
      rows: all.slice(0, DETAIL_LIMIT),
    }
  }

  const byVendor = new Map<string, { vendorId: string | null; payeeName: string | null; cents: number; count: number }>()
  for (const f of picked) {
    const key = f.vendorKey as string
    const cur = byVendor.get(key) ?? { vendorId: f.vendorId, payeeName: f.payeeName, cents: 0, count: 0 }
    cur.cents += f.cents
    cur.count += 1
    byVendor.set(key, cur)
  }
  const all: ExpenseDetailRow[] = [...byVendor.entries()].map(([key, v]) => {
    const vendor = v.vendorId ? model.vendorById.get(v.vendorId) : undefined
    return {
      key,
      vendorId: v.vendorId,
      // 有主檔用目前的廠商名稱；沒有主檔（其他收款方，或廠商列已查不到）退回匯款當下的收款方名稱快照。
      name: vendor?.name ?? ((v.payeeName ?? "").trim() || UNKNOWN_PAYEE_LABEL),
      shortName: vendor?.short_name ?? null,
      isAffiliate: vendor?.is_affiliate === true,
      amount: fromCents(v.cents),
      count: v.count,
    }
  })
  all.sort(byAmountThen<ExpenseDetailRow>((r) => r.name))
  return {
    kind: "expense",
    companyId: company.id,
    companyName: company.name,
    period,
    total: fromCents(picked.reduce((s, f) => s + f.cents, 0)),
    count: all.length,
    truncated: all.length > DETAIL_LIMIT,
    rows: all.slice(0, DETAIL_LIMIT),
  }
}
