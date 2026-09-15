/**
 * 放款專區（匯款紀錄 × 專案連動）的 typed API 呼叫。
 * 後端見 apps/api/src/routes/disbursements.ts（新檔，開發中——本檔依規劃文件
 * 的 API 合約撰寫，尚未逐一對過實際回應形狀，見呼叫端註記）。
 * 刻意獨立成新檔、不改 admin-api.ts（後者已經很大，且此模組是獨立團隊在做）。
 */
import { apiFetch, apiDownload } from "./api-client"

/* ---------------------------------------------------------------- 基本型別 -- */
export type DisbursementStatus = "draft" | "paid" | "void"
export type PayeeKind = "vendor" | "other"
export type DisbursementMethod = "transfer" | "check" | "cash"

export interface Allocation {
  id?: string
  projectId: string
  projectCode?: string | null
  projectName?: string | null
  subcontractId?: string | null
  subcontractPaymentId?: string | null
  installmentNo?: number | null
  vendorName?: string | null
  /** ⚠️ 毛額（含代扣），跟頂層 Disbursement.amount（淨額）方向相反——已對過
   * 後端實作（services/disbursements.ts、packages/db/schema/disbursement-allocations.ts
   * 都註記「毛額」）。分攤合計檢核一律拿這欄位跟 Disbursement.grossAmount 比。 */
  amount: number
  withheldAmount?: number
  /** 唯讀，後端已算好 amount − withheldAmount。 */
  netAmount?: number
  /** 副委託描述性欄位，GET 回應才有。 */
  kind?: string | null
  discipline?: string | null
  item?: string | null
  note?: string | null
}

export interface AllocationInput {
  projectId: string
  subcontractId?: string | null
  subcontractPaymentId?: string | null
  /** 毛額（含代扣），見 Allocation.amount 的說明；後端 zod 要求 > 0。 */
  amount: number
  withheldAmount?: number
  note?: string | null
}

export interface Attachment {
  id: string
  fileName: string
  sizeBytes: number
  contentType: string | null
  createdAt: string
  /** signed URL，3600s 過期；GET /disbursements/:id 才會帶。 */
  url: string | null
}

export interface Disbursement {
  id: string
  disbursementNo: string
  status: DisbursementStatus
  payeeKind: PayeeKind
  vendorId: string | null
  payeeName: string
  payeeBankName: string | null
  payeeBankAccount: string | null
  /** 收款方銀行代碼，與 payeeBankName／payeeBankAccount 同組快照。 */
  payeeBankCode: string | null
  payingCompanyId: string | null
  payingCompanyName: string | null
  payingBankAccount: string | null
  method: DisbursementMethod
  paidOn: string | null
  /** 實付（淨額）。 */
  amount: number
  /** 代扣合計。 */
  withheldAmount: number
  /** 毛額 = amount + withheldAmount；應用層算，回應才有，不用送。 */
  grossAmount: number
  receiptIssuerCompanyId: string | null
  /** 收據抬頭公司名稱（快照/join），GET 回應才有。 */
  receiptIssuerCompanyName?: string | null
  receiptRef: string | null
  /** 收款方是否已開立發票（B2）。 */
  hasInvoice: boolean
  invoiceNo: string | null
  purpose: string | null
  note: string | null
  voidReason: string | null
  paidByEmpId: string | null
  createdByEmpId?: string | null
  createdAt: string
  updatedAt?: string
  /** 「AT-115-001 第1,2期」這類分攤摘要字串，列表／明細／匯出共用。 */
  allocationLabel?: string
  allocations: Allocation[]
  attachments?: Attachment[]
}

/** POST /disbursements、PATCH /disbursements/:id 的 body。 */
export interface DisbursementInput {
  payeeKind: PayeeKind
  vendorId?: string | null
  payeeName?: string
  payeeBankName?: string | null
  payeeBankAccount?: string | null
  payeeBankCode?: string | null
  payingCompanyId: string
  method: DisbursementMethod
  paidOn?: string | null
  amount: number
  withheldAmount?: number
  receiptIssuerCompanyId?: string | null
  receiptRef?: string | null
  /** 是否已取得發票／收據；paid 狀態下仍可用 PATCH 補（見 DisbursementPatchInput 註記）。 */
  hasInvoice?: boolean
  invoiceNo?: string | null
  purpose?: string | null
  note?: string | null
  status: "draft" | "paid"
  allocations: AllocationInput[]
}

/** PATCH：draft 全欄可改（allocations 整批覆蓋，列數變少可能 409
 * allocation_not_removable）。paid 狀態下 note/receiptRef/purpose/hasInvoice/invoiceNo
 * 可正常改（已匯款後補發票號是常態）；其餘欄位「省略不送」沒事、「送了但值跟現存
 * 相同」也沒事，只有「送了且值不同」才會 409 paid（帶 field）——所以呼叫端請只送
 * 這五個欄位，別把整張表單原樣回傳。 */
export type DisbursementPatchInput = Partial<Omit<DisbursementInput, "status">>

export interface Payable {
  subcontractPaymentId: string
  subcontractId: string
  projectId: string
  projectCode: string | null
  projectName: string
  vendorId: string | null
  vendorName: string | null
  installmentNo: number
  dueWhen: string | null
  grossAmount: number
  withheldAmount: number
  netAmount: number
  /** 該專案收款進度%（「收到款才放款」提示用）；查不到給 null。 */
  projectReceiptProgressPct: number | null
  /** 副委託描述性欄位。 */
  kind?: string
  discipline?: string | null
  item?: string | null
  /** 可用來預填建單表單的預設值。 */
  payingCompanyId?: string | null
  receiptIssuerCompanyId?: string | null
  /** 收款進度%的分子／分母，可做 tooltip。 */
  projectReceivedTotal?: number
  projectAmountUntaxed?: number | null
  /** 該案已封存但期款未付（C2 複製封存原案後仍要付）；列上打灰標。 */
  archived?: boolean
}

/** 依廠商分組的應付清單彙總（GET /disbursements/payables 的 groups）。 */
export interface PayableGroup {
  key: string
  vendorId: string | null
  vendorName: string | null
  count: number
  grossTotal: number
  withheldTotal: number
  netTotal: number
  subcontractPaymentIds: string[]
}

/** manualPaid=1 時 GET /disbursements 改列的「已付但無匯款單」期款列。 */
export interface ManualPaidPayment {
  subcontractPaymentId: string
  subcontractId: string
  projectId: string
  projectCode: string | null
  projectName: string
  vendorId: string | null
  vendorName: string | null
  /** 副委託描述，GET 回應才有。 */
  kind?: string
  installmentNo: number
  paidOn: string | null
  paidAmount: number | null
  withheldAmount: number | null
  payingCompanyId: string | null
  payingCompanyName: string | null
  receiptIssuerCompanyId: string | null
  receiptRef: string | null
}

export interface DisbursementSummaryGroup {
  key: string
  label: string
  total: number
  count: number
}

export interface DisbursementSummary {
  today?: string
  from: string
  to: string
  /** 期間（from~to）放款總額／筆數／代扣／毛額。 */
  periodTotal: number
  periodCount: number
  periodWithheldTotal?: number
  periodGrossTotal?: number
  monthTotal: number
  monthCount?: number
  monthWithheldTotal?: number
  yearTotal: number
  yearCount?: number
  /** 應付未付：未付期款 Σnet（筆數／毛額／代扣為對應細項）。 */
  unpaidPayableTotal: number
  unpaidPayableCount?: number
  unpaidPayableGrossTotal?: number
  unpaidPayableWithheldTotal?: number
  yearWithheldTotal: number
  byCompany: DisbursementSummaryGroup[]
  byVendorTop5: DisbursementSummaryGroup[]
  byProjectTop5: Array<DisbursementSummaryGroup & { projectCode: string | null; projectName: string }>
}

/* -------------------------------------------------------------------- 查詢 -- */
function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `?${s}` : ""
}

// A `type` alias (not `interface`) so it structurally satisfies buildQuery's
// `Record<string, ...>` parameter without needing an explicit index signature.
export type DisbursementListParams = {
  from?: string
  to?: string
  vendorId?: string
  projectId?: string
  companyId?: string
  status?: DisbursementStatus
  q?: string
}

/** 匯款紀錄列表；預設近 90 天、排除 void 除非 status=void（後端行為，見規劃 §三）。 */
export function listDisbursements(params: DisbursementListParams = {}) {
  return apiFetch<{
    from: string
    to: string
    status?: string
    disbursements: Disbursement[]
    totals: { count: number; amount: number; withheldAmount: number; grossAmount: number }
  }>(`/disbursements${buildQuery(params)}`)
}

/** 同一端點但 manualPaid=1：改列「已付但無匯款單」的期款，供老闆補建匯款單。 */
export function listManualPaidPayments(params: Omit<DisbursementListParams, "status"> = {}) {
  return apiFetch<{ mode: "manualPaid"; from: string; to: string; items: ManualPaidPayment[] }>(
    `/disbursements${buildQuery({ ...params, manualPaid: 1 })}`,
  )
}

export function getDisbursementSummary(params: { from?: string; to?: string } = {}) {
  return apiFetch<DisbursementSummary>(`/disbursements/summary${buildQuery(params)}`)
}

export function getPayables(params: { vendorId?: string; projectId?: string } = {}) {
  return apiFetch<{
    today: string
    payables: Payable[]
    groups: PayableGroup[]
    summary: { count: number; grossTotal: number; withheldTotal: number; netTotal: number }
  }>(`/disbursements/payables${buildQuery(params)}`)
}

export function getDisbursement(id: string) {
  return apiFetch<{ disbursement: Disbursement }>(`/disbursements/${id}`)
}

/** GET /disbursements/:id/attachments：跟 GET /disbursements/:id 的 attachments[] 同形狀，
 * 明細頁目前直接靠 getDisbursement() 整包重讀取得附件，這支是額外提供的獨立端點。 */
export function listDisbursementAttachments(id: string) {
  return apiFetch<{ attachments: Attachment[] }>(`/disbursements/${id}/attachments`)
}

export function createDisbursement(body: DisbursementInput) {
  return apiFetch<{ disbursement: Disbursement }>("/disbursements", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function patchDisbursement(id: string, body: DisbursementPatchInput) {
  return apiFetch<{ disbursement: Disbursement }>(`/disbursements/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

export function payDisbursement(id: string, body: { paidOn?: string } = {}) {
  return apiFetch<{ disbursement: Disbursement }>(`/disbursements/${id}/pay`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidDisbursement(id: string, reason: string) {
  return apiFetch<{ disbursement: Disbursement }>(`/disbursements/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

/* ---------------------------------------------------------------- 附件 -- */
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** ≤5 檔、≤5MB：檔數超過第 6 個回 409 max_files_reached，單檔超過 5MB 或空檔回 413
 * file_too_large；前端也可先擋一次減少無謂上傳。 */
export async function uploadDisbursementAttachment(id: string, file: File) {
  const dataBase64 = await fileToBase64(file)
  return apiFetch<{ id: string; sizeBytes: number }>(`/disbursements/${id}/attachments`, {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", dataBase64 }),
  })
}

export function deleteDisbursementAttachment(id: string, attachmentId: string) {
  return apiFetch<{ id: string }>(`/disbursements/${id}/attachments/${attachmentId}`, {
    method: "DELETE",
  })
}

/** 匯出跟列表共用同一組篩選參數（後端 parseListQuery 共用），可以把畫面上目前的
 * 篩選條件原樣帶進來，匯出列數才會等於畫面上看到的列數。 */
export function exportDisbursementsXlsx(params: DisbursementListParams = {}, filename = "放款紀錄.xlsx") {
  return apiDownload(`/disbursements/export.xlsx${buildQuery(params)}`, filename)
}

/* -------------------------------------------------------------------- 顯示 -- */
export const DISBURSEMENT_STATUS_LABELS: Record<DisbursementStatus, string> = {
  draft: "草稿",
  paid: "已匯款",
  void: "作廢",
}
export const PAYEE_KIND_LABELS: Record<PayeeKind, string> = {
  vendor: "廠商",
  other: "其他",
}
export const DISBURSEMENT_METHOD_LABELS: Record<DisbursementMethod, string> = {
  transfer: "轉帳",
  check: "支票",
  cash: "現金",
}

// ⚠️ 順序有意義：humanizeDisbursementError 用 msg.includes(code) 逐一比對，
// 命中就回傳，所以較長／較具體的 code（如 payment_already_paid、paid_on_required）
// 必須排在會被它們的字串「包含」的較短 code（如 already_paid、paid）前面，
// 否則短 code 會先誤判命中。新增 code 時請留意這點，別直接塞在最前面。
export const DISBURSEMENT_ERRORS: Record<string, string> = {
  allocation_mismatch: "分攤合計金額與毛額不符。",
  payment_already_paid: "選到的期款已由其他匯款標記為已付。",
  invalid_vendor: "選到的廠商不存在或已刪除。",
  invalid_company: "選到的公司主體不存在。",
  invalid_project: "選到的專案不存在。",
  paid_on_required: "標記已匯款必須填放款日。",
  void: "已作廢的匯款不能再修改。",
  invalid_allocation: "分攤列格式錯誤。",
  duplicate_payment: "同一期款被分攤了兩次。",
  invalid_payment: "選到的期款不存在或不屬於這個副委託。",
  invalid_subcontract: "選到的副委託不存在。",
  payee_name_required: "「其他」收款方必須填收款方名稱。",
  invalid_amount: "金額不可為負數。",
  allocation_not_removable: "草稿的分攤列數變少會撞到期款硬刪限制，請改金額而不要整列刪除。",
  code_conflict: "產生匯款單號時撞號，請重新送出一次。",
  file_too_large: "附件過大（上限 5MB）或是空檔。",
  max_files_reached: "附件已達上限（5 個）。",
  // 這個必須排在 payment_already_paid／paid_on_required 之後，見上方註記。
  already_paid: "這筆匯款已經是已匯款狀態，不能再標記一次。",
  paid: "已匯款的單只能改用途／收據編號／發票資訊／備註，其餘欄位維持原樣才會通過。",
  invalid_query: "查詢參數格式錯誤。",
  invalid_body: "送出的資料格式錯誤。",
  invalid_base64: "檔案內容編碼錯誤，請重新選擇檔案。",
  not_found: "找不到這筆資料，可能已被刪除。",
}

export function humanizeDisbursementError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  for (const [code, text] of Object.entries(DISBURSEMENT_ERRORS)) {
    if (msg.includes(code)) return text
  }
  return msg
}

/* ------------------------------------------------------------ 匯款資訊複製 -- */
/** 銀行顯示字串：後端 vendor 快照慣例會把代碼內嵌進 bankName（如「國泰世華（013）」，
 * 見 services/disbursements.ts vendorBankName）；已內嵌就照原樣顯示，否則把
 * bankCode 用括號補在後面，避免「國泰世華（013）（013）」重複。純函式。 */
function formatBankLine(bankName: string | null, bankCode: string | null): string {
  const name = (bankName ?? "").trim()
  const code = (bankCode ?? "").trim()
  if (!code) return name
  if (name.includes(code)) return name
  return name ? `${name}（${code}）` : code
}

/** 「複製匯款資訊」按鈕的文字組裝（純函式，不碰 DOM／clipboard，方便單元測試）：
 * 戶名／銀行（代號）／帳號／金額，一行一項，貼進網銀 APP 轉帳頁面剛好對應四個欄位。 */
export function buildRemittanceText(d: {
  payeeName: string
  payeeBankName: string | null
  payeeBankCode: string | null
  payeeBankAccount: string | null
  amount: number
}): string {
  return [
    `戶名：${d.payeeName || "—"}`,
    `銀行：${formatBankLine(d.payeeBankName, d.payeeBankCode) || "—"}`,
    `帳號：${d.payeeBankAccount || "—"}`,
    `金額：${d.amount.toLocaleString()}`,
  ].join("\n")
}
