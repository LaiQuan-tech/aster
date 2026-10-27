/**
 * ESS「待我簽核」的多選批次簽核（2026-10-11，0930 會議：主管在手機一次簽多張）。
 *
 * 後端是既有的 `POST /requests/batch-decision`：任何登入的員工都能呼叫，但**逐張**檢查是不是
 * 「輪到他簽」——不是的那張回 `{ ok:false, error:'not_current_approver' }`，其他張照常、整批 HTTP 仍是 200
 * （apps/api/src/routes/requests.ts；測試在 apps/api 的 requests-batch-decision.test.ts）。
 * 這支檔案放前端這一側的純函式（勾選、分批送、結果彙整、錯誤碼翻成人話）與那支 API 的呼叫。
 *
 * 放款單走另一套 API（`/disbursements/:id/approve`，獨立簽核表、沒有批次端點），不在這裡，維持逐張。
 *
 * 為什麼自己分批送：API 單次上限 100 張、而且伺服器逐張依序處理（每張要讀寫十幾次 DB），
 * 一次丟太多可能撞到函式逾時；每批 {@link BATCH_CHUNK_SIZE} 張依序送，超過 100 張的「全選」也能處理。
 */
import { apiFetch, type ApiError } from "./api-client";
import { PERIOD_CLOSED_CODE, periodClosedMessage, periodClosedPeriod } from "./period-closed";

export type BatchAction = "approve" | "reject";

export type BatchItemResult =
  | { ok: true; id: string; status: "pending" | "approved" | "rejected"; currentStep: number; notified?: number }
  | {
      ok: false;
      id: string;
      error: string;
      /** `error: "period_closed"`（這張單碰到已發薪鎖定的月份）時伺服器附的最早已結算月 'YYYY-MM'。 */
      period?: string;
    };

export interface BatchDecisionResponse {
  ok: number;
  failed: number;
  results: BatchItemResult[];
}

export interface BatchDecisionBody {
  ids: string[];
  action: BatchAction;
  comment?: string;
}

/** POST /requests/batch-decision。呼叫端通常用 {@link runBatchDecision}（會分批、不丟例外）。 */
export function batchDecideRequests(body: BatchDecisionBody) {
  return apiFetch<BatchDecisionResponse>("/requests/batch-decision", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------ 分批 --- */

/** 每批送幾張（API 上限 100；伺服器逐張處理，批小一點才不會逾時）。 */
export const BATCH_CHUNK_SIZE = 20;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/** 整批請求失敗（沒拿到逐張結果）時的錯誤代碼：有 API 錯誤碼用它，否則依 HTTP 狀態，再不然視為網路問題。 */
export function errorCodeOf(err: unknown): string {
  const e = err as Partial<ApiError> | null;
  if (e && typeof e.code === "string" && e.code) return e.code;
  if (e && typeof e.status === "number") return `http_${e.status}`;
  return "network_error";
}

/**
 * 依序分批送出，回傳每一張的結果（順序同 `ids` 去重後）。**不丟例外**：
 *   • 某一批整批失敗（網路中斷、逾時、401／403／5xx）→ 那一批每張都記成失敗（錯誤碼見 {@link errorCodeOf}），
 *     繼續送下一批——前面已經成功的不會被當成沒做。
 *   • 伺服器沒回報某張的結果 → 記成 `no_result`，不假裝成功。
 * 注意：整批逾時時伺服器可能已處理了其中幾張，所以這類失敗的說明是「結果不確定，請重新整理確認」。
 */
export async function runBatchDecision(
  params: { ids: readonly string[]; action: BatchAction; comment?: string },
  send: (body: BatchDecisionBody) => Promise<BatchDecisionResponse> = batchDecideRequests,
  chunkSize: number = BATCH_CHUNK_SIZE,
): Promise<BatchItemResult[]> {
  const ids = Array.from(new Set(params.ids));
  const comment = params.comment?.trim();
  const results: BatchItemResult[] = [];
  for (const part of chunk(ids, chunkSize)) {
    try {
      const res = await send({ ids: part, action: params.action, ...(comment ? { comment } : {}) });
      const byId = new Map<string, BatchItemResult>();
      for (const item of Array.isArray(res?.results) ? res.results : []) byId.set(item.id, item);
      for (const id of part) results.push(byId.get(id) ?? { ok: false, id, error: "no_result" });
    } catch (err) {
      const error = errorCodeOf(err);
      // 整批被 409 period_closed 擋下（正常是逐張回結果，這是保底）：月份一併帶著，畫面才寫得出「YYYY-MM 已結算」。
      const period = periodClosedPeriod(err);
      for (const id of part) results.push({ ok: false, id, error, ...(period ? { period } : {}) });
    }
  }
  return results;
}

/* -------------------------------------------------------------- 勾選 --- */

/** 勾選／取消勾選一張（回新陣列，不改原陣列）。 */
export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}

/** 依清單順序取出「仍在清單裡」的已勾選項（清單重抓後被處理掉的單自動從勾選裡消失；送出順序＝畫面順序）。 */
export function selectedInOrder(selected: readonly string[], allIds: readonly string[]): string[] {
  const set = new Set(selected);
  return allIds.filter((id) => set.has(id));
}

/** 清單非空，而且每一張都已勾選。 */
export function isAllSelected(selected: readonly string[], allIds: readonly string[]): boolean {
  return allIds.length > 0 && selectedInOrder(selected, allIds).length === allIds.length;
}

/* ---------------------------------------------------------- 錯誤說明 --- */

const ERROR_TEXT: Record<string, string> = {
  not_current_approver: "這張單目前不是輪到你簽核。",
  own_request: "不能簽核自己的單。",
  already_signed_step: "你已經簽過這張單前面的關卡，同一張單不能再簽下一關，請由其他簽核人處理。",
  not_pending: "這張單已被處理過（或已撤回），請重新整理。",
  not_found: "找不到這張單，可能已被註銷。",
  attachment_required: "此假別需要附件，申請人尚未上傳，無法核准（可駁回請其補件）。",
  current_step_not_found: "這張單的簽核關卡資料有問題，請聯絡人資。",
  internal_error: "系統暫時無法處理這張單，結果不確定，請重新整理確認。",
  no_result: "伺服器沒有回報這張單的結果，請重新整理確認。",
  network_error: "網路連線異常，這張單的結果不確定，請重新整理確認。",
  not_an_employee: "這個帳號尚未對應到員工資料，無法簽核。",
  ess_tab_disabled: "你的帳號沒有開放簽核功能。",
  unauthorized: "登入已過期，請重新登入。",
  invalid_token: "登入已過期，請重新登入。",
  invalid_body: "送出的內容格式不正確，請重新整理後再試。",
};

/**
 * 錯誤代碼 → 主管看得懂的話。不認得的（例如伺服器附的原始 DB 訊息）一律用通用說明，
 * 不把內部錯誤文字秀給使用者。`period_closed`（發薪鎖定，整批仍是 HTTP 200、只有那一張失敗）
 * 帶上伺服器附的月份 →「YYYY-MM 已結算，請洽管理者」，沒附月份就是「該月份已結算，請洽管理者」。
 */
export function describeBatchError(code: string, period?: string | null): string {
  if (code === PERIOD_CLOSED_CODE) return periodClosedMessage(period);
  const known = ERROR_TEXT[code];
  if (known) return known;
  if (/^http_5\d\d$/.test(code)) return "伺服器暫時異常，這張單的結果不確定，請重新整理確認。";
  return "處理失敗，請稍後再試或聯絡人資。";
}

/* ---------------------------------------------------------- 結果彙整 --- */

export interface BatchFailure {
  id: string;
  /** 畫面上認得出是哪一張（例：「王小明 · 請假（特休）· 10/13 09:00」）。 */
  label: string;
  reason: string;
}

export interface BatchSummary {
  action: BatchAction;
  total: number;
  okCount: number;
  failedCount: number;
  /** 核准成功、但單子還有下一關（status 仍是 pending）的張數；它們算在 okCount 裡。 */
  advancedCount: number;
  failures: BatchFailure[];
}

export function summarizeBatch(
  action: BatchAction,
  results: readonly BatchItemResult[],
  labelOf: (id: string) => string,
): BatchSummary {
  const failures: BatchFailure[] = [];
  let okCount = 0;
  let advancedCount = 0;
  for (const result of results) {
    if (result.ok) {
      okCount += 1;
      if (action === "approve" && result.status === "pending") advancedCount += 1;
    } else {
      failures.push({ id: result.id, label: labelOf(result.id), reason: describeBatchError(result.error, result.period) });
    }
  }
  return { action, total: results.length, okCount, failedCount: failures.length, advancedCount, failures };
}

export const batchActionVerb = (action: BatchAction): string => (action === "approve" ? "核准" : "駁回");

/** 底部固定列的按鈕文字：「核准（3）」「駁回（3）」。 */
export const batchActionLabel = (action: BatchAction, count: number): string => `${batchActionVerb(action)}（${count}）`;

export function batchSummaryTitle(summary: BatchSummary): string {
  return `批次${batchActionVerb(summary.action)}結果`;
}

/** 「成功 5 張（其中 2 張已送往下一關）、失敗 1 張」；全部成功就不提失敗。 */
export function batchSummaryLine(summary: BatchSummary): string {
  const advanced = summary.advancedCount > 0 ? `（其中 ${summary.advancedCount} 張已送往下一關）` : "";
  const success = `成功 ${summary.okCount} 張${advanced}`;
  return summary.failedCount > 0 ? `${success}、失敗 ${summary.failedCount} 張` : success;
}

/** Toast 的語氣：全成功 success、部分失敗 info、全失敗 error。 */
export function batchToastTone(summary: BatchSummary): "success" | "info" | "error" {
  if (summary.failedCount === 0) return "success";
  return summary.okCount === 0 ? "error" : "info";
}

export function batchToastMessage(summary: BatchSummary): string {
  return `批次${batchActionVerb(summary.action)}完成：${batchSummaryLine(summary)}`;
}
