/**
 * 遲到說明（late_reports，2026-10-11）client＋型別。後台「出勤 → 遲到說明」與員工端簽核頁共用。
 *
 *   GET  /late-reports?period=&employeeId=&decision=   老闆／HR 看全公司、主管看部屬、每人看自己
 *   POST /late-reports/:id/decision { decision, note? } 只有老闆（其他人 403 not_boss）
 *
 * 形狀手抄自 apps/api/src/services/late-reports.ts 的 LateReportView。
 */
import { apiFetch } from "./api-client";

export type LateDecision = "affects" | "exempt" | null;
export type LateDecisionFilter = "undecided" | "affects" | "exempt" | "all";

export interface LateReport {
  id: string;
  employeeId: string;
  employeeName: string;
  /** 'YYYY-MM-DD'（租戶時區的上班日）。 */
  workDate: string;
  /** 上班卡時間（ISO）。 */
  punchAt: string;
  lateMinutes: number;
  reason: string;
  /** affects＝影響全勤、exempt＝不影響、null＝老闆尚未決定（視為影響）。 */
  decision: LateDecision;
  decidedByEmpId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface LateReportList {
  lateReports: LateReport[];
  /** 呼叫者是不是老闆（只有老闆能按決定）。 */
  canDecide: boolean;
  scope: "all" | "team";
}

export function getLateReports(params: { period?: string; employeeId?: string; decision?: LateDecisionFilter } = {}) {
  const qs = new URLSearchParams();
  if (params.period) qs.set("period", params.period);
  if (params.employeeId) qs.set("employeeId", params.employeeId);
  if (params.decision) qs.set("decision", params.decision);
  const query = qs.toString();
  return apiFetch<LateReportList>(`/late-reports${query ? `?${query}` : ""}`);
}

export function decideLateReport(id: string, decision: "affects" | "exempt", note?: string) {
  return apiFetch<{ lateReport: LateReport }>(`/late-reports/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(note && note.trim() ? { note: note.trim() } : {}) }),
  });
}
