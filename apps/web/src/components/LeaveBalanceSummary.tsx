import { leaveBalanceSummaryView, type LeaveBalanceSummary } from "@/lib/leave-balance-summary";

/** 簽核卡片／後台簽核表格的剩餘假小字（只有請假列且 API 有附 leaveBalance 才顯示）。 */
export function LeaveBalanceSummaryText({
  balance,
  hours,
  className = "",
}: {
  balance: LeaveBalanceSummary | null | undefined;
  hours: number | string | null | undefined;
  className?: string;
}) {
  const view = leaveBalanceSummaryView(balance, hours);
  if (!view) return null;
  return (
    <span className={className}>
      <span className="text-gray-600">{view.text}</span>
      {view.warning && <span className="block font-medium text-red-600">{view.warning}</span>}
    </span>
  );
}
