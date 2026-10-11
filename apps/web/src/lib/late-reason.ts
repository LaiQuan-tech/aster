/**
 * 遲到理由（2026-10-11 業主拍板）的純函式：打卡對話框文案、理由驗證、決定狀態的顯示。
 * 不碰 React／DOM／API；全部有單元測試（__tests__/late-reason.test.ts）。
 */
import type { LateDecision } from "./late-reports-api";

/** 理由長度上限（與 API 的 LATE_REASON_MAX 相同）。 */
export const LATE_REASON_MAX = 500;

/**
 * 打卡被擋下時的對話框說明：
 * 「你今天 HH:MM 上班，超過 10:00（遲到 N 分鐘），請填寫原因（主管與老闆會看到）」。
 * 門檻是伺服器回的（沒排班＝彈性時窗 10:00；有排班＝班別上班時間）；沒給就不寫「超過幾點」。
 */
export function lateReasonPrompt(input: { punchTime: string; threshold: string | null; lateMinutes: number }): string {
  const time = input.punchTime || "現在";
  const over = input.threshold ? `超過 ${input.threshold}` : "已超過上班時間";
  return `你今天 ${time} 上班，${over}（遲到 ${input.lateMinutes} 分鐘），請填寫原因（主管與老闆會看到）`;
}

/** 理由驗證：trim 後 1–500 字；回錯誤訊息或 null（可送出）。 */
export function lateReasonError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "請填寫遲到原因";
  if (trimmed.length > LATE_REASON_MAX) return `最多 ${LATE_REASON_MAX} 字（目前 ${trimmed.length} 字）`;
  return null;
}

/** 決定狀態的文字：未決定也要講清楚「視為影響全勤」。 */
export function lateDecisionLabel(decision: LateDecision): string {
  if (decision === "exempt") return "不影響全勤";
  if (decision === "affects") return "影響全勤";
  return "老闆尚未決定（視為影響全勤）";
}

/** 決定狀態的 Pill 色調。 */
export function lateDecisionTone(decision: LateDecision): "green" | "red" | "amber" {
  if (decision === "exempt") return "green";
  if (decision === "affects") return "red";
  return "amber";
}

/** 清單一行：「10/12（一）10:30 上班 · 遲到 30 分」。日期與時間由呼叫端格式化後傳入。 */
export function lateReportHeadline(input: { dateLabel: string; punchHm: string; lateMinutes: number }): string {
  return `${input.dateLabel} ${input.punchHm} 上班 · 遲到 ${input.lateMinutes} 分`;
}

/** 清單排序：老闆還沒決定的排前面，其餘依上班日新到舊、同日依打卡時間新到舊。不改原陣列。 */
export function sortLateReports<T extends { decision: LateDecision; workDate: string; punchAt: string }>(reports: readonly T[]): T[] {
  return [...reports].sort((a, b) => {
    const pendingA = a.decision === null ? 0 : 1;
    const pendingB = b.decision === null ? 0 : 1;
    if (pendingA !== pendingB) return pendingA - pendingB;
    if (a.workDate !== b.workDate) return a.workDate < b.workDate ? 1 : -1;
    return a.punchAt < b.punchAt ? 1 : a.punchAt > b.punchAt ? -1 : 0;
  });
}

/** 'YYYY-MM'（以傳入時間的本地日曆；預設現在）。 */
export function periodOf(now: Date = new Date()): string {
  const m = now.getMonth() + 1;
  return `${now.getFullYear()}-${m < 10 ? `0${m}` : m}`;
}
