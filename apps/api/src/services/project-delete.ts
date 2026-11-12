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
 *     • project_subcontract_payments 本案副委託（含已刪除的）底下有已付款（paid_on／paid_amount）或已驗收（accepted_on）的期款
 *     • project_subcontracts      未刪除、kind='firm' 且已有代扣日期（withholding_date）的事務所副委託
 *     • projects（子案）          未刪除的追加減／加做／估驗子案（parent_project_id 指向本案）
 *
 *   不擋、隨專案一併軟刪除（建案時順手填的計畫資料，沒有任何金流）：
 *     • project_billings          沒有請款／開票／入帳的期程列
 *     • contracts                 未簽約、未繳印花稅的合約／報價單列
 *     • project_subcontracts      沒有發票、沒有代扣、沒有已付／已驗收期款、沒有放款的副委託列
 *
 *   不擋、原樣保留（沒有 deleted_at 欄位；專案已刪除後只經 /projects/:id/* 讀，一律 404）：
 *     • project_members           成員名單（「我的專案」另外過濾掉已刪除的案）
 *     • project_application_versions 申請單版本快照（本案自己的歷史，不是交易）
 *
 * ⚠️ 2026-11-12 修正：真正的檢查＋寫入在 DB 函式 soft_delete_project（migration 0096 ＝ sql/0086）同一交易內完成——
 * 先 FOR UPDATE 鎖專案列、重新檢查上列全部條件、連帶軟刪除、還原被本案取代的原案、最後標記專案。這裡的
 * planProjectDelete 只是給 UI／API 的快速預檢（兩邊條件要一致）；檢查到寫入之間別人新增的請款／工時／分攤，
 * 由 DB 函式的鎖＋子表觸發器 assert_project_not_deleted（PD409）擋下，不會被一起刪掉或變孤兒。
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
  | "paid_subcontract_payments"
  | "withheld_subcontracts"
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
  paid_subcontract_payments: "副委託期款已付款或已驗收",
  withheld_subcontracts: "事務所副委託已代扣",
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
type SubLite = {
  id: string
  invoice_no: string | null
  invoice_date: string | null
  kind?: string | null
  withholding_date?: string | null
}
type SubPaymentLite = { id: string; paid_on: string | null; paid_amount: string | number | null; accepted_on: string | null }

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
      rowsOf<SubLite>(
        "project_subcontracts",
        "id, invoice_no, invoice_date, kind, withholding_date",
        tenantId, "project_id", ids, { notDeleted: true },
      ),
      rowsOf<{ id: string }>("projects", "id", tenantId, "parent_project_id", ids, { notDeleted: true }),
    ])
  // 放款分攤也可能只掛副委託（subcontract_id）沒帶 project_id：本案副委託（含已刪除的）上有分攤一樣擋。
  const allSubIds = (await rowsOf<{ id: string }>("project_subcontracts", "id", tenantId, "project_id", ids)).map((s) => s.id)
  const [subAllocations, subPayments] = await Promise.all([
    rowsOf<{ id: string }>("disbursement_allocations", "id", tenantId, "subcontract_id", allSubIds),
    rowsOf<SubPaymentLite>(
      "project_subcontract_payments",
      "id, paid_on, paid_amount, accepted_on",
      tenantId, "subcontract_id", allSubIds,
    ),
  ])
  const allocationIds = new Set([...allocations, ...subAllocations].map((a) => a.id))

  const activeBillings = billings.filter(
    (b) =>
      present(b.billed_on) || present(b.billed_amount) || present(b.invoice_no) ||
      present(b.invoiced_on) || present(b.received_on) || present(b.received_amount),
  )
  const signedContracts = contracts.filter((c) => present(c.signed_on) || present(c.stamp_duty_paid_on))
  const invoicedSubs = subs.filter((s) => present(s.invoice_no) || present(s.invoice_date))
  // 副委託期款：已付款或已驗收＝錢已經（或即將）付出去（含已刪除的副委託底下的期款）。
  const paidPayments = subPayments.filter((p) => present(p.paid_on) || present(p.paid_amount) || present(p.accepted_on))
  // 事務所（kind='firm'）已代扣：扣繳憑單已經產生。
  const withheldSubs = subs.filter((s) => s.kind === "firm" && present(s.withholding_date))

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
    ["paid_subcontract_payments", paidPayments.length],
    ["withheld_subcontracts", withheldSubs.length],
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

/** 被刪除的新案取代而封存的原案，刪除時的處理（DB 函式回傳；只用 id 比對，見 migration 0097）。 */
export type RestoredOriginal = {
  id: string
  code: string | null
  /**
   * restored＝回到複製前的封存狀態與原因；unmarked＝找不到複製前快照，只解除「被取代」標記、封存保留；
   * repointed＝被刪除的案自己也已被別案（toCode）取代（換案鏈 O→本案→X），原案改由 X 取代，仍封存、仍不計獎金。
   */
  mode: "restored" | "unmarked" | "repointed"
  /** 處理後是否仍封存。 */
  archived: boolean
  /** repointed 時：改指向的後繼案。 */
  toId?: string | null
  toCode?: string | null
}

/** 只有序號前綴吻合（「已由 本案序號 取代：」）、但 id 對不上的案：DB 不動，請使用者手動檢查。 */
export type UnverifiedOriginal = { id: string; code: string | null }

export type SoftDeleteResult =
  | {
      status: "deleted"
      id: string
      code: string | null
      cascade: { billings: number; contracts: number; subcontracts: number }
      restored: RestoredOriginal[]
      unverified: UnverifiedOriginal[]
    }
  | { status: "blocked"; blockers: DeleteBlocker[] }
  | { status: "not_found" }

/** DB 函式回的 blockers（只有 key／count）補上中文標籤；不認得的 key 原樣顯示。 */
export function labelBlockers(raw: unknown): DeleteBlocker[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b): b is { key: string; count: unknown } => !!b && typeof b === "object" && typeof (b as { key?: unknown }).key === "string")
    .map((b) => ({
      key: b.key as DeleteBlockerKey,
      label: DELETE_BLOCKER_LABELS[b.key as DeleteBlockerKey] ?? b.key,
      count: Number(b.count) || 0,
    }))
}

/** 原案處理的說明文字（API 回應 restoredMessage／畫面直接顯示）；沒有任何原案要說明回 null。 */
export function restoredMessage(restored: RestoredOriginal[], unverified: UnverifiedOriginal[] = []): string | null {
  const parts = restored.map((r) => {
    const code = r.code ?? "（無序號）"
    if (r.mode === "repointed") return `原案 ${code} 改由 ${r.toCode ?? "後繼案"} 取代（仍封存，獎金仍由 ${r.toCode ?? "後繼案"} 計）`
    if (r.mode === "unmarked") return `原案 ${code} 已解除「被取代」標記（仍是封存，需要時請自行解除封存）`
    return r.archived
      ? `原案 ${code} 已解除「被取代」標記，回到複製前的封存狀態`
      : `原案 ${code} 已解除「被取代」標記並恢復為未封存`
  })
  if (unverified.length > 0) {
    const codes = unverified.map((u) => u.code ?? "（無序號）").join("、")
    parts.push(`${codes} 的封存原因寫著「已由本案取代」，但無法確認是本案複製出來的，系統沒有更動，請手動檢查`)
  }
  return parts.length > 0 ? parts.join("；") : null
}

/**
 * 執行軟刪除：呼叫 DB 函式 soft_delete_project（migration 0096），在同一交易內鎖專案列、重新檢查擋刪條件、
 * 連帶軟刪除空期程／未簽約合約／無金流副委託、還原被本案取代的原案、最後標記專案。
 * 回 blocked＝檢查到寫入之間有人寫了實質資料（以 DB 為準）；not_found＝專案已不存在或已被刪除。
 * projects 與子表的 audit_all 觸發器會把每一列的 UPDATE 自動寫進 audit_logs。
 */
export async function softDeleteProject(
  tenantId: string,
  projectId: string,
  empId: string,
  reason = "專案刪除（打錯的空殼專案）",
): Promise<SoftDeleteResult> {
  const { data, error } = await supabaseAdmin.rpc("soft_delete_project", {
    p_tenant_id: tenantId,
    p_project_id: projectId,
    p_actor_emp_id: empId,
    p_reason: reason,
  })
  // 帶著 code 往上丟：死鎖（40P01）等可重試衝突由全域錯誤處理轉成 409 conflict_retry。
  if (error) throw Object.assign(new Error(`softDeleteProject: ${error.message}`), { code: error.code })
  const out = (data ?? {}) as Record<string, unknown>
  if (out.status === "blocked") return { status: "blocked", blockers: labelBlockers(out.blockers) }
  if (out.status !== "deleted") return { status: "not_found" }
  const cascade = (out.cascade ?? {}) as Record<string, unknown>
  const restored = Array.isArray(out.restored) ? (out.restored as Array<Record<string, unknown>>) : []
  const unverified = Array.isArray(out.unverified) ? (out.unverified as Array<Record<string, unknown>>) : []
  return {
    status: "deleted",
    id: String(out.id ?? projectId),
    code: (out.code as string | null | undefined) ?? null,
    cascade: {
      billings: Number(cascade.billings) || 0,
      contracts: Number(cascade.contracts) || 0,
      subcontracts: Number(cascade.subcontracts) || 0,
    },
    restored: restored.map((r) => ({
      id: String(r.id),
      code: (r.code as string | null | undefined) ?? null,
      mode: r.mode === "unmarked" || r.mode === "repointed" ? r.mode : "restored",
      archived: r.archived === true,
      ...(r.mode === "repointed"
        ? { toId: (r.toId as string | null | undefined) ?? null, toCode: (r.toCode as string | null | undefined) ?? null }
        : {}),
    })),
    unverified: unverified.map((u) => ({ id: String(u.id), code: (u.code as string | null | undefined) ?? null })),
  }
}
