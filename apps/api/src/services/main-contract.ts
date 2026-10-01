import { supabaseAdmin } from "../lib/supabase.js"
import { recomputeBillings } from "./billing-store.js"
import { computeStampDuty, DEFAULT_STAMP_DUTY_RATE } from "./stamp-duty.js"

export const MAIN_CONTRACT_COLS =
  "id, tenant_id, project_id, doc_type, our_role, title, counterparty, amount, is_primary, signed_on, version, supersedes_id, copies, stamp_duty_required, stamp_duty_rate, stamp_duty_amount, stamp_duty_paid_on, stamp_duty_note, created_by_emp_id, created_at, deleted_at"

export type MainContractRow = {
  id: string
  project_id: string
  doc_type: string
  our_role: string
  title: string
  counterparty: string | null
  amount: string | number | null
  is_primary: boolean
  signed_on: string | null
  version: number
  supersedes_id: string | null
  copies: number
  stamp_duty_required: string
  stamp_duty_rate: string | number | null
  stamp_duty_amount: string | number | null
  stamp_duty_paid_on: string | null
  stamp_duty_note: string | null
  created_at: string
}

export type MainContractInput = {
  amount: number
  title?: string | null
  counterparty?: string | null
  signedOn?: string | null
  copies?: number
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function serializeMainContract(row: MainContractRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    docType: row.doc_type,
    ourRole: row.our_role,
    title: row.title,
    counterparty: row.counterparty,
    amount: num(row.amount),
    isPrimary: row.is_primary,
    signedOn: row.signed_on,
    version: row.version,
    supersedesId: row.supersedes_id,
    copies: row.copies,
    stampDutyRequired: row.stamp_duty_required,
    stampDutyRate: num(row.stamp_duty_rate),
    stampDutyAmount: num(row.stamp_duty_amount),
    stampDutyPaidOn: row.stamp_duty_paid_on,
    stampDutyNote: row.stamp_duty_note,
    createdAt: row.created_at,
  }
}

export async function loadMainContract(tenantId: string, projectId: string): Promise<MainContractRow | null> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select(MAIN_CONTRACT_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("is_primary", true)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`loadMainContract: ${error.message}`)
  return (data as MainContractRow | null) ?? null
}

/**
 * 舊資料沒有 is_primary：只在承攬合約版本鏈恰有一個 active leaf 時採用。
 * 多分支或多份無關合約都不猜，呼叫端會另建明確的主合約。
 */
async function adoptableLegacyContract(tenantId: string, projectId: string): Promise<MainContractRow | null> {
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select(MAIN_CONTRACT_COLS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("doc_type", "contract")
    .eq("our_role", "contractor")
    .is("deleted_at", null)
  if (error) throw new Error(`adoptableLegacyContract: ${error.message}`)
  const rows = (data ?? []) as MainContractRow[]
  const superseded = new Set(rows.map((row) => row.supersedes_id).filter((id): id is string => !!id))
  const leaves = rows.filter((row) => !superseded.has(row.id))
  return leaves.length === 1 ? leaves[0] : null
}

async function stampDutyRate(tenantId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("project_settings")
    .select("stamp_duty_rate")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`mainContract stampDutyRate: ${error.message}`)
  const rate = Number(data?.stamp_duty_rate ?? DEFAULT_STAMP_DUTY_RATE)
  return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_STAMP_DUTY_RATE
}

export async function createMainContract(
  tenantId: string,
  projectId: string,
  createdByEmpId: string | null,
  input: MainContractInput,
): Promise<MainContractRow> {
  const rate = await stampDutyRate(tenantId)
  const copies = input.copies ?? 1
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .insert({
      tenant_id: tenantId,
      project_id: projectId,
      doc_type: "contract",
      our_role: "contractor",
      title: input.title?.trim() || "主合約",
      counterparty: input.counterparty ?? null,
      amount: input.amount,
      is_primary: true,
      signed_on: input.signedOn ?? null,
      copies,
      stamp_duty_required: "auto",
      stamp_duty_rate: rate,
      stamp_duty_amount: computeStampDuty({ amount: input.amount, rate, copies }),
      created_by_emp_id: createdByEmpId,
    })
    .select(MAIN_CONTRACT_COLS)
    .single()
  if (error || !data) throw new Error(`createMainContract: ${error?.message ?? "missing row"}`)
  return data as MainContractRow
}

export async function upsertMainContract(
  tenantId: string,
  projectId: string,
  createdByEmpId: string,
  input: MainContractInput,
): Promise<MainContractRow> {
  const current = await loadMainContract(tenantId, projectId)
  let target = current
  if (!target) {
    const legacy = await adoptableLegacyContract(tenantId, projectId)
    if (legacy) {
      const { data, error } = await supabaseAdmin
        .from("contracts")
        .update({ is_primary: true })
        .eq("tenant_id", tenantId)
        .eq("id", legacy.id)
        .is("deleted_at", null)
        .select(MAIN_CONTRACT_COLS)
        .single()
      if (error || !data) throw new Error(`adoptMainContract: ${error?.message ?? "missing row"}`)
      target = data as MainContractRow
    }
  }
  if (!target) {
    const created = await createMainContract(tenantId, projectId, createdByEmpId, input)
    await recomputeBillings(tenantId, projectId)
    return created
  }

  const rate = num(target.stamp_duty_rate) ?? (await stampDutyRate(tenantId))
  const copies = input.copies ?? target.copies
  const patch = {
    amount: input.amount,
    title: input.title === undefined ? target.title : (input.title?.trim() || "主合約"),
    counterparty: input.counterparty === undefined ? target.counterparty : input.counterparty,
    signed_on: input.signedOn === undefined ? target.signed_on : input.signedOn,
    copies,
    stamp_duty_rate: rate,
    stamp_duty_amount: computeStampDuty({ amount: input.amount, rate, copies }),
  }
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", target.id)
    .is("deleted_at", null)
    .select(MAIN_CONTRACT_COLS)
    .single()
  if (error || !data) throw new Error(`upsertMainContract: ${error?.message ?? "missing row"}`)
  await recomputeBillings(tenantId, projectId)
  return data as MainContractRow
}
