/**
 * D1 專案獎金季發放批次（bonus_runs）的 typed API 呼叫。
 * 後端見 apps/api/src/routes/bonus-runs.ts；回應形狀對過 services/bonus-run-store.ts
 * 的 SerializedRun／SerializedItem／BonusSummary。刻意獨立成新檔、不改 projects-api.ts。
 */
import { apiFetch, apiDownload } from "./api-client"

/* ---------------------------------------------------------------- 基本型別 -- */
/** 2026-10-26 起：草稿 →（HR）送審 →（老闆）核准 → 發放。 */
export type BonusRunStatus = "draft" | "pending_approval" | "approved" | "paid"
/** 獎金池基礎：毛利制／舊制（手填獎金池）／固定金額。 */
export type BonusBasis = "gross_profit" | "legacy_pool" | "fixed_amount"

export interface BonusWarning {
  projectId: string
  kind: "over_contract"
  overContractPct: number
  message: string
  code?: string | null
  name?: string | null
}
export type BonusSkipReason = "no_contract" | "no_pool"

export interface BonusSkipped {
  projectId: string
  reason: BonusSkipReason
  code?: string | null
  name?: string | null
}

export interface BonusTotals {
  amount: number
  entitledCumulative: number
  paidBefore: number
  itemCount: number
  employeeCount: number
  projectCount: number
  overpaidCount: number
  skipped: BonusSkipped[]
  /** 入帳超過合約等提醒（舊批次沒有）。 */
  warnings?: BonusWarning[]
}

export type BonusRunKind = "regular" | "reversal"

export interface BonusRun {
  id: string
  label: string
  asOf: string
  status: BonusRunStatus
  /** regular＝季批次；reversal＝紅字沖銷（金額為負） */
  kind: BonusRunKind
  reversesRunId: string | null
  /** 被哪個有效沖銷批次沖掉了（含草稿＝沖銷中） */
  reversedByRunId: string | null
  reversedByStatus: BonusRunStatus | null
  paidOn: string | null
  totals: BonusTotals
  note: string | null
  createdByEmpId: string | null
  paidByEmpId: string | null
  createdAt: string
  updatedAt: string
  // 核准（舊 API 沒有這些欄位）
  submittedAt?: string | null
  submittedByEmpId?: string | null
  approvedAt?: string | null
  approvedByEmpId?: string | null
  approvedAmount?: number | null
  returnedAt?: string | null
  returnedByEmpId?: string | null
  returnReason?: string | null
  /** 送審人與核准人相同（老闆兼 HR 自己送審自己核准）。 */
  selfApproved?: boolean
}

export interface BonusRunItem {
  id: string | null
  runId: string | null
  projectId: string
  projectCode: string | null
  projectName: string | null
  employeeId: string
  employeeName: string | null
  empNo: string | null
  roleInProject: string | null
  shareMode: "pool_pct" | "fixed_amount" | string
  sharePct: number | null
  shareAmount: number | null
  bonusPool: number | null
  /** 專案獎金比例（百分數，例如 2 代表 2%）；舊快照可能沒有。 */
  bonusRatePct?: number | null
  contractTotal: number | null
  receivedTotal: number
  /** 前次已累積收款、本次新增收款；舊快照由 UI 相容回退。 */
  previousReceived?: number
  previousReceivedPct?: number
  currentReceived?: number
  currentReceivedPct?: number
  unallocatedPct?: number
  projectNote?: string | null
  /** 0～1。 */
  receivedPct: number
  entitledCumulative: number
  paidBefore: number
  amount: number
  overpaid: boolean
  overpaidBy: number
  /** 2026-10-26 起：獎金池基礎與毛利明細；舊明細為 null／缺。 */
  basis?: BonusBasis | null
  revenue?: number
  cost?: number | null
  disbursementCost?: number | null
  subcontractCost?: number | null
  grossProfit?: number | null
  overContractPct?: number | null
}

export interface BonusRunSnapshotProject {
  projectId: string
  code: string | null
  name: string | null
  shareMode: string
  bonusPool: number | null
  contractTotal: number | null
  receivedTotal: number
  memberCount: number
  skipped: boolean
}

export interface BonusRunSnapshot {
  asOf?: string
  projects?: BonusRunSnapshotProject[]
  skipped?: BonusSkipped[]
  /** 封存而不列入的專案（複製取代的原案、封存後沒有新入帳／成本）。 */
  excludedArchived?: Array<{ projectId: string; reason: string; code: string | null; name: string | null }>
  warnings?: BonusWarning[]
}

export interface BonusRunDetail {
  run: BonusRun
  items: BonusRunItem[]
  snapshot: BonusRunSnapshot | null
  /** 呼叫者是不是老闆（能核准／退回）。 */
  canApprove?: boolean
  /** PATCH 重算後從送審中／已核准退回草稿。 */
  returnedToDraft?: boolean
}

export interface BonusRunPreview {
  label: string
  asOf: string
  items: BonusRunItem[]
  totals: BonusTotals
  snapshot: BonusRunSnapshot
}

export interface BonusSummaryQuarter {
  runId: string
  label: string
  year: number
  quarter: number
  paidOn: string | null
  amount: number
  employeeCount: number
  projectCount: number
}

export interface BonusSummaryEmployee {
  employeeId: string
  employeeName: string | null
  empNo: string | null
  amountYear: number
  amountAllTime: number
  runCount: number
}

export interface BonusSummary {
  years: number[]
  year: number | null
  yearTotal: number
  allTimeTotal: number
  byQuarter: BonusSummaryQuarter[]
  byEmployee: BonusSummaryEmployee[]
  comparison: {
    latest: BonusSummaryQuarter | null
    previous: BonusSummaryQuarter | null
    delta: number | null
    deltaPct: number | null
    byEmployee: Array<{
      employeeId: string
      employeeName: string | null
      empNo: string | null
      latest: number
      previous: number
      delta: number
    }>
  }
}

/** ESS 我的獎金歷史：精簡白名單（不含入帳／成本／毛利／獎金池／比例等可反推毛利的欄位）。 */
export interface MyBonusHistoryRow {
  id: string
  runId: string
  label: string
  asOf: string
  paidOn: string | null
  kind: BonusRunKind
  projectId: string
  projectCode: string | null
  projectName: string | null
  roleInProject: string | null
  shareMode: string
  sharePct: number | null
  shareAmount: number | null
  /** 本期金額。 */
  amount: number
  /** 該專案截至這一期本人累計已發。 */
  paidCumulative: number
  basis: BonusBasis | null
}

/* -------------------------------------------------------------------- 呼叫 -- */
export function previewBonusRun(body: { asOf?: string; label?: string }) {
  return apiFetch<BonusRunPreview>("/bonus-runs/preview", { method: "POST", body: JSON.stringify(body) })
}

export function createBonusRun(body: { asOf: string; label: string; note?: string | null }) {
  return apiFetch<BonusRunDetail>("/bonus-runs", { method: "POST", body: JSON.stringify(body) })
}

export function listBonusRuns() {
  return apiFetch<{ runs: BonusRun[]; canApprove?: boolean }>("/bonus-runs")
}

/** HR 送審（草稿 → 送審中，通知老闆）。 */
export function submitBonusRun(id: string) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}/submit`, { method: "POST", body: "{}" })
}

/** 老闆核准（送審中 → 已核准）。 */
export function approveBonusRun(id: string) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}/approve`, { method: "POST", body: "{}" })
}

/** 老闆退回草稿（需原因）。 */
export function returnBonusRun(id: string, reason: string) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}/return`, { method: "POST", body: JSON.stringify({ reason }) })
}

/** HR 撤回送審（限送審中、需原因；通知老闆）。已核准後只能老闆退回。 */
export function withdrawBonusRun(id: string, reason: string) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}/withdraw`, { method: "POST", body: JSON.stringify({ reason }) })
}

/** ESS 簽核頁：老闆的待核准獎金批次（非老闆回 canApprove=false、空清單）。 */
export function getMyBonusApprovals() {
  return apiFetch<{ canApprove: boolean; runs: BonusRunDetail[] }>("/my/bonus-approvals")
}

export function getBonusRun(id: string) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}`)
}

export function patchBonusRun(id: string, body: { asOf?: string; label?: string; note?: string | null; recompute?: boolean }) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}`, { method: "PATCH", body: JSON.stringify(body) })
}

export function payBonusRun(id: string, body: { paidOn?: string } = {}) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}/pay`, { method: "POST", body: JSON.stringify(body) })
}

/** 對 paid 批次開紅字沖銷草稿；之後走 payBonusRun 才生效。 */
export function reverseBonusRun(id: string, reason: string) {
  return apiFetch<BonusRunDetail>(`/bonus-runs/${id}/reverse`, { method: "POST", body: JSON.stringify({ reason }) })
}

export function deleteBonusRun(id: string, reason: string) {
  return apiFetch<{ ok: true; id: string }>(`/bonus-runs/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) })
}

export function getBonusSummary(params: { year?: number | null; empId?: string | null } = {}) {
  const qs = new URLSearchParams()
  if (params.year) qs.set("year", String(params.year))
  if (params.empId) qs.set("empId", params.empId)
  const q = qs.toString()
  return apiFetch<{ summary: BonusSummary }>(`/bonus-runs/summary${q ? `?${q}` : ""}`)
}

export function exportBonusRunXlsx(run: Pick<BonusRun, "id" | "label">) {
  return apiDownload(`/bonus-runs/${run.id}/export.xlsx`, `獎金季發放-${run.label}.xlsx`)
}

export function getMyBonusHistory() {
  return apiFetch<{ rows: MyBonusHistoryRow[]; total: number }>("/my/bonus-history")
}

/* -------------------------------------------------------------------- 顯示 -- */
export const BONUS_RUN_STATUS_LABELS: Record<BonusRunStatus, string> = {
  draft: "草稿",
  pending_approval: "送審中",
  approved: "已核准",
  paid: "已發放",
}

export const BONUS_BASIS_LABELS: Record<BonusBasis, string> = {
  gross_profit: "毛利制",
  legacy_pool: "舊制（手填獎金池）",
  fixed_amount: "固定金額",
}

export const BONUS_ARCHIVE_EXCLUDE_LABELS: Record<string, string> = {
  duplicate_replaced: "已複製成新案（原案不重複採計）",
  archived_settled: "已封存，所有成員的獎金都已結清",
}

export const BONUS_SKIP_REASON_LABELS: Record<BonusSkipReason, string> = {
  no_contract: "沒有我方承攬合約（無分母）",
  no_pool: "pool_pct 但沒填獎金池",
}

const BONUS_ERRORS: Record<string, string> = {
  label_exists: "這個期別已經有一筆批次（同期別只能一筆；先刪掉舊草稿再建）",
  not_draft: "這個狀態不能做這個動作（已發放的批次是凍結快照；送審中／已核准要先退回草稿才能刪除）",
  not_approved: "要先送審並經老闆核准才能發放",
  not_pending: "只有送審中的批次能核准",
  not_returnable: "只有送審中或已核准的批次能退回",
  not_withdrawable: "只有送審中（尚未核准）的批次能撤回；已核准請老闆退回",
  not_approver: "只有老闆（租戶設定的最終核准人）能核准或退回",
  boss_not_configured: "還沒設定老闆（最終核准人）——請先到「公司設定 → 簽核」設定老闆再送審",
  amount_changed: "送審後金額有變動：老闆請按「退回」；HR 請按「重算」（會自動退回草稿）後重新送審",
  status_changed: "狀態剛被別人改過，請重新整理",
  schema_not_ready: "資料庫尚未套用獎金核准（migration 0073），請先通知管理員套用",
  stale_paid_before: "這份草稿建立後又有別的批次發放了，累計已發已過期——請先「重算」再發放",
  not_paid: "只有已發放的批次才能沖銷；草稿直接刪除即可",
  already_reversed: "這批已經有沖銷批次了（可能還是草稿，到批次列表找「-沖銷」那筆）",
  not_latest_paid: "只能沖銷最新一批已發放的批次——後面已經有別批發放了，要沖就從最新的往回沖",
  reversal_of_reversal: "沖銷批次不能再被沖銷",
  reversal_not_editable: "沖銷批次的內容是原批取負，不能重算或改期別；只能改備註",
  invalid_body: "欄位格式不正確",
  invalid_query: "查詢參數不正確",
  not_found: "找不到這筆批次（可能已刪除）",
}

export function humanizeBonusError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  for (const [code, text] of Object.entries(BONUS_ERRORS)) {
    if (msg.includes(code)) return text
  }
  return msg
}

/** 今天（瀏覽器本地）'YYYY-MM-DD'。 */
export function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** 預設期別標籤：基準日所在年-季，如 2026-08-15 → "2026-Q3"。 */
export function defaultBonusLabel(dateKey: string): string {
  const month = Number(dateKey.slice(5, 7))
  const q = Math.min(4, Math.max(1, Math.ceil(month / 3)))
  return `${dateKey.slice(0, 4)}-Q${q}`
}

export function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString("zh-TW")
}

export function fmtPct(p: number | null | undefined): string {
  return p == null ? "—" : `${Math.round(p * 1000) / 10}%`
}
