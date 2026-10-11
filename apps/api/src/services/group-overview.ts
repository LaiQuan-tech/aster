import { supabaseAdmin } from "../lib/supabase.js"
import { defaultCompanyOf, loadTenantCompanies, type CompanyLite } from "./project-company.js"
import { effectiveBillingAmount, pct1 } from "./project-money.js"

/**
 * 集團總覽（2026-10-11 業主拍板第一版）：跨公司彙總入帳收入、放款支出與專案毛利。
 * 淨利（含薪資等人事成本）是第二版，這裡不算。
 *
 * ── 口徑（業主定案）────────────────────────────────────────────────
 *   • 收入（主）＝實際入帳金額，依**入帳日**（project_billings.received_on）歸月，一律**未稅**。
 *   • 已開票（應收，參考）＝依**開票日**（invoiced_on）歸月的開票金額，也是未稅；不併入收入。
 *   • 支出＝已匯款的放款：`disbursements.status='paid'`，依**匯款日**（paid_on）歸月，取**代扣前的毛額**
 *     （`amount`＋`withheld_amount`）。放款單是支出的唯一來源——下包期款經放款單付出的不另計，
 *     草稿／送簽中／已核准未付／作廢一律不計。⚠️ 反過來說，舊路徑手動標記已付、沒有經放款單的下包期款
 *     （project_subcontract_payments.disbursement_id 為空）不在 disbursements 裡，第一版不計入支出。
 *   • 專案毛利＝入帳收入－放款支出；毛利率＝毛利÷入帳收入（收入 0 → null，畫面顯示「—」）。不含人事成本。
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

export type VendorInputRow = {
  id: string
  name: string
  short_name?: string | null
  is_affiliate: boolean | null
}

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
  vendors: VendorInputRow[]
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
export async function loadGroupOverviewData(tenantId: string, year: number): Promise<GroupOverviewData> {
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const [companies, receivedRows, invoicedRows, undatedReceived, disbursementRows] = await Promise.all([
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
  ])

  // 同一期可能兩條查詢都撈到、offset 分頁遇到並發寫入也可能在頁界重複一列 → 一律以 id 去重。
  const billings = [...new Map([...receivedRows, ...invoicedRows].map((row) => [row.id, row])).values()]
  const disbursements = [...new Map(disbursementRows.map((row) => [row.id, row])).values()]
  const projects = await fetchByIds<ProjectInputRow>(
    "projects",
    "id, code, name, company_id, client_id",
    tenantId,
    uniq([...billings.map((b) => b.project_id), ...undatedReceived.map((u) => u.project_id)]),
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
      uniq(disbursements.map((d) => d.vendor_id)),
    ),
  ])
  return { year, companies, billings, undatedReceived, projects, clients, disbursements, vendors }
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
}

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
      // 代扣前毛額＝實付淨額＋代扣合計。
      cents: toCents(d.amount) + toCents(d.withheld_amount),
      affiliate: vendor?.is_affiliate === true,
      projectId: null,
      vendorKey: vendorKeyOf(d),
      vendorId: d.vendor_id ?? null,
      payeeName: d.payee_name ?? null,
    })
  }

  const active = new Set(facts.map((f) => f.companyId))
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
  return { year, roster, companies, facts, projectById, clientById, vendorById, quality }
}

/* ──────────────────────────────────────────────────────────────────
 * 總覽
 * ────────────────────────────────────────────────────────────────── */

export type MonthPoint = { month: number; revenue: number; invoiced: number; expense: number; grossProfit: number }
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
}

export type GroupOverviewResult = {
  period: OverviewPeriod
  companies: CompanyOverview[]
  group: GroupTotals
  /** 資料品質提醒（見檔頭）；不影響上面任何數字。 */
  dataQuality: DataQuality
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

function point(month: number, revenue: number, invoiced: number, expense: number): MonthPoint {
  return {
    month,
    revenue: fromCents(revenue),
    invoiced: fromCents(invoiced),
    expense: fromCents(expense),
    grossProfit: fromCents(revenue - expense),
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
    if (!excluded) {
      includedIds.push(company.id)
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
      monthly: cells.map((cell, i) => point(i + 1, cell.revenue, cell.invoiced, cell.expense)),
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
      monthly: groupMonths.map((g, i) => point(i + 1, g.revenue - g.affRevenue, g.invoiced - g.affInvoiced, g.expense - g.affExpense)),
    },
    dataQuality: model.quality,
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
