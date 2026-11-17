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

/**
 * requestHours：本單時數（leave_requests.hours）。
 * leaveTypeName：本單假別名稱（API 的 leave_type_name，租戶假別設定為準）；有給就寫進文字，
 * 讓主管知道是哪個假別的累計（「今年已請病假 8 小時」「特休剩餘 40 小時」）。
 */
export function leaveBalanceSummaryView(
  lb: LeaveBalanceSummary | null | undefined,
  requestHours: number | string | null | undefined,
  leaveTypeName?: string | null,
): LeaveBalanceSummaryView | null {
  if (!lb) return null;
  const hpd = lb.hoursPerDay;
  const name = (leaveTypeName ?? "").trim();
  if (!lb.capped || lb.remainingHours == null) {
    const used = round2(num(lb.usedHours));
    return { text: `今年已請${name ? name : ""} ${used} 小時（約 ${formatLeaveDuration(used, hpd)}）`, warning: null };
  }
  const remaining = round2(num(lb.remainingHours));
  const pending = round2(num(lb.pendingHours));
  const label = name ? `${name}剩餘` : lb.source === "comp" ? "補休剩餘" : "剩餘";
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

/**
 * 申請人「各假別」一覽（2026-11-17 業主：每張請假單都要看到這個人各假別今年已請多少、還剩多少）。
 * 資料是 API 附的 `leaveBalancesByType`（apps/api/src/services/leave-balance-summary.ts，與擋額度、ESS 假別額度同一套算法）。
 */
export interface LeaveTypeBalanceEntry {
  leaveTypeId: string;
  name: string;
  /** 本張申請的假別。 */
  current: boolean;
  capped: boolean;
  source: "balance" | "comp" | null;
  remainingHours: number | null;
  pendingHours: number;
  usedHours: number;
}

export interface LeaveTypeBalanceItem {
  leaveTypeId: string;
  name: string;
  current: boolean;
  /** 「已請 16 小時／剩 40 小時（約 5 天）・簽核中 4 小時」；無額度「已請 12 小時（無額度）」。 */
  text: string;
  /** 剩餘為負（超用）。 */
  overused: boolean;
}

/** 各假別一覽 → 每項的顯示文字（天數用 API 回的每日工時換算）。 */
export function leaveTypeBalanceItems(
  list: LeaveTypeBalanceEntry[] | null | undefined,
  hoursPerDay: number | null | undefined,
): LeaveTypeBalanceItem[] {
  if (!list || list.length === 0) return [];
  const hpd = hoursPerDay ?? undefined;
  return list.map((e) => {
    const used = round2(num(e.usedHours));
    const pending = round2(num(e.pendingHours));
    const pendingText = pending > 0 ? `・簽核中 ${pending} 小時` : "";
    if (!e.capped || e.remainingHours == null) {
      return { leaveTypeId: e.leaveTypeId, name: e.name, current: e.current, text: `已請 ${used} 小時（無額度）${pendingText}`, overused: false };
    }
    const remaining = round2(num(e.remainingHours));
    const remainText =
      remaining < 0 ? formatLeaveRemaining(remaining, hpd) : `剩 ${remaining} 小時（約 ${formatLeaveRemaining(remaining, hpd)}）`;
    return {
      leaveTypeId: e.leaveTypeId,
      name: e.name,
      current: e.current,
      text: `已請 ${used} 小時／${remainText}${pendingText}`,
      overused: remaining < 0,
    };
  });
}
