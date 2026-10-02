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
