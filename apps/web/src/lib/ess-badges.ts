/**
 * ESS 底列徽章的計數（純函式，不碰 React／API；全部有單元測試）。
 *
 * 「簽核」分頁的紅點（2026-10-12）＝待簽申請單（GET /requests/pending-approvals 的筆數，
 * ess-state 的 `pendingApprovals`）＋老闆還能決定的遲到說明（`pendingLateReports`）。
 * 後者只有老闆會 >0；後台 AdminShell 的「簽核」徽章仍只看 `pendingApprovals`，不受影響。
 *
 * 遲到說明的計數規則跟簽核頁的「遲到說明」段（app/ess/approvals/_components/LateReportsSection.tsx）一致：
 *   - 伺服器回 `canDecide`（呼叫者是老闆）才算；主管、HR 看得到但不能決定 → 0。
 *   - 排除自己的遲到說明（簽核頁也不列自己的）。
 *   - 只算還沒決定的（decision 為 null；資料來自 GET /late-reports?decision=undecided，這裡再擋一次）。
 *   - 不算已經不能決定的（`lockedReason` 非 null：那個月已結算，或該員月表已核准／鎖定——API 會拒絕決定，
 *     簽核頁也不給按鈕；不排除的話這些永遠未決定，紅點會卡住）。舊 API 沒有這個欄位（缺席）＝照算。
 */
import type { LateReport } from "./late-reports-api";

export interface LateReportCountSource {
  lateReports: ReadonlyArray<Pick<LateReport, "employeeId" | "decision" | "lockedReason">>;
  canDecide: boolean;
}

/** 老闆還能決定的遲到說明筆數；`res` 缺席、不能決定或清單不是陣列 → 0。 */
export function countPendingLateReports(
  res: LateReportCountSource | null | undefined,
  meId: string | null | undefined,
): number {
  if (!res || res.canDecide !== true || !Array.isArray(res.lateReports)) return 0;
  let n = 0;
  for (const report of res.lateReports) {
    if (report.decision !== null && report.decision !== undefined) continue;
    if (report.lockedReason !== null && report.lockedReason !== undefined) continue;
    if (meId && report.employeeId === meId) continue;
    n++;
  }
  return n;
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 員工端「簽核」分頁的紅點數：待簽申請單＋待決定的遲到說明（負數／NaN 當 0）。 */
export function approvalsBadgeCount(counts: { pendingApprovals: number; pendingLateReports: number }): number {
  return nonNegative(counts.pendingApprovals) + nonNegative(counts.pendingLateReports);
}
