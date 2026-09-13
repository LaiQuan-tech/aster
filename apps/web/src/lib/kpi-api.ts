/**
 * 績效考核（KPI）的 typed API 呼叫。後端見 apps/api/src/routes/{kpi-templates,kpi-reviews}.ts。
 * admin（HR：範本、指派、定案）與 ess（考核者：評分、送出；受評者：看定案結果）共用。
 * 可見性由後端分流：非 HR 只拿得到「自己要評的」與「自己被評且已定案的」。
 */
import { apiFetch } from "./api-client"

export interface KpiTemplateItem {
  key: string
  label: string
  weight: number
  maxScore: number
}

export interface KpiTemplate {
  id: string
  name: string
  items: KpiTemplateItem[]
  active: boolean
  created_at: string
}

export type KpiReviewStatus = "draft" | "submitted" | "finalized"

export interface KpiScore {
  key: string
  score: number
  comment?: string
}

export interface KpiReview {
  id: string
  employee_id: string
  reviewer_emp_id: string
  template_id: string
  period: string
  scores: KpiScore[]
  total_score: string | null
  status: KpiReviewStatus
  created_at: string
  updated_at: string
}

export const REVIEW_STATUS_LABEL: Record<KpiReviewStatus, string> = {
  draft: "評分中",
  submitted: "已送出",
  finalized: "已定案",
}

export function listKpiTemplates() {
  return apiFetch<{ templates: KpiTemplate[] }>("/kpi-templates")
}
export function createKpiTemplate(body: { name: string; items: KpiTemplateItem[]; active?: boolean }) {
  return apiFetch<{ template: KpiTemplate }>("/kpi-templates", { method: "POST", body: JSON.stringify(body) })
}
export function updateKpiTemplate(id: string, body: Partial<{ name: string; items: KpiTemplateItem[]; active: boolean }>) {
  return apiFetch<{ template: KpiTemplate }>(`/kpi-templates/${id}`, { method: "PATCH", body: JSON.stringify(body) })
}
export function deleteKpiTemplate(id: string) {
  return apiFetch<{ id: string }>(`/kpi-templates/${id}`, { method: "DELETE" })
}

export function listKpiReviews(params: { period?: string; status?: KpiReviewStatus } = {}) {
  const qs = new URLSearchParams()
  if (params.period) qs.set("period", params.period)
  if (params.status) qs.set("status", params.status)
  const q = qs.toString()
  return apiFetch<{ reviews: KpiReview[] }>(`/kpi-reviews${q ? `?${q}` : ""}`)
}
export function assignKpiReview(body: { employeeId: string; reviewerEmpId: string; templateId: string; period: string }) {
  return apiFetch<{ review: KpiReview }>("/kpi-reviews", { method: "POST", body: JSON.stringify(body) })
}
export function scoreKpiReview(id: string, scores: KpiScore[]) {
  return apiFetch<{ review: KpiReview }>(`/kpi-reviews/${id}`, { method: "PATCH", body: JSON.stringify({ scores }) })
}
export function submitKpiReview(id: string) {
  return apiFetch<{ review: KpiReview }>(`/kpi-reviews/${id}/submit`, { method: "POST" })
}
export function finalizeKpiReview(id: string) {
  return apiFetch<{ review: KpiReview }>(`/kpi-reviews/${id}/finalize`, { method: "POST" })
}

/** 與後端 computeTotal 同一條公式：Σ (score / maxScore) × weight，四捨五入到小數 2 位。 */
export function computeKpiTotal(items: KpiTemplateItem[], scores: KpiScore[]): number {
  const byKey = new Map(scores.map((s) => [s.key, s.score]))
  let total = 0
  for (const it of items) {
    if (!(it.maxScore > 0)) continue
    total += ((byKey.get(it.key) ?? 0) / it.maxScore) * it.weight
  }
  return Math.round(total * 100) / 100
}

/** 預設考核期間：當季，例 2026-Q3。period 是自由文字，這只是預設值。 */
export function defaultKpiPeriod(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}
