/**
 * 放款專區（匯款紀錄 × 專案連動）的 typed API 呼叫。
 * 後端見 apps/api/src/routes/disbursements.ts、services/disbursement-approval.ts。
 * 刻意獨立成新檔、不改 admin-api.ts（後者已經很大，且此模組是獨立團隊在做）。
 *
 * M4（2026-09-23）加簽核鏈：`submit` → `approve`／`reject` → `pay`，
 * 以及 HR 的 `change-approver`／`withdraw`；「複製匯款資訊」的純函式已抽到
 * `lib/remittance.ts`（廠商頁也在用），這裡只 re-export 方便既有呼叫端。
 */
import { apiFetch, apiDownload } from "./api-client"

export { buildRemittanceText, copyText, formatBankLine, type RemittanceInfo } from "./remittance"

/* ---------------------------------------------------------------- 基本型別 -- */
export type DisbursementStatus = "draft" | "pending_approval" | "approved" | "paid" | "void"
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
  /* ── M4 簽核（欄位尚未套用時後端一律回 null／0）── */
  currentStep?: number | null
  approvalRound?: number
  submittedAt?: string | null
  submittedByEmpId?: string | null
  approvedAt?: string | null
  /** 簽核軌跡（含舊輪）；只有 GET /disbursements/:id 會帶。 */
  approvalSteps?: DisbursementApprovalStep[]
  /** 「AT-115-001 第1,2期」這類分攤摘要字串，列表／明細／匯出共用。 */
  allocationLabel?: string
  allocations: Allocation[]
  attachments?: Attachment[]
}

/** 一關簽核（disbursement_approval_steps）。 */
export interface DisbursementApprovalStep {
  id: string
  round: number
  stepOrder: number
  /** 'manager' | 'accountant' | 'fallback'（老闆）| 'list' | 'hr_admin'。 */
  stepKind: string | null
  approverEmpId: string
  approverName: string | null
  candidateEmpIds: string[]
  candidateNames: string[]
  decision: "pending" | "approved" | "rejected"
  comment: string | null
  actedAt: string | null
  actedByEmpId: string | null
  actedByName: string | null
}

/** GET /disbursements/pending-approvals 的一列（匯款單本身 ＋ 現行關卡資訊）。 */
export interface PendingDisbursementApproval extends Disbursement {
  currentStepOrder: number
  totalSteps: number
  stepKind: string | null
  stepKindLabel: string | null
  candidateEmpIds: string[]
  candidateNames: string[]
  createdByName: string | null
  submittedByName: string | null
  /** 是否輪到「我」簽（scope=all 時才可能 false）。 */
  mine: boolean
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
  /** HR 跳過簽核直接建已匯款單，或強制放行未驗收期款的理由（寫稽核）。 */
  forceReason?: string | null
  /** HR 勾「未驗收仍要放款」（M5）。 */
  forceAcceptance?: boolean
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

/** approved → paid。draft 直接付款要 HR ＋ `forceReason`（否則 409 approval_required）。 */
export function payDisbursement(
  id: string,
  body: { paidOn?: string; forceReason?: string; forceAcceptance?: boolean } = {},
) {
  return apiFetch<{ disbursement: Disbursement }>(`/disbursements/${id}/pay`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/* ------------------------------------------------------------ M4 簽核鏈 -- */

/** draft → pending_approval：建單人主管鏈 → 會計 → 老闆，通知第 1 關。 */
export function submitDisbursement(id: string, body: { forceReason?: string; forceAcceptance?: boolean } = {}) {
  return apiFetch<{
    disbursement: Disbursement
    approvalSource: string
    steps: Array<{ stepOrder: number; kind: string; candidateEmpIds: string[]; candidateNames: string[] }>
    notified: number
  }>(`/disbursements/${id}/submit`, { method: "POST", body: JSON.stringify(body) })
}

export interface DisbursementDecisionResult {
  status: "pending_approval" | "approved" | "draft"
  currentStep: number | null
  notified: number
  disbursement: Disbursement
}

export function approveDisbursement(id: string, comment?: string) {
  return apiFetch<DisbursementDecisionResult>(`/disbursements/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ comment: comment ?? null }),
  })
}

export function rejectDisbursement(id: string, comment: string) {
  return apiFetch<DisbursementDecisionResult>(`/disbursements/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  })
}

/** HR：把現行關卡換人。 */
export function changeDisbursementApprover(id: string, approverEmpId: string) {
  return apiFetch<{ stepOrder: number; previousApproverEmpId: string; notified: number }>(
    `/disbursements/${id}/change-approver`,
    { method: "POST", body: JSON.stringify({ approverEmpId }) },
  )
}

/** HR：撤回送簽（pending_approval → draft，理由必填）。 */
export function withdrawDisbursement(id: string, reason: string) {
  return apiFetch<{ disbursement: Disbursement }>(`/disbursements/${id}/withdraw`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

/** 輪到我簽的放款單；`scope='all'`（限 finance 角色）改列全租戶送簽中的單。 */
export function getPendingDisbursementApprovals(params: { scope?: "mine" | "all" } = {}) {
  return apiFetch<{ scope: "mine" | "all"; disbursements: PendingDisbursementApproval[] }>(
    `/disbursements/pending-approvals${buildQuery(params)}`,
  )
}

/* ------------------------------------------------------- M5 複委託驗收 -- */

/** 專案頁每期的「驗收確認」；`acceptedOn` 省略＝今天。回傳整個副委託（含期款）。 */
export function acceptSubcontractPayment(
  projectId: string,
  subcontractId: string,
  installmentNo: number,
  body: { acceptedOn?: string; note?: string } = {},
) {
  return apiFetch<{ subcontract: unknown; acceptedOn: string }>(
    `/projects/${projectId}/subcontracts/${subcontractId}/payments/${installmentNo}/accept`,
    { method: "POST", body: JSON.stringify(body) },
  )
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
  pending_approval: "待簽核",
  approved: "已核准",
  paid: "已匯款",
  void: "作廢",
}

/** 列表／明細的狀態色（草稿與待簽核都是「還沒付錢」，但待簽核不能再改）。 */
export const DISBURSEMENT_STATUS_TONE: Record<DisbursementStatus, string> = {
  draft: "text-amber-700",
  pending_approval: "text-blue-700",
  approved: "text-emerald-700",
  paid: "text-green-700",
  void: "text-gray-400",
}

/** 簽核關卡的中文（stepKind → 標籤）。 */
export const DISBURSEMENT_STEP_KIND_LABELS: Record<string, string> = {
  manager: "主管",
  accountant: "會計",
  fallback: "老闆",
  hr: "HR 覆核",
  hr_admin: "HR",
  list: "指定簽核人",
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
  // M4／M5（放在最前面：都是完整字串，不會被其他 code 包含）
  acceptance_force_forbidden: "只有 HR 可以強制放行未驗收的期款。",
  acceptance_not_available: "驗收功能所需的資料庫欄位尚未套用，請聯絡管理員。",
  acceptance_required: "分攤到的複委託期款還沒驗收確認，請先在專案頁按「驗收確認」。",
  approval_not_available: "放款簽核所需的資料表尚未套用，請聯絡管理員。",
  force_reason_required: "這個動作需要填寫理由（會寫進稽核紀錄）。",
  no_approver_available: "找不到可以簽核的人，請先在「簽核流程」設定或指定老闆。",
  not_current_approver: "這張放款單目前不是輪到你簽核。",
  current_step_not_found: "找不到目前的簽核關卡，請重新整理。",
  invalid_approver: "選到的簽核人不存在或已離職。",
  acceptance_locked: "已付款的期別不能取消驗收。",
  approval_required: "放款要先送簽核准才能付款（HR 可填理由直接付款）。",
  pending_approval: "送簽中的放款單不可修改，要改請先撤回簽核。",
  not_pending: "這張單目前不在送簽中，請重新整理。",
  not_draft: "只有草稿可以送簽，請重新整理。",
  approved: "已核准的單只能改用途／收據編號／發票資訊／備註；要改其他欄位請先撤回簽核。",
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
