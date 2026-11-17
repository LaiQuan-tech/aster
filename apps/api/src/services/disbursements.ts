import { selectAllPages } from "../lib/select-all-pages.js"
import { buildRosterKeyIndex, exactNameKey, invalidNameMessage, rosterKeyMatches } from "../lib/payee-name.js"
import { vendorHasUnpaidInstallments } from "./vendor-unpaid.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isProjectDeletedError, isRetryableConflictError, isRowDeletedError } from "../middleware/project-deleted.js"
import { logger } from "../lib/logger.js"
import { sanitizeSearchTerm } from "../lib/search-term.js"
import { addDaysKey, dayWindowUtc, todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { BILLING_COLS, num, type BillingRow } from "./billing-store.js"
import {
  computeMoney,
  computeSubcontractPayments,
  resolveAmountUntaxed,
  round0,
  summarizeContracts,
  DEFAULT_WITHHOLDING_RATE,
  DEFAULT_WITHHOLDING_THRESHOLD,
  type ContractLite,
} from "./project-money.js"
import {
  CONTRACT_LITE_COLS,
  PAYMENT_COLS,
  SUBCONTRACT_COLS,
  batch,
  compareCode,
  groupBy,
  loadP3Settings,
  toMoneyBilling,
  uniq,
  type P3Settings,
  type PaymentRow,
  type SubcontractRow,
} from "./project-application-store.js"
import { isUniqueViolation, MAX_CODE_ATTEMPTS } from "./project-code.js"
import { loadDisbursementNoFormat, nextDisbursementNo } from "./disbursement-no.js"
import { recomputeBonusRunsBestEffort } from "./bonus-run-store.js"
import { writeAuditLog, writeAuditLogStrict } from "./audit.js"
import { firstNewlyPickedInactive } from "./company-lifecycle.js"
import { columnsExist } from "../lib/schema-compat.js"
import { isHrRole } from "../middleware/scope.js"
import { composeAccountSnapshot, holderSegment, maskBankAccount, normalizeAccountNumber, splitAccountSnapshot, vendorHasPendingBankChange, vendorsWithPendingBankChange } from "./vendor-bank-change.js"

/**
 * 放款專區——匯款紀錄（disbursements）× 分攤（disbursement_allocations）×
 * 專案期款（project_subcontract_payments）的連動。放款的**單一真相**在這裡：
 * 專案頁期款的「已付」由匯款紀錄連動產生（舊的整批 PUT 保留相容，見
 * routes/subcontracts.ts）。
 *
 * ── 狀態機（M4 放款簽核鏈；2026-09-23 起）──────────────────────────
 *   draft ──submit──▶ pending_approval ──最後一關 approve──▶ approved ──pay──▶ paid
 *     ▲                     │ reject／withdraw（HR）                       │
 *     └─────────────────────┘                                    任何狀態 ──void──▶ void
 *   • draft：不動期款；全部欄位可改（allocations 整批覆蓋）。**不能直接付款**——
 *     要 HR 且帶 `forceReason` 才放行（409 `approval_required`／400
 *     `force_reason_required`），並寫稽核。
 *   • pending_approval：送簽中，不可編輯（409 `pending_approval`）；要改先撤回。
 *     關卡在 disbursement_approval_steps（services/disbursement-approval.ts）。
 *   • approved：簽核完成，只可改 `PAID_EDITABLE` 那幾欄（409 `approved`）；可 pay。
 *   • paid：連動期款（`syncPaymentsOnPay`）；只可改 note／receiptRef／purpose／
 *     hasInvoice／invoiceNo（已匯款後補發票號是常態）。
 *   • void：反向清期款（`unsyncPaymentsOnVoid`）；之後不能再改。
 *
 * ── 複委託驗收（M5）───────────────────────────────────────────────
 *   分攤到「未驗收」（`project_subcontract_payments.accepted_on` 為 null）的期款
 *   時 409 `acceptance_required`；HR 可帶 `forceAcceptance:true` ＋ `forceReason`
 *   放行並寫稽核。建單／改分攤／送簽／付款四個點都檢查（`assertPaymentsAccepted`）。
 *   驗收欄位尚未套用（migration 0050）時整條檢查略過＝維持上線前行為。
 *
 * ── 金額口徑 ──────────────────────────────────────────────────────
 *   `amount`＝實際匯出的淨額、`withheldAmount`＝代扣合計、毛額＝兩者相加
 *   （回應提供 `grossAmount`）。分攤列的 `amount` 是**毛額**（含代扣）、
 *   `withheldAmount` 是該列代扣；規則
 *     Σ allocations.amount     = amount + withheldAmount
 *     Σ allocations.withheld   = withheldAmount
 *   不符 → 400 `allocation_mismatch`（`payeeKind='other'` 允許零分攤）。
 *
 * ── 一個期款最多被一筆有效匯款付清 ─────────────────────────────────
 *   期款已 paid 且 `disbursement_id` 不是本單（含舊路徑手動標記＝null）→
 *   409 `payment_already_paid`；作廢後期款清回未付，可再被新匯款付。
 *   純應用層檢查（DB 無跨表 partial unique，見計畫 §一）。
 *
 * ── 沒有交易 ──────────────────────────────────────────────────────
 *   supabase-js 沒有 transaction；比照 routes/subcontracts.ts 的做法：所有
 *   驗證（參照、金額、期款可付）都在第一筆寫入之前做完，寫入順序是
 *   匯款單 → 分攤 → 期款連動 → 通知，讓失敗盡量落在還沒動到期款之前。
 *
 * 純函式（金額檢核、聚合、單號格式）集中在檔案上半段，供單元測試。
 */

export const DISBURSEMENT_STATUSES = ["draft", "pending_approval", "approved", "paid", "void"] as const
export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number]
export const DISBURSEMENT_METHODS = ["transfer", "check", "cash"] as const
export type DisbursementMethod = (typeof DISBURSEMENT_METHODS)[number]
export const PAYEE_KINDS = ["vendor", "other"] as const
export type PayeeKind = (typeof PAYEE_KINDS)[number]

/** 列表預設回顧天數。 */
export const DEFAULT_LIST_DAYS = 90
/** 附件：≤5 檔、≤5MB。 */
export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_BUCKET = "disbursement-vouchers"
/** 金額比對容差（numeric(14,2) 來回會有 0.005 的浮點誤差）。 */
export const AMOUNT_TOLERANCE = 0.01

// ⚠️ 單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別。
export const DISBURSEMENT_COLS =
  "id, tenant_id, disbursement_no, status, payee_kind, vendor_id, payee_name, payee_bank_name, payee_bank_account, payee_bank_code, paying_company_id, paying_company_name, paying_bank_account, method, paid_on, amount, withheld_amount, receipt_issuer_company_id, receipt_ref, has_invoice, invoice_no, purpose, note, void_reason, paid_by_emp_id, created_by_emp_id, created_at, updated_at"
/** 加上 M4 簽核欄位（migration 0050）；欄位尚未套用時退回 `DISBURSEMENT_COLS`。 */
export const DISBURSEMENT_COLS_APPROVAL =
  "id, tenant_id, disbursement_no, status, payee_kind, vendor_id, payee_name, payee_bank_name, payee_bank_account, payee_bank_code, paying_company_id, paying_company_name, paying_bank_account, method, paid_on, amount, withheld_amount, receipt_issuer_company_id, receipt_ref, has_invoice, invoice_no, purpose, note, void_reason, paid_by_emp_id, created_by_emp_id, created_at, updated_at, current_step, approval_round, submitted_at, submitted_by_emp_id, approved_at"

/** 再加上草稿編輯人（migration 0080 edited_by_emp_ids；2026-10-27 安全驗收 M2）。 */
export const DISBURSEMENT_COLS_APPROVAL_EDITORS =
  "id, tenant_id, disbursement_no, status, payee_kind, vendor_id, payee_name, payee_bank_name, payee_bank_account, payee_bank_code, paying_company_id, paying_company_name, paying_bank_account, method, paid_on, amount, withheld_amount, receipt_issuer_company_id, receipt_ref, has_invoice, invoice_no, purpose, note, void_reason, paid_by_emp_id, created_by_emp_id, created_at, updated_at, current_step, approval_round, submitted_at, submitted_by_emp_id, approved_at, edited_by_emp_ids"

/** disbursements.edited_by_emp_ids（migration 0080）是否已套用；未套用時不記錄、也不納入「自己的單」（退回舊行為）。 */
export function disbursementsHaveEditors(): Promise<boolean> {
  return columnsExist("disbursements", "edited_by_emp_ids")
}

/** disbursements 的簽核欄位（migration 0050）是否已套用（探測一次、之後分支）。 */
export function disbursementsHaveApproval(): Promise<boolean> {
  return columnsExist("disbursements", "current_step, approval_round, submitted_at, submitted_by_emp_id, approved_at")
}
/** 讀 disbursements 時要帶的欄位（已套用簽核欄位就一起帶回來）。 */
export async function disbursementCols(): Promise<string> {
  const split = (await disbursementsHaveSplitAccount()) ? ", payee_bank_account_number, payee_account_holder" : ""
  if (!(await disbursementsHaveApproval())) return DISBURSEMENT_COLS + split
  return ((await disbursementsHaveEditors()) ? DISBURSEMENT_COLS_APPROVAL_EDITORS : DISBURSEMENT_COLS_APPROVAL) + split
}
/** disbursements 的收款帳號／戶名分欄（migration 0106）是否已套用。 */
export function disbursementsHaveSplitAccount(): Promise<boolean> {
  return columnsExist("disbursements", "payee_bank_account_number, payee_account_holder")
}
/** `project_subcontract_payments` 的驗收欄位（migration 0050）是否已套用。 */
export function paymentsHaveAcceptance(): Promise<boolean> {
  return columnsExist("project_subcontract_payments", "accepted_on, accepted_by_emp_id, acceptance_note")
}
export const ALLOCATION_COLS =
  "id, disbursement_id, project_id, subcontract_id, subcontract_payment_id, amount, withheld_amount, note, created_at"
export const ATTACHMENT_COLS =
  "id, disbursement_id, file_name, storage_path, size_bytes, content_type, uploaded_by_emp_id, created_at"

export type DisbursementRow = {
  id: string
  tenant_id: string
  disbursement_no: string
  status: DisbursementStatus
  payee_kind: PayeeKind
  vendor_id: string | null
  payee_name: string
  payee_bank_name: string | null
  payee_bank_account: string | null
  payee_bank_code: string | null
  /** 0106：收款帳號（只含數字）與戶名分欄；欄位未套用或舊單為 undefined／null（改讀 payee_bank_account 快照）。 */
  payee_bank_account_number?: string | null
  payee_account_holder?: string | null
  paying_company_id: string
  paying_company_name: string | null
  paying_bank_account: string | null
  method: DisbursementMethod
  paid_on: string | null
  amount: string | number
  withheld_amount: string | number
  receipt_issuer_company_id: string | null
  receipt_ref: string | null
  has_invoice: boolean
  invoice_no: string | null
  purpose: string | null
  note: string | null
  void_reason: string | null
  paid_by_emp_id: string | null
  created_by_emp_id: string | null
  created_at: string
  updated_at: string
  /* ── M4 簽核欄位（migration 0050；未套用時 loadDisbursement 不會帶回來）── */
  current_step?: number | null
  approval_round?: number | null
  submitted_at?: string | null
  submitted_by_emp_id?: string | null
  approved_at?: string | null
  /** 曾編輯過這張單（PATCH）的人（migration 0080；未套用時沒有）。算「自己的單」，不能簽也不能改派。 */
  edited_by_emp_ids?: string[] | null
}

export type AllocationRow = {
  id: string
  disbursement_id: string
  project_id: string
  subcontract_id: string | null
  subcontract_payment_id: string | null
  amount: string | number
  withheld_amount: string | number
  note: string | null
  created_at: string
}

export type AttachmentRow = {
  id: string
  disbursement_id: string
  file_name: string
  storage_path: string
  size_bytes: number
  content_type: string | null
  uploaded_by_emp_id: string | null
  created_at: string
}

export type ProjectLite = {
  id: string
  code: string | null
  name: string
  lead_emp_id: string | null
  archived_at: string | null
  reserved_at: string | null
  client_id: string | null
}
const PROJECT_LITE_COLS = "id, code, name, lead_emp_id, archived_at, reserved_at, client_id"

/** `is_active`：停用的公司不能被新選成付款公司／收據抬頭（見 resolveHeader）；缺值一律當啟用。 */
type CompanyLite = { id: string; name: string; bank_name: string | null; bank_account: string | null; is_active?: boolean }
const COMPANY_LITE_COLS = "id, name, bank_name, bank_account, is_active"

type VendorLite = {
  id: string
  name: string
  bank_name: string | null
  bank_code: string | null
  bank_account: string | null
  account_holder: string | null
  deleted_at: string | null
}
const VENDOR_LITE_COLS = "id, name, bank_name, bank_code, bank_account, account_holder, deleted_at"

/* ──────────────────────────────────────────────────────────────────
 * 錯誤
 * ────────────────────────────────────────────────────────────────── */

export class DisbursementError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = "DisbursementError"
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 輸入形狀（zod 在 route；這裡是 service 看到的型別）
 * ────────────────────────────────────────────────────────────────── */

export type AllocationInput = {
  projectId: string
  subcontractId?: string | null
  subcontractPaymentId?: string | null
  /** 毛額（含代扣）。 */
  amount: number
  withheldAmount?: number | null
  note?: string | null
}

export type DisbursementInput = {
  payeeKind: PayeeKind
  vendorId?: string | null
  payeeName?: string | null
  payeeBankName?: string | null
  payeeBankAccount?: string | null
  /** 驗收第三輪：「其他」收款分欄送帳號與戶名（有送就以這兩欄組快照，取代 payeeBankAccount 單一字串）。 */
  payeeBankAccountNumber?: string | null
  payeeAccountHolder?: string | null
  /** 收款方銀行代碼，與 payeeBankName／payeeBankAccount 同組快照。 */
  payeeBankCode?: string | null
  payingCompanyId: string
  method: DisbursementMethod
  paidOn?: string | null
  /** 實付＝淨額。 */
  amount: number
  withheldAmount?: number | null
  receiptIssuerCompanyId?: string | null
  receiptRef?: string | null
  /** 收款方是否已開立發票；paid 之後仍可補改（見 PAID_EDITABLE）。 */
  hasInvoice?: boolean
  invoiceNo?: string | null
  purpose?: string | null
  note?: string | null
  status: "draft" | "paid"
  allocations: AllocationInput[]
  /** HR 跳過簽核（status:'paid'）或強制放行未驗收期款的理由；寫稽核。 */
  forceReason?: string | null
  /** HR 勾「未驗收仍要放款」（M5）。 */
  forceAcceptance?: boolean
  /** 第五輪：登錄廠商零分攤、但廠商仍有未付期款時，確認這筆不是付期款（寫稽核）。 */
  confirmNonInstallment?: boolean
  /** 第八輪：「其他」收款名稱與名冊廠商相近（payee_name_similar）但確為不同公司的說明（寫嚴格稽核）。 */
  confirmDistinctReason?: string | null
}

export type DisbursementPatch = Partial<Omit<DisbursementInput, "status">>

/* ──────────────────────────────────────────────────────────────────
 * 純函式：金額檢核
 * ────────────────────────────────────────────────────────────────── */

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

export type AllocationTotalsCheck =
  | { ok: true; grossAmount: number; allocatedGross: number; allocatedWithheld: number }
  | { ok: false; code: "allocation_mismatch"; field: "amount" | "withheldAmount"; expected: number; actual: number }

/**
 * Σ allocations.amount 必須＝amount + withheldAmount，Σ allocations.withheld
 * 必須＝withheldAmount（差 > 0.01 即不符）。`payeeKind='other'` 且零分攤時跳過
 * （印刷／快遞這類非專案支出）；廠商匯款必須有分攤（否則就是 0 ≠ 毛額）。
 */
export function checkAllocationTotals(
  payeeKind: PayeeKind,
  amount: number,
  withheldAmount: number,
  allocations: Array<{ amount: number; withheldAmount?: number | null }>,
): AllocationTotalsCheck {
  const grossAmount = roundMoney(amount + withheldAmount)
  const allocatedGross = roundMoney(allocations.reduce((s, a) => s + a.amount, 0))
  const allocatedWithheld = roundMoney(allocations.reduce((s, a) => s + (a.withheldAmount ?? 0), 0))
  // 零分攤＝非專案支出（印刷／快遞）：「其他」與登錄廠商都允許（登錄廠商零分攤須填用途，見 assertVendorPurpose，2026-11-16）。
  void payeeKind
  if (allocations.length === 0) {
    return { ok: true, grossAmount, allocatedGross: 0, allocatedWithheld: 0 }
  }
  if (Math.abs(allocatedGross - grossAmount) > AMOUNT_TOLERANCE) {
    return { ok: false, code: "allocation_mismatch", field: "amount", expected: grossAmount, actual: allocatedGross }
  }
  if (Math.abs(allocatedWithheld - roundMoney(withheldAmount)) > AMOUNT_TOLERANCE) {
    return {
      ok: false,
      code: "allocation_mismatch",
      field: "withheldAmount",
      expected: roundMoney(withheldAmount),
      actual: allocatedWithheld,
    }
  }
  return { ok: true, grossAmount, allocatedGross, allocatedWithheld }
}

/** 分攤列自身的形狀：代扣不可超過毛額；同一期款不可在同一單出現兩次。 */
export function checkAllocationShape(
  allocations: Array<{ amount: number; withheldAmount?: number | null; subcontractPaymentId?: string | null }>,
): { ok: true } | { ok: false; code: "invalid_allocation" | "duplicate_payment"; index: number; subcontractPaymentId?: string } {
  const seen = new Set<string>()
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i]
    const withheld = a.withheldAmount ?? 0
    if (!(a.amount > 0) || withheld < 0 || withheld > a.amount + AMOUNT_TOLERANCE) {
      return { ok: false, code: "invalid_allocation", index: i }
    }
    if (a.subcontractPaymentId) {
      if (seen.has(a.subcontractPaymentId)) {
        return { ok: false, code: "duplicate_payment", index: i, subcontractPaymentId: a.subcontractPaymentId }
      }
      seen.add(a.subcontractPaymentId)
    }
  }
  return { ok: true }
}

/** 作廢時附在期款 note 後面的一行（同 billings unbill／subcontracts 撤銷付款的寫法）。 */
export function voidNoteLine(disbursementNo: string, reason: string): string {
  return `作廢匯款 ${disbursementNo}：${reason}`
}

export function appendNote(existing: string | null | undefined, line: string): string {
  return [existing, line].filter((s): s is string => !!s && s.trim().length > 0).join("\n")
}

/**
 * 列表用的分攤摘要：「AT-115-001 第1,2期、AT-115-003」——同專案的期別併成一段，
 * 只到專案層級的分攤不寫期別。
 */
export function allocationLabel(
  allocations: Array<{ projectCode: string | null; projectName: string; installmentNo: number | null }>,
): string {
  const byProject = new Map<string, { label: string; nos: number[] }>()
  for (const a of allocations) {
    const key = a.projectCode ?? a.projectName
    const entry = byProject.get(key) ?? { label: a.projectCode ?? a.projectName, nos: [] }
    if (a.installmentNo !== null) entry.nos.push(a.installmentNo)
    byProject.set(key, entry)
  }
  return [...byProject.values()]
    .map((e) => {
      const nos = [...new Set(e.nos)].sort((x, y) => x - y)
      return nos.length > 0 ? `${e.label} 第${nos.join(",")}期` : e.label
    })
    .join("、")
}

/* ──────────────────────────────────────────────────────────────────
 * 純函式：老闆卡聚合
 * ────────────────────────────────────────────────────────────────── */

export type SummaryDisbursementInput = {
  id: string
  paidOn: string
  /** 淨額。 */
  amount: number
  withheldAmount: number
  payingCompanyId: string
  payingCompanyName: string | null
  vendorId: string | null
  payeeName: string
  allocations: Array<{ projectId: string; projectCode: string | null; projectName: string; amount: number; withheldAmount: number }>
}

export type SummaryGroup = { key: string; label: string; total: number; count: number }

export type DisbursementSummary = {
  from: string
  to: string
  today: string
  periodTotal: number
  periodCount: number
  periodWithheldTotal: number
  periodGrossTotal: number
  monthTotal: number
  monthCount: number
  monthWithheldTotal: number
  yearTotal: number
  yearCount: number
  yearWithheldTotal: number
  unpaidPayableTotal: number
  unpaidPayableCount: number
  unpaidPayableGrossTotal: number
  unpaidPayableWithheldTotal: number
  byCompany: SummaryGroup[]
  byVendorTop5: SummaryGroup[]
  byProjectTop5: Array<SummaryGroup & { projectCode: string | null; projectName: string }>
}

function inRange(day: string, from: string, to: string): boolean {
  return day >= from && day <= to
}

/**
 * 老闆卡：期間（from~to）放款總額／筆數／代扣、本月、本年（以 today 的月／年）、
 * 按付款公司、按收款方 top5、按專案 top5（分攤淨額）、應付未付。
 * 只算 status='paid' 的列（呼叫端先過濾）；金額都是淨額（實際匯出）。
 */
export function summarizeDisbursements(
  rows: SummaryDisbursementInput[],
  payables: Array<{ netAmount: number; grossAmount: number; withheldAmount: number }>,
  opts: { from: string; to: string; today: string },
): DisbursementSummary {
  const monthPrefix = opts.today.slice(0, 7)
  const yearPrefix = opts.today.slice(0, 4)
  const period = rows.filter((r) => inRange(r.paidOn, opts.from, opts.to))
  const month = rows.filter((r) => r.paidOn.startsWith(monthPrefix))
  const year = rows.filter((r) => r.paidOn.startsWith(yearPrefix))
  const sum = (xs: SummaryDisbursementInput[], pick: (r: SummaryDisbursementInput) => number) =>
    roundMoney(xs.reduce((s, r) => s + pick(r), 0))

  const byCompany = new Map<string, SummaryGroup>()
  const byVendor = new Map<string, SummaryGroup>()
  const byProject = new Map<string, SummaryGroup & { projectCode: string | null; projectName: string }>()
  for (const r of period) {
    const c = byCompany.get(r.payingCompanyId) ?? { key: r.payingCompanyId, label: r.payingCompanyName ?? "", total: 0, count: 0 }
    c.total = roundMoney(c.total + r.amount)
    c.count += 1
    byCompany.set(r.payingCompanyId, c)

    const vkey = r.vendorId ?? `other:${r.payeeName}`
    const v = byVendor.get(vkey) ?? { key: vkey, label: r.payeeName, total: 0, count: 0 }
    v.total = roundMoney(v.total + r.amount)
    v.count += 1
    byVendor.set(vkey, v)

    for (const a of r.allocations) {
      const p = byProject.get(a.projectId) ?? {
        key: a.projectId,
        label: a.projectCode ? `${a.projectCode} ${a.projectName}` : a.projectName,
        projectCode: a.projectCode,
        projectName: a.projectName,
        total: 0,
        count: 0,
      }
      p.total = roundMoney(p.total + (a.amount - a.withheldAmount))
      p.count += 1
      byProject.set(a.projectId, p)
    }
  }
  const desc = (a: SummaryGroup, b: SummaryGroup) => b.total - a.total || a.label.localeCompare(b.label)

  return {
    from: opts.from,
    to: opts.to,
    today: opts.today,
    periodTotal: sum(period, (r) => r.amount),
    periodCount: period.length,
    periodWithheldTotal: sum(period, (r) => r.withheldAmount),
    periodGrossTotal: sum(period, (r) => r.amount + r.withheldAmount),
    monthTotal: sum(month, (r) => r.amount),
    monthCount: month.length,
    monthWithheldTotal: sum(month, (r) => r.withheldAmount),
    yearTotal: sum(year, (r) => r.amount),
    yearCount: year.length,
    yearWithheldTotal: sum(year, (r) => r.withheldAmount),
    unpaidPayableTotal: roundMoney(payables.reduce((s, p) => s + p.netAmount, 0)),
    unpaidPayableCount: payables.length,
    unpaidPayableGrossTotal: roundMoney(payables.reduce((s, p) => s + p.grossAmount, 0)),
    unpaidPayableWithheldTotal: roundMoney(payables.reduce((s, p) => s + p.withheldAmount, 0)),
    byCompany: [...byCompany.values()].sort(desc),
    byVendorTop5: [...byVendor.values()].sort(desc).slice(0, 5),
    byProjectTop5: [...byProject.values()].sort(desc).slice(0, 5),
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 序列化
 * ────────────────────────────────────────────────────────────────── */

export type SerializedAllocation = {
  id: string
  projectId: string
  projectCode: string | null
  projectName: string
  subcontractId: string | null
  subcontractPaymentId: string | null
  installmentNo: number | null
  /** 該副委託的廠商名（快照 vendor_name → vendors.name）。 */
  vendorName: string | null
  kind: string | null
  discipline: string | null
  item: string | null
  amount: number
  withheldAmount: number
  netAmount: number
  note: string | null
}

export type SerializedAttachment = {
  id: string
  fileName: string
  sizeBytes: number
  contentType: string | null
  createdAt: string
  url: string | null
}

export type SerializedDisbursement = {
  id: string
  disbursementNo: string
  status: DisbursementStatus
  payeeKind: PayeeKind
  vendorId: string | null
  payeeName: string
  payeeBankName: string | null
  payeeBankAccount: string | null
  payeeBankCode: string | null
  /**
   * 2026-11-17 業主：核准人看得到收款帳號——只露末 4 碼（****1234），後端遮好；核准類端點不送完整帳號。
   */
  payeeAccountMasked?: string | null
  /** 帳戶來源：roster＝照名冊（登錄廠商）／manual＝手動輸入（非登錄收款方）。 */
  payeeAccountSource?: "roster" | "manual"
  /** 0106：收款帳號（只含數字）。完整帳號——簽核端點遮成 null（routes/disbursements.ts maskPayeeBank）。 */
  payeeBankAccountNumber?: string | null
  /** 0106 分欄是否實存（帳號或戶名任一有值）；false＝舊單（前端解析 payeeBankAccount）。 */
  payeeAccountSplit?: boolean
  /** 驗收 M2：真正的帳戶戶名（登錄廠商取名冊 account_holder；手動取快照「帳號 戶名」的戶名段）；查不到 null。 */
  payeeAccountHolder?: string | null
  /** 登錄廠商的名冊收款帳戶是否經第二人確認（0104 bank_verified_at）；未確認時送審／核准／付款 409 vendor_bank_unverified。 */
  vendorBankVerified?: boolean
  /** 驗收 S2：收款為手動（其他）且分攤到曾解除／改綁名冊廠商的副委託（有 rebind 稽核）→ 核准頁紅框。 */
  payeeRebindWarning?: { message: string; subcontractIds: string[] }
  /** 登錄廠商的名冊收款帳戶 30 天內變更或確認過 → 該時間（vendors.bank_changed_at／bank_verified_at 取較晚者）；否則 null。 */
  payeeBankChangedAt?: string | null
  /** 登錄廠商有「帳戶變更待覆核」→ true（送審／核准／付款會被擋）。 */
  vendorBankChangePending?: boolean
  payingCompanyId: string
  payingCompanyName: string | null
  payingBankAccount: string | null
  method: DisbursementMethod
  paidOn: string | null
  amount: number
  withheldAmount: number
  grossAmount: number
  receiptIssuerCompanyId: string | null
  receiptIssuerCompanyName: string | null
  receiptRef: string | null
  hasInvoice: boolean
  invoiceNo: string | null
  purpose: string | null
  note: string | null
  voidReason: string | null
  paidByEmpId: string | null
  createdByEmpId: string | null
  createdAt: string
  updatedAt: string
  /* ── M4 簽核（欄位未套用時一律 null／0）── */
  currentStep: number | null
  approvalRound: number
  submittedAt: string | null
  submittedByEmpId: string | null
  approvedAt: string | null
  allocations: SerializedAllocation[]
  allocationLabel: string
  attachments?: SerializedAttachment[]
  /**
   * 第六輪（核准頁標示）：登錄廠商零分攤單曾確認「非期款支出」（confirmNonInstallment，由稽核紀錄查出）。
   * 只有單筆 GET 帶；列表不帶。
   */
  nonInstallmentConfirmed?: boolean
  /** 第八輪：「其他」收款名稱與名冊廠商相近的標示（由稽核查出）；單筆 GET、待簽清單與列表（未付的單，第九輪 C）帶。 */
  payeeSimilarWarning?: PayeeSimilarWarning
  /** 簽核軌跡（只有 GET /disbursements/:id 帶；services/disbursement-approval.ts 填）。 */
  approvalSteps?: SerializedApprovalStep[]
}

/** 一關簽核（disbursement_approval_steps 序列化後的形狀；明細頁與 ESS 簽核頁共用）。 */
export type SerializedApprovalStep = {
  id: string
  round: number
  stepOrder: number
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

type AllocationContext = {
  projects: Map<string, ProjectLite>
  subcontracts: Map<string, SubcontractRow>
  payments: Map<string, PaymentRow>
}

function rel1<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] as T) ?? null
  return (v as T) ?? null
}

function subVendorName(s: SubcontractRow | null | undefined): string | null {
  if (!s) return null
  return s.vendor_name ?? rel1<{ name: string }>(s.vendors)?.name ?? null
}

export function serializeAllocation(a: AllocationRow, ctx: AllocationContext): SerializedAllocation {
  const project = ctx.projects.get(a.project_id)
  const sub = a.subcontract_id ? ctx.subcontracts.get(a.subcontract_id) : null
  const payment = a.subcontract_payment_id ? ctx.payments.get(a.subcontract_payment_id) : null
  const amount = num(a.amount) ?? 0
  const withheld = num(a.withheld_amount) ?? 0
  return {
    id: a.id,
    projectId: a.project_id,
    projectCode: project?.code ?? null,
    projectName: project?.name ?? "",
    subcontractId: a.subcontract_id,
    subcontractPaymentId: a.subcontract_payment_id,
    installmentNo: payment?.installment_no ?? null,
    vendorName: subVendorName(sub),
    kind: sub?.kind ?? null,
    discipline: sub?.discipline ?? null,
    item: sub?.item ?? null,
    amount,
    withheldAmount: withheld,
    netAmount: roundMoney(amount - withheld),
    note: a.note,
  }
}

export function serializeDisbursement(
  d: DisbursementRow,
  allocations: AllocationRow[],
  ctx: AllocationContext,
  companies: Map<string, CompanyLite>,
  attachments?: SerializedAttachment[],
): SerializedDisbursement {
  const amount = num(d.amount) ?? 0
  const withheld = num(d.withheld_amount) ?? 0
  // 顯示順序：專案代號 → 期別 → 建立順序（整批 insert 的 created_at 會同秒，不能只靠它）。
  const allocs = allocations
    .map((a) => ({ row: a, out: serializeAllocation(a, ctx) }))
    .sort(
      (x, y) =>
        compareCode(x.out.projectCode, y.out.projectCode) ||
        (x.out.installmentNo ?? 1e9) - (y.out.installmentNo ?? 1e9) ||
        x.row.created_at.localeCompare(y.row.created_at) ||
        x.row.id.localeCompare(y.row.id),
    )
    .map((x) => x.out)
  const out: SerializedDisbursement = {
    id: d.id,
    disbursementNo: d.disbursement_no,
    status: d.status,
    payeeKind: d.payee_kind,
    vendorId: d.vendor_id,
    payeeName: d.payee_name,
    payeeBankName: d.payee_bank_name,
    payeeBankAccount: d.payee_bank_account,
    payeeBankCode: d.payee_bank_code,
    payeeBankAccountNumber: d.payee_bank_account_number ?? null,
    // 驗收第五輪：分欄是否實存（帳號或戶名任一有值）——實存就只用分欄（帳號空＝沒有帳號），否則解析舊快照。
    payeeAccountSplit: d.payee_bank_account_number != null || d.payee_account_holder != null,
    payeeAccountMasked:
      d.payee_bank_account_number != null || d.payee_account_holder != null
        ? d.payee_bank_account_number ? `****${d.payee_bank_account_number.slice(-4)}` : null
        : maskBankAccount(d.payee_bank_account),
    payeeAccountSource: d.payee_kind === "vendor" && d.vendor_id ? "roster" : "manual",
    payeeAccountHolder: d.payee_bank_account_number || d.payee_account_holder ? (d.payee_account_holder ?? null) : holderSegment(d.payee_bank_account),
    payingCompanyId: d.paying_company_id,
    payingCompanyName: d.paying_company_name ?? companies.get(d.paying_company_id)?.name ?? null,
    payingBankAccount: d.paying_bank_account,
    method: d.method,
    paidOn: d.paid_on,
    amount,
    withheldAmount: withheld,
    grossAmount: roundMoney(amount + withheld),
    receiptIssuerCompanyId: d.receipt_issuer_company_id,
    receiptIssuerCompanyName: d.receipt_issuer_company_id ? (companies.get(d.receipt_issuer_company_id)?.name ?? null) : null,
    receiptRef: d.receipt_ref,
    hasInvoice: d.has_invoice,
    invoiceNo: d.invoice_no,
    purpose: d.purpose,
    note: d.note,
    voidReason: d.void_reason,
    paidByEmpId: d.paid_by_emp_id,
    createdByEmpId: d.created_by_emp_id,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    currentStep: d.current_step ?? null,
    approvalRound: d.approval_round ?? 0,
    submittedAt: d.submitted_at ?? null,
    submittedByEmpId: d.submitted_by_emp_id ?? null,
    approvedAt: d.approved_at ?? null,
    allocations: allocs,
    allocationLabel: allocationLabel(allocs),
  }
  if (attachments) out.attachments = attachments
  return out
}

/* ──────────────────────────────────────────────────────────────────
 * 載入
 * ────────────────────────────────────────────────────────────────── */

export async function tenantToday(tenantId: string): Promise<string> {
  return todayKey(await getTenantTimezone(tenantId))
}

export async function loadDisbursement(tenantId: string, id: string): Promise<DisbursementRow | null> {
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .select(await disbursementCols())
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`loadDisbursement: ${error.message}`)
  return (data as unknown as DisbursementRow | null) ?? null
}

export async function loadAllocations(tenantId: string, disbursementIds: string[]): Promise<AllocationRow[]> {
  if (disbursementIds.length === 0) return []
  const rows = await batch<AllocationRow>("disbursement_allocations", ALLOCATION_COLS, tenantId, disbursementIds, "disbursement_id", false)
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  return rows
}

async function loadAllocationContext(tenantId: string, allocations: AllocationRow[]): Promise<AllocationContext> {
  const projectIds = uniq(allocations.map((a) => a.project_id))
  const subIds = uniq(allocations.map((a) => a.subcontract_id))
  const paymentIds = uniq(allocations.map((a) => a.subcontract_payment_id))
  const [projects, subcontracts, payments] = await Promise.all([
    batch<ProjectLite>("projects", PROJECT_LITE_COLS, tenantId, projectIds, "id", false),
    batch<SubcontractRow>("project_subcontracts", SUBCONTRACT_COLS, tenantId, subIds, "id", false),
    batch<PaymentRow>("project_subcontract_payments", PAYMENT_COLS, tenantId, paymentIds, "id", false),
  ])
  return {
    projects: new Map(projects.map((p) => [p.id, p])),
    subcontracts: new Map(subcontracts.map((s) => [s.id, s])),
    payments: new Map(payments.map((p) => [p.id, p])),
  }
}

async function loadCompanies(tenantId: string, ids: string[]): Promise<Map<string, CompanyLite>> {
  const rows = await batch<CompanyLite>("companies", COMPANY_LITE_COLS, tenantId, uniq(ids), "id", false)
  return new Map(rows.map((c) => [c.id, c]))
}

async function loadAttachments(tenantId: string, disbursementId: string, signed: boolean): Promise<SerializedAttachment[]> {
  const { data, error } = await supabaseAdmin
    .from("disbursement_attachments")
    .select(ATTACHMENT_COLS)
    .eq("tenant_id", tenantId)
    .eq("disbursement_id", disbursementId)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`loadAttachments: ${error.message}`)
  const rows = (data ?? []) as unknown as AttachmentRow[]
  return Promise.all(
    rows.map(async (r) => {
      let url: string | null = null
      if (signed) {
        const { data: s } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).createSignedUrl(r.storage_path, 3600)
        url = s?.signedUrl ?? null
      }
      return {
        id: r.id,
        fileName: r.file_name,
        sizeBytes: r.size_bytes,
        contentType: r.content_type,
        createdAt: r.created_at,
        url,
      }
    }),
  )
}

/** 一批匯款單 → 序列化（分攤／專案／期款／公司名一次批次撈）。 */
export async function serializeMany(tenantId: string, rows: DisbursementRow[]): Promise<SerializedDisbursement[]> {
  if (rows.length === 0) return []
  const allocations = await loadAllocations(tenantId, rows.map((r) => r.id))
  const [ctx, companies] = await Promise.all([
    loadAllocationContext(tenantId, allocations),
    loadCompanies(tenantId, rows.flatMap((r) => [r.paying_company_id, r.receipt_issuer_company_id ?? ""]).filter(Boolean)),
  ])
  const allocBy = groupBy(allocations, (a) => a.disbursement_id)
  const out = rows.map((r) => serializeDisbursement(r, allocBy.get(r.id) ?? [], ctx, companies))
  await attachVendorBankStatus(tenantId, out)
  await attachRebindWarning(tenantId, out)
  return out
}

/**
 * 驗收 S2：「其他」（手動帳戶）收款單分攤到的副委託曾經解除或改綁名冊廠商（project_subcontracts 稽核帶 rebindReason）→ 紅框：
 * 這是「解除綁定後改用其他收款繞過名冊帳戶確認」的樣態，請核准人確認收款對象。查詢失敗不擋顯示（記 log）。
 */
async function attachRebindWarning(tenantId: string, items: SerializedDisbursement[]): Promise<void> {
  const targets = items.filter((d) => d.payeeKind === "other" && d.allocations.some((a) => !!a.subcontractId))
  if (targets.length === 0) return
  const subIds = [...new Set(targets.flatMap((d) => d.allocations.map((a) => a.subcontractId).filter((v): v is string => !!v)))]
  try {
    const rebound = new Set<string>()
    for (let i = 0; i < subIds.length; i += 100) {
      const { data, error } = await supabaseAdmin
        .from("audit_logs")
        .select("record_id, new_row")
        .eq("tenant_id", tenantId)
        .eq("table_name", "project_subcontracts")
        .in("record_id", subIds.slice(i, i + 100))
        .not("new_row->>rebindReason", "is", null) // 驗收第三輪效能：只撈有改綁原因的稽核列
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as Array<{ record_id: string | null; new_row: Record<string, unknown> | null }>) {
        const reason = r.new_row?.rebindReason
        if (r.record_id && typeof reason === "string" && reason.trim()) rebound.add(r.record_id.toLowerCase())
      }
    }
    for (const d of targets) {
      const hit = d.allocations.map((a) => a.subcontractId).filter((v): v is string => !!v && rebound.has(v.toLowerCase()))
      if (hit.length > 0) {
        d.payeeRebindWarning = {
          message: "分攤的副委託曾解除或改綁名冊廠商，這張單改用手動輸入的帳戶收款，請確認收款對象與帳號",
          subcontractIds: [...new Set(hit)],
        }
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "attachRebindWarning: lookup failed")
  }
}

/** 名冊帳戶「最近變更」的警示天數（業主：30 天）。 */
export const BANK_CHANGED_WARN_DAYS = 30

/**
 * 2026-11-17：登錄廠商單補上名冊帳戶近期變更時間（30 天內）與「帳戶變更待覆核」旗標（核准畫面黃色警示用）。
 * 只是顯示資訊：0103 未套用或查詢失敗 → 不帶、記 log，不擋列表（送審／核准／付款的硬擋另在 assertPayeeBankStillMatchesVendor）。
 */
async function attachVendorBankStatus(tenantId: string, items: SerializedDisbursement[]): Promise<void> {
  const vendorIds = [...new Set(items.filter((d) => d.payeeKind === "vendor" && d.vendorId).map((d) => d.vendorId as string))]
  if (vendorIds.length === 0) return
  try {
    const changedAt = new Map<string, string>()
    const verified = new Map<string, boolean>()
    const holders = new Map<string, string | null>()
    const changedCol = await columnsExist("vendors", "bank_changed_at")
    const verifiedCol = changedCol && (await columnsExist("vendors", "bank_verified_at"))
    const cols = `id, account_holder${changedCol ? ", bank_changed_at" : ""}${verifiedCol ? ", bank_verified_at, bank_verified_by" : ""}`
    const rows = await batch<{ id: string; account_holder: string | null; bank_changed_at?: string | null; bank_verified_at?: string | null; bank_verified_by?: string | null }>(
      "vendors", cols, tenantId, vendorIds, "id", false,
    )
    const cutoff = Date.now() - BANK_CHANGED_WARN_DAYS * 86_400_000
    for (const r of rows) {
      const key = r.id.toLowerCase()
      holders.set(key, r.account_holder ?? null)
      if (verifiedCol && r.bank_verified_at !== undefined) verified.set(key, r.bank_verified_at !== null)
      // 驗收 F8：0104 回填的「既有已確認」（bank_verified_by 為空）不算近期確認，只看真正的變更時間與有確認人的確認時間。
      const verifiedAtByPerson = r.bank_verified_by ? r.bank_verified_at : null
      const latest = [r.bank_changed_at, verifiedAtByPerson].filter((v): v is string => !!v).sort().pop()
      if (latest && Date.parse(latest) >= cutoff) changedAt.set(key, latest)
    }
    const pending = await vendorsWithPendingBankChange(tenantId, vendorIds)
    for (const d of items) {
      if (d.payeeKind !== "vendor" || !d.vendorId) continue
      const key = d.vendorId.toLowerCase()
      d.payeeBankChangedAt = changedAt.get(key) ?? null
      d.vendorBankChangePending = pending.has(key)
      if (verified.has(key)) d.vendorBankVerified = verified.get(key)
      const holder = holders.get(key)
      // 有分欄的單：戶名與末 4 碼直接用分欄（不再解析快照）。
      if (holder && !d.payeeAccountSplit) {
        d.payeeAccountHolder = holder
        // 快照是「帳號 戶名」：知道戶名後重新遮，避免戶名開頭數字混進末 4 碼。
        if (d.payeeBankAccount) d.payeeAccountMasked = maskBankAccount(d.payeeBankAccount, holder)
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "attachVendorBankStatus: lookup failed")
  }
}

export async function getDisbursement(tenantId: string, id: string): Promise<SerializedDisbursement | null> {
  const row = await loadDisbursement(tenantId, id)
  if (!row) return null
  const [serialized, attachments] = await Promise.all([serializeMany(tenantId, [row]), loadAttachments(tenantId, id, true)])
  const out: SerializedDisbursement = { ...serialized[0], attachments }
  if (row.payee_kind === "vendor" && out.allocations.length === 0) {
    out.nonInstallmentConfirmed = (await nonInstallmentConfirmedIds(tenantId, [id])).has(id)
  }
  if (row.payee_kind === "other") {
    const warning = (await payeeSimilarWarnings(tenantId, [row])).get(id)
    if (warning) out.payeeSimilarWarning = warning
  }
  return out
}

/**
 * 第六輪（核准頁標示）：這些單中有「確認非期款支出」稽核的 id（建單 INSERT 稽核或改單嚴格稽核的
 * new_row.confirmNonInstallment＝true）。查稽核表失敗不擋顯示，回空集合並記 log。
 */
export async function nonInstallmentConfirmedIds(tenantId: string, ids: string[], opts: { strict?: boolean } = {}): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from("audit_logs")
      .select("record_id")
      .eq("tenant_id", tenantId)
      .eq("table_name", "disbursements")
      .in("record_id", ids.slice(i, i + 100))
      .contains("new_row", { confirmNonInstallment: true })
    if (error) {
      // 第七輪 M2：送審／核准／付款守門用 strict——查不到就不放行（500），不當成「沒確認」誤回 409。
      if (opts.strict) throw new Error(`nonInstallmentConfirmedIds: ${error.message}`)
      logger.warn({ err: error.message }, "nonInstallmentConfirmedIds: audit lookup failed")
      return out
    }
    for (const r of (data ?? []) as Array<{ record_id: string | null }>) if (r.record_id) out.add(r.record_id)
  }
  return out
}

export { loadAttachments as listAttachments }

/* ──────────────────────────────────────────────────────────────────
 * 列表
 * ────────────────────────────────────────────────────────────────── */

export type ListFilters = {
  from?: string
  to?: string
  vendorId?: string
  projectId?: string
  companyId?: string
  status?: DisbursementStatus
  q?: string
}

/** 預設近 90 天（含 today）；呼叫端只給其中一端時另一端補預設。 */
export function defaultRange(today: string, from?: string, to?: string): { from: string; to: string } {
  const t = to ?? today
  const f = from ?? addDaysKey(t, -DEFAULT_LIST_DAYS)
  return { from: f, to: t }
}

/**
 * 匯款紀錄列表。日期範圍看 `paid_on`；草稿沒有匯款日也要看得到（不然存了草稿
 * 就消失），所以 `status.eq.draft` 一律放行日期條件。作廢的草稿同樣沒有 `paid_on`
 * （作廢只改 status，不補匯款日），但不能像草稿那樣無條件放行——作廢單只會累積——
 * 所以改拿 `updated_at` 套日期窗：作廢後所有寫入路徑都擋（PATCH／pay／void／
 * 附件皆 409），`updated_at` 就是作廢時點。from／to 是租戶當地日，比對 timestamptz
 * 要先換成 UTC 半開區間 [當日 00:00, 隔日 00:00)。預設排除作廢，除非明確
 * `status=void`。`q` 找單號／收款方／收據編號／用途。
 */
export async function listDisbursements(
  tenantId: string,
  filters: ListFilters,
): Promise<{ from: string; to: string; disbursements: SerializedDisbursement[] }> {
  const tz = await getTenantTimezone(tenantId)
  const { from, to } = defaultRange(todayKey(tz), filters.from, filters.to)
  const voidedSince = dayWindowUtc(from, tz).startIso
  const voidedBefore = dayWindowUtc(to, tz).endIso

  let ids: string[] | null = null
  if (filters.projectId) {
    const { data, error } = await supabaseAdmin
      .from("disbursement_allocations")
      .select("disbursement_id")
      .eq("tenant_id", tenantId)
      .eq("project_id", filters.projectId)
    if (error) throw new Error(`listDisbursements (allocations): ${error.message}`)
    ids = uniq((data ?? []).map((r) => r.disbursement_id as string))
    if (ids.length === 0) return { from, to, disbursements: [] }
  }

  let q = supabaseAdmin
    .from("disbursements")
    .select(await disbursementCols())
    .eq("tenant_id", tenantId)
    .or(
      [
        `and(paid_on.gte.${from},paid_on.lte.${to})`,
        "status.eq.draft",
        // 送簽中／已核准但還沒付款的單沒有 paid_on，跟草稿一樣無條件列出，
        // 不然送簽之後單子會從列表上消失（M4）。
        "status.eq.pending_approval",
        "status.eq.approved",
        `and(status.eq.void,paid_on.is.null,updated_at.gte.${voidedSince},updated_at.lt.${voidedBefore})`,
      ].join(","),
    )
  if (filters.status) q = q.eq("status", filters.status)
  else q = q.neq("status", "void")
  if (filters.vendorId) q = q.eq("vendor_id", filters.vendorId)
  if (filters.companyId) q = q.eq("paying_company_id", filters.companyId)
  if (ids) q = q.in("id", ids.slice(0, 500))
  if (filters.q) {
    const like = `%${sanitizeSearchTerm(filters.q)}%`
    q = q.or(`disbursement_no.ilike.${like},payee_name.ilike.${like},receipt_ref.ilike.${like},purpose.ilike.${like}`)
  }
  const { data, error } = await q
    .order("paid_on", { ascending: false, nullsFirst: true })
    .order("disbursement_no", { ascending: false })
    .limit(1000)
  if (error) throw new Error(`listDisbursements: ${error.message}`)
  const rows = (data ?? []) as unknown as DisbursementRow[]
  const disbursements = await serializeMany(tenantId, rows)
  // 第九輪 C：批次付款頁（請款與放款）也要紅框——未付（草稿／送簽／已核准）的「其他」收款單帶 payeeSimilarWarning。
  const pending = rows.filter((r) => r.payee_kind === "other" && r.status !== "paid" && r.status !== "void")
  if (pending.length > 0) {
    const warnings = await payeeSimilarWarnings(tenantId, pending)
    for (const d of disbursements) {
      const w = warnings.get(d.id)
      if (w) d.payeeSimilarWarning = w
    }
  }
  return { from, to, disbursements }
}

/* ──────────────────────────────────────────────────────────────────
 * 應付清單、已付但無匯款單
 * ────────────────────────────────────────────────────────────────── */

export type PayableRow = {
  subcontractPaymentId: string
  subcontractId: string
  projectId: string
  projectCode: string | null
  projectName: string
  vendorId: string | null
  vendorName: string | null
  kind: string
  discipline: string | null
  item: string | null
  installmentNo: number
  dueWhen: string | null
  /** 有效毛額（effectiveAmount）。 */
  grossAmount: number
  withheldAmount: number
  netAmount: number
  payingCompanyId: string | null
  receiptIssuerCompanyId: string | null
  /** 該專案收款進度%（「收到款才放款」提示）；分母未知時 null。 */
  projectReceiptProgressPct: number | null
  projectReceivedTotal: number
  projectAmountUntaxed: number | null
  /** 該案已封存（C2 複製封存原案後，未付期款仍列，前端灰標）。 */
  archived: boolean
  /**
   * 驗收日（M5 `accepted_on`）；null＝未驗收。驗收欄位尚未套用時一律 null，
   * 並以 `PayablesResult.acceptanceTracked=false` 告知前端「這個庫沒有驗收概念」。
   * 「請款與放款」頁用它判斷哪些期款能放款（未驗收的不能勾）。
   */
  acceptedOn: string | null
}

export type PayableGroup = {
  key: string
  vendorId: string | null
  vendorName: string | null
  count: number
  grossTotal: number
  withheldTotal: number
  netTotal: number
  subcontractPaymentIds: string[]
}

export type PayablesResult = {
  today: string
  /** false＝驗收欄位尚未套用（migration 0050），`acceptedOn` 一律 null、放款不檢查驗收。 */
  acceptanceTracked: boolean
  payables: PayableRow[]
  groups: PayableGroup[]
  summary: { count: number; grossTotal: number; withheldTotal: number; netTotal: number }
}

type PayableScope = {
  projects: ProjectLite[]
  subcontracts: SubcontractRow[]
  payments: PaymentRow[]
}

/**
 * 專案（含已封存）→ 未刪副委託 → 期款，一次批次撈。
 * 封存案不濾：C2 複製案預設封存原案，原案還沒付的副委託期款不能因此從應付清單消失
 * （封存是可見性，不是「錢不用付了」）。buildPayables 只列未付期款，所以已付完的封存案
 * 自然不會出現；每列帶 archived 讓前端打灰標。
 */
async function loadPayableScope(tenantId: string, opts: { vendorId?: string; projectId?: string }): Promise<PayableScope> {
  let pq = supabaseAdmin.from("projects").select(PROJECT_LITE_COLS).eq("tenant_id", tenantId).is("deleted_at", null)
  if (opts.projectId) pq = pq.eq("id", opts.projectId)
  const { data: projData, error: projErr } = await pq
  if (projErr) throw new Error(`payables (projects): ${projErr.message}`)
  const projects = (projData ?? []) as unknown as ProjectLite[]
  if (projects.length === 0) return { projects, subcontracts: [], payments: [] }
  let subcontracts = await batch<SubcontractRow>(
    "project_subcontracts",
    SUBCONTRACT_COLS,
    tenantId,
    projects.map((p) => p.id),
    "project_id",
    true,
  )
  if (opts.vendorId) subcontracts = subcontracts.filter((s) => s.vendor_id === opts.vendorId)
  const payments = await batch<PaymentRow>(
    "project_subcontract_payments",
    PAYMENT_COLS,
    tenantId,
    subcontracts.map((s) => s.id),
    "subcontract_id",
    false,
  )
  return { projects, subcontracts, payments }
}

/** 各專案收款進度（同 buildReceivables 的算法：合約分母＋期程 → computeMoney）。 */
async function loadReceiptProgress(
  tenantId: string,
  projectIds: string[],
  settings: P3Settings,
): Promise<Map<string, { pct: number | null; received: number; amountUntaxed: number | null }>> {
  const out = new Map<string, { pct: number | null; received: number; amountUntaxed: number | null }>()
  if (projectIds.length === 0) return out
  const [contracts, billings] = await Promise.all([
    batch<ContractLite & { project_id: string }>("contracts", CONTRACT_LITE_COLS, tenantId, projectIds, "project_id", true),
    batch<BillingRow>("project_billings", BILLING_COLS, tenantId, projectIds, "project_id", true),
  ])
  const contractsBy = groupBy(contracts, (c) => c.project_id)
  const billingsBy = groupBy(billings, (b) => b.project_id)
  for (const id of projectIds) {
    const summary = summarizeContracts(contractsBy.get(id) ?? [])
    const { amountUntaxed, amountSource } = resolveAmountUntaxed(summary.total, summary.latestQuotation)
    const money = computeMoney({
      amountUntaxed,
      amountSource,
      vatRate: settings.vatRate,
      billings: (billingsBy.get(id) ?? []).map(toMoneyBilling),
      subcontracts: [],
      otherExpenses: 0,
    })
    out.set(id, { pct: money.receiptProgressPct, received: money.receivedTotal, amountUntaxed: money.amountUntaxed })
  }
  return out
}

function vendorGroupKey(s: SubcontractRow): string {
  return s.vendor_id ?? `name:${subVendorName(s) ?? ""}`
}

/**
 * 應付清單：每個未付（母副委託未刪、有效毛額 > 0）期款一列。毛額＝effectiveAmount、
 * 代扣＝withheldAmount、淨額（同 serializeSubcontract 的算法，已付期別凍結、
 * 末期吸收尾差）。按廠商分組回 groups；勾選多筆建匯款時 amount＝Σnet、
 * withheld＝Σwithheld（前端帶入）。
 */
export async function buildPayables(
  tenantId: string,
  opts: { vendorId?: string; projectId?: string; settings?: P3Settings },
): Promise<PayablesResult> {
  const [today, settings, scope] = await Promise.all([
    tenantToday(tenantId),
    opts.settings ? Promise.resolve(opts.settings) : loadP3Settings(tenantId),
    loadPayableScope(tenantId, opts),
  ])
  const projectById = new Map(scope.projects.map((p) => [p.id, p]))
  const paymentsBy = groupBy(scope.payments, (p) => p.subcontract_id)
  const activeProjectIds = uniq(scope.subcontracts.map((s) => s.project_id))
  const progress = await loadReceiptProgress(tenantId, activeProjectIds, settings)

  const rows: PayableRow[] = []
  for (const s of scope.subcontracts) {
    const project = projectById.get(s.project_id)
    if (!project) continue
    const payments = [...(paymentsBy.get(s.id) ?? [])].sort((a, b) => a.installment_no - b.installment_no)
    if (payments.length === 0) continue
    const computed = computeSubcontractPayments(
      payments.map((p) => ({
        installmentNo: p.installment_no,
        percentage: num(p.percentage),
        overrideAmount: num(p.override_amount),
        paid: p.paid_on !== null,
        paidGrossAmount: num(p.override_amount) ?? num(p.amount),
      })),
      num(s.amount) ?? 0,
      num(s.withholding_rate) ?? DEFAULT_WITHHOLDING_RATE,
      Number(s.withholding_threshold ?? DEFAULT_WITHHOLDING_THRESHOLD),
    )
    const byNo = new Map(computed.rows.map((r) => [r.installmentNo, r]))
    const prog = progress.get(s.project_id)
    for (const p of payments) {
      if (p.paid_on !== null) continue
      const calc = byNo.get(p.installment_no)
      const gross = calc?.effectiveAmount ?? null
      if (gross === null || gross <= 0) continue
      const withheld = calc?.withheldAmount ?? 0
      rows.push({
        subcontractPaymentId: p.id,
        subcontractId: s.id,
        projectId: s.project_id,
        projectCode: project.code,
        projectName: project.name,
        vendorId: s.vendor_id,
        vendorName: subVendorName(s),
        kind: s.kind,
        discipline: s.discipline,
        item: s.item,
        installmentNo: p.installment_no,
        dueWhen: p.due_when,
        grossAmount: gross,
        withheldAmount: withheld,
        netAmount: round0(gross - withheld),
        payingCompanyId: p.paying_company_id,
        receiptIssuerCompanyId: p.receipt_issuer_company_id,
        projectReceiptProgressPct: prog?.pct ?? null,
        projectReceivedTotal: prog?.received ?? 0,
        projectAmountUntaxed: prog?.amountUntaxed ?? null,
        archived: project.archived_at !== null,
        acceptedOn: null,
      })
    }
  }
  const acceptance = await loadPaymentAcceptance(tenantId, rows.map((r) => r.subcontractPaymentId))
  if (acceptance) for (const r of rows) r.acceptedOn = acceptance.get(r.subcontractPaymentId)?.accepted_on ?? null
  rows.sort(
    (a, b) =>
      (a.vendorName ?? "").localeCompare(b.vendorName ?? "", "zh-Hant") ||
      compareCode(a.projectCode, b.projectCode) ||
      a.installmentNo - b.installmentNo,
  )

  const subById = new Map(scope.subcontracts.map((s) => [s.id, s]))
  const groupMap = new Map<string, PayableGroup>()
  for (const r of rows) {
    const key = vendorGroupKey(subById.get(r.subcontractId)!)
    const g = groupMap.get(key) ?? {
      key,
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      count: 0,
      grossTotal: 0,
      withheldTotal: 0,
      netTotal: 0,
      subcontractPaymentIds: [],
    }
    g.count += 1
    g.grossTotal = roundMoney(g.grossTotal + r.grossAmount)
    g.withheldTotal = roundMoney(g.withheldTotal + r.withheldAmount)
    g.netTotal = roundMoney(g.netTotal + r.netAmount)
    g.subcontractPaymentIds.push(r.subcontractPaymentId)
    groupMap.set(key, g)
  }
  return {
    today,
    acceptanceTracked: acceptance !== null,
    payables: rows,
    groups: [...groupMap.values()],
    summary: {
      count: rows.length,
      grossTotal: roundMoney(rows.reduce((s, r) => s + r.grossAmount, 0)),
      withheldTotal: roundMoney(rows.reduce((s, r) => s + r.withheldAmount, 0)),
      netTotal: roundMoney(rows.reduce((s, r) => s + r.netAmount, 0)),
    },
  }
}

export type ManualPaidRow = {
  subcontractPaymentId: string
  subcontractId: string
  projectId: string
  projectCode: string | null
  projectName: string
  vendorId: string | null
  vendorName: string | null
  kind: string
  installmentNo: number
  paidOn: string | null
  paidAmount: number | null
  withheldAmount: number | null
  payingCompanyId: string | null
  payingCompanyName: string | null
  receiptIssuerCompanyId: string | null
  receiptRef: string | null
}

/** 補單模式不設下限：這清單就是要挖很久以前手動標記的舊期款，近 90 天預設會把它們濾掉。 */
export const MANUAL_PAID_ALL_TIME_FROM = "1900-01-01"

/**
 * 已付（paid_on 有值）但沒有匯款單（disbursement_id 空）的期款——老闆補單用。
 * 日期預設「全部」（只補上限 today），跟一般列表的近 90 天不同；呼叫端明確給 from 才收窄。
 */
export async function listManualPaidPayments(
  tenantId: string,
  filters: { from?: string; to?: string; vendorId?: string; projectId?: string },
): Promise<{ from: string; to: string; items: ManualPaidRow[] }> {
  const today = await tenantToday(tenantId)
  const to = filters.to ?? today
  const from = filters.from ?? MANUAL_PAID_ALL_TIME_FROM
  const scope = await loadPayableScope(tenantId, { vendorId: filters.vendorId, projectId: filters.projectId })
  const projectById = new Map(scope.projects.map((p) => [p.id, p]))
  const subById = new Map(scope.subcontracts.map((s) => [s.id, s]))
  const paymentRows = scope.payments.filter(
    (p) => p.paid_on !== null && !p.disbursement_id && p.paid_on! >= from && p.paid_on! <= to,
  )
  const companies = await loadCompanies(tenantId, paymentRows.map((p) => p.paying_company_id ?? "").filter(Boolean))
  const items: ManualPaidRow[] = []
  for (const p of paymentRows) {
    const s = subById.get(p.subcontract_id)
    const project = s ? projectById.get(s.project_id) : undefined
    if (!s || !project) continue
    items.push({
      subcontractPaymentId: p.id,
      subcontractId: s.id,
      projectId: s.project_id,
      projectCode: project.code,
      projectName: project.name,
      vendorId: s.vendor_id,
      vendorName: subVendorName(s),
      kind: s.kind,
      installmentNo: p.installment_no,
      paidOn: p.paid_on,
      paidAmount: num(p.paid_amount),
      withheldAmount: num(p.withheld_amount),
      payingCompanyId: p.paying_company_id,
      payingCompanyName: p.paying_company_id ? (companies.get(p.paying_company_id)?.name ?? null) : null,
      receiptIssuerCompanyId: p.receipt_issuer_company_id,
      receiptRef: p.receipt_ref,
    })
  }
  items.sort((a, b) => (b.paidOn ?? "").localeCompare(a.paidOn ?? "") || compareCode(a.projectCode, b.projectCode) || a.installmentNo - b.installmentNo)
  return { from, to, items }
}

/* ──────────────────────────────────────────────────────────────────
 * 老闆卡
 * ────────────────────────────────────────────────────────────────── */

export async function buildSummary(tenantId: string, opts: { from?: string; to?: string }): Promise<DisbursementSummary> {
  const today = await tenantToday(tenantId)
  const yearStart = `${today.slice(0, 4)}-01-01`
  const from = opts.from ?? yearStart
  const to = opts.to ?? today
  const lo = from < yearStart ? from : yearStart
  const hi = to > today ? to : today

  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .select(await disbursementCols())
    .eq("tenant_id", tenantId)
    .eq("status", "paid")
    .gte("paid_on", lo)
    .lte("paid_on", hi)
    .limit(5000)
  if (error) throw new Error(`buildSummary: ${error.message}`)
  const rows = (data ?? []) as unknown as DisbursementRow[]
  const [serialized, payables] = await Promise.all([serializeMany(tenantId, rows), buildPayables(tenantId, {})])
  const inputs: SummaryDisbursementInput[] = serialized
    .filter((d) => d.paidOn !== null)
    .map((d) => ({
      id: d.id,
      paidOn: d.paidOn!,
      amount: d.amount,
      withheldAmount: d.withheldAmount,
      payingCompanyId: d.payingCompanyId,
      payingCompanyName: d.payingCompanyName,
      vendorId: d.vendorId,
      payeeName: d.payeeName,
      allocations: d.allocations.map((a) => ({
        projectId: a.projectId,
        projectCode: a.projectCode,
        projectName: a.projectName,
        amount: a.amount,
        withheldAmount: a.withheldAmount,
      })),
    }))
  return summarizeDisbursements(inputs, payables.payables, { from, to, today })
}

/* ──────────────────────────────────────────────────────────────────
 * 參照解析（建立／修改共用）
 * ────────────────────────────────────────────────────────────────── */

type ResolvedAllocation = {
  projectId: string
  subcontractId: string | null
  subcontractPaymentId: string | null
  amount: number
  withheldAmount: number
  note: string | null
  project: ProjectLite
  payment: PaymentRow | null
  /** 這列對到的副委託登錄廠商（副委託非登錄廠商＝null；沒對到副委託＝undefined）。付錯人檢查用。 */
  subcontractVendorId?: string | null
  /** 這列對到的副委託廠商名稱快照（R3 #4 比對用；沒對到副委託＝undefined）。 */
  subcontractVendorName?: string | null
  /** 這列對到的副委託建立時間（#4 截止時間判斷用）。 */
  subcontractCreatedAt?: string | null
}

async function resolveAllocations(tenantId: string, inputs: AllocationInput[]): Promise<ResolvedAllocation[]> {
  const shape = checkAllocationShape(inputs)
  if (!shape.ok) throw new DisbursementError(400, shape.code, { index: shape.index, subcontractPaymentId: shape.subcontractPaymentId })

  const projectIds = uniq(inputs.map((a) => a.projectId))
  const paymentIds = uniq(inputs.map((a) => a.subcontractPaymentId))
  const [projects, payments] = await Promise.all([
    // deleted_at 一併讀：已刪除的專案不能再新增／改到分攤（2026-11-12 驗收；DB 觸發器 assert_project_not_deleted 是第二道）。
    batch<ProjectLite & { deleted_at?: string | null }>("projects", `${PROJECT_LITE_COLS}, deleted_at`, tenantId, projectIds, "id", false),
    batch<PaymentRow>("project_subcontract_payments", PAYMENT_COLS, tenantId, paymentIds, "id", false),
  ])
  const deletedProject = projects.find((p) => !!p.deleted_at)
  if (deletedProject) throw new DisbursementError(409, "project_deleted", { projectId: deletedProject.id })
  const subIds = uniq([...inputs.map((a) => a.subcontractId), ...payments.map((p) => p.subcontract_id)])
  const subcontracts = await batch<SubcontractRow>("project_subcontracts", SUBCONTRACT_COLS, tenantId, subIds, "id", true)
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const paymentById = new Map(payments.map((p) => [p.id, p]))
  const subById = new Map(subcontracts.map((s) => [s.id, s]))

  return inputs.map((a) => {
    const project = projectById.get(a.projectId)
    if (!project) throw new DisbursementError(400, "invalid_project", { projectId: a.projectId })
    let subcontractId: string | null = a.subcontractId ?? null
    let payment: PaymentRow | null = null
    let subcontractVendorId: string | null | undefined
    let subcontractVendorName: string | null | undefined
    let subcontractCreatedAt: string | null | undefined
    if (a.subcontractPaymentId) {
      payment = paymentById.get(a.subcontractPaymentId) ?? null
      const sub = payment ? subById.get(payment.subcontract_id) : undefined
      if (!payment || !sub || sub.project_id !== a.projectId || (subcontractId && subcontractId !== sub.id)) {
        throw new DisbursementError(400, "invalid_payment", { subcontractPaymentId: a.subcontractPaymentId })
      }
      subcontractId = sub.id
      subcontractVendorId = sub.vendor_id ?? null
      subcontractVendorName = sub.vendor_name ?? null
      subcontractCreatedAt = sub.created_at ?? null
    } else if (subcontractId) {
      const sub = subById.get(subcontractId)
      if (!sub || sub.project_id !== a.projectId) {
        throw new DisbursementError(400, "invalid_subcontract", { subcontractId })
      }
      subcontractVendorId = sub.vendor_id ?? null
      subcontractVendorName = sub.vendor_name ?? null
      subcontractCreatedAt = sub.created_at ?? null
    }
    return {
      projectId: a.projectId,
      subcontractId,
      subcontractPaymentId: payment?.id ?? null,
      amount: roundMoney(a.amount),
      withheldAmount: roundMoney(a.withheldAmount ?? 0),
      note: a.note ?? null,
      project,
      payment,
      subcontractVendorId,
      subcontractVendorName,
      subcontractCreatedAt,
    }
  })
}

/**
 * 付錯人防線（2026-11-16 驗收 A）：收款方是登錄廠商時，每列有對到副委託的分攤，副委託的登錄廠商必須就是收款廠商
 * （UUID 不分大小寫）；副委託是非登錄廠商（vendor_id null）也擋——不然「從乙的應付開單、把收款廠商改成甲」
 * 會把乙的期款標成已付、錢匯給甲。收款方是非登錄（vendor_id null）時維持原行為。只在建立／修改草稿時呼叫，
 * 已存在的單子不回溯檢查。
 */
export function assertAllocationVendors(
  payeeVendorId: string | null,
  allocations: ReadonlyArray<{ subcontractId: string | null; subcontractVendorId?: string | null }>,
): void {
  const payee = payeeVendorId ? payeeVendorId.toLowerCase() : null
  allocations.forEach((a, index) => {
    if (a.subcontractVendorId === undefined) return
    // 收款方非登錄（「其他」）：不能分攤到登錄廠商的期款（2026-11-16 第二輪）；分攤到非登錄副委託維持原行為。
    const mismatch = payee
      ? !a.subcontractVendorId || a.subcontractVendorId.toLowerCase() !== payee
      : !!a.subcontractVendorId
    if (mismatch) {
      throw new DisbursementError(400, "allocation_vendor_mismatch", {
        index,
        subcontractId: a.subcontractId,
        message: "分攤的副委託廠商與收款廠商不同，請確認收款對象",
      })
    }
  })
}

/**
 * R1b（2026-11-16）：送簽／核准／付款（含批次付款）執行前，用「目前」的副委託 vendor_id 重跑廠商一致性。
 * 開單後副委託換了廠商 → 409 allocation_vendor_changed。作廢與自動作廢不呼叫（不能擋止血）。
 */
export async function assertAllocationVendorsStillMatch(
  tenantId: string,
  current: Pick<DisbursementRow, "vendor_id">,
  allocations: ReadonlyArray<Pick<AllocationRow, "subcontract_id" | "subcontract_payment_id">>,
): Promise<void> {
  const payIdsNeedingSub = uniq(allocations.filter((a) => !a.subcontract_id && a.subcontract_payment_id).map((a) => a.subcontract_payment_id))
  const pays = payIdsNeedingSub.length
    ? await batch<{ id: string; subcontract_id: string }>("project_subcontract_payments", "id, subcontract_id", tenantId, payIdsNeedingSub, "id", false)
    : []
  const subOfPay = new Map(pays.map((p) => [p.id, p.subcontract_id]))
  const subIdOf = (a: Pick<AllocationRow, "subcontract_id" | "subcontract_payment_id">) =>
    a.subcontract_id ?? (a.subcontract_payment_id ? (subOfPay.get(a.subcontract_payment_id) ?? null) : null)
  const subIds = uniq(allocations.map(subIdOf))
  if (subIds.length === 0) return
  const subs = await batch<{ id: string; vendor_id: string | null }>("project_subcontracts", "id, vendor_id", tenantId, subIds, "id", false)
  const subById = new Map(subs.map((x) => [x.id, x]))
  try {
    assertAllocationVendors(
      current.vendor_id ?? null,
      allocations.map((a) => {
        const subId = subIdOf(a)
        const sub = subId ? subById.get(subId) : undefined
        return { subcontractId: subId, subcontractVendorId: sub ? (sub.vendor_id ?? null) : undefined }
      }),
    )
  } catch (err) {
    if (err instanceof DisbursementError && err.code === "allocation_vendor_mismatch") {
      throw new DisbursementError(409, "allocation_vendor_changed", {
        ...(err.details ?? {}),
        message: "分攤的副委託廠商已變更，請重新確認放款單",
      })
    }
    throw err
  }
}

export type PayeeBankField = "payeeBankName" | "payeeBankAccount" | "payeeBankCode"
export const PAYEE_BANK_FIELDS: readonly PayeeBankField[] = ["payeeBankName", "payeeBankAccount", "payeeBankCode"]

function normBankText(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim()
}
function normBankAccount(v: unknown): string {
  return normBankText(v).replace(/[\s\-－‐–—]/g, "")
}

/**
 * 名冊上這家廠商「可接受」的輸入值：只收原始欄位（銀行名、代碼、帳號；帳號去空白與半形／全形連字號）。
 * 系統快照格式（「銀行名（代碼）」「帳號 戶名」）不再當作輸入接受——2026-11-16 A1：
 * 整串去空白比對會讓 帳號 12345＋戶名 678甲 與輸入 "12345678 甲" 相等而放行。
 */
function vendorBankRawMatches(v: VendorLite, field: PayeeBankField, sent: unknown): boolean {
  if (field === "payeeBankCode") return normBankText(sent) === normBankText(v.bank_code)
  if (field === "payeeBankName") return normBankText(sent) === normBankText(v.bank_name)
  return normBankAccount(sent) === normBankAccount(v.bank_account)
}

/** 名冊上這家廠商該欄位的預設快照值（沒送時照名冊帶的值）。 */
function vendorBankDefault(v: VendorLite, field: PayeeBankField): string | null {
  if (field === "payeeBankCode") return v.bank_code ?? null
  if (field === "payeeBankName") return vendorBankName(v)
  // 驗收 F2：快照的帳號段正規化（去空白與連字號）——「0123 4567 8901」存成「012345678901 戶名」，之後拆帳號／戶名不會拆錯。
  return [normBankAccount(v.bank_account), v.account_holder].filter(Boolean).join(" ") || null
}

/**
 * 快照是否就是這家廠商名冊的帳號快照（F2）：帳號段（依名冊戶名精確拆）去空白／連字號後等於名冊帳號，且戶名段等於名冊戶名
 * （或沒有戶名段）。新舊兩種存法（正規化前「0123 4567 8901 戶名」／正規化後「012345678901 戶名」）都認。
 */
function accountSnapshotMatchesVendor(v: VendorLite, snapshot: unknown): boolean {
  const raw = normBankText(snapshot)
  if (!raw) return normBankText(v.bank_account) === ""
  if (normalizeAccountNumber(v.bank_account) === "") return false
  const holder = (v.account_holder ?? "").normalize("NFKC").replace(/\s+/g, " ").trim()
  // 驗收第三輪：用 splitAccountSnapshot 的戶名段比對（不用 indexOf）。
  const parts = splitAccountSnapshot(raw, holder || null)
  return normalizeAccountNumber(parts.account) === normalizeAccountNumber(v.bank_account) && (parts.holder === null || parts.holder === holder)
}

/**
 * 2026-11-16 第三輪（B1）：登錄廠商收款時，銀行欄位送 null／空字串而名冊有值 → 視同沒送、照名冊帶。
 * 表單在名冊尚未載入、或舊入口沒帶代碼時會送 null；不能當作「想清掉」而擋（也不會真的清掉——快照照名冊）。
 */
export function dropBlankBankFieldsForVendor<T extends Partial<Record<PayeeBankField, string | null | undefined>>>(
  vendor: VendorLite,
  input: T,
): T {
  const out = { ...input }
  for (const field of PAYEE_BANK_FIELDS) {
    const sent = out[field]
    if (sent === undefined) continue
    if (normBankText(sent) === "" && normBankText(vendorBankDefault(vendor, field)) !== "") delete out[field]
  }
  return out
}

/**
 * 付錯人防線（2026-11-16 第二輪）：收款方是登錄廠商時，有送的收款銀行欄位必須等於名冊上該廠商的值
 * （trim；帳號去掉空白與連字號後比對；空值＝名冊也空）。帳戶變更要先改廠商名冊（需財務權限）。
 */
export function assertPayeeBankMatchesVendor(
  vendor: VendorLite,
  input: Partial<Record<PayeeBankField, string | null | undefined>>,
  fields: Iterable<PayeeBankField>,
  stored?: Partial<Record<PayeeBankField, string | null>>,
): void {
  for (const field of fields) {
    const sent = input[field]
    if (sent === undefined) continue
    if (vendorBankRawMatches(vendor, field, sent)) continue
    // 第六輪 U1：名冊這欄沒有資料、卻手填了值 → 請先到名冊補帳戶（不是「與名冊不同」）。
    if (normBankText(vendorBankDefault(vendor, field)) === "" && normBankText(sent) !== "") {
      throw new DisbursementError(400, "vendor_bank_missing", {
        field,
        message: "名冊尚未登錄此廠商的收款帳戶，請先到廠商名冊補上帳戶",
      })
    }
    // 快照格式只在「與 DB 上這張單現有快照完全相同（未改動）」且該快照就是名冊快照時放行。
    // 註（2026-11-17 第六輪）：目前前端廠商單只送名冊原始帳號（上面 vendorBankRawMatches 就放行），走不到這條；
    // 保留給 API／MCP 直接把 GET 回來的快照原樣送回的情況。登錄廠商的帳戶最後一律照名冊（resolvePayeeAccount）。
    const storedVal = stored?.[field]
    const unchangedSnapshot =
      storedVal != null &&
      normBankText(sent) === normBankText(storedVal) &&
      (field === "payeeBankAccount"
        ? accountSnapshotMatchesVendor(vendor, storedVal)
        : normBankText(storedVal) === normBankText(vendorBankDefault(vendor, field)))
    if (!unchangedSnapshot) {
      throw new DisbursementError(400, "payee_bank_mismatch", {
        field,
        message: "收款帳戶與登錄廠商名冊不同；若帳戶已變更請先到廠商名冊更新（需財務權限）",
      })
    }
  }
}

export { payeeNameKey } from "../lib/payee-name.js"

type RosterLite = { id: string; name: string | null; short_name?: string | null; account_holder: string | null }

async function loadRosterForPayee(tenantId: string, label: string): Promise<RosterLite[]> {
  return selectAllPages<RosterLite>(
    (from, to) =>
      supabaseAdmin
        .from("vendors")
        .select("id, name, short_name, account_holder")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("id")
        .range(from, to),
    label,
  )
}

/** 第八輪：「其他」收款名稱與名冊廠商相近（已說明為不同公司）的命中資訊。 */
export type PayeeSimilarHit = { matchedVendorId: string; matchedVendorName: string; similarVendorIds: string[]; similarVendorNames: string[] }

/**
 * R3：收款「其他」但戶名與同租戶未刪名冊廠商比對（名稱／簡稱 key≥3／帳戶戶名，lib/payee-name.ts rosterVendorKeys，
 * 副委託 must_bind_vendor 同一套）。第八輪（2026-11-17）拆兩級：
 * - exact（exactNameKey：只差空白／全形／標點／大小寫／臺台）→ payee_is_registered_vendor 硬擋
 *  （建單／改單 400；送審／核准／付款守門 409，F4）；
 * - similar（去公司後綴、分公司、括號段…）→ 建單／改單須帶 confirmDistinctReason，否則 409 payee_name_similar；
 *   帶了回傳命中資訊，呼叫端寫嚴格稽核（核准頁從稽核查出標示）。gate（送審／核准／付款）時 similar 不擋（建單時已確認過）。
 */
export async function assertPayeeNotRegisteredVendor(
  tenantId: string,
  payeeName: string,
  opts: {
    status?: 400 | 409
    gate?: boolean
    confirmDistinctReason?: string | null
    /** 第九輪 L-2：分攤到非登錄副委託（vendor_id 為 null）→ 撞名時訊息補「先到專案副委託綁定」。 */
    unboundSubcontractAllocated?: boolean
  } = {},
): Promise<PayeeSimilarHit | null> {
  if (!exactNameKey(payeeName)) return null
  const vendors = (await loadRosterForPayee(tenantId, "assertPayeeNotRegisteredVendor")).filter((v) => (v.name ?? "").trim() !== "")
  const { exact, similar } = rosterKeyMatches(buildRosterKeyIndex(vendors), payeeName)
  if (exact.length > 0) {
    const hit = exact[0]!
    const matchedVendorName = hit.name ?? ""
    throw new DisbursementError(opts.status ?? 400, "payee_is_registered_vendor", {
      matchedVendorName,
      matchedVendorId: hit.id,
      message: opts.unboundSubcontractAllocated
        ? `收款對象與名冊廠商「${matchedVendorName}」名稱相同。請先到專案副委託把該列綁定為名冊廠商「${matchedVendorName}」，再以登錄廠商開單`
        : `收款對象與名冊廠商「${matchedVendorName}」名稱相同，請改選登錄廠商「${matchedVendorName}」`,
    })
  }
  if (similar.length === 0 || opts.gate) return null
  const matchedVendorName = similar[0]!.name ?? ""
  const reason = (opts.confirmDistinctReason ?? "").trim()
  if (!reason) {
    throw new DisbursementError(409, "payee_name_similar", {
      matchedVendorName,
      matchedVendorId: similar[0]!.id,
      matchedVendorNames: similar.map((v) => v.name ?? ""),
      message: `收款名稱與名冊廠商「${matchedVendorName}」相近；若是同一家請改選登錄廠商，若確為不同公司請填寫說明`,
    })
  }
  return {
    matchedVendorId: similar[0]!.id,
    matchedVendorName,
    similarVendorIds: similar.map((v) => v.id),
    similarVendorNames: similar.map((v) => v.name ?? ""),
  }
}

/** 第八輪：「其他」收款名稱相近、已說明為不同公司 → 寫入前嚴格稽核（核准頁標示從這裡查）。 */
async function auditPayeeSimilarConfirm(
  tenantId: string,
  actor: Actor,
  recordId: string | null,
  payeeName: string,
  hit: PayeeSimilarHit,
  reason: string,
  context: string,
): Promise<void> {
  await writeAuditLogStrict({
    tenantId,
    tableName: "disbursements",
    recordId,
    action: recordId ? "UPDATE" : "INSERT",
    oldRow: null,
    newRow: { payee_kind: "other", payee_name: payeeName, ...payeeSimilarAuditFields(hit, reason) },
    actorEmpId: actor.empId,
    context: `${context} 「其他」收款名稱與名冊廠商相近（確認為不同公司）`,
  })
}

function payeeSimilarAuditFields(hit: PayeeSimilarHit, reason: string) {
  return {
    confirmDistinctPayee: true,
    similarVendorIds: hit.similarVendorIds,
    similarVendorNames: hit.similarVendorNames,
    confirmDistinctReason: reason,
  }
}

/** 核准頁／詳情頁／批次付款頁的「收款名稱與名冊廠商相近」標示（第八輪；第九輪加 unconfirmedVendorNames／unknown）。 */
export type PayeeSimilarWarning = {
  /** 第九輪 M-1：查稽核／名冊失敗，無法確認比對結果 → true（前端照樣顯示紅框，請人工核對）。 */
  unknown?: true
  matchedVendorName: string
  /** 目前名冊中與收款名稱相近的廠商（第九輪 E：以「目前」為準；目前已無相近者則列說明當時的名單）。 */
  matchedVendorNames: string[]
  /** 第九輪 E：目前相近、但說明紀錄沒涵蓋的廠商（說明後名冊才新增或改名而相近）。沒有說明紀錄時＝全部。 */
  unconfirmedVendorNames: string[]
  /** 已說明的原因；null＝沒有說明紀錄（開單後名冊才新增相近廠商）或無法確認。 */
  reason: string | null
  confirmedByName: string | null
  message: string
}

/** 第九輪 M-1：比對查詢失敗時每張「其他」收款單回的標示。 */
export const PAYEE_SIMILAR_UNKNOWN_MESSAGE = "無法確認收款名稱比對，請人工核對收款對象"
const unknownPayeeSimilarWarning = (): PayeeSimilarWarning => ({
  unknown: true,
  matchedVendorName: "",
  matchedVendorNames: [],
  unconfirmedVendorNames: [],
  reason: null,
  confirmedByName: null,
  message: PAYEE_SIMILAR_UNKNOWN_MESSAGE,
})

/**
 * 第八輪：「其他」收款單的相近名稱標示（無 DDL，從稽核查）：
 * 稽核 new_row.confirmDistinctPayee＝true 且 payee_name 等於單上現值的最新一筆 → 「已由 XXX 說明：…」；
 * 沒有說明紀錄但現在名冊有相近廠商（開單後才新增）→ 「相近（未說明）」。
 * 第九輪：有說明紀錄時仍以目前名冊的相近名單為準，標出未涵蓋者（E）；查失敗不擋顯示，但每張「其他」收款單回 unknown（M-1）。
 */
export async function payeeSimilarWarnings(
  tenantId: string,
  rows: ReadonlyArray<{ id: string; payee_kind: string | null; payee_name: string | null }>,
): Promise<Map<string, PayeeSimilarWarning>> {
  const out = new Map<string, PayeeSimilarWarning>()
  const others = rows.filter((r) => r.payee_kind === "other" && exactNameKey(r.payee_name))
  if (others.length === 0) return out
  try {
    const confirmed = new Map<string, { ids: string[]; names: string[]; reason: string; actor: string | null }>()
    const ids = others.map((r) => r.id)
    const nameOf = new Map(others.map((r) => [r.id, (r.payee_name ?? "").trim()]))
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabaseAdmin
        .from("audit_logs")
        .select("record_id, new_row, actor_emp_id, created_at")
        .eq("tenant_id", tenantId)
        .eq("table_name", "disbursements")
        .in("record_id", ids.slice(i, i + 100))
        .contains("new_row", { confirmDistinctPayee: true })
        .order("created_at", { ascending: false })
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as Array<{ record_id: string | null; new_row: Record<string, unknown> | null; actor_emp_id: string | null }>) {
        if (!r.record_id || confirmed.has(r.record_id)) continue
        const nr = r.new_row ?? {}
        if (String(nr.payee_name ?? "").trim() !== nameOf.get(r.record_id)) continue
        const names = Array.isArray(nr.similarVendorNames) ? nr.similarVendorNames.map((n) => String(n)) : []
        const vids = Array.isArray(nr.similarVendorIds) ? nr.similarVendorIds.map((n) => String(n).toLowerCase()) : []
        confirmed.set(r.record_id, { ids: vids, names, reason: String(nr.confirmDistinctReason ?? ""), actor: r.actor_emp_id })
      }
    }
    const actorIds = [...new Set([...confirmed.values()].map((c) => c.actor).filter((v): v is string => !!v))]
    const actorNames = new Map<string, string>()
    if (actorIds.length > 0) {
      const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", actorIds)
      if (error) throw new Error(error.message)
      for (const e of (data ?? []) as Array<{ id: string; name: string | null }>) actorNames.set(e.id, e.name ?? "")
    }
    const roster = (await loadRosterForPayee(tenantId, "payeeSimilarWarnings")).filter((v) => (v.name ?? "").trim() !== "")
    const index = buildRosterKeyIndex(roster)
    for (const r of others) {
      const c = confirmed.get(r.id)
      // 第九輪 E：以「目前」名冊的相近名單為準，標出說明紀錄沒涵蓋的廠商（說明後名冊才新增／改名而相近）。
      const similar = rosterKeyMatches(index, r.payee_name).similar
      if (c) {
        const by = (c.actor && actorNames.get(c.actor)) || "（未知）"
        const coveredIds = new Set(c.ids)
        const coveredNames = new Set(c.names)
        const unconfirmed = similar.filter((v) => !coveredIds.has(String(v.id).toLowerCase()) && !(c.ids.length === 0 && coveredNames.has(v.name ?? "")))
        const current = similar.map((v) => v.name ?? "")
        const names = current.length > 0 ? current : c.names
        const main = names[0] ?? ""
        const unconfirmedNames = unconfirmed.map((v) => v.name ?? "")
        out.set(r.id, {
          matchedVendorName: main,
          matchedVendorNames: names,
          unconfirmedVendorNames: unconfirmedNames,
          reason: c.reason,
          confirmedByName: c.actor ? (actorNames.get(c.actor) ?? null) : null,
          message:
            `收款名稱與名冊廠商「${c.names[0] ?? main}」相近，已由 ${by} 說明：${c.reason}` +
            (unconfirmedNames.length > 0 ? `；但「${unconfirmedNames.join("」「")}」為說明後才相近的名冊廠商，未經說明，請確認收款對象` : ""),
        })
        continue
      }
      if (similar.length > 0) {
        const main = similar[0]!.name ?? ""
        const names = similar.map((v) => v.name ?? "")
        out.set(r.id, {
          matchedVendorName: main,
          matchedVendorNames: names,
          unconfirmedVendorNames: names,
          reason: null,
          confirmedByName: null,
          message: `收款名稱與名冊廠商「${main}」相近（開單時名冊尚無此廠商，未經說明），請確認收款對象`,
        })
      }
    }
  } catch (err) {
    // 第九輪 M-1：查不到不能讓紅框消失——每張「其他」收款單都回 unknown，請人工核對。
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "payeeSimilarWarnings: lookup failed")
    const unknown = new Map<string, PayeeSimilarWarning>()
    for (const r of others) unknown.set(r.id, unknownPayeeSimilarWarning())
    return unknown
  }
  return out
}

/**
 * F4（第六輪）：送審、核准、付款（含批次）前，「其他」收款單重驗戶名不是名冊廠商——開單後名冊才新增同名廠商時擋（409）。
 * 第八輪：只有 exact 擋；相近（similar）不擋（建單／改單時已說明，核准頁標示）。駁回、作廢不呼叫。
 */
export async function assertOtherPayeeStillNotRegisteredVendor(
  tenantId: string,
  current: Pick<DisbursementRow, "payee_kind" | "payee_name">,
): Promise<void> {
  if (current.payee_kind !== "other") return
  await assertPayeeNotRegisteredVendor(tenantId, current.payee_name ?? "", { status: 409, gate: true })
}

/**
 * 第五輪第 5 項（2026-11-17）：登錄廠商零分攤（非專案支出）而該廠商仍有未付期款 → 須帶 confirmNonInstallment:true，
 * 否則 409 vendor_has_unpaid_installments（避免付了期款卻沒分攤，期款仍顯示未付而重複付款）。
 * 帶了 → 回傳 true，呼叫端在寫入前以嚴格稽核記下（寫不進去就不建／不改）。
 */
async function assertZeroAllocVendorConfirmed(
  tenantId: string,
  header: Pick<ResolvedHeader, "payee_kind" | "vendor_id">,
  allocations: ReadonlyArray<unknown>,
  confirmed: boolean | undefined,
): Promise<boolean> {
  if (header.payee_kind !== "vendor" || !header.vendor_id || allocations.length > 0) return false
  if (!(await vendorHasUnpaidInstallments(tenantId, header.vendor_id, "assertZeroAllocVendorConfirmed"))) return false
  if (confirmed !== true) {
    throw new DisbursementError(409, "vendor_has_unpaid_installments", {
      message: "此廠商仍有未付期款，若要付期款請改用分攤；確定為非期款支出請勾選確認",
    })
  }
  return true
}

/**
 * 第七輪 M2：送審、核准、付款（含批次）前，登錄廠商零分攤單重驗——開單時廠商沒有未付期款（免確認），
 * 之後才新增期款：單上沒有「確認非期款支出」稽核（nonInstallmentConfirmedIds）且廠商現在有未付期款
 * → 409 vendor_has_unpaid_installments（請編輯放款單改用分攤或勾選確認）。駁回、作廢不呼叫。
 */
export async function assertZeroAllocVendorStillConfirmed(
  tenantId: string,
  current: Pick<DisbursementRow, "id" | "payee_kind" | "vendor_id">,
  allocations: ReadonlyArray<unknown>,
): Promise<void> {
  if (current.payee_kind !== "vendor" || !current.vendor_id || allocations.length > 0) return
  if (!(await vendorHasUnpaidInstallments(tenantId, current.vendor_id, "assertZeroAllocVendorStillConfirmed"))) return
  if ((await nonInstallmentConfirmedIds(tenantId, [current.id], { strict: true })).has(current.id)) return
  throw new DisbursementError(409, "vendor_has_unpaid_installments", {
    message: "此廠商仍有未付期款，這張不分攤期款的放款單尚未確認為非期款支出；請編輯放款單改用分攤，或勾選確認為非期款支出",
  })
}

async function auditNonInstallmentConfirm(
  tenantId: string,
  actor: Actor,
  recordId: string | null,
  header: Pick<ResolvedHeader, "vendor_id" | "payee_name" | "amount" | "withheld_amount" | "purpose">,
  context: string,
): Promise<void> {
  await writeAuditLogStrict({
    tenantId,
    tableName: "disbursements",
    recordId,
    action: recordId ? "UPDATE" : "INSERT",
    oldRow: null,
    newRow: {
      confirmNonInstallment: true,
      vendor_id: header.vendor_id,
      payee_name: header.payee_name,
      amount: header.amount,
      withheld_amount: header.withheld_amount,
      purpose: header.purpose,
    },
    actorEmpId: actor.empId,
    context: `${context} 登錄廠商零分攤（廠商仍有未付期款，確認非期款支出）`,
  })
}

/** 第 6 項（2026-11-16）：登錄廠商零分攤（非專案支出）必須填用途。 */
function assertVendorPurpose(header: Pick<ResolvedHeader, "payee_kind" | "purpose">, allocations: ReadonlyArray<unknown>): void {
  if (header.payee_kind === "vendor" && allocations.length === 0 && !(header.purpose ?? "").trim()) {
    throw new DisbursementError(400, "purpose_required", { message: "登錄廠商不分攤期款（非專案支出）時，請填寫用途" })
  }
}

/** 單上的銀行快照（原始值或系統快照格式皆可）是否等於名冊現值。 */
function bankSnapshotMatchesVendor(v: VendorLite, field: PayeeBankField, snapshot: string | null): boolean {
  if (vendorBankRawMatches(v, field, snapshot)) return true
  if (field === "payeeBankAccount") return accountSnapshotMatchesVendor(v, snapshot)
  return normBankText(snapshot) === normBankText(vendorBankDefault(v, field))
}

/**
 * N-1 第五輪（2026-11-17）：銀行名稱也比對，快照格式寬鬆接受——名冊原始銀行名、系統快照「銀行名（代碼）」、
 * 半形括號、去空白後相同都算；單上銀行名空白（舊單沒存）不擋（帳號與代碼另外比）。
 */
function bankNameSnapshotMatchesVendor(v: VendorLite, snapshot: string | null | undefined): boolean {
  const k = (x: string | null | undefined) => String(x ?? "").normalize("NFKC").replace(/\s+/g, "")
  const snap = k(snapshot)
  if (!snap) return true
  const accepted = [v.bank_name, vendorBankName(v), v.bank_name && v.bank_code ? `${v.bank_name}(${v.bank_code})` : null].map(k)
  return accepted.includes(snap)
}

/**
 * N-1（2026-11-16 第四輪）：送簽／核准／付款（含批次付款、直接建成已匯款）前，登錄廠商單的收款帳號與銀行代碼快照必須等於名冊現值，
 * 且名冊帳戶已經第二人確認（0104 bank_verified_at，否則 409 vendor_bank_unverified）、沒有待覆核的帳戶變更（409 vendor_bank_change_pending），
 * 否則 409 payee_bank_changed（名冊改了帳戶，舊單還掛舊帳戶／或名冊被改成他人帳戶後又改回）。駁回、作廢不呼叫。
 */
export async function assertPayeeBankStillMatchesVendor(
  tenantId: string,
  current: Pick<DisbursementRow, "payee_kind" | "vendor_id" | "payee_bank_account" | "payee_bank_code" | "payee_bank_name" | "payee_bank_account_number" | "payee_account_holder"> & { method?: DisbursementMethod | null },
): Promise<void> {
  if (current.payee_kind !== "vendor" || !current.vendor_id) return
  // 2026-11-17 雙人覆核：廠商帳戶變更待覆核期間，這家廠商的單不能送審／核准／付款（避免覆核期間把錢匯出去）。
  if (await vendorHasPendingBankChange(tenantId, current.vendor_id)) {
    throw new DisbursementError(409, "vendor_bank_change_pending", {
      message: "此廠商的收款帳戶變更正在等待覆核，覆核完成前不能送審、核准或付款",
    })
  }
  const verifiedCol = await columnsExist("vendors", "bank_verified_at")
  const { data, error } = await supabaseAdmin
    .from("vendors")
    .select(verifiedCol ? `${VENDOR_LITE_COLS}, bank_verified_at` : VENDOR_LITE_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", current.vendor_id)
    .is("deleted_at", null) // 驗收 S3：已刪除的廠商不算（→ 下面 payee_bank_changed）
    .maybeSingle()
  if (error) throw new Error(`assertPayeeBankStillMatchesVendor: ${error.message}`)
  const vendor = (data ?? null) as unknown as (VendorLite & { bank_verified_at?: string | null }) | null
  // 驗收 H1／H2（0104）：名冊帳戶要經第二人（老闆／platform_admin）確認過才能收款。PostgREST 對存在的欄位一定回該鍵（未確認＝null）；
  // 鍵不存在（undefined）只會是欄位尚未套用或測試假資料，視為未知、不擋（schema-compat 慣例）。
  // 驗收 F1：現金／支票付款、名冊與單上都沒有帳號 → 不需要帳戶，不檢查確認（轉帳仍一律要求已確認帳戶）。
  const noAccountAtAll = !!vendor && normBankAccount(vendor.bank_account) === "" && normBankText(current.payee_bank_account) === ""
  const accountNotNeeded = noAccountAtAll && !!current.method && current.method !== "transfer"
  if (vendor && vendor.bank_verified_at === null && !accountNotNeeded) {
    throw new DisbursementError(409, "vendor_bank_unverified", {
      message: "此廠商的收款帳戶尚未經老闆／平台管理員 確認，確認前不能送審、核准或付款",
    })
  }
  const ok =
    !!vendor &&
    // 驗收第四輪：有分欄就用分欄比對（帳號＝名冊帳號正規化、戶名＝名冊戶名或空），沒有才比舊快照。
    (current.payee_bank_account_number
      ? current.payee_bank_account_number === normalizeAccountNumber(vendor.bank_account) &&
        (current.payee_account_holder == null || current.payee_account_holder === rosterAccountHolder(vendor))
      : bankSnapshotMatchesVendor(vendor, "payeeBankAccount", current.payee_bank_account)) &&
    bankSnapshotMatchesVendor(vendor, "payeeBankCode", current.payee_bank_code) &&
    bankNameSnapshotMatchesVendor(vendor, current.payee_bank_name)
  if (!ok) {
    throw new DisbursementError(409, "payee_bank_changed", {
      message: "廠商名冊的收款帳戶已變更，請編輯放款單按『重新帶入名冊帳戶』後再送出；已核准的單請先撤回簽核再編輯",
    })
  }
}

/**
 * 付錯人防線（2026-11-16 驗收 B）：收款方是登錄廠商時，收款戶名（trim）只能是名冊名稱或名冊上的帳戶戶名
 * （account_holder），不能「選廠商甲、戶名打乙」——主管簽核時銀行欄位被遮，只看得到名稱。
 */
export function assertPayeeNameMatchesVendor(payeeName: string, vendor: { name: string; account_holder?: string | null }): void {
  const n = payeeName.trim()
  const allowed = [vendor.name, vendor.account_holder].map((v) => (v ?? "").trim()).filter(Boolean)
  if (!allowed.includes(n)) {
    throw new DisbursementError(400, "payee_name_mismatch", {
      message: "收款戶名與登錄廠商名稱不同；若要付給其他對象請改為非登錄收款方",
    })
  }
}

type ResolvedHeader = {
  payee_kind: PayeeKind
  vendor_id: string | null
  payee_name: string
  payee_bank_name: string | null
  payee_bank_account: string | null
  payee_bank_code: string | null
  /** 0106 分欄（欄位未套用時寫入前剔除，見 headerRow）。 */
  payee_bank_account_number?: string | null
  payee_account_holder?: string | null
  paying_company_id: string
  paying_company_name: string | null
  paying_bank_account: string | null
  method: DisbursementMethod
  paid_on: string | null
  amount: number
  withheld_amount: number
  receipt_issuer_company_id: string | null
  receipt_ref: string | null
  has_invoice: boolean
  invoice_no: string | null
  purpose: string | null
  note: string | null
}

function vendorBankName(v: VendorLite): string | null {
  if (!v.bank_name) return v.bank_code ?? null
  return v.bank_code ? `${v.bank_name}（${v.bank_code}）` : v.bank_name
}

function companyBankAccount(c: CompanyLite): string | null {
  return [c.bank_name, c.bank_account].filter(Boolean).join(" ") || null
}

/**
 * 收款方／付款公司的參照檢查與快照複製：廠商改名、公司換帳戶都不影響歷史匯款單。
 * 快照欄只在建立與 draft 修改時寫入（paid 之後不再碰）。
 *
 * 停用的公司（companies.is_active=false）不能被**新選或改選**成付款公司／收據抬頭
 * （400 `company_inactive`）。`stored` 是單據上目前已存的兩個欄位（修改草稿時帶入）：
 * 與已存值相同＝沿用，放行——不然舊草稿上的公司後來被停用，這張單連備註都改不了。
 */
/* ── 0106 收款帳號／戶名分欄 ─────────────────────────────────────── */

const CONTROL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/** 帳號：NFKC 後只收數字、空白、連字號（否則 400 invalid_payee_bank_account），存成純數字；空回 null。 */
export function validatePayeeAccountNumber(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").normalize("NFKC").trim()
  if (!t) return null
  if (!/^[\d\s\-‐–—]+$/.test(t)) {
    throw new DisbursementError(400, "invalid_payee_bank_account", { message: "收款帳號只能有數字（可含空白或連字號）" })
  }
  const digits = t.replace(/\D/g, "")
  if (digits.length > 40) throw new DisbursementError(400, "invalid_payee_bank_account", { message: "收款帳號太長" })
  return digits || null
}

/** 戶名：原樣（trim），拒收控制字元／格式字元／換行（H1：複製匯款資訊與匯出不可被注入換行），最長 120 字；空回 null。 */
export function validatePayeeAccountHolder(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim()
  if (!t) return null
  if (CONTROL_CHARS.test(t)) {
    throw new DisbursementError(400, "invalid_payee_account_holder", { message: "帳戶戶名不可含換行或不可見字元" })
  }
  if (t.length > 120) throw new DisbursementError(400, "invalid_payee_account_holder", { message: "帳戶戶名最多 120 字" })
  return t
}

/** 名冊帳號 → 分欄帳號（只含數字才採用；名冊有其他字元就不寫分欄、只留快照）。 */
function rosterAccountNumber(v: VendorLite): string | null {
  const n = normalizeAccountNumber(v.bank_account)
  return /^\d{1,40}$/.test(n) ? n : null
}
function rosterAccountHolder(v: VendorLite): string | null {
  return cleanHolder(v.account_holder)
}

/** 戶名寫入分欄前的清理（驗收第五輪：去控制字元、依字元（code point）截 120）；空回 null，不丟錯。 */
function cleanHolder(raw: string | null | undefined): string | null {
  const h = String(raw ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim()
  return h ? Array.from(h).slice(0, 120).join("") : null
}

/**
 * 決定這張單的收款帳號（分欄＋相容快照）。
 * - 登錄廠商：沒有送帳戶（或已因 bankTouched 清掉）→ 照名冊（帳號正規化、戶名＝名冊 account_holder）；
 *   送回的快照與 DB 現值相同 → 原樣保留（含分欄）。
 * - 其他：送了分欄（payeeBankAccountNumber／payeeAccountHolder）→ 只送其中一欄時另一欄沿用 DB 現值（storedSplit；
 *   舊單沒有分欄才解析舊快照）；只送舊的單一字串 → 與 DB 現值相同就原樣保留，否則解析後驗證再分欄存。
 */
function resolvePayeeAccount(
  vendor: VendorLite | null,
  input: Omit<DisbursementInput, "status" | "allocations">,
  opts: { storedBank?: Partial<Record<PayeeBankField, string | null>>; storedSplit?: { number: string | null; holder: string | null } },
): { number: string | null; holder: string | null; snapshot: string | null } {
  const stored = opts.storedBank?.payeeBankAccount ?? null
  // DB 現有分欄（原樣；兩欄都 null＝舊單，沒動帳戶時維持 null、只留快照——驗收第六輪 #2：不再寫半套分欄）。
  const storedSplit = opts.storedSplit ?? { number: null, holder: null }
  const unchanged = () => ({ number: storedSplit.number, holder: storedSplit.holder, snapshot: stored })
  /**
   * 只送其中一欄時另一欄的基準：有分欄用分欄；舊單才解析舊快照——帳號段拆得出純數字才採用；
   * 拆不出（「TW-12345 丙印刷行」「郵局 0001234-5678901 …」）→ 400 split_account_required，要求兩欄一起填（不讓帳號默默遺失）。
   */
  const baseForPartial = (): { number: string | null; holder: string | null } => {
    if (storedSplit.number !== null || storedSplit.holder !== null) return storedSplit
    if (!stored) return { number: null, holder: null }
    const p = splitAccountSnapshot(stored, vendor?.account_holder ?? null)
    const n = normalizeAccountNumber(p.account)
    if (!/^\d{1,40}$/.test(n)) {
      throw new DisbursementError(400, "split_account_required", {
        message: "這張單的舊收款帳號格式無法拆開，請同時填寫帳號與帳戶戶名",
      })
    }
    return { number: n, holder: cleanHolder(p.holder) }
  }
  const sameAsStored = (sent: string | null | undefined) => sent !== undefined && (sent ?? "").trim() === (stored ?? "").trim()
  if (vendor) {
    const sent = input.payeeBankAccount
    // 沒送、或送的不是 DB 現值（單一字串不再解析）→ 照名冊。
    if (sent !== undefined && stored !== null && sameAsStored(sent)) return unchanged()
    const number = rosterAccountNumber(vendor)
    // 名冊有帳號但含非數字（寫不進分欄）→ 兩欄都不寫，前端改解析舊快照。
    const rosterHasAccount = String(vendor.bank_account ?? "").trim() !== ""
    const holder = rosterHasAccount && number === null ? null : rosterAccountHolder(vendor)
    return { number, holder, snapshot: vendorBankDefault(vendor, "payeeBankAccount") }
  }
  if (input.payeeBankAccountNumber !== undefined || input.payeeAccountHolder !== undefined) {
    const bothSent = input.payeeBankAccountNumber !== undefined && input.payeeAccountHolder !== undefined
    const base = bothSent ? { number: null, holder: null } : baseForPartial()
    const number = input.payeeBankAccountNumber !== undefined ? validatePayeeAccountNumber(input.payeeBankAccountNumber) : base.number
    const holder = input.payeeAccountHolder !== undefined ? validatePayeeAccountHolder(input.payeeAccountHolder) : base.holder
    return { number, holder, snapshot: composeAccountSnapshot(number, holder) }
  }
  // 驗收第六輪 #1：「其他」收款不再接受單一字串 payeeBankAccount 作為新帳戶（"99995678 1234" 這種拆法有歧義）——
  // 原樣回送 DB 現值才放行（維持不變），否則 400 use_split_account_fields（建單／改單入口另有同樣檢查）。
  const sent = input.payeeBankAccount
  if (sent === undefined || sameAsStored(sent)) return unchanged()
  throw new DisbursementError(400, "use_split_account_fields", {
    message: "「其他」收款請用 payeeBankAccountNumber（帳號）與 payeeAccountHolder（帳戶戶名）分欄填寫，不再接受單一字串 payeeBankAccount",
  })
}

/** 寫入用的單頭：0106 分欄未套用時剔除分欄鍵（schema-compat）。 */
async function headerRow(header: ResolvedHeader): Promise<Record<string, unknown>> {
  if (await disbursementsHaveSplitAccount()) return { ...header }
  const { payee_bank_account_number: _n, payee_account_holder: _h, ...rest } = header
  return rest
}

async function resolveHeader(
  tenantId: string,
  input: Omit<DisbursementInput, "status" | "allocations">,
  stored?: { payingCompanyId?: string | null; receiptIssuerCompanyId?: string | null },
  opts: {
    checkPayeeName?: boolean
    checkBankFields?: Iterable<PayeeBankField>
    storedBank?: Partial<Record<PayeeBankField, string | null>>
    /** 0106：DB 現有的分欄值（PATCH 只送其中一欄時，另一欄沿用這裡）。 */
    storedSplit?: { number: string | null; holder: string | null }
    /** 這次有送／改到任一銀行欄位（未給＝看 input 有沒有送）：登錄廠商時三欄整組照名冊帶入。 */
    bankTouched?: boolean
  } = {},
): Promise<ResolvedHeader> {
  let vendor: VendorLite | null = null
  if (input.payeeKind === "vendor") {
    if (!input.vendorId) throw new DisbursementError(400, "invalid_vendor", { vendorId: null })
    const { data, error } = await supabaseAdmin
      .from("vendors")
      .select(VENDOR_LITE_COLS)
      .eq("tenant_id", tenantId)
      .eq("id", input.vendorId)
      .is("deleted_at", null)
      .maybeSingle()
    if (error) throw new Error(`resolveHeader (vendor): ${error.message}`)
    if (!data) throw new DisbursementError(400, "invalid_vendor", { vendorId: input.vendorId })
    vendor = data as unknown as VendorLite
  }
  // R3 第五輪（2026-11-17）：戶名含不可見字元 → 400（PATCH 只在戶名／收款方有改時查，不回溯舊單）。
  // 第六輪 F2：拉丁字母混用西里爾／希臘字母也擋。
  // 2026-11-17：收款方是名冊廠商、戶名等於該廠商名冊名稱或帳戶戶名 → 已在名冊驗過，不再跑 invalidNameMessage（舊資料不回溯）。
  const trimmedPayee = (input.payeeName ?? "").trim()
  const sameAsRoster = !!vendor && trimmedPayee !== "" && (trimmedPayee === (vendor.name ?? "").trim() || trimmedPayee === (vendor.account_holder ?? "").trim())
  const badName = opts.checkPayeeName !== false && !sameAsRoster ? invalidNameMessage(input.payeeName) : null
  if (badName) throw new DisbursementError(400, "invalid_payee_name", { message: badName })
  const payeeName = (input.payeeName ?? "").trim() || vendor?.name || ""
  if (!payeeName) throw new DisbursementError(400, "payee_name_required")
  if (vendor && opts.checkPayeeName !== false) assertPayeeNameMatchesVendor(payeeName, vendor)
  if (vendor) {
    const bankTouched =
      opts.bankTouched ?? (PAYEE_BANK_FIELDS.some((f) => input[f] !== undefined) || input.payeeBankAccountNumber !== undefined || input.payeeAccountHolder !== undefined)
    // 登錄廠商的帳戶一律照名冊；分欄欄位不採用。
    input = { ...input, payeeBankAccountNumber: undefined, payeeAccountHolder: undefined }
    input = dropBlankBankFieldsForVendor(vendor, input)
    assertPayeeBankMatchesVendor(vendor, input, opts.checkBankFields ?? PAYEE_BANK_FIELDS, opts.storedBank)
    // 銀行三欄一致（2026-11-16 第四輪）：有送／改到任一欄 → 代碼、銀行名、帳號整組照名冊帶入，不留新舊混搭。
    if (bankTouched) {
      input = { ...input }
      for (const f of PAYEE_BANK_FIELDS) delete input[f]
    }
  }
  // R3 的「其他」收款戶名冒用檢查移到分攤解析之後（assertPayeeNotRegisteredVendor，需要分攤的副委託名稱，#4）。

  const companyIds = uniq([input.payingCompanyId, input.receiptIssuerCompanyId])
  const companies = await loadCompanies(tenantId, companyIds)
  const paying = companies.get(input.payingCompanyId)
  if (!paying) throw new DisbursementError(400, "invalid_company", { companyId: input.payingCompanyId })
  if (input.receiptIssuerCompanyId && !companies.has(input.receiptIssuerCompanyId)) {
    throw new DisbursementError(400, "invalid_company", { companyId: input.receiptIssuerCompanyId })
  }
  const inactiveIds = new Set([...companies.values()].filter((c) => c.is_active === false).map((c) => c.id))
  const inactiveId = firstNewlyPickedInactive(
    [
      { companyId: input.payingCompanyId, storedCompanyId: stored?.payingCompanyId },
      { companyId: input.receiptIssuerCompanyId, storedCompanyId: stored?.receiptIssuerCompanyId },
    ],
    inactiveIds,
  )
  if (inactiveId) throw new DisbursementError(400, "company_inactive", { companyId: inactiveId })
  const amount = roundMoney(input.amount)
  const withheld = roundMoney(input.withheldAmount ?? 0)
  if (amount < 0 || withheld < 0) throw new DisbursementError(400, "invalid_amount")
  const account = resolvePayeeAccount(vendor, input, opts)

  return {
    payee_kind: input.payeeKind,
    vendor_id: vendor?.id ?? null,
    payee_name: payeeName,
    payee_bank_name: input.payeeBankName !== undefined ? (input.payeeBankName ?? null) : vendor ? vendorBankDefault(vendor, "payeeBankName") : null,
    // 驗收第四輪：帳號與戶名分欄存（resolvePayeeAccount），payee_bank_account 仍寫「帳號 戶名」相容快照。
    payee_bank_account: account.snapshot,
    payee_bank_account_number: account.number,
    payee_account_holder: account.holder,
    payee_bank_code: input.payeeBankCode !== undefined ? (input.payeeBankCode ?? null) : vendor ? vendorBankDefault(vendor, "payeeBankCode") : null,
    paying_company_id: paying.id,
    paying_company_name: paying.name,
    paying_bank_account: companyBankAccount(paying),
    method: input.method,
    paid_on: input.paidOn ?? null,
    amount,
    withheld_amount: withheld,
    receipt_issuer_company_id: input.receiptIssuerCompanyId ?? null,
    receipt_ref: input.receiptRef?.trim() || null,
    has_invoice: input.hasInvoice ?? false,
    invoice_no: input.invoiceNo?.trim() || null,
    purpose: input.purpose?.trim() || null,
    note: input.note?.trim() || null,
  }
}

function assertTotals(payeeKind: PayeeKind, amount: number, withheld: number, allocations: ResolvedAllocation[]): void {
  const check = checkAllocationTotals(payeeKind, amount, withheld, allocations)
  if (!check.ok) {
    throw new DisbursementError(400, check.code, { field: check.field, expected: check.expected, actual: check.actual })
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 期款連動
 * ────────────────────────────────────────────────────────────────── */

type SyncHeader = {
  id: string
  disbursement_no: string
  paid_on: string
  paying_company_id: string
  receipt_issuer_company_id: string | null
  receipt_ref: string | null
}

type SyncAllocation = { subcontract_payment_id: string | null; amount: number; withheld_amount: number }

/**
 * 期款是否可被本單付：已付且 `disbursement_id` 不是本單（含手動標記＝null）→ 409。
 * 建立（status:'paid'）時在第一筆寫入前先跑一次；連動時再跑一次（兩次之間
 * 可能有人手動標了）。
 */
async function assertPaymentsPayable(tenantId: string, selfId: string | null, payments: PaymentRow[]): Promise<void> {
  // selfId=null（建立中、還沒有單）時任何已付都算衝突；有 selfId 時只放行「本單付的」。
  const conflict = payments.find((p) => p.paid_on !== null && !(selfId && (p.disbursement_id ?? null) === selfId))
  if (!conflict) return
  let otherNo: string | null = null
  if (conflict.disbursement_id) {
    const other = await loadDisbursement(tenantId, conflict.disbursement_id)
    otherNo = other?.disbursement_no ?? null
  }
  throw new DisbursementError(409, "payment_already_paid", {
    subcontractPaymentId: conflict.id,
    subcontractId: conflict.subcontract_id,
    installmentNo: conflict.installment_no,
    paidOn: conflict.paid_on,
    disbursementId: conflict.disbursement_id ?? null,
    disbursementNo: otherNo,
    manual: !conflict.disbursement_id,
  })
}

/* ──────────────────────────────────────────────────────────────────
 * M5 複委託驗收（accepted_on）
 * ────────────────────────────────────────────────────────────────── */

export type PaymentAcceptanceRow = {
  id: string
  subcontract_id: string
  installment_no: number
  accepted_on: string | null
  accepted_by_emp_id: string | null
  acceptance_note: string | null
}
export const PAYMENT_ACCEPTANCE_COLS = "id, subcontract_id, installment_no, accepted_on, accepted_by_emp_id, acceptance_note"

/**
 * 批次載入期款的驗收狀態。刻意**不**動 `project-application-store.ts` 的
 * `PAYMENT_COLS`（那是好幾個模組共用的字串常值，加欄位會牽動範圍外的檔案），
 * 改在這裡自己查三個驗收欄位。欄位尚未套用（migration 0050）回 `null`＝
 * 「這個庫還沒有驗收概念」，呼叫端據此整條略過檢查。
 */
export async function loadPaymentAcceptance(
  tenantId: string,
  paymentIds: string[],
): Promise<Map<string, PaymentAcceptanceRow> | null> {
  const ids = uniq(paymentIds)
  if (ids.length === 0) return new Map()
  if (!(await paymentsHaveAcceptance())) return null
  const rows = await batch<PaymentAcceptanceRow>(
    "project_subcontract_payments",
    PAYMENT_ACCEPTANCE_COLS,
    tenantId,
    ids,
    "id",
    false,
  )
  return new Map(rows.map((r) => [r.id, r]))
}

export type AcceptanceGuardOpts = {
  /** HR 勾了「強制放行未驗收」。 */
  force?: boolean
  /** 強制放行的理由（HR 必填）。 */
  reason?: string | null
  /** 寫稽核用的來源標記，例如 'POST /disbursements'。 */
  context: string
}

/**
 * M5：分攤到未驗收期款 → 409 `acceptance_required`（details 帶第一筆與全部待驗收
 * 期別，前端顯示「第 N 期尚未驗收」）。HR 帶 `force` ＋ `reason` 放行並寫稽核；
 * 非 HR 帶 force 一律 403 `acceptance_force_forbidden`。
 */
export async function assertPaymentsAccepted(
  tenantId: string,
  actor: Actor,
  paymentIds: string[],
  opts: AcceptanceGuardOpts,
): Promise<void> {
  const ids = uniq(paymentIds)
  if (ids.length === 0) return
  const acceptance = await loadPaymentAcceptance(tenantId, ids)
  if (acceptance === null) return // 驗收欄位還沒套用：維持上線前行為
  const pending = ids.map((id) => acceptance.get(id)).filter((r): r is PaymentAcceptanceRow => !!r && !r.accepted_on)
  if (pending.length === 0) return
  if (!opts.force) {
    const first = pending[0]
    throw new DisbursementError(409, "acceptance_required", {
      subcontractPaymentId: first.id,
      subcontractId: first.subcontract_id,
      installmentNo: first.installment_no,
      pending: pending.map((p) => ({
        subcontractPaymentId: p.id,
        subcontractId: p.subcontract_id,
        installmentNo: p.installment_no,
      })),
    })
  }
  if (!isHrRole(actor.role)) throw new DisbursementError(403, "acceptance_force_forbidden")
  const reason = opts.reason?.trim()
  if (!reason) throw new DisbursementError(400, "force_reason_required")
  await writeAuditLog({
    tenantId,
    tableName: "project_subcontract_payments",
    recordId: pending[0].id,
    action: "UPDATE",
    newRow: {
      forcedAcceptance: true,
      reason,
      installmentNos: pending.map((p) => p.installment_no),
      subcontractPaymentIds: pending.map((p) => p.id),
    },
    actorEmpId: actor.empId,
    context: opts.context,
  })
}

/**
 * M4：跳過簽核直接付款／直接建已匯款單＝HR 專屬例外，一定要留理由（稽核）。
 * 其餘角色 409 `approval_required`（前端提示「請先送簽」）。
 */
export function assertForcePayAllowed(actor: Actor, reason: string | null | undefined): string {
  if (!isHrRole(actor.role)) {
    throw new DisbursementError(409, "approval_required", { hint: "放款需經簽核核准後才能付款，請先送簽。" })
  }
  const trimmed = reason?.trim()
  if (!trimmed) throw new DisbursementError(400, "force_reason_required")
  return trimmed
}

/**
 * 轉 paid：每筆指到期款的分攤寫 `paid_on / paid_amount（=毛額−代扣）/ withheld_amount /
 * paying_company_id / receipt_issuer_company_id / receipt_ref / disbursement_id`
 * （沿用 routes/subcontracts.ts 的已付語意）。
 */
export async function syncPaymentsOnPay(tenantId: string, d: SyncHeader, allocations: SyncAllocation[]): Promise<string[]> {
  const targets = allocations.filter((a) => a.subcontract_payment_id)
  if (targets.length === 0) return []
  const payments = await batch<PaymentRow>(
    "project_subcontract_payments",
    PAYMENT_COLS,
    tenantId,
    uniq(targets.map((a) => a.subcontract_payment_id)),
    "id",
    false,
  )
  const byId = new Map(payments.map((p) => [p.id, p]))
  for (const a of targets) {
    if (!byId.has(a.subcontract_payment_id!)) {
      throw new DisbursementError(400, "invalid_payment", { subcontractPaymentId: a.subcontract_payment_id })
    }
  }
  await assertPaymentsPayable(tenantId, d.id, payments)
  // 期款所屬副委託已軟刪除（或專案已刪除）：不付款，回明確的 409（2026-11-12 驗收）。
  const subs = await batch<{ id: string; project_id: string; deleted_at: string | null }>(
    "project_subcontracts",
    "id, project_id, deleted_at",
    tenantId,
    uniq(payments.map((p) => p.subcontract_id)),
    "id",
    false,
  )
  const deletedSub = subs.find((s) => !!s.deleted_at)
  if (deletedSub) throw new DisbursementError(409, "subcontract_deleted", { subcontractId: deletedSub.id })

  const nowIso = new Date().toISOString()
  const touched: string[] = []
  try {
    for (const a of targets) {
      const { data, error } = await supabaseAdmin
        .from("project_subcontract_payments")
        .update({
          paid_on: d.paid_on,
          paid_amount: roundMoney(a.amount - a.withheld_amount),
          withheld_amount: a.withheld_amount,
          paying_company_id: d.paying_company_id,
          receipt_issuer_company_id: d.receipt_issuer_company_id,
          receipt_ref: d.receipt_ref,
          disbursement_id: d.id,
          updated_at: nowIso,
        })
        .eq("tenant_id", tenantId)
        .eq("id", a.subcontract_payment_id!)
        // 2026-10-27 驗收：兩張放款單分到同一期款並發付款時只能一張成功——期款仍未付、或本來就掛這張單才寫。
        .or(`paid_on.is.null,disbursement_id.eq.${d.id}`)
        .select("id")
      if (error) {
        // 讀到之後副委託被軟刪除／專案被刪除（DB 觸發器 RD409／PD409）：明確的 409，不是 500；已寫的期款照下面還原。
        if (isRowDeletedError(error)) throw new DisbursementError(409, "subcontract_deleted", { paymentId: a.subcontract_payment_id })
        if (isProjectDeletedError(error)) throw new DisbursementError(409, "project_deleted", { paymentId: a.subcontract_payment_id })
        throw new Error(`syncPaymentsOnPay: ${error.message}`)
      }
      if (!data || data.length === 0) throw new DisbursementError(409, "payment_already_paid", { paymentId: a.subcontract_payment_id })
      touched.push(a.subcontract_payment_id!)
    }
  } catch (err) {
    // 寫到一半失敗：已寫的期款還原成寫入前的快照，不留半套「已付」（2026-10-27 驗收 B）。
    try {
      await restorePaymentSnapshots(tenantId, touched.map((pid) => byId.get(pid)!))
    } catch (restoreErr) {
      // 還原也失敗：部分期款已是「已付」——上層不可再把單頭退回未付（會變成期款已付卻掛在未付單上）。
      throw new PaymentRestoreError(err, restoreErr)
    }
    throw err
  }
  return touched
}

/**
 * 已匯款單改收據編號 → 連動期款：依期款 id 排序逐筆寫。任何一筆失敗：已寫的期款還原成舊收據編號、
 * 放款單的收據編號也還原成舊值，再拋出原錯誤；還原本身也失敗就拋出需人工確認的錯誤。
 */
async function syncReceiptRefToPayments(
  tenantId: string,
  disbursementId: string,
  nextRef: string | null,
  prevRef: string | null,
  nowIso: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("project_subcontract_payments")
    .select("id, receipt_ref")
    .eq("tenant_id", tenantId)
    .eq("disbursement_id", disbursementId)
    .order("id", { ascending: true })
  if (error) throw new Error(`updateDisbursement (receipt_ref → payments, load): ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; receipt_ref: string | null }>
  const done: Array<{ id: string; receipt_ref: string | null }> = []
  try {
    for (const p of rows) {
      const { error: pErr } = await supabaseAdmin
        .from("project_subcontract_payments")
        .update({ receipt_ref: nextRef, updated_at: nowIso })
        .eq("tenant_id", tenantId)
        .eq("id", p.id)
      if (pErr) throw new Error(`updateDisbursement (receipt_ref → payments): ${pErr.message}`)
      done.push(p)
    }
  } catch (err) {
    const restoreErrors: string[] = []
    let restoreSkipped = false
    // 還原只在「仍是這次寫的新值」時才做（條件 receipt_ref = nextRef）：期間有人又改了就不蓋掉，記 log。
    const sameRef = <Q extends { is: (c: string, v: null) => Q; eq: (c: string, v: string) => Q }>(q: Q): Q =>
      nextRef === null ? q.is("receipt_ref", null) : q.eq("receipt_ref", nextRef)
    for (const p of done) {
      const { data: back, error: rErr } = await sameRef(
        supabaseAdmin
          .from("project_subcontract_payments")
          .update({ receipt_ref: p.receipt_ref, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", p.id),
      ).select("id")
      if (rErr) restoreErrors.push(`期款 ${p.id}：${rErr.message}`)
      else if (!back || back.length === 0) {
        logger.warn({ paymentId: p.id }, "receipt_ref restore skipped: payment changed by someone else")
        restoreSkipped = true
      }
    }
    const { data: dBack, error: dErr } = await sameRef(
      supabaseAdmin
        .from("disbursements")
        .update({ receipt_ref: prevRef, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", disbursementId),
    ).select("id")
    if (dErr) restoreErrors.push(`放款單：${dErr.message}`)
    else if (!dBack || dBack.length === 0) {
      logger.warn({ disbursementId }, "receipt_ref restore skipped: disbursement changed by someone else")
      restoreSkipped = true
    }
    // 還原失敗、或被略過（別人已改）都視同需人工確認：放款單與期款的收據編號可能不一致。
    if (restoreErrors.length > 0 || restoreSkipped) {
      const m = err instanceof Error ? err.message : String(err)
      logger.error({ disbursementId, err: m, restoreErrors, restoreSkipped }, "updateDisbursement: receipt_ref restore incomplete (manual check)")
      const { data: d } = await supabaseAdmin.from("disbursements").select("disbursement_no").eq("tenant_id", tenantId).eq("id", disbursementId).maybeSingle()
      const no = (d?.disbursement_no as string | undefined) ?? ""
      const label = no ? `單號 ${no}` : "此放款單"
      const detail = restoreErrors.length > 0 ? "且無法還原" : "且還原時發現已被他人修改"
      throw manualCheckError(no, `${label}的收據編號連動期款失敗${detail}，放款單與期款的收據編號可能不一致，需人工確認`)
    }
    throw err
  }
}

/** syncPaymentsOnPay 寫到一半失敗、且還原快照也失敗：部分期款已寫成已付，需人工確認。 */
export class PaymentRestoreError extends Error {
  constructor(cause: unknown, restoreErr: unknown) {
    const m = (e: unknown) => (e instanceof Error ? e.message : String(e))
    super(`期款寫入失敗且還原失敗：${m(cause)}；還原錯誤：${m(restoreErr)}`)
    this.name = "PaymentRestoreError"
  }
}

/** 期款連動欄位還原成快照（syncPaymentsOnPay 失敗時用）；還原本身失敗只能拋出，讓上層清楚回報。 */
async function restorePaymentSnapshots(tenantId: string, snapshots: PaymentRow[]): Promise<void> {
  for (const p of snapshots) {
    const { error } = await supabaseAdmin
      .from("project_subcontract_payments")
      .update({
        paid_on: p.paid_on,
        paid_amount: p.paid_amount,
        withheld_amount: p.withheld_amount,
        paying_company_id: p.paying_company_id,
        receipt_issuer_company_id: p.receipt_issuer_company_id,
        receipt_ref: p.receipt_ref,
        disbursement_id: p.disbursement_id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("id", p.id)
    if (error) throw new Error(`restorePaymentSnapshots (${p.id}): ${error.message}`)
  }
}

/**
 * 作廢：反向清空連動欄位（`disbursement_id=null`），note 附「作廢匯款 D-…：reason」，
 * 然後把該副委託未付期別的試算金額／代扣重算回來（同 subcontracts.ts
 * recomputePayments：已付凍結、末期吸收尾差）。
 */
export async function unsyncPaymentsOnVoid(
  tenantId: string,
  d: { id: string; disbursement_no: string },
  reason: string,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("project_subcontract_payments")
    .select(PAYMENT_COLS)
    .eq("tenant_id", tenantId)
    .eq("disbursement_id", d.id)
  if (error) throw new Error(`unsyncPaymentsOnVoid (load): ${error.message}`)
  const payments = (data ?? []) as unknown as PaymentRow[]
  if (payments.length === 0) return []

  const nowIso = new Date().toISOString()
  for (const p of payments) {
    const { error: upErr } = await supabaseAdmin
      .from("project_subcontract_payments")
      .update({
        paid_on: null,
        paid_amount: null,
        paying_company_id: null,
        receipt_issuer_company_id: null,
        receipt_ref: null,
        disbursement_id: null,
        note: appendNote(p.note, voidNoteLine(d.disbursement_no, reason)),
        updated_at: nowIso,
      })
      .eq("tenant_id", tenantId)
      .eq("id", p.id)
    if (upErr) throw new Error(`unsyncPaymentsOnVoid (update): ${upErr.message}`)
  }
  for (const subId of uniq(payments.map((p) => p.subcontract_id))) {
    await recomputeUnpaid(tenantId, subId)
  }
  return payments.map((p) => p.id)
}

/** 副委託未付期別的 amount／withheld_amount 重算（複製 subcontracts.ts recomputePayments 的規則）。 */
async function recomputeUnpaid(tenantId: string, subcontractId: string): Promise<void> {
  const { data: subData, error: subErr } = await supabaseAdmin
    .from("project_subcontracts")
    .select(SUBCONTRACT_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", subcontractId)
    // 已軟刪除的副委託不重算（2026-11-12 驗收）。
    .is("deleted_at", null)
    .maybeSingle()
  if (subErr) throw new Error(`recomputeUnpaid (subcontract): ${subErr.message}`)
  if (!subData) return
  const sub = subData as unknown as SubcontractRow
  const { data, error } = await supabaseAdmin
    .from("project_subcontract_payments")
    .select(PAYMENT_COLS)
    .eq("tenant_id", tenantId)
    .eq("subcontract_id", subcontractId)
    .order("installment_no", { ascending: true })
  if (error) throw new Error(`recomputeUnpaid (payments): ${error.message}`)
  const payments = (data ?? []) as unknown as PaymentRow[]
  if (payments.length === 0) return
  const contractAmount = num(sub.amount) ?? 0
  const result = computeSubcontractPayments(
    payments.map((p) => ({
      installmentNo: p.installment_no,
      percentage: num(p.percentage),
      overrideAmount: num(p.override_amount),
      paid: p.paid_on !== null,
      paidGrossAmount: num(p.override_amount) ?? num(p.amount),
    })),
    contractAmount,
    num(sub.withholding_rate) ?? DEFAULT_WITHHOLDING_RATE,
    Number(sub.withholding_threshold ?? DEFAULT_WITHHOLDING_THRESHOLD),
  )
  const byNo = new Map(result.rows.map((r) => [r.installmentNo, r]))
  for (const p of payments) {
    if (p.paid_on !== null) continue
    const next = byNo.get(p.installment_no)
    if (!next) continue
    const pct = num(p.percentage)
    const rawCalc = pct === null ? 0 : round0(contractAmount * (pct / 100))
    const amount = next.calculatedAmount ?? rawCalc
    const withheld = next.withheldAmount
    if (num(p.amount) === amount && (num(p.withheld_amount) ?? 0) === withheld) continue
    const { error: upErr } = await supabaseAdmin
      .from("project_subcontract_payments")
      .update({ amount, withheld_amount: withheld, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", p.id)
    // 讀到之後副委託被軟刪除（或專案被刪除）：觸發器 RD409／PD409，試算重算略過即可（2026-11-12 驗收）。
    if (upErr && (isRowDeletedError(upErr) || isProjectDeletedError(upErr))) return
    if (upErr) throw new Error(`recomputeUnpaid (update): ${upErr.message}`)
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 通知：轉 paid 時通知各分攤專案的 lead
 * ────────────────────────────────────────────────────────────────── */

async function notifyProjectLeads(tenantId: string, d: DisbursementRow, allocations: AllocationRow[]): Promise<number> {
  if (allocations.length === 0) return 0
  const ctx = await loadAllocationContext(tenantId, allocations)
  const byProject = groupBy(allocations, (a) => a.project_id)
  const rows: Array<Record<string, unknown>> = []
  const amountText = (num(d.amount) ?? 0).toLocaleString("en-US")
  for (const [projectId, allocs] of byProject) {
    const project = ctx.projects.get(projectId)
    if (!project?.lead_emp_id) continue
    const nos = allocs
      .map((a) => (a.subcontract_payment_id ? ctx.payments.get(a.subcontract_payment_id)?.installment_no : null))
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b)
    const net = roundMoney(allocs.reduce((s, a) => s + ((num(a.amount) ?? 0) - (num(a.withheld_amount) ?? 0)), 0))
    rows.push({
      tenant_id: tenantId,
      employee_id: project.lead_emp_id,
      type: "disbursement",
      title: `已放款 ${d.payee_name} ${amountText}`,
      body: `${d.disbursement_no}（${d.paid_on}）分攤至 ${project.code ? `${project.code} ` : ""}${project.name}${nos.length ? ` 第${nos.join(",")}期` : ""}，實付 ${net.toLocaleString("en-US")}。`,
      channel: "inapp",
      status: "pending",
      payload: {
        disbursementId: d.id,
        disbursementNo: d.disbursement_no,
        projectId,
        paidOn: d.paid_on,
        amount: net,
        installmentNos: nos,
      },
    })
  }
  if (rows.length === 0) return 0
  const { error } = await supabaseAdmin.from("notifications").insert(rows)
  if (error) {
    // 通知是附帶的：錢已經匯了、期款已經連動了，不因為通知寫不進去回 500。
    logger.warn({ err: error.message, disbursementId: d.id }, "disbursement notify failed")
    return 0
  }
  return rows.length
}

/* ──────────────────────────────────────────────────────────────────
 * 寫入
 * ────────────────────────────────────────────────────────────────── */

/** 逐列 insert（不用整批）：created_at 才保得住輸入順序，replaceAllocations 的就地更新靠它對位。 */
async function insertAllocations(tenantId: string, disbursementId: string, allocations: ResolvedAllocation[]): Promise<void> {
  for (const a of allocations) {
    const { error } = await supabaseAdmin.from("disbursement_allocations").insert({
      tenant_id: tenantId,
      disbursement_id: disbursementId,
      project_id: a.projectId,
      subcontract_id: a.subcontractId,
      subcontract_payment_id: a.subcontractPaymentId,
      amount: a.amount,
      withheld_amount: a.withheldAmount,
      note: a.note,
    })
    if (error) throw new Error(`insertAllocations: ${error.message}`)
  }
}

function isRestrictViolation(err: { code?: string | null; message?: string | null } | null): boolean {
  return err?.code === "23001" || /禁止實體刪除/.test(err?.message ?? "")
}

/**
 * draft 的分攤整批覆蓋。`disbursement_allocations` 掛了 no_hard_delete（sql/0029），
 * 正式租戶刪不掉列，所以做法是「就地更新既有列、多的新增、少的才刪」：
 * 改金額／改對象／加列在正式環境都行得通，只有**減少列數**會撞到 trigger
 * → 409 `allocation_not_removable`（先刪、再改、再加，撞到時草稿未被動過）。
 */
async function replaceAllocations(tenantId: string, disbursementId: string, next: ResolvedAllocation[]): Promise<void> {
  const existing = await loadAllocations(tenantId, [disbursementId])
  const extras = existing.slice(next.length)
  for (const row of extras) {
    const { error } = await supabaseAdmin
      .from("disbursement_allocations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", row.id)
    if (error) {
      if (isRestrictViolation(error)) {
        throw new DisbursementError(409, "allocation_not_removable", {
          hint: "草稿的分攤列數只能增加不能減少（DB 禁刪）；要少一列請作廢後重建。",
        })
      }
      throw new Error(`replaceAllocations (delete): ${error.message}`)
    }
  }
  const keep = Math.min(existing.length, next.length)
  for (let i = 0; i < keep; i++) {
    const a = next[i]
    const { error } = await supabaseAdmin
      .from("disbursement_allocations")
      .update({
        project_id: a.projectId,
        subcontract_id: a.subcontractId,
        subcontract_payment_id: a.subcontractPaymentId,
        amount: a.amount,
        withheld_amount: a.withheldAmount,
        note: a.note,
      })
      .eq("tenant_id", tenantId)
      .eq("id", existing[i].id)
    if (error) throw new Error(`replaceAllocations (update): ${error.message}`)
  }
  await insertAllocations(tenantId, disbursementId, next.slice(keep))
}

/** 呼叫者：`role` 是 employees.role（`isHrRole` 判斷強制放行用；省略＝非 HR）。 */
export type Actor = { empId: string | null; role?: string | null; active?: boolean }

/**
 * 建立匯款單。`status:'paid'` 立即連動期款（先驗證期款可付，再寫）。
 * 單號 `D-{年}-{NNN}`：unique index 撞號時重試（同 nextProjectCode 的併發策略）。
 */
export async function createDisbursement(tenantId: string, actor: Actor, input: DisbursementInput): Promise<SerializedDisbursement> {
  const header = await resolveHeader(tenantId, input)
  const allocations = await resolveAllocations(tenantId, input.allocations)
  // R3：收款「其他」但戶名（正規化後）與名冊廠商視為同一家 → 400（第六輪起非登錄副委託同名也不放行）。
  const confirmDistinctReason = (input.confirmDistinctReason ?? "").trim()
  const payeeSimilar =
    header.payee_kind === "other"
      ? await assertPayeeNotRegisteredVendor(tenantId, header.payee_name, {
          confirmDistinctReason,
          unboundSubcontractAllocated: allocations.some((a) => !!a.subcontractId && a.subcontractVendorId === null),
        })
      : null
  assertAllocationVendors(header.vendor_id, allocations)
  assertTotals(header.payee_kind, header.amount, header.withheld_amount, allocations)
  assertVendorPurpose(header, allocations)
  const nonInstallmentConfirmed = await assertZeroAllocVendorConfirmed(tenantId, header, allocations, input.confirmNonInstallment)
  const payments = allocations.map((a) => a.payment).filter((p): p is PaymentRow => !!p)
  // M5：分攤到未驗收期款一律擋（HR 可帶 forceAcceptance＋forceReason 放行）。
  await assertPaymentsAccepted(tenantId, actor, payments.map((p) => p.id), {
    force: input.forceAcceptance === true,
    reason: input.forceReason,
    context: "POST /disbursements",
  })
  let forcedPayReason: string | null = null
  if (input.status === "paid") {
    // M4：不經簽核直接建「已匯款」＝HR 專屬例外，必須留理由。
    forcedPayReason = assertForcePayAllowed(actor, input.forceReason)
    if (!header.paid_on) throw new DisbursementError(400, "paid_on_required")
    await assertPaymentsPayable(tenantId, null, payments)
    // 驗收 M1：直接建成「已匯款」也要過收款帳戶防線（帳戶變更待覆核、帳戶未確認、快照不等於名冊）。
    await assertPayeeBankStillMatchesVendor(tenantId, header)
  }
  // 第 5 項：確認非期款支出的稽核嚴格、且在建單之前寫（寫不進去就不建）。
  if (nonInstallmentConfirmed) await auditNonInstallmentConfirm(tenantId, actor, null, header, "POST /disbursements")
  // 第八輪：相近名稱的說明——嚴格、建單前寫（寫不進去就不建）；建單後的 INSERT 稽核也帶同樣欄位（核准頁從那裡依單號查）。
  if (payeeSimilar) await auditPayeeSimilarConfirm(tenantId, actor, null, header.payee_name, payeeSimilar, confirmDistinctReason, "POST /disbursements")

  const today = await tenantToday(tenantId)
  const year = Number(today.slice(0, 4))
  const fmt = await loadDisbursementNoFormat(tenantId)
  let row: DisbursementRow | null = null
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !row; attempt++) {
    const disbursementNo = await nextDisbursementNo(tenantId, year, fmt)
    const { data, error } = await supabaseAdmin
      .from("disbursements")
      .insert({
        tenant_id: tenantId,
        disbursement_no: disbursementNo,
        status: input.status,
        ...(await headerRow(header)),
        paid_by_emp_id: input.status === "paid" ? actor.empId : null,
        created_by_emp_id: actor.empId,
      })
      .select(await disbursementCols())
      .single()
    if (error) {
      if (isUniqueViolation(error)) continue
      throw new Error(`createDisbursement: ${error.message}`)
    }
    row = data as unknown as DisbursementRow
  }
  if (!row) throw new DisbursementError(409, "code_conflict", { hint: "單號連續撞號，請重試。" })

  const writeInsertAudit = () =>
    writeAuditLog({
      tenantId,
      tableName: "disbursements",
      recordId: row!.id,
      action: "INSERT",
      newRow: {
        ...row,
        allocations: input.allocations,
        ...(forcedPayReason ? { forcedPaid: true, forceReason: forcedPayReason } : {}),
        // 第六輪：核准頁「已確認為非期款支出」標示從這裡查（建單前的嚴格稽核還沒有單號 id）。
        ...(nonInstallmentConfirmed ? { confirmNonInstallment: true } : {}),
        ...(payeeSimilar ? payeeSimilarAuditFields(payeeSimilar, confirmDistinctReason) : {}),
      },
      actorEmpId: actor.empId,
      context: "POST /disbursements",
    })
  if (input.status !== "paid") {
    await insertAllocations(tenantId, row.id, allocations)
  } else {
    // 已匯款的單頭一建立就先寫 app 層 INSERT 稽核（含建立人、強制匯款理由）：之後任何失敗路徑
    //（自動作廢、作廢失敗、期款還原失敗）都查得到這張單是誰、為什麼直接建成已匯款（2026-11-12 驗收）。
    await writeInsertAudit()
    // 直接建成已匯款：寫分攤與連動期款都在同一個 try 裡——任何一步失敗（例：分攤寫到一半撞 PD409 專案已刪除）
    // 都把剛建的單自動作廢，不留已匯款單頭＋部分分攤的半成品（2026-11-12 驗收）。
    try {
      await insertAllocations(tenantId, row.id, allocations)
      await syncPaymentsOnPay(
        tenantId,
        {
          id: row.id,
          disbursement_no: row.disbursement_no,
          paid_on: row.paid_on!,
          paying_company_id: row.paying_company_id,
          receipt_issuer_company_id: row.receipt_issuer_company_id,
          receipt_ref: row.receipt_ref,
        },
        allocations.map((a) => ({ subcontract_payment_id: a.subcontractPaymentId, amount: a.amount, withheld_amount: a.withheldAmount })),
      )
    } catch (syncErr) {
      throw await voidCreatedAfterSyncFailure(tenantId, actor, row, syncErr)
    }
    await notifyProjectLeads(tenantId, row, await loadAllocations(tenantId, [row.id]))
  }
  if (input.status !== "paid") await writeInsertAudit()
  // #3：直接建成已匯款＝專案成本增加 → 排程重算未發放的獎金批次（非同步、失敗只 log）。
  if (input.status === "paid") {
    await recomputeBonusRunsBestEffort(tenantId, allocations.map((a) => a.projectId), "POST /disbursements (paid)")
  }
  return (await getDisbursement(tenantId, row.id))!
}

/**
 * 直接建成已匯款、但寫分攤或連動期款失敗（2026-11-12 驗收）：不留「已匯款的單頭＋分攤、期款卻沒付」的半成品。
 * 單頭不能實體刪除（no_hard_delete）、非草稿的分攤也不能刪 → 用既有的作廢機制：狀態改 void＋作廢原因
 *（作廢單的分攤不算擋刪）；作廢後若仍有掛這張單的已付期款（網路不確定是否寫成）比照 unsyncPaymentsOnVoid 清回未付。
 * 稽核：INSERT 由 createDisbursement 在單頭建立後就寫好；這裡在作廢成功當下寫作廢 UPDATE（oldRow 是完整單頭），
 * 之後清期款失敗也已留下作廢紀錄。syncPaymentsOnPay 已把寫到一半的期款還原；若連還原都失敗
 *（PaymentRestoreError：部分期款已付）就不作廢、單頭維持已匯款，回需人工確認（同 payDisbursement）。
 * 回傳要丟給使用者的 DisbursementError：帶中文 message、自己被作廢的單號 autoVoidedNo（原錯誤 details 裡的單號——
 * 例如搶先付款的那張——原樣保留）；內部錯誤細節只進 log。
 */
async function voidCreatedAfterSyncFailure(
  tenantId: string,
  actor: Actor,
  row: DisbursementRow,
  syncErr: unknown,
): Promise<DisbursementError> {
  const no = row.disbursement_no
  const internal = syncErr instanceof Error ? syncErr.message : String(syncErr)
  if (syncErr instanceof PaymentRestoreError) {
    logger.error({ disbursementId: row.id, err: internal }, "createDisbursement: payment restore failed (manual check)")
    return manualCheckError(no, `已建立單號 ${no}，但期款同步失敗且部分期款無法還原，放款單維持已匯款，需人工確認期款`)
  }
  const code =
    syncErr instanceof DisbursementError
      ? syncErr.code
      : isProjectDeletedError(syncErr)
        ? "project_deleted"
        : isRowDeletedError(syncErr)
          ? "subcontract_deleted"
          : isRetryableConflictError(syncErr)
            ? "conflict_retry"
            : "sync_failed"
  const reason = `建立時寫入分攤／期款失敗，系統自動作廢（${code}）`
  const { data: voided, error: voidErr } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "void", void_reason: reason, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", row.id)
    .eq("status", "paid")
    .select("id")
    .maybeSingle()
  if (voidErr || !voided) {
    logger.error({ disbursementId: row.id, err: internal, voidErr: voidErr?.message }, "createDisbursement: auto void failed (manual check)")
    return manualCheckError(no, `已建立單號 ${no}，但寫入分攤／期款失敗，且系統無法自動作廢這張單，需人工確認`)
  }
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: row.id,
    action: "UPDATE",
    oldRow: { ...row },
    newRow: { ...row, status: "void", void_reason: reason },
    actorEmpId: actor.empId,
    context: "POST /disbursements (paid, sync failed → auto void)",
  })
  // 作廢保險：仍掛這張單、已寫成已付的期款（網路不確定是否寫成）清回未付。
  try {
    await unsyncPaymentsOnVoid(tenantId, { id: row.id, disbursement_no: no }, "建立時期款同步失敗，系統自動作廢")
  } catch (err) {
    logger.error({ disbursementId: row.id, err: err instanceof Error ? err.message : String(err) }, "createDisbursement: unsync after auto void failed")
    return manualCheckError(no, `已建立單號 ${no} 並已自動作廢，但連動的期款無法清回未付，需人工確認期款`)
  }
  const base = syncErr instanceof DisbursementError ? syncErr : null
  const fixable = code in CREATE_FAIL_REASON
  const why =
    code === "payment_already_paid" && typeof base?.details?.disbursementNo === "string" && base.details.disbursementNo
      ? `期款已由其他匯款（單號 ${base.details.disbursementNo}）標記為已付`
      : code === "conflict_retry"
        ? "資料正被同時修改"
        : (CREATE_FAIL_REASON[code] ?? "寫入分攤／期款失敗")
  return new DisbursementError(base?.httpStatus && base.httpStatus < 500 ? base.httpStatus : 409, code, {
    ...(base?.details ?? {}),
    autoVoidedNo: no,
    autoVoided: true,
    message: `已建立單號 ${no}，但${why}，系統已自動作廢這張單；${fixable ? "請修正後重新建立" : "請重新建立（重試）"}`,
  })
}

/** 可由使用者修正的失敗原因（其餘如死鎖、未知錯誤 → 請重新建立／重試）。 */
const CREATE_FAIL_REASON: Record<string, string> = {
  project_deleted: "分攤的專案已被刪除",
  subcontract_deleted: "分攤的副委託已被刪除",
  payment_already_paid: "期款已由其他匯款標記為已付",
  invalid_payment: "期款不存在",
}

/** 需人工確認：500，帶中文說明與單號（不含內部錯誤細節，細節只進 log）。 */
function manualCheckError(disbursementNo: string, message: string): DisbursementError {
  return new DisbursementError(500, "manual_check_required", {
    disbursementNo,
    message: `${message}；請勿直接重新建立或重新送出，以免重複付款`,
  })
}

const PAID_EDITABLE = new Set<keyof DisbursementPatch>(["note", "receiptRef", "purpose", "hasInvoice", "invoiceNo"])
/** 不是單據欄位、只是這次呼叫的旗標，比對「有沒有被改動」時要跳過。 */
const CONTROL_KEYS = new Set<keyof DisbursementPatch>(["forceReason", "forceAcceptance", "confirmNonInstallment", "confirmDistinctReason"])

function headerToInput(d: DisbursementRow): Omit<DisbursementInput, "status" | "allocations"> {
  return {
    payeeKind: d.payee_kind,
    vendorId: d.vendor_id,
    payeeName: d.payee_name,
    payeeBankName: d.payee_bank_name,
    payeeBankAccount: d.payee_bank_account,
    payeeBankCode: d.payee_bank_code,
    payingCompanyId: d.paying_company_id,
    method: d.method,
    paidOn: d.paid_on,
    amount: num(d.amount) ?? 0,
    withheldAmount: num(d.withheld_amount) ?? 0,
    receiptIssuerCompanyId: d.receipt_issuer_company_id,
    receiptRef: d.receipt_ref,
    hasInvoice: d.has_invoice,
    invoiceNo: d.invoice_no,
    purpose: d.purpose,
    note: d.note,
  }
}

/**
 * PATCH：draft 全部可改（allocations 整批覆蓋、快照重抓）；paid／approved 只可改
 * note／receiptRef／purpose／hasInvoice／invoiceNo（已匯款後補發票號是常態）——
 * 其他欄位若出現且與現值不同 → 409 `paid`／`approved`（UI 送整份表單但值沒動的
 * 情況放行；要真的改就先撤回簽核）；pending_approval → 409 `pending_approval`；
 * void → 409 `void`。改分攤時一併檢查複委託驗收（M5）。
 */
export async function updateDisbursement(
  tenantId: string,
  actor: Actor,
  id: string,
  patch: DisbursementPatch,
): Promise<SerializedDisbursement | null> {
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status === "void") throw new DisbursementError(409, "void")
  if (current.status === "pending_approval") {
    throw new DisbursementError(409, "pending_approval", { hint: "送簽中的放款單不可修改；要改請先撤回簽核。" })
  }
  const nowIso = new Date().toISOString()
  const trackEditors = await disbursementsHaveEditors()
  /** 編輯人名單（M2）：把這次的操作者加進去（欄位未套用時不寫）。 */
  const editorsPatch = (): Record<string, unknown> =>
    trackEditors && actor.empId
      ? { edited_by_emp_ids: [...new Set([...(current.edited_by_emp_ids ?? []), actor.empId.toLowerCase()])] }
      : {}
  /**
   * 條件寫入（2026-10-27 安全驗收 M2：之前「先讀 status 再無條件寫入」有 TOCTOU——讀完到寫入之間單子可能已被送簽／
   * 核准）：只在 status 仍是讀到的值、updated_at 也沒變（樂觀鎖，防兩人同時改互蓋、編輯人名單漏記）時才寫；
   * 0 列＝搶輸 → 409 `conflict`（請重新整理再改）。
   */
  // 表上有 set_updated_at trigger（sql/0029）：寫入後 updated_at 由 DB 決定，所以回傳寫入後的值給下一次條件寫入用。
  const guardedUpdate = async (fields: Record<string, unknown>, label: string, expectUpdatedAt: string | null): Promise<string | null> => {
    let q = supabaseAdmin.from("disbursements").update(fields).eq("tenant_id", tenantId).eq("id", id).eq("status", current.status)
    q = expectUpdatedAt ? q.eq("updated_at", expectUpdatedAt) : q.is("updated_at", null)
    const { data, error } = await q.select("id, updated_at")
    if (error) throw new Error(`updateDisbursement (${label}): ${error.message}`)
    const hit = (data ?? []) as Array<{ updated_at?: string | null }>
    if (hit.length === 0) {
      throw new DisbursementError(409, "conflict", { hint: "這張放款單剛被其他人修改、送簽或核准，請重新整理後再改。" })
    }
    return hit[0].updated_at ?? null
  }

  // approved 與 paid 同一套限縮：已核准的內容不能再偷改（要改先撤回）。
  const frozen = current.status === "paid" || current.status === "approved"
  const frozenCode = current.status === "approved" ? "approved" : "paid"
  if (frozen) {
    const base = headerToInput(current)
    for (const key of Object.keys(patch) as Array<keyof DisbursementPatch>) {
      if (PAID_EDITABLE.has(key) || CONTROL_KEYS.has(key)) continue
      if (key === "allocations") {
        // 分攤已連動期款（或已被簽核核准），之後不再收；值一樣就放行（表單整份回送）。
        const same = await allocationsUnchanged(tenantId, id, patch.allocations ?? [])
        if (!same) throw new DisbursementError(409, frozenCode, { field: key })
        continue
      }
      const nextVal = (patch as Record<string, unknown>)[key]
      const curVal = (base as Record<string, unknown>)[key]
      if (nextVal !== undefined && normalize(nextVal) !== normalize(curVal)) {
        throw new DisbursementError(409, frozenCode, { field: key })
      }
    }
    const fields: Record<string, unknown> = { updated_at: nowIso }
    if (patch.note !== undefined) fields.note = patch.note?.trim() || null
    if (patch.receiptRef !== undefined) fields.receipt_ref = patch.receiptRef?.trim() || null
    if (patch.purpose !== undefined) fields.purpose = patch.purpose?.trim() || null
    if (patch.hasInvoice !== undefined) fields.has_invoice = patch.hasInvoice
    if (patch.invoiceNo !== undefined) fields.invoice_no = patch.invoiceNo?.trim() || null
    await guardedUpdate(fields, frozenCode, current.updated_at ?? null)
    if (current.status === "paid" && fields.receipt_ref !== undefined && fields.receipt_ref !== current.receipt_ref) {
      // 收據編號是連動寫進期款的，改了要跟著走。依期款 id 排序逐筆更新（一句多筆會以不定順序鎖期款列，
      // 可能與刪除專案的交易反序死鎖，2026-11-12 驗收）；中途失敗就把已改的期款與放款單的收據編號還原，不留不一致。
      await syncReceiptRefToPayments(tenantId, id, (fields.receipt_ref as string | null) ?? null, current.receipt_ref ?? null, nowIso)
    }
  } else {
    const merged: Omit<DisbursementInput, "status" | "allocations"> & { allocations?: AllocationInput[] } = {
      ...headerToInput(current),
      ...stripUndefined(patch),
    }
    // 驗收第五輪：登錄廠商 → 其他，且沒送帳戶欄 → 帳戶（分欄、舊快照、銀行名／代碼）一律清空，不沿用原廠商的名冊帳戶。
    let kindSwitchedToOther = false
    if (patch.payeeKind === "other" && current.payee_kind === "vendor") {
      const sentAccount =
        patch.payeeBankAccount !== undefined || patch.payeeBankAccountNumber !== undefined || patch.payeeAccountHolder !== undefined
      if (!sentAccount) {
        merged.payeeBankAccountNumber = null
        merged.payeeAccountHolder = null
        merged.payeeBankAccount = null
      }
      if (patch.payeeBankName === undefined) merged.payeeBankName = null
      if (patch.payeeBankCode === undefined) merged.payeeBankCode = null
      kindSwitchedToOther = true
    }
    // 換了廠商而沒另外給名稱／帳戶 → 快照重新從新廠商複製，不然會留著舊廠商的名字。
    if (patch.vendorId !== undefined && patch.vendorId !== current.vendor_id) {
      if (patch.payeeName === undefined) merged.payeeName = null
      if (patch.payeeBankName === undefined) delete merged.payeeBankName
      if (patch.payeeBankAccount === undefined) delete merged.payeeBankAccount
      if (patch.payeeBankCode === undefined) delete merged.payeeBankCode
    }
    // 付錯人檢查（2026-11-16）只對這次「改到」的東西：換了收款廠商／收款方種類，或戶名真的改了。
    // 只改備註的 PATCH 不重驗——草稿建立後廠商改名，舊快照名稱不該讓整張單改不動。
    const payeeChanged =
      (patch.payeeKind !== undefined && patch.payeeKind !== current.payee_kind) ||
      (patch.vendorId !== undefined && (patch.vendorId ?? null) !== (current.vendor_id ?? null))
    const payeeNameChanged = patch.payeeName !== undefined && normalize(patch.payeeName) !== normalize(current.payee_name)
    // 銀行欄位同理：換了收款方就驗有送的；沒換就只驗「這次真的改了值」的欄位（舊單整份表單回送原快照放行）。
    const storedBank: Record<PayeeBankField, string | null> = {
      payeeBankName: current.payee_bank_name,
      payeeBankAccount: current.payee_bank_account,
      payeeBankCode: current.payee_bank_code,
    }
    const bankFieldsToCheck = PAYEE_BANK_FIELDS.filter((f) =>
      payeeChanged ? true : patch[f] !== undefined && normalize(patch[f]) !== normalize(storedBank[f]),
    )
    const header = await resolveHeader(
      tenantId,
      merged,
      {
        payingCompanyId: current.paying_company_id,
        receiptIssuerCompanyId: current.receipt_issuer_company_id,
      },
      {
        checkPayeeName: payeeChanged || payeeNameChanged,
        checkBankFields: bankFieldsToCheck,
        // 改成「其他」時不沿用原廠商的分欄／快照（只送一欄時另一欄也不從原廠商帶）。
        storedBank: kindSwitchedToOther ? { ...storedBank, payeeBankAccount: null } : storedBank,
        storedSplit: kindSwitchedToOther ? { number: null, holder: null } : { number: current.payee_bank_account_number ?? null, holder: current.payee_account_holder ?? null },
        bankTouched: payeeChanged || bankFieldsToCheck.length > 0,
      },
    )
    const storedAllocs = await loadAllocations(tenantId, [id])
    // 第五輪第 5 項：原本有分攤的單不能改成零分攤（要改成非專案支出請作廢重開）。
    if (patch.allocations !== undefined && patch.allocations.length === 0 && storedAllocs.length > 0) {
      throw new DisbursementError(400, "cannot_clear_allocations", { message: "已分攤的放款單不能改成零分攤，請作廢後重開" })
    }
    const allocInputs: AllocationInput[] =
      patch.allocations !== undefined
        ? patch.allocations
        : storedAllocs.map((a) => ({
            projectId: a.project_id,
            subcontractId: a.subcontract_id,
            subcontractPaymentId: a.subcontract_payment_id,
            amount: num(a.amount) ?? 0,
            withheldAmount: num(a.withheld_amount) ?? 0,
            note: a.note,
          }))
    const allocations = await resolveAllocations(tenantId, allocInputs)
    // 第五輪第 2 項：分攤有變（新增／移除／替換，或清成零分攤）也要重驗——不然先用無關分攤建單、再換成同名非登錄副委託就能繞過。
    const refKeys = (rows: Array<{ sub: string | null | undefined; pay: string | null | undefined }>) =>
      rows.map((r) => allocationRefKey(r.sub, r.pay)).sort().join(",")
    const allocationsChanged =
      patch.allocations !== undefined &&
      refKeys(storedAllocs.map((a) => ({ sub: a.subcontract_id, pay: a.subcontract_payment_id }))) !==
        refKeys(allocations.map((a) => ({ sub: a.subcontractId, pay: a.subcontractPaymentId })))
    // R3：PATCH 只在收款方、戶名或分攤有改時檢查（不回溯）。
    const confirmDistinctReason = (patch.confirmDistinctReason ?? "").trim()
    let payeeSimilar: PayeeSimilarHit | null = null
    if (header.payee_kind === "other" && (payeeChanged || payeeNameChanged || allocationsChanged)) {
      try {
        payeeSimilar = await assertPayeeNotRegisteredVendor(tenantId, header.payee_name, {
          confirmDistinctReason,
          unboundSubcontractAllocated: allocations.some((a) => !!a.subcontractId && a.subcontractVendorId === null),
        })
      } catch (err) {
        // 戶名沒變、只改分攤：這個名稱先前已說明過（稽核有紀錄）就不重問。
        // 第九輪 E：但目前名冊有舊說明沒涵蓋的相近廠商（說明後才新增／改名）、或查不到比對結果 → 要求重新說明。
        if (!(err instanceof DisbursementError) || err.code !== "payee_name_similar" || payeeChanged || payeeNameChanged) throw err
        const prior = (await payeeSimilarWarnings(tenantId, [current])).get(id)
        if (!prior || prior.unknown || prior.reason === null || prior.unconfirmedVendorNames.length > 0) throw err
      }
    }
    if (payeeChanged) {
      assertAllocationVendors(header.vendor_id, allocations)
    } else if (patch.allocations !== undefined) {
      // 收款方沒換：只驗這次新加／換掉的分攤列（副委託＋期款組合原本不在單上的），既有列不回溯。
      const existingKeys = new Set(storedAllocs.map((e) => allocationRefKey(e.subcontract_id, e.subcontract_payment_id)))
      assertAllocationVendors(
        header.vendor_id,
        allocations.map((r) =>
          existingKeys.has(allocationRefKey(r.subcontractId, r.subcontractPaymentId)) ? { ...r, subcontractVendorId: undefined } : r,
        ),
      )
    }
    assertTotals(header.payee_kind, header.amount, header.withheld_amount, allocations)
    if (payeeChanged || patch.allocations !== undefined || patch.purpose !== undefined) assertVendorPurpose(header, allocations)
    // 第 5 項：換成登錄廠商零分攤時，廠商仍有未付期款要確認（整份表單回送、分攤沒變不重問）。
    // 第六輪 F3：零分攤登錄廠商單只要金額（含代扣）或用途有改，也重跑（開單後廠商才新增期款、再改金額的情況）。
    const amountOrPurposeChanged =
      roundMoney(header.amount) !== roundMoney(num(current.amount) ?? 0) ||
      roundMoney(header.withheld_amount) !== roundMoney(num(current.withheld_amount) ?? 0) ||
      (header.purpose ?? "") !== (current.purpose ?? "").trim()
    const nonInstallmentConfirmed =
      payeeChanged || allocationsChanged || amountOrPurposeChanged
        ? await assertZeroAllocVendorConfirmed(tenantId, header, allocations, patch.confirmNonInstallment)
        : false
    if (patch.allocations !== undefined) {
      // M5：改了分攤才重查驗收（只改備註的 PATCH 不該被未驗收期款擋下來）。
      await assertPaymentsAccepted(
        tenantId,
        actor,
        allocations.map((a) => a.payment?.id).filter((v): v is string => !!v),
        { force: patch.forceAcceptance === true, reason: patch.forceReason, context: "PATCH /disbursements/:id" },
      )
    }
    // 先「佔住」這張草稿：條件寫入 updated_at＋編輯人（仍是 draft、沒被別人改過才成立，否則 409），
    // 之後分攤與單頭才寫——送簽／別人的修改搶在中間時不會改到已送簽的單（M2）。
    if (nonInstallmentConfirmed) await auditNonInstallmentConfirm(tenantId, actor, id, header, "PATCH /disbursements/:id")
    if (payeeSimilar) await auditPayeeSimilarConfirm(tenantId, actor, id, header.payee_name, payeeSimilar, confirmDistinctReason, "PATCH /disbursements/:id")
    const claimedAt = await guardedUpdate({ updated_at: nowIso, ...editorsPatch() }, "draft claim", current.updated_at ?? null)
    // 分攤先寫：唯一預期中的失敗（409 allocation_not_removable）發生在還沒動到單頭之前。
    if (patch.allocations !== undefined) await replaceAllocations(tenantId, id, allocations)
    await guardedUpdate({ ...(await headerRow(header)), updated_at: nowIso }, "draft", claimedAt)
  }

  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: patch,
    actorEmpId: actor.empId,
    context: "PATCH /disbursements/:id",
  })
  return getDisbursement(tenantId, id)
}

function allocationRefKey(subcontractId: string | null | undefined, paymentId: string | null | undefined): string {
  return `${(subcontractId ?? "").toLowerCase()}|${(paymentId ?? "").toLowerCase()}`
}

function normalize(v: unknown): string {
  if (v === undefined || v === null || v === "") return ""
  if (typeof v === "number") return String(roundMoney(v))
  if (typeof v === "string") return v.trim()
  return JSON.stringify(v)
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

async function allocationsUnchanged(tenantId: string, id: string, next: AllocationInput[]): Promise<boolean> {
  const existing = await loadAllocations(tenantId, [id])
  if (existing.length !== next.length) return false
  const key = (a: { projectId: string; subcontractPaymentId?: string | null; amount: number; withheldAmount?: number | null }) =>
    `${a.projectId}|${a.subcontractPaymentId ?? ""}|${roundMoney(a.amount)}|${roundMoney(a.withheldAmount ?? 0)}`
  const a = existing
    .map((e) => key({ projectId: e.project_id, subcontractPaymentId: e.subcontract_payment_id, amount: num(e.amount) ?? 0, withheldAmount: num(e.withheld_amount) ?? 0 }))
    .sort()
  const b = next.map(key).sort()
  return a.every((x, i) => x === b[i])
}

/**
 * approved → paid：連動期款、通知 lead。`paidOn` 省略時用單上既有的匯款日。
 * M4：`draft` 直接付款＝HR 專屬例外（`forceReason` 必填、寫稽核），其餘角色
 * 409 `approval_required`；`pending_approval` 一律 409（要嘛簽完、要嘛先撤回）。
 */
export async function payDisbursement(
  tenantId: string,
  actor: Actor,
  id: string,
  input: { paidOn?: string | null; forceReason?: string | null; forceAcceptance?: boolean },
): Promise<SerializedDisbursement | null> {
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status === "void") throw new DisbursementError(409, "void")
  if (current.status === "paid") throw new DisbursementError(409, "already_paid")
  if (current.status === "pending_approval") {
    throw new DisbursementError(409, "approval_required", { hint: "簽核尚未完成；要直接付款請先撤回簽核。" })
  }
  const forcedPayReason = current.status === "approved" ? null : assertForcePayAllowed(actor, input.forceReason)
  const paidOn = input.paidOn ?? current.paid_on
  if (!paidOn) throw new DisbursementError(400, "paid_on_required")

  const allocations = await loadAllocations(tenantId, [id])
  // R1b：付款前重驗分攤副委託的廠商仍是收款廠商（開單後副委託換廠商 → 409）。
  await assertAllocationVendorsStillMatch(tenantId, current, allocations)
  // N-1：付款前重驗收款帳戶快照仍等於名冊現值。
  await assertPayeeBankStillMatchesVendor(tenantId, current)
  // F4（第六輪）：「其他」收款單付款前（含批次付款）重驗戶名不是名冊廠商。
  await assertOtherPayeeStillNotRegisteredVendor(tenantId, current)
  // M2（第七輪）：登錄廠商零分攤單付款前（含批次付款）重驗「廠商有未付期款 → 須已確認非期款支出」。
  await assertZeroAllocVendorStillConfirmed(tenantId, current, allocations)
  // M5：付款前再確認一次期款都已驗收（建單之後才被取消驗收的情況）。
  await assertPaymentsAccepted(
    tenantId,
    actor,
    allocations.map((a) => a.subcontract_payment_id).filter((v): v is string => !!v),
    { force: input.forceAcceptance === true, reason: input.forceReason, context: "POST /disbursements/:id/pay" },
  )
  // 2026-10-27 驗收 B：先用條件更新（狀態仍是讀到的那個）搶下這張單，搶到了才寫期款。
  // 兩個請求同時付同一張單（例如批次放款逾時重按、兩個不同匯款日）或同時被作廢／撤回時，
  // 搶輸的那個更新不到任何列 → 409，期款完全不動；不會出現「期款已付卻掛在未付單上」。
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "paid", paid_on: paidOn, paid_by_emp_id: actor.empId, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", current.status)
    .select(await disbursementCols())
    .maybeSingle()
  if (error) throw new Error(`payDisbursement: ${error.message}`)
  if (!data) {
    const latest = await loadDisbursement(tenantId, id)
    if (latest?.status === "void") throw new DisbursementError(409, "void")
    if (latest && latest.status !== "paid") throw new DisbursementError(409, "status_changed", { status: latest.status })
    throw new DisbursementError(409, "already_paid")
  }
  try {
    await syncPaymentsOnPay(
      tenantId,
      {
        id,
        disbursement_no: current.disbursement_no,
        paid_on: paidOn,
        paying_company_id: current.paying_company_id,
        receipt_issuer_company_id: current.receipt_issuer_company_id,
        receipt_ref: current.receipt_ref,
      },
      allocations.map((a) => ({
        subcontract_payment_id: a.subcontract_payment_id,
        amount: num(a.amount) ?? 0,
        withheld_amount: num(a.withheld_amount) ?? 0,
      })),
    )
  } catch (syncErr) {
    if (syncErr instanceof PaymentRestoreError) {
      // 期款還原也失敗：部分期款已付，單頭維持 paid（不退回），交人工確認。
      logger.error({ disbursementId: id, err: syncErr.message }, "payDisbursement: payment restore failed (manual check)")
      throw manualCheckError(current.disbursement_no, `單號 ${current.disbursement_no} 期款同步失敗且部分期款無法還原，放款單維持已放款，需人工確認期款`)
    }
    // 期款寫入失敗（syncPaymentsOnPay 已把寫到一半的期款還原）：把單子的狀態條件式退回原狀，再把原因拋出去。
    const paidBy = supabaseAdmin
      .from("disbursements")
      .update({ status: current.status, paid_on: current.paid_on, paid_by_emp_id: current.paid_by_emp_id ?? null, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "paid")
    const { data: reverted, error: revertErr } = await (actor.empId ? paidBy.eq("paid_by_emp_id", actor.empId) : paidBy.is("paid_by_emp_id", null))
      .select("id")
      .maybeSingle()
    if (revertErr || !reverted) {
      const msg = syncErr instanceof Error ? syncErr.message : String(syncErr)
      logger.error({ disbursementId: id, err: msg, revertErr: revertErr?.message }, "payDisbursement: status revert failed (manual check)")
      throw manualCheckError(current.disbursement_no, `單號 ${current.disbursement_no} 期款同步失敗，且放款單狀態無法退回，需人工確認`)
    }
    throw syncErr
  }
  // 2026-10-27 驗收：期款寫完再確認單頭仍是本次付款（作廢可能在搶狀態與寫期款之間插入）；不是就還原期款並 409。
  {
    const latest = await loadDisbursement(tenantId, id)
    if (!latest || latest.status !== "paid") {
      try {
        await unsyncPaymentsOnVoid(tenantId, { id, disbursement_no: current.disbursement_no }, "付款期間單據已變更，期款還原")
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ disbursementId: id, err: msg }, "payDisbursement: unsync after concurrent void failed (manual check)")
        throw manualCheckError(current.disbursement_no, `單號 ${current.disbursement_no} 付款期間被作廢，且期款無法還原，需人工確認期款`)
      }
      if (latest?.status === "void") throw new DisbursementError(409, "void")
      throw new DisbursementError(409, "status_changed", { status: latest?.status ?? null })
    }
  }
  const row = data as unknown as DisbursementRow
  await notifyProjectLeads(tenantId, row, allocations)
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { ...row, ...(forcedPayReason ? { forcedPaid: true, forceReason: forcedPayReason } : {}) },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/pay",
  })
  // #3：放款付款＝專案成本增加 → 未發放的獎金批次重算（best-effort，失敗只 log）。
  await recomputeBonusRunsBestEffort(tenantId, allocations.map((a) => a.project_id), "POST /disbursements/:id/pay")
  return getDisbursement(tenantId, id)
}

/** paid／draft → void：反向清期款（草稿本來就沒連動，但仍防禦性地清一次）。 */
export async function voidDisbursement(
  tenantId: string,
  actor: Actor,
  id: string,
  reason: string,
): Promise<SerializedDisbursement | null> {
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status === "void") throw new DisbursementError(409, "void")
  const wasPaid = current.status === "paid"
  // 只給事後的獎金重算用：讀不到不能擋作廢。
  const voidedAllocations = wasPaid ? await loadAllocations(tenantId, [id]).catch(() => []) : []
  // 2026-10-27 驗收：先條件式搶下單頭狀態（與付款同一把鎖），搶到才清期款——避免付款在「清完期款、改單頭」之間寫入，
  // 留下「期款已付卻掛在作廢單上」。
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "void", void_reason: reason, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", current.status)
    .select(await disbursementCols())
    .maybeSingle()
  if (error) throw new Error(`voidDisbursement: ${error.message}`)
  if (!data) {
    const latest = await loadDisbursement(tenantId, id)
    if (latest?.status === "void") throw new DisbursementError(409, "void")
    throw new DisbursementError(409, "status_changed", { status: latest?.status ?? null })
  }
  let cleared: Awaited<ReturnType<typeof unsyncPaymentsOnVoid>>
  try {
    cleared = await unsyncPaymentsOnVoid(tenantId, { id, disbursement_no: current.disbursement_no }, reason)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`voidDisbursement: 放款單已作廢但期款清除失敗（單號 ${current.disbursement_no}，需人工確認）：${msg}`)
  }
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { ...(data as unknown as Record<string, unknown>), clearedPaymentIds: cleared },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/void",
  })
  // #3：作廢已付放款＝專案成本減少 → 重算未發放批次（草稿作廢不影響成本，不重算）。
  if (wasPaid) await recomputeBonusRunsBestEffort(tenantId, voidedAllocations.map((a) => a.project_id), "POST /disbursements/:id/void")
  return getDisbursement(tenantId, id)
}

/* ──────────────────────────────────────────────────────────────────
 * 附件（bucket disbursement-vouchers；≤5 檔、≤5MB）
 * ────────────────────────────────────────────────────────────────── */

export async function addAttachment(
  tenantId: string,
  actor: Actor,
  disbursement: DisbursementRow,
  file: { fileName: string; contentType: string; bytes: Buffer },
): Promise<{ id: string; sizeBytes: number }> {
  if (disbursement.status === "void") throw new DisbursementError(409, "void")
  if (file.bytes.length === 0 || file.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new DisbursementError(413, "file_too_large", { maxBytes: MAX_ATTACHMENT_BYTES })
  }
  const { count, error: cntErr } = await supabaseAdmin
    .from("disbursement_attachments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("disbursement_id", disbursement.id)
  if (cntErr) throw new Error(`addAttachment (count): ${cntErr.message}`)
  if ((count ?? 0) >= MAX_ATTACHMENTS) throw new DisbursementError(409, "max_files_reached", { max: MAX_ATTACHMENTS })

  const ext = (file.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
  const path = `${tenantId}/${disbursement.id}/${crypto.randomUUID()}${ext}`
  const { error: upErr } = await supabaseAdmin.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, file.bytes, { contentType: file.contentType })
  if (upErr) throw new Error(`addAttachment (upload): ${upErr.message}`)

  const { data: row, error: insErr } = await supabaseAdmin
    .from("disbursement_attachments")
    .insert({
      tenant_id: tenantId,
      disbursement_id: disbursement.id,
      file_name: file.fileName,
      storage_path: path,
      size_bytes: file.bytes.length,
      content_type: file.contentType,
      uploaded_by_emp_id: actor.empId,
    })
    .select("id")
    .single()
  if (insErr || !row) {
    await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).remove([path])
    throw new Error(`addAttachment (insert): ${insErr?.message}`)
  }
  await writeAuditLog({
    tenantId,
    tableName: "disbursement_attachments",
    recordId: row.id as string,
    action: "INSERT",
    newRow: { disbursementId: disbursement.id, fileName: file.fileName, sizeBytes: file.bytes.length },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/attachments",
  })
  return { id: row.id as string, sizeBytes: file.bytes.length }
}

export async function removeAttachment(
  tenantId: string,
  actor: Actor,
  disbursement: DisbursementRow,
  attachmentId: string,
): Promise<boolean> {
  if (disbursement.status === "void") throw new DisbursementError(409, "void")
  const { data: doc, error } = await supabaseAdmin
    .from("disbursement_attachments")
    .select(ATTACHMENT_COLS)
    .eq("tenant_id", tenantId)
    .eq("disbursement_id", disbursement.id)
    .eq("id", attachmentId)
    .maybeSingle()
  if (error) throw new Error(`removeAttachment (load): ${error.message}`)
  if (!doc) return false
  const row = doc as unknown as AttachmentRow
  await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).remove([row.storage_path])
  const { error: delErr } = await supabaseAdmin
    .from("disbursement_attachments")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("id", attachmentId)
  if (delErr) throw new Error(`removeAttachment: ${delErr.message}`)
  await writeAuditLog({
    tenantId,
    tableName: "disbursement_attachments",
    recordId: attachmentId,
    action: "DELETE",
    oldRow: row,
    actorEmpId: actor.empId,
    context: "DELETE /disbursements/:id/attachments/:aid",
  })
  return true
}
