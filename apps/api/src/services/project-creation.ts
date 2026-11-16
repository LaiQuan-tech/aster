import { supabaseAdmin } from "../lib/supabase.js"
import type { NewBillingInput } from "./billing-store.js"
import type { MainContractInput } from "./main-contract.js"
import { computeSchedule, DEFAULT_WITHHOLDING_RATE, DEFAULT_WITHHOLDING_THRESHOLD } from "./project-money.js"
import { computeStampDuty, DEFAULT_STAMP_DUTY_RATE } from "./stamp-duty.js"

export class AtomicProjectCreationError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

export type InitialSubcontractInput = {
  kind?: "subcontract" | "technician"
  discipline?: string | null
  vendorId?: string | null
  vendorName?: string | null
  contact?: string | null
  item?: string | null
  amount: number
  billingBasis?: string | null
  orderType?: "quotation" | "contract" | null
  withholdingRate?: number | null
  withholdingThreshold?: number | null
  sortOrder?: number
  note?: string | null
}

export async function createProjectApplicationAtomic(
  tenantId: string,
  createdByEmpId: string,
  project: Record<string, unknown>,
  primary: MainContractInput | null,
  billings: NewBillingInput[],
  subcontracts: InitialSubcontractInput[] = [],
): Promise<{ id: string; code: string | null }> {
  let primaryRow: Record<string, unknown> | null = null
  if (primary) {
    const { data: settings, error: settingsError } = await supabaseAdmin
      .from("project_settings")
      .select("stamp_duty_rate")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (settingsError) throw new AtomicProjectCreationError(`project settings: ${settingsError.message}`)
    const configuredRate = Number(settings?.stamp_duty_rate ?? DEFAULT_STAMP_DUTY_RATE)
    const rate = Number.isFinite(configuredRate) && configuredRate >= 0 ? configuredRate : DEFAULT_STAMP_DUTY_RATE
    const copies = primary.copies ?? 1
    primaryRow = {
      doc_type: "contract",
      our_role: "contractor",
      title: primary.title?.trim() || "主合約",
      counterparty: primary.counterparty ?? null,
      amount: primary.amount,
      is_primary: true,
      signed_on: primary.signedOn ?? null,
      copies,
      stamp_duty_required: "auto",
      stamp_duty_rate: rate,
      stamp_duty_amount: computeStampDuty({ amount: primary.amount, rate, copies }),
    }
  }

  const schedule = computeSchedule(billings.map((item) => ({
    installmentNo: item.installmentNo,
    kind: item.kind ?? "installment",
    percentage: item.percentage ?? null,
    overrideAmount: item.overrideAmount ?? null,
    billedAmount: null,
    billed: false,
  })), primary?.amount ?? null)
  const calculated = new Map(schedule.rows.map((row) => [row.installmentNo, row]))
  const billingRows = billings.map((item) => ({
    installment_no: item.installmentNo,
    kind: item.kind ?? "installment",
    percentage: item.percentage ?? null,
    milestone: item.milestone ?? null,
    planned_on: item.plannedOn ?? null,
    calculated_amount: calculated.get(item.installmentNo)?.calculatedAmount ?? null,
    residue_applied: calculated.get(item.installmentNo)?.residueApplied ?? 0,
    override_amount: item.overrideAmount ?? null,
    override_reason: item.overrideReason ?? null,
    note: item.note ?? null,
  }))
  const subcontractRows = subcontracts.map((item, index) => ({
    kind: item.kind ?? "subcontract",
    discipline: item.discipline ?? null,
    vendor_id: item.vendorId ?? null,
    vendor_name: item.vendorName ?? null,
    contact: item.contact ?? null,
    item: item.item ?? null,
    amount: item.amount,
    billing_basis: item.billingBasis ?? null,
    order_type: item.orderType ?? null,
    withholding_rate: item.withholdingRate ?? DEFAULT_WITHHOLDING_RATE,
    withholding_threshold: item.withholdingThreshold ?? DEFAULT_WITHHOLDING_THRESHOLD,
    sort_order: item.sortOrder ?? index,
    note: item.note ?? null,
  }))

  const { data, error } = await supabaseAdmin.rpc("create_project_application_atomic", {
    p_tenant_id: tenantId,
    p_created_by_emp_id: createdByEmpId,
    p_project: project,
    p_primary_contract: primaryRow,
    p_billings: billingRows,
    p_subcontracts: subcontractRows,
  })
  if (error) throw new AtomicProjectCreationError(error.message, error.code)
  if (!data?.id) throw new AtomicProjectCreationError("atomic project creation returned no id")
  return { id: data.id as string, code: (data.code as string | null) ?? null }
}

/** 建案後讀回的副委託列（對應 mapInitialSubcontractRows 用）。 */
export type InitialSubcontractRow = {
  id: string
  sort_order: number | null
  vendor_id: string | null
  vendor_name: string | null
  amount?: number | string | null
  item?: string | null
  contact?: string | null
  note?: string | null
  discipline?: string | null
  kind?: string | null
}

/**
 * 第十輪（2026-11-17）：建案的 initialSubcontracts（第 i 列）→ 建出來的副委託 id（建案函式沒回傳各列 id）。
 * 以列 index 對應：同一個 sort_order（＝sortOrder ?? index）只有一列輸入、一列結果 → 直接對上；
 * 同 sort_order 多列 → 依內容（vendor_id、名稱、金額、項目、聯絡人、備註、專業、種類）對，內容完全相同的多列依序各取一列，
 * 同一列不重複指派。對不到回 null。不以名稱跨 sort_order 找（同名非登錄多列時不會全指到同一列）。
 */
export function mapInitialSubcontractRows(
  inputs: ReadonlyArray<InitialSubcontractInput & { sortOrder: number }>,
  rows: readonly InitialSubcontractRow[],
): Array<string | null> {
  const norm = (v: unknown) => (v == null ? "" : String(v).trim())
  const fp = (x: { vendorId?: unknown; vendorName?: unknown; amount?: unknown; item?: unknown; contact?: unknown; note?: unknown; discipline?: unknown; kind?: unknown }) =>
    JSON.stringify([norm(x.vendorId).toLowerCase(), norm(x.vendorName), Number(x.amount ?? 0), norm(x.item), norm(x.contact), norm(x.note), norm(x.discipline), norm(x.kind)])
  const rowFp = (r: InitialSubcontractRow) =>
    fp({ vendorId: r.vendor_id, vendorName: r.vendor_name, amount: r.amount, item: r.item, contact: r.contact, note: r.note, discipline: r.discipline, kind: r.kind ?? "subcontract" })
  const used = new Set<string>()
  const sorted = [...rows].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id))
  return inputs.map((input) => {
    const sameOrder = sorted.filter((r) => r.sort_order === input.sortOrder)
    const inputsSameOrder = inputs.filter((i) => i.sortOrder === input.sortOrder)
    if (sameOrder.length === 1 && inputsSameOrder.length === 1) {
      used.add(sameOrder[0]!.id)
      return sameOrder[0]!.id
    }
    const want = fp({ ...input, kind: input.kind ?? "subcontract" })
    const hit = sameOrder.find((r) => !used.has(r.id) && rowFp(r) === want)
    if (!hit) return null
    used.add(hit.id)
    return hit.id
  })
}
