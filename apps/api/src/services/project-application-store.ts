import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { localDateKey, DEFAULT_TIMEZONE } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { BILLING_COLS, num, type BillingRow } from "./billing-store.js"
import {
  computeMoney,
  computeSubcontractPayments,
  compareReceivables,
  effectiveBillingAmount,
  overdueDays,
  pct1,
  resolveAmountUntaxed,
  rocDate,
  rocMonthKey,
  summarizeContracts,
  DEFAULT_VAT_RATE,
  DEFAULT_WITHHOLDING_RATE,
  DEFAULT_WITHHOLDING_THRESHOLD,
  type ContractLite,
  type ProjectMoney,
} from "./project-money.js"
import { toCodeFormat, type CodeFormat } from "./project-code.js"

/**
 * P3 專案申請單的 DB 存取（IO）。算術全在 project-money.ts（純函式）。
 *
 * 四個投影——`GET /projects/:id`、`/application`、年度總表、未收款清單——
 * 都從這裡拿資料，money 的算法只有一份。年度總表與未收款是**批次**查詢
 * （一次撈整年的合約／期程／下包再在記憶體裡分組），不逐案打 DB。
 */

// ⚠️ 單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別。
export const SUBCONTRACT_COLS =
  "id, project_id, kind, discipline, vendor_id, vendor_name, contact, item, amount, billing_basis, order_type, contract_id, withholding_rate, withholding_threshold, sort_order, note, created_at, updated_at, deleted_at, vendors(name)"

export const PAYMENT_COLS =
  "id, subcontract_id, installment_no, percentage, amount, override_amount, override_reason, due_when, paid_on, paid_amount, withheld_amount, paying_company_id, receipt_issuer_company_id, receipt_ref, disbursement_id, note, created_at, updated_at"

/** 正式庫尚未套 0041（`disbursement_id` 欄不存在）時的退路；套完就不會再走到。 */
export const PAYMENT_COLS_LEGACY =
  "id, subcontract_id, installment_no, percentage, amount, override_amount, override_reason, due_when, paid_on, paid_amount, withheld_amount, paying_company_id, receipt_issuer_company_id, receipt_ref, note, created_at, updated_at"

export const CONTRACT_LITE_COLS =
  "id, project_id, doc_type, our_role, title, amount, signed_on, created_at, deleted_at"

export type SubcontractRow = {
  id: string
  project_id: string
  kind: string
  discipline: string | null
  vendor_id: string | null
  vendor_name: string | null
  contact: string | null
  item: string | null
  amount: string | number
  billing_basis: string | null
  order_type: string | null
  contract_id: string | null
  withholding_rate: string | number
  withholding_threshold: number
  sort_order: number
  note: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  vendors?: { name: string } | { name: string }[] | null
}

export type PaymentRow = {
  id: string
  subcontract_id: string
  installment_no: number
  percentage: string | null
  amount: string | number
  override_amount: string | null
  override_reason: string | null
  due_when: string | null
  paid_on: string | null
  paid_amount: string | null
  withheld_amount: string | number
  paying_company_id: string | null
  receipt_issuer_company_id: string | null
  receipt_ref: string | null
  /** 放款專區連動寫入的匯款單；null＝未經放款專區（含舊路徑手動標記已付）。未套 0041 時欄位不存在。 */
  disbursement_id?: string | null
  /** 由 loadPayments 以 disbursement_id 批次補上的單號（非 DB 欄位）。 */
  disbursement_no?: string | null
  note: string | null
  created_at: string
  updated_at: string
}

export type ClientRow = {
  id: string
  name: string
  tax_id: string | null
  phone: string | null
  fax: string | null
  invoice_address: string | null
  contact_name: string | null
  contact_phone: string | null
  email: string | null
  invoice_type: string | null
  payment_method: string | null
  closing_day: string | null
  payment_day: string | null
  note: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export const CLIENT_COLS =
  "id, name, tax_id, phone, fax, invoice_address, contact_name, contact_phone, email, invoice_type, payment_method, closing_day, payment_day, note, created_by_emp_id, created_at, updated_at, deleted_at"

function rel1<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] as T) ?? null
  return (v as T) ?? null
}

/* ──────────────────────────────────────────────────────────────────
 * 租戶參數
 * ────────────────────────────────────────────────────────────────── */

export type P3Settings = {
  vatRate: number
  disciplines: string[]
  codeFormat: CodeFormat
}

export async function loadP3Settings(tenantId: string): Promise<P3Settings> {
  const { data, error } = await supabaseAdmin
    .from("project_settings")
    .select("vat_rate, disciplines, code_prefix, code_year_style, code_seq_digits")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`loadP3Settings: ${error.message}`)
  const vat = data ? num(data.vat_rate as string | null) : null
  const disciplines = Array.isArray(data?.disciplines)
    ? (data!.disciplines as unknown[]).filter((d): d is string => typeof d === "string")
    : ["電機", "空調", "消防", "汙水"]
  return {
    vatRate: vat ?? DEFAULT_VAT_RATE,
    disciplines,
    codeFormat: toCodeFormat(data as Parameters<typeof toCodeFormat>[0]),
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 序列化
 * ────────────────────────────────────────────────────────────────── */

export function serializeClient(r: ClientRow) {
  return {
    id: r.id,
    name: r.name,
    taxId: r.tax_id,
    phone: r.phone,
    fax: r.fax,
    invoiceAddress: r.invoice_address,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    email: r.email,
    invoiceType: r.invoice_type,
    paymentMethod: r.payment_method,
    closingDay: r.closing_day,
    paymentDay: r.payment_day,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function serializeBilling(row: BillingRow) {
  return {
    id: row.id,
    installmentNo: row.installment_no,
    kind: row.kind ?? "installment",
    percentage: num(row.percentage),
    milestone: row.milestone,
    plannedOn: row.planned_on,
    calculatedAmount: num(row.calculated_amount),
    residueApplied: num(row.residue_applied) ?? 0,
    overrideAmount: num(row.override_amount),
    overrideReason: row.override_reason,
    billedOn: row.billed_on,
    billedAmount: num(row.billed_amount),
    invoiceNo: row.invoice_no ?? null,
    invoicedOn: row.invoiced_on ?? null,
    receivedOn: row.received_on ?? null,
    receivedAmount: num(row.received_amount),
    note: row.note,
    /** 有效金額 = 已請款 ?? 人工覆寫 ?? 試算。UI 顯示這個。 */
    effectiveAmount: effectiveBillingAmount(row),
  }
}

export function serializePayment(row: PaymentRow, computed?: {
  calculatedAmount: number | null
  residueApplied: number
  effectiveAmount: number | null
  withheldAmount: number
  netAmount: number | null
}) {
  const effective = computed?.effectiveAmount ?? (num(row.override_amount) ?? num(row.amount))
  const withheld = computed?.withheldAmount ?? (num(row.withheld_amount) ?? 0)
  return {
    id: row.id,
    installmentNo: row.installment_no,
    percentage: num(row.percentage),
    amount: num(row.amount) ?? 0,
    residueApplied: computed?.residueApplied ?? 0,
    overrideAmount: num(row.override_amount),
    overrideReason: row.override_reason,
    effectiveAmount: effective,
    withheldAmount: withheld,
    /** 實付 = 有效毛額 − 代扣。 */
    netAmount: effective === null ? null : effective - withheld,
    dueWhen: row.due_when,
    paidOn: row.paid_on,
    paidAmount: num(row.paid_amount),
    payingCompanyId: row.paying_company_id,
    receiptIssuerCompanyId: row.receipt_issuer_company_id,
    receiptRef: row.receipt_ref,
    /** 放款專區連動的匯款單；兩者皆 null 而 paidOn 有值＝舊路徑「手動標記」。 */
    disbursementId: row.disbursement_id ?? null,
    disbursementNo: row.disbursement_no ?? null,
    note: row.note,
  }
}

export function serializeSubcontract(row: SubcontractRow, payments: PaymentRow[]) {
  const vendor = rel1<{ name: string }>(row.vendors)
  const amount = num(row.amount) ?? 0
  const rate = num(row.withholding_rate) ?? DEFAULT_WITHHOLDING_RATE
  const threshold = Number(row.withholding_threshold ?? DEFAULT_WITHHOLDING_THRESHOLD)
  const sorted = [...payments].sort((a, b) => a.installment_no - b.installment_no)
  const computed = computeSubcontractPayments(
    sorted.map((p) => ({
      installmentNo: p.installment_no,
      percentage: num(p.percentage),
      overrideAmount: num(p.override_amount),
      paid: p.paid_on !== null,
      paidGrossAmount: num(p.override_amount) ?? num(p.amount),
    })),
    amount,
    rate,
    threshold,
  )
  const byNo = new Map(computed.rows.map((r) => [r.installmentNo, r]))
  let paidTotal = 0
  let withheldPaid = 0
  for (const p of sorted) {
    if (p.paid_on) {
      paidTotal += num(p.paid_amount) ?? 0
      withheldPaid += num(p.withheld_amount) ?? 0
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    discipline: row.discipline,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name ?? vendor?.name ?? null,
    contact: row.contact,
    item: row.item,
    amount,
    billingBasis: row.billing_basis,
    orderType: row.order_type,
    contractId: row.contract_id,
    withholdingRate: rate,
    withholdingThreshold: threshold,
    sortOrder: row.sort_order,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payments: sorted.map((p) => serializePayment(p, byNo.get(p.installment_no))),
    summary: {
      percentageTotal: sorted.reduce((s, p) => s + (num(p.percentage) ?? 0), 0),
      effectiveTotal: computed.effectiveTotal,
      withheldTotal: computed.withheldTotal,
      unallocatedResidue: computed.unallocatedResidue,
      /** 已付實付合計（paid_amount）與其代扣。 */
      paidTotal,
      withheldPaidTotal: withheldPaid,
    },
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 單一專案的載入
 * ────────────────────────────────────────────────────────────────── */

export async function loadSubcontracts(tenantId: string, projectId: string): Promise<SubcontractRow[]> {
  const { data, error } = await supabaseAdmin
    .from("project_subcontracts")
    .select(SUBCONTRACT_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (error) throw new Error(`loadSubcontracts: ${error.message}`)
  return (data ?? []) as unknown as SubcontractRow[]
}

/** 一旦探到 `disbursement_id` 欄不存在（未套 0041）就記住，之後直接走退路，不每次多打一次。 */
let paymentDisbursementColMissing = false

export async function loadPayments(tenantId: string, subcontractIds: string[]): Promise<PaymentRow[]> {
  if (subcontractIds.length === 0) return []
  const select = (cols: string) =>
    supabaseAdmin
      .from("project_subcontract_payments")
      .select(cols)
      .eq("tenant_id", tenantId)
      .in("subcontract_id", subcontractIds)
      .order("installment_no", { ascending: true })
  let { data, error } = await select(paymentDisbursementColMissing ? PAYMENT_COLS_LEGACY : PAYMENT_COLS)
  if (error && !paymentDisbursementColMissing && isMissingColumnError(error)) {
    // 正式庫還沒套 0041：退回舊欄位集，行為與放款專區上線前一致。
    paymentDisbursementColMissing = true
    warnSchemaGapOnce("project_subcontract_payments.disbursement_id", error)
    ;({ data, error } = await select(PAYMENT_COLS_LEGACY))
  }
  if (error) throw new Error(`loadPayments: ${error.message}`)
  const rows = (data ?? []) as unknown as PaymentRow[]
  await attachDisbursementNos(tenantId, rows)
  return rows
}

/** 有 disbursement_id 的期款列補上單號（專案頁顯示「D-115-001」而不是 uuid）。 */
export async function attachDisbursementNos(tenantId: string, rows: PaymentRow[]): Promise<void> {
  const ids = uniq(rows.map((r) => r.disbursement_id))
  if (ids.length === 0) return
  const found = await batch<{ id: string; disbursement_no: string }>(
    "disbursements",
    "id, disbursement_no",
    tenantId,
    ids,
    "id",
    false,
  )
  const noById = new Map(found.map((d) => [d.id, d.disbursement_no]))
  for (const r of rows) {
    r.disbursement_no = r.disbursement_id ? (noById.get(r.disbursement_id) ?? null) : null
  }
}

export async function loadContractsLite(tenantId: string, projectId: string): Promise<ContractLite[]> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select(CONTRACT_LITE_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
  if (error) throw new Error(`loadContractsLite: ${error.message}`)
  return (data ?? []) as ContractLite[]
}

export async function loadBillingRows(tenantId: string, projectId: string): Promise<BillingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("project_billings")
    .select(BILLING_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("installment_no", { ascending: true })
  if (error) throw new Error(`loadBillingRows: ${error.message}`)
  return (data ?? []) as BillingRow[]
}

export async function loadClient(tenantId: string, clientId: string | null): Promise<ClientRow | null> {
  if (!clientId) return null
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select(CLIENT_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", clientId)
    .maybeSingle()
  if (error) throw new Error(`loadClient: ${error.message}`)
  return (data as ClientRow | null) ?? null
}

/** 把 billing 列轉成 money 的輸入（有效金額＋三個事件）。 */
export function toMoneyBilling(row: BillingRow) {
  return {
    kind: row.kind ?? "installment",
    effectiveAmount: effectiveBillingAmount(row),
    billedOn: row.billed_on,
    billedAmount: num(row.billed_amount),
    invoicedOn: row.invoiced_on ?? null,
    receivedOn: row.received_on ?? null,
    receivedAmount: num(row.received_amount),
  }
}

export type ProjectFinanceBundle = {
  money: ProjectMoney
  contracts: ContractLite[]
  latestDocument: { id: string | null; docType: string; title: string | null; amount: number | null; signedOn: string | null } | null
  billings: BillingRow[]
  subcontracts: SubcontractRow[]
  payments: PaymentRow[]
}

/**
 * 一個專案的完整財務資料：分母（合約→報價單）、稅、期程、下包、損益。
 * finance 權限才呼叫；basic 使用者不該連算都算（算了再遮，等於多做一次查詢）。
 */
export async function loadProjectFinance(
  tenantId: string,
  projectId: string,
  otherExpenses: number,
  settings: P3Settings,
): Promise<ProjectFinanceBundle> {
  const [contracts, billings, subcontracts] = await Promise.all([
    loadContractsLite(tenantId, projectId),
    loadBillingRows(tenantId, projectId),
    loadSubcontracts(tenantId, projectId),
  ])
  const payments = await loadPayments(tenantId, subcontracts.map((s) => s.id))
  const summary = summarizeContracts(contracts)
  const { amountUntaxed, amountSource } = resolveAmountUntaxed(summary.total, summary.latestQuotation)
  const money = computeMoney({
    amountUntaxed,
    amountSource,
    vatRate: settings.vatRate,
    billings: billings.map(toMoneyBilling),
    subcontracts: subcontracts.map((s) => ({ kind: s.kind, amount: num(s.amount) ?? 0 })),
    otherExpenses,
  })
  const latest = summary.latest
  return {
    money,
    contracts,
    latestDocument: latest
      ? {
          id: latest.id ?? null,
          docType: latest.doc_type,
          title: latest.title ?? null,
          amount: num(latest.amount as string | null),
          signedOn: latest.signed_on,
        }
      : null,
    billings,
    subcontracts,
    payments,
  }
}

export function serializeContractLite(c: ContractLite) {
  return {
    id: c.id ?? null,
    docType: c.doc_type,
    ourRole: c.our_role,
    title: c.title ?? null,
    amount: num(c.amount as string | null),
    signedOn: c.signed_on,
    createdAt: c.created_at,
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 年度總表（批次）
 * ────────────────────────────────────────────────────────────────── */

export type AnnualProjectRow = {
  id: string
  name: string
  code: string | null
  fiscal_year: number | null
  status: string
  kind: string
  reserved_at: string | null
  archived_at: string | null
  client_id: string | null
  lead_emp_id: string | null
  other_expenses: string | number | null
  created_at: string
}

export type AnnualRow = {
  seq: number
  projectId: string
  code: string | null
  /** 建立日（台北），民國寫法 'yyy.m.d'。 */
  dateRoc: string | null
  createdOn: string
  clientName: string | null
  name: string
  kind: string
  reserved: boolean
  amountUntaxed: number | null
  amountSource: "contract" | "quotation" | null
  taxAmount: number | null
  amountTotal: number | null
  leadName: string | null
  note: string
  subcontractByDiscipline: Record<string, number>
  subcontractTotal: number
  technicianTotal: number
  billedTotal: number
  receivedTotal: number
  billingProgressPct: number | null
  receiptProgressPct: number | null
  unreceived: number | null
  /** 未收比例（未收 ÷ 分母），排序用。 */
  unreceivedPct: number | null
  status: string
  archived: boolean
  installments: string
  installmentsBilled: number
  installmentsTotal: number
}

export type AnnualTotals = {
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

export type AnnualBlock = {
  /** 'yyy.mm'（建立月份，民國） */
  month: string
  seqs: number[]
  subtotal: AnnualTotals
}

export type AnnualTable = {
  year: number
  rocYear: number
  sort: "code" | "unreceived_pct"
  disciplines: string[]
  rows: AnnualRow[]
  blocks: AnnualBlock[]
  totals: AnnualTotals
}

function emptyTotals(): AnnualTotals {
  return {
    count: 0,
    amountUntaxed: 0,
    taxAmount: 0,
    amountTotal: 0,
    billedTotal: 0,
    receivedTotal: 0,
    unreceived: 0,
    subcontractTotal: 0,
    subcontractByDiscipline: {},
  }
}

function addTotals(t: AnnualTotals, r: AnnualRow): void {
  t.count += 1
  t.amountUntaxed += r.amountUntaxed ?? 0
  t.taxAmount += r.taxAmount ?? 0
  t.amountTotal += r.amountTotal ?? 0
  t.billedTotal += r.billedTotal
  t.receivedTotal += r.receivedTotal
  t.unreceived += r.unreceived ?? 0
  t.subcontractTotal += r.subcontractTotal + r.technicianTotal
  for (const [k, v] of Object.entries(r.subcontractByDiscipline)) {
    t.subcontractByDiscipline[k] = (t.subcontractByDiscipline[k] ?? 0) + v
  }
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US")
}

/**
 * 該歸屬年度的所有專案，一列一案，含 reserved 空列；封存的除非 includeArchived。
 * 分母／稅／進度全走 computeMoney，與單案頁一致。
 */
export async function buildAnnualTable(
  tenantId: string,
  year: number,
  opts: { sort: "code" | "unreceived_pct"; includeArchived: boolean; settings: P3Settings },
): Promise<AnnualTable> {
  const tz = await getTenantTimezone(tenantId).catch(() => DEFAULT_TIMEZONE)
  let q = supabaseAdmin
    .from("projects")
    .select(
      "id, name, code, fiscal_year, status, kind, reserved_at, archived_at, client_id, lead_emp_id, other_expenses, created_at",
    )
    .eq("tenant_id", tenantId)
    .eq("fiscal_year", year)
  if (!opts.includeArchived) q = q.is("archived_at", null)
  const { data: projData, error: projErr } = await q
  if (projErr) throw new Error(`buildAnnualTable (projects): ${projErr.message}`)
  const projects = (projData ?? []) as AnnualProjectRow[]
  const ids = projects.map((p) => p.id)

  const [contracts, billings, subcontracts, clients, employees] = await Promise.all([
    batch<ContractLite & { project_id: string }>("contracts", CONTRACT_LITE_COLS, tenantId, ids, "project_id", true),
    batch<BillingRow>("project_billings", BILLING_COLS, tenantId, ids, "project_id", true),
    batch<SubcontractRow>("project_subcontracts", SUBCONTRACT_COLS, tenantId, ids, "project_id", true),
    batch<{ id: string; name: string }>("clients", "id, name", tenantId, uniq(projects.map((p) => p.client_id)), "id", false),
    batch<{ id: string; name: string }>("employees", "id, name", tenantId, uniq(projects.map((p) => p.lead_emp_id)), "id", false),
  ])
  const clientName = new Map(clients.map((c) => [c.id, c.name]))
  const empName = new Map(employees.map((e) => [e.id, e.name]))
  const contractsBy = groupBy(contracts, (c) => c.project_id)
  const billingsBy = groupBy(billings, (b) => b.project_id)
  const subsBy = groupBy(subcontracts, (s) => s.project_id)

  const rows: AnnualRow[] = projects.map((p) => {
    const pc = contractsBy.get(p.id) ?? []
    const pb = billingsBy.get(p.id) ?? []
    const ps = subsBy.get(p.id) ?? []
    const summary = summarizeContracts(pc)
    const { amountUntaxed, amountSource } = resolveAmountUntaxed(summary.total, summary.latestQuotation)
    const money = computeMoney({
      amountUntaxed,
      amountSource,
      vatRate: opts.settings.vatRate,
      billings: pb.map(toMoneyBilling),
      subcontracts: ps.map((s) => ({ kind: s.kind, amount: num(s.amount) ?? 0 })),
      otherExpenses: num(p.other_expenses) ?? 0,
    })
    const byDiscipline: Record<string, number> = {}
    const noteParts: string[] = []
    if (money.billingProgressPct !== null) noteParts.push(`累計請款 ${money.billingProgressPct}%`)
    if (amountSource === "quotation") noteParts.push("金額為報價單")
    for (const s of ps) {
      const amt = num(s.amount) ?? 0
      if (s.kind === "technician") {
        const vendor = s.vendor_name ?? rel1<{ name: string }>(s.vendors)?.name ?? s.discipline ?? "技師"
        noteParts.push(`應付${vendor} ${fmtMoney(amt)}`)
      } else {
        const key = s.discipline?.trim() || "未分類"
        byDiscipline[key] = (byDiscipline[key] ?? 0) + amt
      }
    }
    const installmentRows = pb.filter((b) => (b.kind ?? "installment") === "installment")
    const billedCount = installmentRows.filter((b) => b.billed_on).length
    const createdOn = localDateKey(p.created_at, tz)
    return {
      seq: 0,
      projectId: p.id,
      code: p.code,
      dateRoc: rocDate(createdOn),
      createdOn,
      clientName: p.client_id ? (clientName.get(p.client_id) ?? null) : null,
      name: p.name,
      kind: p.kind ?? "main",
      reserved: p.reserved_at !== null,
      amountUntaxed: money.amountUntaxed,
      amountSource: money.amountSource,
      taxAmount: money.taxAmount,
      amountTotal: money.amountTotal,
      leadName: p.lead_emp_id ? (empName.get(p.lead_emp_id) ?? null) : null,
      note: noteParts.join("；"),
      subcontractByDiscipline: byDiscipline,
      subcontractTotal: money.subcontractTotal - money.technicianTotal,
      technicianTotal: money.technicianTotal,
      billedTotal: money.billedTotal,
      receivedTotal: money.receivedTotal,
      billingProgressPct: money.billingProgressPct,
      receiptProgressPct: money.receiptProgressPct,
      unreceived: money.unreceived,
      unreceivedPct: money.unreceived === null ? null : pct1(money.unreceived, money.amountUntaxed),
      status: p.status,
      archived: p.archived_at !== null,
      installments: `${billedCount}/${installmentRows.length}`,
      installmentsBilled: billedCount,
      installmentsTotal: installmentRows.length,
    }
  })

  rows.sort((a, b) => {
    if (opts.sort === "unreceived_pct") {
      const pa = a.unreceivedPct
      const pb = b.unreceivedPct
      if (pa !== pb) {
        if (pa === null) return 1
        if (pb === null) return -1
        return pb - pa
      }
    }
    return compareCode(a.code, b.code) || a.createdOn.localeCompare(b.createdOn)
  })
  rows.forEach((r, i) => {
    r.seq = i + 1
  })

  // 區塊：依建立月份，月份升冪；同月內維持 rows 的順序。
  const blockMap = new Map<string, AnnualBlock>()
  const totals = emptyTotals()
  for (const r of rows) {
    const month = rocMonthKey(r.createdOn)
    let block = blockMap.get(month)
    if (!block) {
      block = { month, seqs: [], subtotal: emptyTotals() }
      blockMap.set(month, block)
    }
    block.seqs.push(r.seq)
    addTotals(block.subtotal, r)
    addTotals(totals, r)
  }
  const blocks = [...blockMap.values()].sort((a, b) => a.month.localeCompare(b.month))

  // 科別欄：租戶設定的順序在前，資料裡冒出來的其他科別接在後面。
  const seen = new Set<string>(opts.settings.disciplines)
  const extra: string[] = []
  for (const r of rows) {
    for (const k of Object.keys(r.subcontractByDiscipline)) {
      if (!seen.has(k)) {
        seen.add(k)
        extra.push(k)
      }
    }
  }

  return {
    year,
    rocYear: year - 1911,
    sort: opts.sort,
    disciplines: [...opts.settings.disciplines, ...extra],
    rows,
    blocks,
    totals,
  }
}

/** 編號比較：同前綴／年度時按流水號的數值比，不然 `AT-115-10` 會排在 `AT-115-2` 前面。 */
export function compareCode(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  const pa = a.split("-")
  const pb = b.split("-")
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? ""
    const y = pb[i] ?? ""
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) return nx - ny
    return x < y ? -1 : 1
  }
  return 0
}

export function uniq(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((v): v is string => !!v))]
}

export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const arr = m.get(k)
    if (arr) arr.push(r)
    else m.set(k, [r])
  }
  return m
}

/** `.in()` 有 URL 長度上限，分批撈。放款專區（services/disbursements.ts）也用這三個 helper。 */
export async function batch<T>(
  table: string,
  cols: string,
  tenantId: string,
  ids: string[],
  column: string,
  softDeleted: boolean,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    let q = supabaseAdmin.from(table).select(cols).eq("tenant_id", tenantId).in(column, chunk)
    if (softDeleted) q = q.is("deleted_at", null)
    const { data, error } = await q
    if (error) throw new Error(`annual batch(${table}): ${error.message}`)
    out.push(...((data ?? []) as unknown as T[]))
  }
  return out
}

/* ──────────────────────────────────────────────────────────────────
 * 未收款清單（批次）
 * ────────────────────────────────────────────────────────────────── */

export type ReceivableRow = {
  projectId: string
  code: string | null
  projectName: string
  clientName: string | null
  billingId: string
  installmentNo: number
  kind: string
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
  projectUnreceivedPct: number | null
  projectCode: string | null
}

export async function buildReceivables(
  tenantId: string,
  opts: { projectIds: Set<string> | null; status: "open" | "all"; today: string; settings: P3Settings },
): Promise<ReceivableRow[]> {
  const { data: projData, error: projErr } = await supabaseAdmin
    .from("projects")
    .select("id, name, code, client_id, archived_at")
    .eq("tenant_id", tenantId)
    .is("archived_at", null)
  if (projErr) throw new Error(`buildReceivables (projects): ${projErr.message}`)
  const projects = ((projData ?? []) as Array<{ id: string; name: string; code: string | null; client_id: string | null }>)
    .filter((p) => opts.projectIds === null || opts.projectIds.has(p.id))
  const ids = projects.map((p) => p.id)
  if (ids.length === 0) return []

  const [contracts, billings, clients] = await Promise.all([
    batch<ContractLite & { project_id: string }>("contracts", CONTRACT_LITE_COLS, tenantId, ids, "project_id", true),
    batch<BillingRow>("project_billings", BILLING_COLS, tenantId, ids, "project_id", true),
    batch<{ id: string; name: string }>("clients", "id, name", tenantId, uniq(projects.map((p) => p.client_id)), "id", false),
  ])
  const clientName = new Map(clients.map((c) => [c.id, c.name]))
  const contractsBy = groupBy(contracts, (c) => c.project_id)
  const billingsBy = groupBy(billings, (b) => b.project_id)

  const rows: ReceivableRow[] = []
  for (const p of projects) {
    const pb = billingsBy.get(p.id) ?? []
    if (pb.length === 0) continue
    const summary = summarizeContracts(contractsBy.get(p.id) ?? [])
    const { amountUntaxed, amountSource } = resolveAmountUntaxed(summary.total, summary.latestQuotation)
    const money = computeMoney({
      amountUntaxed,
      amountSource,
      vatRate: opts.settings.vatRate,
      billings: pb.map(toMoneyBilling),
      subcontracts: [],
      otherExpenses: 0,
    })
    const projectPct = money.unreceived === null ? null : pct1(money.unreceived, money.amountUntaxed)
    for (const b of pb) {
      const amount = effectiveBillingAmount(b)
      const received = b.received_on ? (num(b.received_amount) ?? 0) : 0
      const unreceived = amount === null ? null : Math.max(0, amount - received)
      const open = b.received_on === null || (unreceived !== null && unreceived > 0)
      if (opts.status === "open" && !open) continue
      rows.push({
        projectId: p.id,
        code: p.code,
        projectName: p.name,
        clientName: p.client_id ? (clientName.get(p.client_id) ?? null) : null,
        billingId: b.id,
        installmentNo: b.installment_no,
        kind: b.kind ?? "installment",
        milestone: b.milestone,
        percentage: num(b.percentage),
        amount,
        billedOn: b.billed_on,
        invoiceNo: b.invoice_no ?? null,
        invoicedOn: b.invoiced_on ?? null,
        receivedOn: b.received_on ?? null,
        receivedAmount: b.received_on ? num(b.received_amount) : null,
        unreceived,
        overdueDays: overdueDays(b.invoiced_on ?? null, b.received_on ?? null, opts.today),
        projectUnreceivedPct: projectPct,
        projectCode: p.code,
      })
    }
  }
  rows.sort(compareReceivables)
  return rows
}
