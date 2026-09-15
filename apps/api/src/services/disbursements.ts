import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { addDaysKey, todayKey } from "../lib/tz.js"
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
import { writeAuditLog } from "./audit.js"

/**
 * 放款專區——匯款紀錄（disbursements）× 分攤（disbursement_allocations）×
 * 專案期款（project_subcontract_payments）的連動。放款的**單一真相**在這裡：
 * 專案頁期款的「已付」由匯款紀錄連動產生（舊的整批 PUT 保留相容，見
 * routes/subcontracts.ts）。
 *
 * ── 狀態機 ────────────────────────────────────────────────────────
 *   draft ──pay──▶ paid ──void──▶ void
 *     └────────────void───────────▶ void
 *   • draft：不動期款；全部欄位可改（allocations 整批覆蓋）。
 *   • paid：連動期款（`syncPaymentsOnPay`）；只可改 note／receiptRef／purpose／
 *     hasInvoice／invoiceNo（已匯款後補發票號是常態）。
 *   • void：反向清期款（`unsyncPaymentsOnVoid`）；之後不能再改。
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

export const DISBURSEMENT_STATUSES = ["draft", "paid", "void"] as const
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

type CompanyLite = { id: string; name: string; bank_name: string | null; bank_account: string | null }
const COMPANY_LITE_COLS = "id, name, bank_name, bank_account"

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
  if (allocations.length === 0 && payeeKind === "other") {
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
  allocations: SerializedAllocation[]
  allocationLabel: string
  attachments?: SerializedAttachment[]
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
    .select(DISBURSEMENT_COLS)
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
  return rows.map((r) => serializeDisbursement(r, allocBy.get(r.id) ?? [], ctx, companies))
}

export async function getDisbursement(tenantId: string, id: string): Promise<SerializedDisbursement | null> {
  const row = await loadDisbursement(tenantId, id)
  if (!row) return null
  const [serialized, attachments] = await Promise.all([serializeMany(tenantId, [row]), loadAttachments(tenantId, id, true)])
  return { ...serialized[0], attachments }
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
 * 就消失），所以 `status.eq.draft` 一律放行日期條件。預設排除作廢，除非
 * 明確 `status=void`。`q` 找單號／收款方／收據編號／用途。
 */
export async function listDisbursements(
  tenantId: string,
  filters: ListFilters,
): Promise<{ from: string; to: string; disbursements: SerializedDisbursement[] }> {
  const today = await tenantToday(tenantId)
  const { from, to } = defaultRange(today, filters.from, filters.to)

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
    .select(DISBURSEMENT_COLS)
    .eq("tenant_id", tenantId)
    .or(`and(paid_on.gte.${from},paid_on.lte.${to}),status.eq.draft`)
  if (filters.status) q = q.eq("status", filters.status)
  else q = q.neq("status", "void")
  if (filters.vendorId) q = q.eq("vendor_id", filters.vendorId)
  if (filters.companyId) q = q.eq("paying_company_id", filters.companyId)
  if (ids) q = q.in("id", ids.slice(0, 500))
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_,()]/g, "")}%`
    q = q.or(`disbursement_no.ilike.${like},payee_name.ilike.${like},receipt_ref.ilike.${like},purpose.ilike.${like}`)
  }
  const { data, error } = await q
    .order("paid_on", { ascending: false, nullsFirst: true })
    .order("disbursement_no", { ascending: false })
    .limit(1000)
  if (error) throw new Error(`listDisbursements: ${error.message}`)
  const rows = (data ?? []) as unknown as DisbursementRow[]
  return { from, to, disbursements: await serializeMany(tenantId, rows) }
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
  let pq = supabaseAdmin.from("projects").select(PROJECT_LITE_COLS).eq("tenant_id", tenantId)
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
      })
    }
  }
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
    .select(DISBURSEMENT_COLS)
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
}

async function resolveAllocations(tenantId: string, inputs: AllocationInput[]): Promise<ResolvedAllocation[]> {
  const shape = checkAllocationShape(inputs)
  if (!shape.ok) throw new DisbursementError(400, shape.code, { index: shape.index, subcontractPaymentId: shape.subcontractPaymentId })

  const projectIds = uniq(inputs.map((a) => a.projectId))
  const paymentIds = uniq(inputs.map((a) => a.subcontractPaymentId))
  const [projects, payments] = await Promise.all([
    batch<ProjectLite>("projects", PROJECT_LITE_COLS, tenantId, projectIds, "id", false),
    batch<PaymentRow>("project_subcontract_payments", PAYMENT_COLS, tenantId, paymentIds, "id", false),
  ])
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
    if (a.subcontractPaymentId) {
      payment = paymentById.get(a.subcontractPaymentId) ?? null
      const sub = payment ? subById.get(payment.subcontract_id) : undefined
      if (!payment || !sub || sub.project_id !== a.projectId || (subcontractId && subcontractId !== sub.id)) {
        throw new DisbursementError(400, "invalid_payment", { subcontractPaymentId: a.subcontractPaymentId })
      }
      subcontractId = sub.id
    } else if (subcontractId) {
      const sub = subById.get(subcontractId)
      if (!sub || sub.project_id !== a.projectId) {
        throw new DisbursementError(400, "invalid_subcontract", { subcontractId })
      }
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
    }
  })
}

type ResolvedHeader = {
  payee_kind: PayeeKind
  vendor_id: string | null
  payee_name: string
  payee_bank_name: string | null
  payee_bank_account: string | null
  payee_bank_code: string | null
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
 */
async function resolveHeader(tenantId: string, input: Omit<DisbursementInput, "status" | "allocations">): Promise<ResolvedHeader> {
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
  const payeeName = (input.payeeName ?? "").trim() || vendor?.name || ""
  if (!payeeName) throw new DisbursementError(400, "payee_name_required")

  const companyIds = uniq([input.payingCompanyId, input.receiptIssuerCompanyId])
  const companies = await loadCompanies(tenantId, companyIds)
  const paying = companies.get(input.payingCompanyId)
  if (!paying) throw new DisbursementError(400, "invalid_company", { companyId: input.payingCompanyId })
  if (input.receiptIssuerCompanyId && !companies.has(input.receiptIssuerCompanyId)) {
    throw new DisbursementError(400, "invalid_company", { companyId: input.receiptIssuerCompanyId })
  }
  const amount = roundMoney(input.amount)
  const withheld = roundMoney(input.withheldAmount ?? 0)
  if (amount < 0 || withheld < 0) throw new DisbursementError(400, "invalid_amount")

  return {
    payee_kind: input.payeeKind,
    vendor_id: vendor?.id ?? null,
    payee_name: payeeName,
    payee_bank_name: input.payeeBankName !== undefined ? (input.payeeBankName ?? null) : vendor ? vendorBankName(vendor) : null,
    payee_bank_account:
      input.payeeBankAccount !== undefined
        ? (input.payeeBankAccount ?? null)
        : vendor
          ? [vendor.bank_account, vendor.account_holder].filter(Boolean).join(" ") || null
          : null,
    payee_bank_code: input.payeeBankCode !== undefined ? (input.payeeBankCode ?? null) : vendor ? (vendor.bank_code ?? null) : null,
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

  const nowIso = new Date().toISOString()
  const touched: string[] = []
  for (const a of targets) {
    const { error } = await supabaseAdmin
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
    if (error) throw new Error(`syncPaymentsOnPay: ${error.message}`)
    touched.push(a.subcontract_payment_id!)
  }
  return touched
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

export type Actor = { empId: string | null }

/**
 * 建立匯款單。`status:'paid'` 立即連動期款（先驗證期款可付，再寫）。
 * 單號 `D-{年}-{NNN}`：unique index 撞號時重試（同 nextProjectCode 的併發策略）。
 */
export async function createDisbursement(tenantId: string, actor: Actor, input: DisbursementInput): Promise<SerializedDisbursement> {
  const header = await resolveHeader(tenantId, input)
  const allocations = await resolveAllocations(tenantId, input.allocations)
  assertTotals(header.payee_kind, header.amount, header.withheld_amount, allocations)
  if (input.status === "paid") {
    if (!header.paid_on) throw new DisbursementError(400, "paid_on_required")
    await assertPaymentsPayable(
      tenantId,
      null,
      allocations.map((a) => a.payment).filter((p): p is PaymentRow => !!p),
    )
  }

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
        ...header,
        paid_by_emp_id: input.status === "paid" ? actor.empId : null,
        created_by_emp_id: actor.empId,
      })
      .select(DISBURSEMENT_COLS)
      .single()
    if (error) {
      if (isUniqueViolation(error)) continue
      throw new Error(`createDisbursement: ${error.message}`)
    }
    row = data as unknown as DisbursementRow
  }
  if (!row) throw new DisbursementError(409, "code_conflict", { hint: "單號連續撞號，請重試。" })

  await insertAllocations(tenantId, row.id, allocations)
  if (input.status === "paid") {
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
    await notifyProjectLeads(tenantId, row, await loadAllocations(tenantId, [row.id]))
  }
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: row.id,
    action: "INSERT",
    newRow: { ...row, allocations: input.allocations },
    actorEmpId: actor.empId,
    context: "POST /disbursements",
  })
  return (await getDisbursement(tenantId, row.id))!
}

const PAID_EDITABLE = new Set<keyof DisbursementPatch>(["note", "receiptRef", "purpose", "hasInvoice", "invoiceNo"])

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
 * PATCH：draft 全部可改（allocations 整批覆蓋、快照重抓）；paid 只可改
 * note／receiptRef／purpose／hasInvoice／invoiceNo（已匯款後補發票號是常態）——
 * 其他欄位若出現且與現值不同 → 409 `paid`（UI 送整份表單但值沒動的情況放行）；
 * void → 409 `void`。
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
  const nowIso = new Date().toISOString()

  if (current.status === "paid") {
    const base = headerToInput(current)
    for (const key of Object.keys(patch) as Array<keyof DisbursementPatch>) {
      if (PAID_EDITABLE.has(key)) continue
      if (key === "allocations") {
        // 分攤已連動期款，paid 之後不再收；值一樣就放行（表單整份回送）。
        const same = await allocationsUnchanged(tenantId, id, patch.allocations ?? [])
        if (!same) throw new DisbursementError(409, "paid", { field: key })
        continue
      }
      const nextVal = (patch as Record<string, unknown>)[key]
      const curVal = (base as Record<string, unknown>)[key]
      if (nextVal !== undefined && normalize(nextVal) !== normalize(curVal)) {
        throw new DisbursementError(409, "paid", { field: key })
      }
    }
    const fields: Record<string, unknown> = { updated_at: nowIso }
    if (patch.note !== undefined) fields.note = patch.note?.trim() || null
    if (patch.receiptRef !== undefined) fields.receipt_ref = patch.receiptRef?.trim() || null
    if (patch.purpose !== undefined) fields.purpose = patch.purpose?.trim() || null
    if (patch.hasInvoice !== undefined) fields.has_invoice = patch.hasInvoice
    if (patch.invoiceNo !== undefined) fields.invoice_no = patch.invoiceNo?.trim() || null
    const { error } = await supabaseAdmin.from("disbursements").update(fields).eq("tenant_id", tenantId).eq("id", id)
    if (error) throw new Error(`updateDisbursement (paid): ${error.message}`)
    if (fields.receipt_ref !== undefined && fields.receipt_ref !== current.receipt_ref) {
      // 收據編號是連動寫進期款的，改了要跟著走。
      const { error: pErr } = await supabaseAdmin
        .from("project_subcontract_payments")
        .update({ receipt_ref: fields.receipt_ref, updated_at: nowIso })
        .eq("tenant_id", tenantId)
        .eq("disbursement_id", id)
      if (pErr) throw new Error(`updateDisbursement (receipt_ref → payments): ${pErr.message}`)
    }
  } else {
    const merged: Omit<DisbursementInput, "status" | "allocations"> & { allocations?: AllocationInput[] } = {
      ...headerToInput(current),
      ...stripUndefined(patch),
    }
    // 換了廠商而沒另外給名稱／帳戶 → 快照重新從新廠商複製，不然會留著舊廠商的名字。
    if (patch.vendorId !== undefined && patch.vendorId !== current.vendor_id) {
      if (patch.payeeName === undefined) merged.payeeName = null
      if (patch.payeeBankName === undefined) delete merged.payeeBankName
      if (patch.payeeBankAccount === undefined) delete merged.payeeBankAccount
      if (patch.payeeBankCode === undefined) delete merged.payeeBankCode
    }
    const header = await resolveHeader(tenantId, merged)
    const allocInputs: AllocationInput[] =
      patch.allocations !== undefined
        ? patch.allocations
        : (await loadAllocations(tenantId, [id])).map((a) => ({
            projectId: a.project_id,
            subcontractId: a.subcontract_id,
            subcontractPaymentId: a.subcontract_payment_id,
            amount: num(a.amount) ?? 0,
            withheldAmount: num(a.withheld_amount) ?? 0,
            note: a.note,
          }))
    const allocations = await resolveAllocations(tenantId, allocInputs)
    assertTotals(header.payee_kind, header.amount, header.withheld_amount, allocations)
    // 分攤先寫：唯一預期中的失敗（409 allocation_not_removable）發生在還沒動到單頭之前。
    if (patch.allocations !== undefined) await replaceAllocations(tenantId, id, allocations)
    const { error } = await supabaseAdmin
      .from("disbursements")
      .update({ ...header, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      .eq("id", id)
    if (error) throw new Error(`updateDisbursement (draft): ${error.message}`)
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

/** draft → paid：連動期款、通知 lead。`paidOn` 省略時用單上既有的匯款日。 */
export async function payDisbursement(
  tenantId: string,
  actor: Actor,
  id: string,
  input: { paidOn?: string | null },
): Promise<SerializedDisbursement | null> {
  const current = await loadDisbursement(tenantId, id)
  if (!current) return null
  if (current.status === "void") throw new DisbursementError(409, "void")
  if (current.status === "paid") throw new DisbursementError(409, "already_paid")
  const paidOn = input.paidOn ?? current.paid_on
  if (!paidOn) throw new DisbursementError(400, "paid_on_required")

  const allocations = await loadAllocations(tenantId, [id])
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
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "paid", paid_on: paidOn, paid_by_emp_id: actor.empId, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select(DISBURSEMENT_COLS)
    .single()
  if (error || !data) throw new Error(`payDisbursement: ${error?.message}`)
  const row = data as unknown as DisbursementRow
  await notifyProjectLeads(tenantId, row, allocations)
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: row,
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/pay",
  })
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
  const cleared = await unsyncPaymentsOnVoid(tenantId, { id, disbursement_no: current.disbursement_no }, reason)
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .update({ status: "void", void_reason: reason, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select(DISBURSEMENT_COLS)
    .single()
  if (error || !data) throw new Error(`voidDisbursement: ${error?.message}`)
  await writeAuditLog({
    tenantId,
    tableName: "disbursements",
    recordId: id,
    action: "UPDATE",
    oldRow: current,
    newRow: { ...(data as Record<string, unknown>), clearedPaymentIds: cleared },
    actorEmpId: actor.empId,
    context: "POST /disbursements/:id/void",
  })
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
