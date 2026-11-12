import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 刪除打錯（key 錯）的專案（2026-11-12，DELETE /projects/:id；migration 0095 ＝ sql/0085）。
 *
 * 一律**軟刪除**：projects.deleted_at／deleted_by_emp_id。刪除後所有讀取點都排除（列表、Excel、下拉、報表、
 * ESS、MCP 經 API）；序號唯一索引只對未刪除者生效，錯誤序號可以重新使用。
 *
 * 只有「空殼」才准刪——下列任何一項有資料就回 409 project_has_data（建議改用封存）。盤點依據：正式庫
 * 所有 FK 指向 projects(id) 的 12 張表（2026-11-12 唯讀查 pg_constraint）＋ projects.parent_project_id 軟參照：
 *
 *   擋刪（算「有實質資料」）：
 *     • project_billings          未刪除的期程有請款／開票／入帳任一欄位（billed_on／billed_amount／invoice_no／
 *                                 invoiced_on／received_on／received_amount）
 *     • project_billing_shares    每期款獎金分潤
 *     • project_billing_bonus_dates 每期款發獎金日
 *     • bonus_run_items           獎金計算批次（含草稿）
 *     • project_share_adjustments 分潤異動紀錄
 *     • attendance_sheet_days     出勤表工作內容掛了這個專案（工時）
 *     • disbursement_allocations  請款／放款分攤（直接掛專案，或掛在本案副委託上）
 *     • project_documents         專案文件／合約掃描檔（storage 有實體檔）
 *     • contracts                 未刪除且已簽約（signed_on）或已繳印花稅（stamp_duty_paid_on）的合約
 *     • project_subcontracts      未刪除且已有發票（invoice_no／invoice_date）的副委託
 *     • projects（子案）          未刪除的追加減／加做／估驗子案（parent_project_id 指向本案）
 *
 *   不擋、隨專案一併軟刪除（建案時順手填的計畫資料，沒有任何金流）：
 *     • project_billings          沒有請款／開票／入帳的期程列
 *     • contracts                 未簽約、未繳印花稅的合約／報價單列
 *     • project_subcontracts      沒有發票、沒有放款的副委託列
 *
 *   不擋、原樣保留（沒有 deleted_at 欄位；專案已刪除後只經 /projects/:id/* 讀，一律 404）：
 *     • project_members           成員名單（「我的專案」另外過濾掉已刪除的案）
 *     • project_application_versions 申請單版本快照（本案自己的歷史，不是交易）
 *
 * 費用報銷（expenses）、請假、簽核單等沒有 project_id 欄位，不會掛到專案上；放款／獎金批次的簽核中單據
 * 已由 disbursement_allocations／bonus_run_items 涵蓋。
 */

export type DeleteBlockerKey =
  | "billing_activity"
  | "billing_shares"
  | "billing_bonus_dates"
  | "bonus_run_items"
  | "share_adjustments"
  | "attendance_days"
  | "disbursements"
  | "documents"
  | "signed_contracts"
  | "invoiced_subcontracts"
  | "child_projects"

export const DELETE_BLOCKER_LABELS: Record<DeleteBlockerKey, string> = {
  billing_activity: "期程款已請款／開票／入帳",
  billing_shares: "每期款獎金分潤",
  billing_bonus_dates: "每期款發獎金日",
  bonus_run_items: "獎金計算批次",
  share_adjustments: "分潤異動紀錄",
  attendance_days: "出勤表工時（工作內容選了此專案）",
  disbursements: "請款／放款單",
  documents: "專案文件或合約掃描檔",
  signed_contracts: "已簽約或已繳印花稅的合約",
  invoiced_subcontracts: "已開發票的副委託",
  child_projects: "底下的追加減／加做／估驗子案",
}

export type DeleteBlocker = { key: DeleteBlockerKey; label: string; count: number }

const present = (v: unknown) => v !== null && v !== undefined && v !== ""

async function rowsOf<T>(
  table: string,
  cols: string,
  tenantId: string,
  column: string,
  values: string[],
  opts: { notDeleted?: boolean } = {},
): Promise<T[]> {
  if (values.length === 0) return []
  let q = supabaseAdmin.from(table).select(cols).eq("tenant_id", tenantId).in(column, values)
  if (opts.notDeleted) q = q.is("deleted_at", null)
  const { data, error } = await q
  if (error) throw new Error(`project-delete (${table}): ${error.message}`)
  return (data ?? []) as unknown as T[]
}

type BillingLite = {
  id: string
  billed_on: string | null
  billed_amount: string | number | null
  invoice_no: string | null
  invoiced_on: string | null
  received_on: string | null
  received_amount: string | number | null
}
type ContractLite = { id: string; signed_on: string | null; stamp_duty_paid_on: string | null }
type SubLite = { id: string; invoice_no: string | null; invoice_date: string | null }

export type DeletePlan = {
  blockers: DeleteBlocker[]
  /** 沒有擋刪時，隨專案一併軟刪除的列 id。 */
  cascade: { billings: string[]; contracts: string[]; subcontracts: string[] }
}

/** 盤點擋刪條件與要一併軟刪除的列（唯讀）。 */
export async function planProjectDelete(tenantId: string, projectId: string): Promise<DeletePlan> {
  const ids = [projectId]
  const [billings, shares, bonusDates, runItems, adjustments, sheetDays, allocations, documents, contracts, subs, children] =
    await Promise.all([
      rowsOf<BillingLite>(
        "project_billings",
        "id, billed_on, billed_amount, invoice_no, invoiced_on, received_on, received_amount",
        tenantId, "project_id", ids, { notDeleted: true },
      ),
      rowsOf<{ id: string }>("project_billing_shares", "id", tenantId, "project_id", ids),
      rowsOf<{ billing_id: string }>("project_billing_bonus_dates", "billing_id", tenantId, "project_id", ids),
      rowsOf<{ id: string }>("bonus_run_items", "id", tenantId, "project_id", ids),
      rowsOf<{ id: string }>("project_share_adjustments", "id", tenantId, "project_id", ids),
      rowsOf<{ id: string }>("attendance_sheet_days", "id", tenantId, "project_id", ids),
      rowsOf<{ id: string }>("disbursement_allocations", "id", tenantId, "project_id", ids),
      rowsOf<{ id: string }>("project_documents", "id", tenantId, "project_id", ids),
      rowsOf<ContractLite>("contracts", "id, signed_on, stamp_duty_paid_on", tenantId, "project_id", ids, { notDeleted: true }),
      rowsOf<SubLite>("project_subcontracts", "id, invoice_no, invoice_date", tenantId, "project_id", ids, { notDeleted: true }),
      rowsOf<{ id: string }>("projects", "id", tenantId, "parent_project_id", ids, { notDeleted: true }),
    ])
  // 放款分攤也可能只掛副委託（subcontract_id）沒帶 project_id：本案副委託（含已刪除的）上有分攤一樣擋。
  const allSubIds = (await rowsOf<{ id: string }>("project_subcontracts", "id", tenantId, "project_id", ids)).map((s) => s.id)
  const subAllocations = await rowsOf<{ id: string }>("disbursement_allocations", "id", tenantId, "subcontract_id", allSubIds)
  const allocationIds = new Set([...allocations, ...subAllocations].map((a) => a.id))

  const activeBillings = billings.filter(
    (b) =>
      present(b.billed_on) || present(b.billed_amount) || present(b.invoice_no) ||
      present(b.invoiced_on) || present(b.received_on) || present(b.received_amount),
  )
  const signedContracts = contracts.filter((c) => present(c.signed_on) || present(c.stamp_duty_paid_on))
  const invoicedSubs = subs.filter((s) => present(s.invoice_no) || present(s.invoice_date))

  const counts: Array<[DeleteBlockerKey, number]> = [
    ["billing_activity", activeBillings.length],
    ["billing_shares", shares.length],
    ["billing_bonus_dates", bonusDates.length],
    ["bonus_run_items", runItems.length],
    ["share_adjustments", adjustments.length],
    ["attendance_days", sheetDays.length],
    ["disbursements", allocationIds.size],
    ["documents", documents.length],
    ["signed_contracts", signedContracts.length],
    ["invoiced_subcontracts", invoicedSubs.length],
    ["child_projects", children.length],
  ]
  const blockers = counts
    .filter(([, n]) => n > 0)
    .map(([key, count]) => ({ key, label: DELETE_BLOCKER_LABELS[key], count }))

  return {
    blockers,
    cascade: {
      billings: billings.map((b) => b.id),
      contracts: contracts.map((c) => c.id),
      subcontracts: subs.map((s) => s.id),
    },
  }
}

/** 409 回應的說明文字（畫面直接顯示）。 */
export function blockerMessage(blockers: DeleteBlocker[]): string {
  const list = blockers.map((b) => `${b.label}（${b.count} 筆）`).join("、")
  return `此專案已有實際資料，不能刪除：${list}。若只是不再使用，請改用「封存」。`
}

/** 刪除確認：輸入的序號（沒有序號的案用專案名稱）去頭尾空白後須與專案一致（不分大小寫）。 */
export function confirmMatches(input: unknown, project: { code: string | null; name: string }): boolean {
  if (typeof input !== "string") return false
  const expected = (project.code ?? project.name ?? "").trim()
  if (!expected) return false
  return input.trim().toLowerCase() === expected.toLowerCase()
}

/**
 * 執行軟刪除：先標記專案（條件 deleted_at is null，併發重複刪除只有一個會成功），再把計畫用的空期程／
 * 未簽約合約／無發票副委託一併軟刪除。回 null＝專案已不存在或已被刪除。
 * projects 與三張子表的 audit_all 觸發器會把每一列的 UPDATE 自動寫進 audit_logs。
 */
export async function softDeleteProject(
  tenantId: string,
  projectId: string,
  empId: string,
  cascade: DeletePlan["cascade"],
  nowIso: string = new Date().toISOString(),
): Promise<{ id: string; code: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .update({ deleted_at: nowIso, deleted_by_emp_id: empId })
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .is("deleted_at", null)
    .select("id, code")
    .maybeSingle()
  if (error) throw new Error(`softDeleteProject: ${error.message}`)
  if (!data) return null

  const reason = "專案刪除（打錯的空殼專案）"
  const steps: Array<{ table: string; ids: string[]; patch: Record<string, unknown> }> = [
    { table: "project_billings", ids: cascade.billings, patch: { deleted_at: nowIso, deleted_by_emp_id: empId, delete_reason: reason } },
    { table: "contracts", ids: cascade.contracts, patch: { deleted_at: nowIso, deleted_by_emp_id: empId, delete_reason: reason } },
    { table: "project_subcontracts", ids: cascade.subcontracts, patch: { deleted_at: nowIso, deleted_by: empId, delete_reason: reason, updated_at: nowIso } },
  ]
  for (const step of steps) {
    if (step.ids.length === 0) continue
    const { error: e } = await supabaseAdmin
      .from(step.table)
      .update(step.patch)
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      .in("id", step.ids)
      .is("deleted_at", null)
    // 專案本身已刪（列表與 /projects/:id 都看不到了）；子列沒刪成只是殘留，記 log 不回錯。
    if (e) console.error(`[project-delete] cascade ${step.table} failed: ${e.message}`)
  }
  return { id: data.id as string, code: (data.code as string | null) ?? null }
}
