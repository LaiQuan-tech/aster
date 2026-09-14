/**
 * P3 專案申請單模組（模組五）的 typed API 呼叫：客戶名冊、我方公司主體、
 * 專案申請單新欄位、開票／收款、副委託與協力技師分期、年度總表、未收款追蹤。
 * 後端見 apps/api/src/routes/{projects,projects-annual,billings,subcontracts,
 * clients,companies}.ts、apps/api/src/services/{project-money,
 * project-application-store}.ts——型別已對照這些檔案的實際序列化形狀寫死
 * （非只照最初的合約文字），如後端再調整，回來對這幾支檔案重新核對。
 *
 * 刻意獨立成檔，不動 `./projects-api`（既有 admin／ess 頁面共用中）：
 * 這裡的型別用 `extends`／重用既有 Project／Installment／DocType 等型別，
 * 函式打同一組既有端點（如 `GET /projects/:id`）但回傳更完整的形狀。
 */
import { apiFetch, apiDownload } from "./api-client"
import type {
  Project, ProjectStatus, ShareMode, Installment, InstallmentInput, DocType, OurRole,
} from "./projects-api"

/* ============================================================== 通用列舉 == */

export type InvoiceType = "duplicate" | "triplicate"
export type PaymentMethod = "transfer" | "check"

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  duplicate: "二聯式",
  triplicate: "三聯式",
}
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  transfer: "匯款",
  check: "支票",
}

/** project_settings.disciplines 的預設值，datalist 建議用；非強制清單。 */
export const COMMON_DISCIPLINES = ["電機", "空調", "消防", "汙水"] as const

/* ================================================================ 客戶 == */

export interface Client {
  id: string
  name: string
  taxId: string | null
  phone: string | null
  fax: string | null
  invoiceAddress: string | null
  contactName: string | null
  contactPhone: string | null
  email: string | null
  invoiceType: InvoiceType | null
  paymentMethod: PaymentMethod | null
  closingDay: string | null
  paymentDay: string | null
  note: string | null
  createdAt?: string
  updatedAt?: string
}

export type ClientInput = Partial<Omit<Client, "id" | "createdAt" | "updatedAt">> & {
  name: string
}

export function listClients(q?: string) {
  return apiFetch<{ clients: Client[] }>(`/clients${q ? `?q=${encodeURIComponent(q)}` : ""}`)
}
export function createClient(body: ClientInput) {
  return apiFetch<{ client: Client }>("/clients", { method: "POST", body: JSON.stringify(body) })
}
export function updateClient(id: string, body: Partial<ClientInput>) {
  return apiFetch<{ client: Client }>(`/clients/${id}`, { method: "PATCH", body: JSON.stringify(body) })
}
export function deleteClient(id: string) {
  return apiFetch<{ id: string }>(`/clients/${id}`, { method: "DELETE" })
}

/** 常見錯誤碼人性化——客戶名冊統編重複／檢查碼錯誤。 */
export function humanizeClientError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  if (msg.includes("tax_id_taken")) return "統一編號已被其他客戶使用。"
  return msg
}

/* ============================================================ 我方主體 == */

export interface Company {
  id: string
  name: string
  taxId: string | null
  bankName: string | null
  bankAccount: string | null
  isDefault: boolean
  note?: string | null
  createdAt?: string
  updatedAt?: string
}

export function listCompanies() {
  return apiFetch<{ companies: Company[] }>("/companies")
}

/**
 * 整批 upsert：帶 id 更新、沒 id 新增，**不在陣列裡的不會被刪除**——主體被
 * 下包期款引用，後端刻意不刪（見 companies.ts 檔頭）。UI 移除一列只對「這次
 * 存檔前新增、還沒有 id」的列有意義；已存在的主體無法用這支端點刪掉。
 */
export function putCompanies(companies: Array<Partial<Company> & { name: string }>) {
  return apiFetch<{ companies: Company[] }>("/companies", {
    method: "PUT",
    body: JSON.stringify({ companies }),
  })
}

export function humanizeCompanyError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  if (msg.includes("multiple_defaults")) return "預設主體只能勾一筆。"
  if (msg.includes("duplicate_name")) return "名稱重複，請改一下再存。"
  if (msg.includes("name_taken")) return "名稱已被其他主體使用。"
  return msg
}

/* ============================================================ 專案類型 == */

export type ProjectKind = "main" | "change" | "addition" | "advance"

export const PROJECT_KIND_LABELS: Record<ProjectKind, string> = {
  main: "主案",
  change: "變更設計",
  addition: "追加",
  advance: "代墊",
}
export const PROJECT_KIND_ORDER: ProjectKind[] = ["main", "change", "addition", "advance"]

/** 分期請款期別的 kind（區別於上面專案層級的 ProjectKind）。 */
export type BillingKind = "installment" | "guild_advance"
export const BILLING_KIND_LABELS: Record<BillingKind, string> = {
  installment: "一般分期",
  guild_advance: "技師公會代墊",
}

/** 協力技師單一科別的指派：可選既有 vendor，也可直接填自由文字名稱（比照
 * project_subcontracts 的 vendorId／vendorName 兩態並存）。 */
export interface EngineerAssignment {
  vendorId?: string | null
  name: string | null
}
export type EngineerDiscipline = "electrical" | "hvac" | "fire"
export type ProjectEngineers = Partial<Record<EngineerDiscipline, EngineerAssignment | null>>

export const ENGINEER_DISCIPLINE_LABELS: Record<EngineerDiscipline, string> = {
  electrical: "電機",
  hvac: "空調",
  fire: "消防",
}
export const ENGINEER_DISCIPLINES = Object.keys(ENGINEER_DISCIPLINE_LABELS) as EngineerDiscipline[]

export interface DesignScopeItem {
  discipline: string
  item: string | null
  amount: number | null
}

/* ------------------------------------------------- 建案（新欄位）與取號 -- */

export interface CreateProjectExtBody {
  name: string
  code?: string | null
  fiscalYear?: number | null
  description?: string | null
  deptId?: string | null
  leadEmpId?: string | null
  shareMode?: ShareMode
  bonusPool?: number | null
  startsOn?: string | null
  endsOn?: string | null
  clientId?: string | null
  parentProjectId?: string | null
  kind?: ProjectKind
  siteAddress?: string | null
  siteAreaM2?: number | null
  designScope?: DesignScopeItem[]
  invoiceType?: InvoiceType | null
  paymentMethod?: PaymentMethod | null
  closingDay?: string | null
  paymentDay?: string | null
  otherExpenses?: number | null
  engineers?: ProjectEngineers
}

export function createProjectExt(body: CreateProjectExtBody) {
  return apiFetch<{ id: string; code: string | null }>("/projects", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface ReservedProject {
  id: string
  code: string
}

/** 一次預先保留 N 個編號（成立前先掛號用）；上限 20（後端 zod）。 */
export function reserveProjectCodes(count: number) {
  return apiFetch<{ projects: ReservedProject[] }>("/projects/reserve", {
    method: "POST",
    body: JSON.stringify({ count }),
  })
}

/** `GET /projects` 列表列——後端 serializeProject(finance:false) + 平面 clientName。 */
export interface ProjectListItem extends Project {
  clientId?: string | null
  clientName?: string | null
  kind?: ProjectKind
  reservedAt?: string | null
}

export function listProjectsExt(opts?: { includeArchived?: boolean; includeReserved?: boolean }) {
  const q = new URLSearchParams()
  if (opts?.includeArchived) q.set("includeArchived", "1")
  if (opts?.includeReserved) q.set("includeReserved", "1")
  const qs = q.toString()
  return apiFetch<{ projects: ProjectListItem[] }>(`/projects${qs ? `?${qs}` : ""}`)
}

/** 統一取客戶顯示名稱：list 端點給平面 clientName，detail 端點給巢狀 client。 */
export function clientNameOf(p: { client?: { name: string } | null; clientName?: string | null }): string {
  return p.client?.name ?? p.clientName ?? "—"
}

/* ------------------------------------------------------------ 專案明細 -- */

export interface ProjectAccess {
  finance: boolean
  bonus: boolean
}

/** project-money.ts computeMoney() 的原始輸出——欄位與後端逐一對照過。 */
export interface ProjectMoney {
  amountUntaxed: number | null
  amountSource: "contract" | "quotation" | null
  vatRate: number
  taxAmount: number | null
  amountTotal: number | null
  billedTotal: number
  invoicedTotal: number
  receivedTotal: number
  unreceived: number | null
  billingProgressPct: number | null
  receiptProgressPct: number | null
  /** 下包＋技師費合計（両者已加總；要拆開看 technicianTotal）。 */
  subcontractTotal: number
  technicianTotal: number
  otherExpenses: number
  profit: number | null
  grossMarginPct: number | null
}

/** 分期請款列（serializeBilling()：比 Installment 多開票／收款事件與 kind）。 */
export interface BillingExt extends Installment {
  kind: BillingKind
  invoiceNo: string | null
  invoicedOn: string | null
  receivedOn: string | null
  receivedAmount: number | null
}

export interface BillingScheduleExt {
  contract: { total: number | null; base: number; changeOrders: number }
  installments: BillingExt[]
  summary: {
    percentageTotal: number
    effectiveTotal: number
    unallocatedResidue: number
    /** 公會制估驗預付款合計，另計，不在 effectiveTotal 裡。 */
    guildAdvanceTotal: number
    billedTotal: number
    unbilledTotal: number
    invoicedTotal: number
    receivedTotal: number
    unreceivedTotal: number
  }
  warnings: string[]
}

export interface InstallmentInputExt extends InstallmentInput {
  kind?: BillingKind
}

export function getBillingSchedule(projectId: string) {
  return apiFetch<BillingScheduleExt>(`/projects/${projectId}/billings`)
}
/** 整批存：跟原本 saveBillings 同一個端點，型別多帶 kind。 */
export function saveBillingSchedule(projectId: string, installments: InstallmentInputExt[]) {
  return apiFetch<BillingScheduleExt>(`/projects/${projectId}/billings`, {
    method: "PUT",
    body: JSON.stringify({ installments }),
  })
}
export function billInstallmentExt(id: string, body: { billedOn?: string; billedAmount?: number | null } = {}) {
  return apiFetch<BillingScheduleExt>(`/billings/${id}/bill`, { method: "POST", body: JSON.stringify(body) })
}
export function unbillInstallmentExt(id: string, reason: string) {
  return apiFetch<BillingScheduleExt>(`/billings/${id}/unbill`, { method: "POST", body: JSON.stringify({ reason }) })
}
export function invoiceBilling(id: string, body: { invoiceNo: string; invoicedOn?: string }) {
  return apiFetch<BillingScheduleExt>(`/billings/${id}/invoice`, { method: "POST", body: JSON.stringify(body) })
}
export function uninvoiceBilling(id: string, reason: string) {
  return apiFetch<BillingScheduleExt>(`/billings/${id}/uninvoice`, { method: "POST", body: JSON.stringify({ reason }) })
}
export function receiveBilling(id: string, body: { receivedOn?: string; receivedAmount?: number | null } = {}) {
  return apiFetch<BillingScheduleExt>(`/billings/${id}/receive`, { method: "POST", body: JSON.stringify(body) })
}
export function unreceiveBilling(id: string, reason: string) {
  return apiFetch<BillingScheduleExt>(`/billings/${id}/unreceive`, { method: "POST", body: JSON.stringify({ reason }) })
}

/** 分期請款相關錯誤碼人性化（含 P3 開票／收款新增的碼）。 */
export const BILLING_ERRORS: Record<string, string> = {
  override_reason_required: "人工指定金額必須填理由。",
  billed_installment_not_removable: "已請款的期別不能移除。",
  received: "已入帳的期別金額已凍結，不能移除或改百分比／覆寫金額。",
  duplicate_installment_no: "期別編號重複。",
  installment_no_taken: "期別編號已存在。",
  amount_unknown: "算不出金額（還沒有合約，或這期沒有百分比也沒有人工金額）。",
  already_billed: "這期已經標記請款過了。",
  not_billed: "這期還沒標記請款，無法開票。",
  already_invoiced: "這期已經開過票了。",
  not_invoiced: "這期還沒開票。",
  already_received: "這期已經入帳過了。",
  not_received: "這期還沒入帳。",
  reason_required: "請填理由。",
}
export function humanizeBillingError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  for (const [code, text] of Object.entries(BILLING_ERRORS)) {
    if (msg.includes(code)) return text
  }
  return msg
}

export type SubcontractKind = "subcontract" | "technician"
export type OrderType = "quotation" | "contract"

export interface SubcontractPayment {
  id?: string
  installmentNo: number
  percentage: number | null
  /** 系統試算金額（毛額，含尾差）；GET 回傳才有，PUT 不需要送。 */
  amount?: number
  residueApplied?: number
  overrideAmount?: number | null
  overrideReason?: string | null
  /** 有效毛額 = 已付凍結 ?? 覆寫 ?? 試算；唯讀。 */
  effectiveAmount?: number | null
  /** 代扣稅款；唯讀，依 withholdingRate／Threshold 試算。 */
  withheldAmount?: number
  /** 淨額 = 有效毛額 − 代扣；唯讀，付款時可參考此值填實付。 */
  netAmount?: number | null
  dueWhen?: string | null
  paidOn?: string | null
  paidAmount?: number | null
  payingCompanyId?: string | null
  receiptIssuerCompanyId?: string | null
  receiptRef?: string | null
  note?: string | null
}

export interface SubcontractSummary {
  percentageTotal: number
  effectiveTotal: number
  withheldTotal: number
  unallocatedResidue: number
  paidTotal: number
  withheldPaidTotal: number
}

export interface Subcontract {
  id?: string
  kind: SubcontractKind
  discipline: string | null
  vendorId?: string | null
  vendorName: string | null
  contact: string | null
  item: string | null
  /** 必填，後端 zod 不接受 null／undefined——空白就送 0。 */
  amount: number
  billingBasis: string | null
  orderType: OrderType | null
  contractId?: string | null
  withholdingRate: number
  withholdingThreshold: number
  sortOrder?: number
  note: string | null
  createdAt?: string
  updatedAt?: string
  /** GET 就近帶出；PUT 這個端點本身不吃 payments，改期款要另打 payments 端點。 */
  payments?: SubcontractPayment[]
  summary?: SubcontractSummary
}

export interface SubcontractsListSummary {
  subcontractTotal: number
  technicianTotal: number
  total: number
  paidTotal: number
  withheldTotal: number
}
export interface SubcontractsResponse {
  subcontracts: Subcontract[]
  summary: SubcontractsListSummary
}

export function getProjectSubcontracts(projectId: string) {
  return apiFetch<SubcontractsResponse>(`/projects/${projectId}/subcontracts`)
}

/**
 * 整批存：帶 id 更新、沒 id 新增、沒出現的軟刪。
 * ⚠️ 有列被移除時 `deleteReason` 必填（後端 400 `delete_reason_required`）；
 * 該列若有已付款期別會 409 `paid`——UI 應先擋，或至少把錯誤講清楚。
 */
export function putProjectSubcontracts(
  projectId: string,
  body: { subcontracts: Subcontract[]; deleteReason?: string },
) {
  return apiFetch<SubcontractsResponse>(`/projects/${projectId}/subcontracts`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/**
 * ⚠️ 期款列**不可移除**（project_subcontract_payments 沒有軟刪欄位、DB 層
 * 擋硬刪）：payload 必須包含每一筆既有列，漏掉任一筆一律 409
 * `payment_not_removable`（已付的回 `paid`）；要「拿掉」一期就把百分比改 0。
 * 把已付期別改回未付（`paidOn` 清空）時 `reason` 必填。
 */
export function putSubcontractPayments(
  projectId: string,
  subcontractId: string,
  body: { payments: SubcontractPayment[]; reason?: string },
) {
  return apiFetch<{ subcontract: Subcontract }>(
    `/projects/${projectId}/subcontracts/${subcontractId}/payments`,
    { method: "PUT", body: JSON.stringify(body) },
  )
}

export const SUBCONTRACT_ERRORS: Record<string, string> = {
  invalid_vendor: "選到的廠商不存在或已刪除。",
  invalid_contract: "選到的合約不屬於本專案或已作廢。",
  invalid_company: "選到的公司主體不存在。",
  delete_reason_required: "移除下包／技師列必須填理由。",
  paid: "已有付款紀錄的期別不能移除或改百分比／覆寫金額。",
  payment_not_removable: "期款列不能移除；要拿掉這期請把百分比改成 0。",
  duplicate_installment_no: "期別編號重複。",
  installment_no_taken: "期別編號已存在。",
  override_reason_required: "人工指定金額必須填理由。",
  reason_required: "把已付款的期別改回未付，必須填理由。",
  amount_unknown: "算不出金額，無法標記已付。",
}
export function humanizeSubcontractError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  for (const [code, text] of Object.entries(SUBCONTRACT_ERRORS)) {
    if (msg.includes(code)) return text
  }
  return msg
}

/** `GET /projects/:id` 裡「project」段：serializeProject() + client。 */
export interface ProjectDetail extends Project {
  clientId: string | null
  parentProjectId: string | null
  kind: ProjectKind
  /** 預先取號、尚未真正立案的空列（填了 name 就會清掉）。 */
  reservedAt: string | null
  siteAddress: string | null
  siteAreaM2: number | null
  designScope: DesignScopeItem[]
  invoiceType: InvoiceType | null
  paymentMethod: PaymentMethod | null
  closingDay: string | null
  paymentDay: string | null
  otherExpenses: number | null
  engineers: ProjectEngineers
  client: Client | null
}

/** 合約精簡版（年度總表／專案明細內嵌用），比完整 Contract 少幾欄。 */
export interface ContractLiteP3 {
  id: string | null
  docType: DocType
  ourRole: OurRole
  title: string | null
  amount: number | null
  signedOn: string | null
  createdAt: string
}
export interface LatestDocument {
  id: string | null
  docType: DocType
  title: string | null
  amount: number | null
  signedOn: string | null
}

/** `GET /projects/:id` 整包回應——access/money/billings/subcontracts/contracts
 * 是跟 project 平行的欄位，不是塞在 project 裡面。 */
export interface ProjectDetailResponse {
  project: ProjectDetail
  access: ProjectAccess
  money: ProjectMoney | null
  billings: BillingExt[]
  subcontracts: Subcontract[]
  contracts: ContractLiteP3[]
}

export function getProjectDetail(id: string) {
  return apiFetch<ProjectDetailResponse>(`/projects/${id}`)
}

/** 申請單資料——`/application`，project 段本身不含 client（另外平行給）。 */
export interface ApplicationData {
  code: string | null
  /** 建立日（租戶當地時區），'YYYY-MM-DD'。 */
  createdOn: string
  /** 申請日期的民國寫法 'yyy.m.d'。 */
  dateRoc: string | null
  project: Omit<ProjectDetail, "client">
  client: Client | null
  latestDocument: LatestDocument | null
  designScope: DesignScopeItem[]
  engineers: ProjectEngineers
  billings: BillingExt[]
  subcontracts: Subcontract[]
  money: ProjectMoney | null
  settings: { vatRate: number; disciplines: string[] }
}

export function getProjectApplication(id: string) {
  return apiFetch<{ application: ApplicationData; access: ProjectAccess }>(`/projects/${id}/application`)
}

export interface UpdateProjectExtBody {
  name?: string
  fiscalYear?: number | null
  description?: string | null
  status?: ProjectStatus
  statusReason?: string
  statusEffectiveOn?: string | null
  archived?: boolean
  startsOn?: string | null
  endsOn?: string | null
  deptId?: string | null
  leadEmpId?: string | null
  shareMode?: ShareMode
  bonusPool?: number | null
  clientId?: string | null
  parentProjectId?: string | null
  kind?: ProjectKind
  siteAddress?: string | null
  siteAreaM2?: number | null
  designScope?: DesignScopeItem[]
  invoiceType?: InvoiceType | null
  paymentMethod?: PaymentMethod | null
  closingDay?: string | null
  paymentDay?: string | null
  otherExpenses?: number | null
  engineers?: ProjectEngineers
}

/** 編輯專案（含 P3 新欄位）。code 一樣不在參數裡——不可變更（後端回 409 code_immutable）。 */
export function updateProjectFields(id: string, body: UpdateProjectExtBody) {
  return apiFetch<{ id: string }>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

/** 建立／編輯專案共用的錯誤碼人性化（P3 案型與客戶）。 */
export function humanizeProjectExtError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  if (msg.includes("parent_required")) return "變更設計／追加／代墊必須選擇母案。"
  if (msg.includes("invalid_parent")) return "母案不合法（必須是同租戶的主案，且不能是自己）。"
  if (msg.includes("invalid_client")) return "選到的客戶不存在或已刪除。"
  if (msg.includes("code_immutable")) return "專案編號不可變更。"
  return msg
}

/** 輕量 P3 租戶設定（`/project-settings` 的子集，供科別建議、稅率顯示）。 */
export interface P3SettingsLite {
  vatRate: number
  disciplines: string[]
}
export function getP3SettingsLite() {
  return apiFetch<{ settings: P3SettingsLite & Record<string, unknown> }>("/project-settings")
}

/* -------------------------------------------------------------- 年度總表 -- */

export type AnnualSort = "code" | "unreceived_pct"

export interface AnnualRow {
  seq: number
  projectId: string
  code: string | null
  /** 建立日民國寫法 'yyy.m.d'。 */
  dateRoc: string | null
  createdOn: string
  clientName: string | null
  name: string
  kind: ProjectKind
  /** 預先取號、尚未真正立案的空列。 */
  reserved: boolean
  amountUntaxed: number | null
  amountSource: "contract" | "quotation" | null
  taxAmount: number | null
  amountTotal: number | null
  leadName: string | null
  /** 後端已組好的人看得懂的備註（含累計請款%／金額來源／技師應付）。 */
  note: string
  subcontractByDiscipline: Record<string, number>
  subcontractTotal: number
  technicianTotal: number
  billedTotal: number
  receivedTotal: number
  billingProgressPct: number | null
  receiptProgressPct: number | null
  unreceived: number | null
  unreceivedPct: number | null
  status: string
  archived: boolean
  /** 'N/M' 格式（已請款期數／總期數），非數字。 */
  installments: string
  installmentsBilled: number
  installmentsTotal: number
}

export interface AnnualTotals {
  count: number
  amountUntaxed: number
  taxAmount: number
  amountTotal: number
  billedTotal: number
  receivedTotal: number
  unreceived: number
  subcontractTotal: number
  subcontractByDiscipline: Record<string, number>
}

export interface AnnualBlock {
  /** 'yyy.mm'（建立月份，民國）。 */
  month: string
  /** 指到 rows[].seq 的成員，而不是內嵌整份 row。 */
  seqs: number[]
  subtotal: AnnualTotals
}

export interface AnnualReport {
  today: string
  year: number
  rocYear: number
  sort: AnnualSort
  disciplines: string[]
  rows: AnnualRow[]
  blocks: AnnualBlock[]
  totals: AnnualTotals
}

function annualQuery(params: { year: number; sort?: AnnualSort; includeArchived?: boolean }) {
  const q = new URLSearchParams()
  q.set("year", String(params.year))
  if (params.sort) q.set("sort", params.sort)
  if (params.includeArchived) q.set("includeArchived", "1")
  return q
}

export function getAnnualProjects(params: { year: number; sort?: AnnualSort; includeArchived?: boolean }) {
  const q = annualQuery(params)
  q.set("format", "json")
  return apiFetch<AnnualReport>(`/projects/annual?${q.toString()}`)
}

export function downloadAnnualProjectsXlsx(params: { year: number; sort?: AnnualSort; includeArchived?: boolean }) {
  const q = annualQuery(params)
  q.set("format", "xlsx")
  return apiDownload(`/projects/annual?${q.toString()}`, `年度專案申請單總表_民國${params.year}.xlsx`)
}

/* -------------------------------------------------------------- 未收款 -- */

export interface ReceivableRow {
  projectId: string
  code: string | null
  projectName: string
  clientName: string | null
  billingId: string
  installmentNo: number
  kind: BillingKind
  milestone: string | null
  percentage: number | null
  amount: number | null
  billedOn: string | null
  invoiceNo: string | null
  invoicedOn: string | null
  receivedOn: string | null
  receivedAmount: number | null
  unreceived: number | null
  overdueDays: number | null
  /** 該筆所屬專案整體的未收比例，用於解讀為何排序在前面。 */
  projectUnreceivedPct: number | null
  projectCode: string | null
}

export interface ReceivablesResponse {
  today: string
  status: "open" | "all"
  /** "mine" = 非 HR 只看得到自己 finance 權限內的專案；HR 一律 "all"。 */
  scope: "all" | "mine"
  receivables: ReceivableRow[]
  summary: { count: number; unreceivedTotal: number; overdueCount: number }
}

export function getReceivables(status: "open" | "all" = "open") {
  return apiFetch<ReceivablesResponse>(`/projects/receivables?status=${status}`)
}

/* ---------------------------------------------------------- 民國年工具 -- */

const ROC_EPOCH = 1911

export function adYearToRoc(adYear: number): number {
  return adYear - ROC_EPOCH
}
export function rocYearToAd(rocYear: number): number {
  return rocYear + ROC_EPOCH
}
export function currentRocYear(): number {
  return adYearToRoc(new Date().getFullYear())
}

/** 西元日期（YYYY-MM-DD）轉「民國YYY年M月D日」；空值原樣放行。 */
export function formatRocDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `民國${adYearToRoc(d.getFullYear())}年${d.getMonth() + 1}月${d.getDate()}日`
}
