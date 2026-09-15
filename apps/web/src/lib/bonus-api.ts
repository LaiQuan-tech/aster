/**
 * D1 專案獎金季發放批次（bonus_runs）的 typed API 呼叫。
 * 後端見 apps/api/src/routes/bonus-runs.ts；回應形狀對過 services/bonus-run-store.ts
 * 的 SerializedRun／SerializedItem／BonusSummary。刻意獨立成新檔、不改 projects-api.ts。
 */
import { apiFetch, apiDownload } from "./api-client"

/* ---------------------------------------------------------------- 基本型別 -- */
export type BonusRunStatus = "draft" | "paid"
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
}

export interface BonusRun {
  id: string
  label: string
  asOf: string
  status: BonusRunStatus
  paidOn: string | null
  totals: BonusTotals
  note: string | null
  createdByEmpId: string | null
  paidByEmpId: string | null
  createdAt: string
  updatedAt: string
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
  contractTotal: number | null
  receivedTotal: number
  /** 0～1。 */
  receivedPct: number
  entitledCumulative: number
  paidBefore: number
  amount: number
  overpaid: boolean
  overpaidBy: number
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
}

export interface BonusRunDetail {
  run: BonusRun
  items: BonusRunItem[]
  snapshot: BonusRunSnapshot | null
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

export interface MyBonusHistoryRow extends BonusRunItem {
  label: string
  asOf: string
  paidOn: string | null
}

/* -------------------------------------------------------------------- 呼叫 -- */
export function previewBonusRun(body: { asOf?: string; label?: string }) {
  return apiFetch<BonusRunPreview>("/bonus-runs/preview", { method: "POST", body: JSON.stringify(body) })
}

export function createBonusRun(body: { asOf: string; label: string; note?: string | null }) {
  return apiFetch<BonusRunDetail>("/bonus-runs", { method: "POST", body: JSON.stringify(body) })
}

export function listBonusRuns() {
  return apiFetch<{ runs: BonusRun[] }>("/bonus-runs")
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
  paid: "已發放",
}

export const BONUS_SKIP_REASON_LABELS: Record<BonusSkipReason, string> = {
  no_contract: "沒有我方承攬合約（無分母）",
  no_pool: "pool_pct 但沒填獎金池",
}

const BONUS_ERRORS: Record<string, string> = {
  label_exists: "這個期別已經有一筆批次（同期別只能一筆；先刪掉舊草稿再建）",
  not_draft: "已發放的批次是凍結快照，不能修改或刪除",
  stale_paid_before: "這份草稿建立後又有別的批次發放了，累計已發已過期——請先「重算」再發放",
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
