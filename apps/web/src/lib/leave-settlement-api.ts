/**
 * B8「假單月底核銷」第二階段的 client + 型別。
 *
 * 對應 apps/api 的 /leave-settlement 端點（後端由另一 agent 平行開發，本檔依
 * 逐字相同的 API contract 撰寫，尚未對過實際回應——若之後與後端實際回應形狀
 * 不一致，以後端實際回應為準回來改這裡，欄位命名等）。
 *
 * fetch 慣例照抄 attendance-sheets-api.ts / disbursements-api.ts：apiFetch／
 * apiDownload 來自 ./api-client（自動帶 Authorization、組 base URL、非 2xx 丟
 * Error），路徑一律直接掛在 API 根目錄（沒有額外的 /api 前綴），刻意獨立成
 * 新檔、不改 admin-api.ts。
 *
 * GET /requests/:id/attachments 是既有端點（見 apps/api/src/routes/attachments.ts
 * 第 150-205 行），目前前端還沒有任何呼叫端（ess/approvals 只顯示既有的
 * attachment_count，沒有點開清單）；因為這次任務範圍只能新增這個檔案，附件
 * 清單的 typed wrapper 也放在這裡，不是新端點、回應形狀已對照後端程式碼確認。
 */
import { apiFetch, apiDownload } from "./api-client";

/* ---------------------------------------------------------------- 型別 -- */

export type SettlementStatusFilter = "unsettled" | "settled" | "all";

export interface SettlementEmployee {
  id: string;
  name: string;
  employeeNo: string;
  departmentName: string | null;
}

export interface SettlementLeaveType {
  id: string;
  name: string;
  deductRate: number;
}

export interface SettlementItem {
  id: string;
  employee: SettlementEmployee;
  leaveType: SettlementLeaveType;
  startDate: string;
  endDate: string;
  hours: number;
  requiresAttachment: boolean;
  attachmentCount: number;
  settledAt: string | null;
  settledBy: { id: string; name: string } | null;
  /** 核銷時 HR 選的月份（YYYY-MM）；跨月假單可能不等於目前查詢的 period。 */
  settledPeriod: string | null;
  /**
   * 假單期間有一部分落在查詢月份之外。清單改成「期間重疊」歸屬後（後端
   * services/leave-settlement.ts 檔頭），1/28–2/3 的假單 1 月與 2 月都會出現，
   * 靠這個旗標標示「跨月」，避免 HR 以為兩個月各有一張。
   */
  crossMonth: boolean;
}

export interface HoursByLeaveType {
  leaveTypeId: string;
  leaveTypeName: string;
  totalHours: number;
}

export interface SettlementSummary {
  totalCount: number;
  settledCount: number;
  unsettledCount: number;
  hoursByLeaveType: HoursByLeaveType[];
}

export interface LeaveSettlementListResponse {
  period: string;
  summary: SettlementSummary;
  items: SettlementItem[];
}

export interface LeaveSettlementListParams {
  period: string;
  deptId?: string;
  /** 核銷狀態篩選；省略時後端預設 unsettled。 */
  status?: SettlementStatusFilter;
}

export type SettlementSkipReason = "not_approved" | "already_settled" | "attachment_missing";

export interface SettleResult {
  settled: number;
  skipped: { id: string; reason: SettlementSkipReason }[];
}

export interface UnsettleResult {
  unsettled: number;
}

/** GET /requests/:id/attachments 既有端點的回應形狀（見檔頭註解）。 */
export interface RequestAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  /** signed URL，1 小時過期。 */
  url: string | null;
}

/* -------------------------------------------------------------- 查詢字串 -- */
function buildQuery(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    qs.set(key, value);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/* ---------------------------------------------------------------- API -- */

export function listLeaveSettlements(params: LeaveSettlementListParams) {
  return apiFetch<LeaveSettlementListResponse>(
    `/leave-settlement${buildQuery({ period: params.period, deptId: params.deptId, status: params.status })}`,
  );
}

/** 核銷（勾選或全部）；body 只需 period + ids，回應逐筆列出略過原因。 */
export function settleLeaveRequests(period: string, ids: string[]) {
  return apiFetch<SettleResult>("/leave-settlement/settle", {
    method: "POST",
    body: JSON.stringify({ period, ids }),
  });
}

/** 取消核銷；reason 為必填，由呼叫端（UI）擋空字串。 */
export function unsettleLeaveRequests(ids: string[], reason: string) {
  return apiFetch<UnsettleResult>("/leave-settlement/unsettle", {
    method: "POST",
    body: JSON.stringify({ ids, reason }),
  });
}

/** 匯出跟列表共用同一組篩選參數，才能保證匯出列數等於畫面上看到的列數。 */
export function exportLeaveSettlementXlsx(params: LeaveSettlementListParams, filename: string) {
  return apiDownload(
    `/leave-settlement/export.xlsx${buildQuery({ period: params.period, deptId: params.deptId, status: params.status })}`,
    filename,
  );
}

/** GET /requests/:id/attachments —— 既有端點，見檔頭註解，不是本次新增的後端範圍。 */
export function listRequestAttachments(requestId: string) {
  return apiFetch<{ attachments: RequestAttachment[] }>(`/requests/${requestId}/attachments`);
}

/* -------------------------------------------------------------- 顯示小工具 -- */

export const SETTLEMENT_SKIP_REASON_LABEL: Record<SettlementSkipReason, string> = {
  not_approved: "尚未核准",
  already_settled: "已核銷過",
  attachment_missing: "缺附件",
};

/** 把 apiFetch 丟出的 Error（訊息格式 `[status] code或訊息`）轉成中文提示；照抄 attendance-sheets-api.ts 的 friendlyError 寫法。 */
export function friendlySettlementError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    const code = err.message.replace(/^\[\d+\]\s*/, "").trim();
    const map: Record<string, string> = {
      forbidden: "沒有權限執行此操作",
      unauthorized: "請重新登入",
      not_found: "找不到這筆假單",
      invalid_body: "送出的內容格式不正確",
      invalid_query: "查詢參數不正確",
      invalid_period: "月份格式不正確，請用 YYYY-MM",
      reason_required: "必須填寫理由",
    };
    return map[code] ?? err.message;
  }
  return fallback;
}

/** 把 settle() 回應的 skipped 陣列彙總成一句中文摘要（依原因分組計數），供訊息提示使用。 */
export function summarizeSkipped(skipped: SettleResult["skipped"]): string {
  if (skipped.length === 0) return "";
  const counts = new Map<SettlementSkipReason, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([reason, count]) => `${SETTLEMENT_SKIP_REASON_LABEL[reason] ?? reason} ${count}`)
    .join("、");
}
