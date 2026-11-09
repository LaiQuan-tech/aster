/**
 * 簽核卡片／後台簽核表格的「剩餘假」摘要文字（2026-11-09）。
 *
 * 資料來自 API 在 GET /requests/pending-approvals、GET /requests（HR）請假列附的 `leaveBalance`
 * （apps/api/src/services/leave-balance-summary.ts）：判斷與送單／核准擋額度同一套。
 *   • 有額度 →「剩餘 X 小時（約 Y）· 簽核中 Z 小時」；本單（＋其他簽核中）核准後超過剩餘 → 紅字提醒。
 *   • 無額度 →「今年已請 X 小時（約 Y）」。
 */
import { formatLeaveDuration, formatLeaveRemaining } from "./leave-duration";

export interface LeaveBalanceSummary {
  capped: boolean;
  source: "balance" | "comp" | null;
  remainingHours: number | null;
  pendingHours: number;
  usedHours: number;
  hoursPerDay: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export interface LeaveBalanceSummaryView {
  /** 主文字。 */
  text: string;
  /** 本單核准後會超過剩餘時的警示（紅字）；否則 null。 */
  warning: string | null;
}

/** requestHours：本單時數（leave_requests.hours）。 */
export function leaveBalanceSummaryView(
  lb: LeaveBalanceSummary | null | undefined,
  requestHours: number | string | null | undefined,
): LeaveBalanceSummaryView | null {
  if (!lb) return null;
  const hpd = lb.hoursPerDay;
  if (!lb.capped || lb.remainingHours == null) {
    const used = round2(num(lb.usedHours));
    return { text: `今年已請 ${used} 小時（約 ${formatLeaveDuration(used, hpd)}）`, warning: null };
  }
  const remaining = round2(num(lb.remainingHours));
  const pending = round2(num(lb.pendingHours));
  const label = lb.source === "comp" ? "補休剩餘" : "剩餘";
  const head =
    remaining < 0
      ? `${label} ${formatLeaveRemaining(remaining, hpd)}`
      : `${label} ${remaining} 小時（約 ${formatLeaveRemaining(remaining, hpd)}）`;
  const text = pending > 0 ? `${head} · 簽核中 ${pending} 小時` : head;
  const self = round2(num(requestHours));
  const after = round2(remaining - self);
  let warning: string | null = null;
  if (after < -0.001) warning = `本單核准後將超額 ${round2(-after)} 小時`;
  else if (round2(after - pending) < -0.001) warning = `本單＋其他簽核中合計將超額 ${round2(pending - after)} 小時`;
  return { text, warning };
}
