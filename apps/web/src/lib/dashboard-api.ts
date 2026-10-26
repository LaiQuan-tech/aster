/**
 * 後台首頁（app/admin/page.tsx）的讀取：GET /dashboard/boss-summary 一次拿齊「4 個大數字＋需要你處理」要的數字
 * （本年收入另由 GET /group-overview 提供，僅 HR）；boss-summary 404（API 還是舊版）時退回 getPendingRequestsCount 只算假單。
 */
import { apiFetch } from "./api-client";

/**
 * 「待簽核假單」卡只要筆數：GET /requests?status=pending&countOnly=1 與
 * GET /requests?status=pending 權限、篩選條件完全相同，只回 `{ count }`，不撈整批列、
 * 不跑逐列補齊（原本這張卡拿整批 requests 只為了 .length，約 24KB）。
 * 部署先後相容：舊 API 不認得 countOnly 會忽略、照樣回 `{ requests: [...] }`，這裡退回
 * requests.length，卡片數字不受部署順序影響。
 */
export async function getPendingRequestsCount(): Promise<number> {
  const r = await apiFetch<{ count?: number; requests?: unknown[] }>("/requests?status=pending&countOnly=1");
  return r.count ?? r.requests?.length ?? 0;
}

/* ---------------------------------------------- GET /dashboard/boss-summary --- */

/** 這個角色看得到哪些區塊（後端 services/boss-summary.ts bossSummaryScope）；false＝沒權限，true 但值 null＝查詢失敗。 */
export interface BossScope {
  leaveApprovals: boolean;
  disbursementApprovals: boolean;
  attendance: boolean;
  overtime: boolean;
  people: boolean;
  /** 以下三欄 2026-10-25 簡化版首頁才有；舊 API 沒回（undefined）→ 前端當「有權限、值讀不到」顯示「—」。 */
  receivables?: boolean;
  projectAlerts?: boolean;
  monthDisbursements?: boolean;
  /**
   * 2026-10-26 依身分分版才有：可看集團財務（本年收入／毛利率）；false → 首頁不打 /group-overview、第 1 格改 HR 日常數字。
   * 舊 API 沒回（undefined）→ 前端退回舊判斷（HR／平台管理員＝可看）。
   */
  groupFinancials?: boolean;
  /** 呼叫者是老闆（features.approval.fallbackApproverEmpId）→ 有 bossTodo。舊 API 沒回＝不是。 */
  isBoss?: boolean;
}

export interface BossSummary {
  /** 租戶當地本月 YYYY-MM。 */
  period: string;
  today: string;
  scope: BossScope;
  approvals: {
    leave: number | null;
    disbursements: number | null;
    disbursementAmount: number | null;
    total: number | null;
  };
  attendance: {
    sheetCount: number;
    /** error／warn、不含合規碼。 */
    anomalies: number;
    anomalySheets: number;
    compliance: { total: number; sevenDayRule: number; regularLeaveWork: number; dailyOver12h: number; monthlyOtOver46h: number };
  } | null;
  overtime: {
    overCapPeople: number | null;
    draftCount: number | null;
    draftAmount: number | null;
    draftMissingAmount: number | null;
    latestDraftPeriod: string | null;
  } | null;
  people: { active: number; hires: number; exits: number } | null;
  /** 未收款總額＋逾期筆數（＝應收頁 summary）。舊 API 沒有此欄。 */
  receivables?: { unreceivedTotal: number; overdueCount: number } | null;
  /** 專案示警件數（high＝高風險）。舊 API 沒有此欄。 */
  projectAlerts?: { total: number; high: number } | null;
  /** 本月已匯款放款（會計首頁那格；HR 為 null）。舊 API 沒有此欄。 */
  monthDisbursements?: { count: number; amount: number } | null;
  /** 老闆專屬待辦（scope.isBoss 才有）；數字 null＝該子查詢失敗。舊 API 沒有此欄。 */
  bossTodo?: { bonusRunsPendingApproval: number | null; lateReportsPending: number | null } | null;
}

/** 首頁要的數字一次回傳（finance 層可打，依角色裁切）。 */
export function getBossSummary(): Promise<BossSummary> {
  return apiFetch<BossSummary>("/dashboard/boss-summary");
}
