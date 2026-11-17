import {
  leaveBalanceSummaryView,
  leaveTypeBalanceItems,
  type LeaveBalanceSummary,
  type LeaveTypeBalanceEntry,
} from "@/lib/leave-balance-summary";

/** 簽核卡片／後台簽核表格的剩餘假小字（只有請假列且 API 有附 leaveBalance 才顯示）。 */
export function LeaveBalanceSummaryText({
  balance,
  hours,
  leaveTypeName,
  className = "",
}: {
  balance: LeaveBalanceSummary | null | undefined;
  hours: number | string | null | undefined;
  /** 本單假別名稱：寫進「今年已請{假別}」「{假別}剩餘」。 */
  leaveTypeName?: string | null;
  className?: string;
}) {
  const view = leaveBalanceSummaryView(balance, hours, leaveTypeName);
  if (!view) return null;
  return (
    <span className={className}>
      <span className="text-gray-600">{view.text}</span>
      {view.warning && <span className="block font-medium text-red-600">{view.warning}</span>}
    </span>
  );
}

/**
 * 申請人各假別已請／剩餘一覽（簽核表格與「待我簽核」卡片共用）。本單假別粗體＋品牌色底，其餘灰字。
 * 沒資料（非簽核中的請假列、API 沒附）→ 不顯示。
 */
export function LeaveTypeBalanceList({
  list,
  hoursPerDay,
  className = "",
  showHeading = true,
}: {
  list: LeaveTypeBalanceEntry[] | null | undefined;
  hoursPerDay: number | null | undefined;
  className?: string;
  /** 外面已有標籤（ESS 卡片的 dt）時關掉。 */
  showHeading?: boolean;
}) {
  const items = leaveTypeBalanceItems(list, hoursPerDay);
  if (items.length === 0) return null;
  return (
    <div className={className} data-testid="leave-type-balances">
      {showHeading && <p className="text-gray-400">申請人各假別（今年）</p>}
      <ul className={showHeading ? "mt-0.5 space-y-0.5" : "space-y-0.5"}>
        {items.map((item) => (
          <li
            key={item.leaveTypeId}
            aria-current={item.current ? "true" : undefined}
            className={
              item.current
                ? "rounded px-1 font-semibold text-gray-900"
                : "px-1 text-gray-500"
            }
            style={item.current ? { background: "color-mix(in srgb, var(--brand) 14%, transparent)" } : undefined}
          >
            <span className={item.current ? "" : "text-gray-700"}>{item.name}</span>{" "}
            <span className={item.overused ? "text-red-600" : ""}>{item.text}</span>
            {item.current && <span className="ml-1 text-[10px] font-normal text-gray-500">（本單）</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
