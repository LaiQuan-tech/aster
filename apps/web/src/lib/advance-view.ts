/**
 * 預支綁定與核銷的顯示用純函式（2026-10-11；不碰 React／DOM／API，全部有單元測試）。
 *
 *   • ESS 報銷頁：員工新增憑證時選「這筆是哪次預支的花費？」——列出自己**尚未核銷**的預支
 *     （出差或零用金的日期、地點或事由、預支金額、狀態），送出帶 `advanceId`。
 *   • 後台預支頁：核銷前的預覽（GET /advances/:id/settlement-preview）——這筆預支綁了哪些憑證、
 *     合計多少、差額多少，取代原本只用 `prompt` 就直接核銷。
 *
 * 型別對應 API：GET /advances 每列附 `request`（services/advance-settlement.ts AdvanceRequestSummary）；
 * 預覽的形狀是 SettlementPreview。ess-api.ts 的 `MyAdvance`、admin-api.ts 的 `Advance` 沒宣告 `request`，
 * 這裡用結構型別（`AdvanceLike`）接，兩邊的列都收得進來。
 */
import { fmtDateShort, fmtMoney } from "./ess-format";
import { describePeriodClosed, periodClosedMessage } from "./period-closed";
import {
  NETWORK_FAILURE_MESSAGE,
  UPLOAD_NETWORK_FAILURE_MESSAGE,
  UploadPrepError,
  apiErrorStatus,
  isNetworkFailure,
} from "./upload-prep";

/* ------------------------------------------------------------ 預支 --- */

/** 預支對應的申請單摘要（GET /advances 每列的 `request`；查不到＝null）。 */
export interface AdvanceRequestInfo {
  id?: string;
  /** 'business_trip' | 'petty_cash' */
  kind: string;
  start_at: string;
  end_at: string;
  location: string | null;
  reason: string | null;
  /** 'outing' 公出 | 'business_trip' 出差 */
  trip_type: string | null;
  trip_scope: string | null;
}

export interface AdvanceLike {
  id: string;
  /** 'trip' 出差預支 | 'petty_cash' 零用金預支 */
  kind: string;
  amount: string | number;
  /** 'requested' 已核准待撥款 | 'paid' 已撥款待核銷 | 'settled' 已核銷 | 'cancelled' 已取消 */
  status: string;
  paid_at?: string | null;
  created_at?: string;
  request?: AdvanceRequestInfo | null;
}

/** 尚未核銷＝可以被報銷單綁定（與 API services/expense-binding.ts 的 BINDABLE_ADVANCE_STATUSES 同一組）。 */
export const UNSETTLED_ADVANCE_STATUSES = ["requested", "paid"] as const;

export function isUnsettledAdvance(a: Pick<AdvanceLike, "status">): boolean {
  return (UNSETTLED_ADVANCE_STATUSES as readonly string[]).includes(a.status);
}

export function advanceStatusLabel(status: string): string {
  switch (status) {
    case "requested":
      return "已核准，尚未撥款";
    case "paid":
      return "已撥款，待核銷";
    case "settled":
      return "已核銷";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function clip(text: string | null | undefined, max = 14): string {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 預支背後那張單的名稱：「出差・台中客戶公司」「公出・市政府」「零用金・採買活動物資」。 */
export function advanceSubject(a: AdvanceLike): string {
  const r = a.request;
  if (a.kind === "petty_cash") {
    const reason = clip(r?.reason);
    return reason ? `零用金・${reason}` : "零用金";
  }
  const type = r?.trip_type === "outing" ? "公出" : "出差";
  const place = clip(r?.location) || clip(r?.reason);
  return place ? `${type}・${place}` : type;
}

/** 預支的日期（MM/DD）：申請單的起日（出差日、零用金申請日）；沒有申請單摘要就退回撥款日、建立日。 */
export function advanceDate(a: AdvanceLike, tz?: string): string {
  const iso = a.request?.start_at ?? a.paid_at ?? a.created_at ?? "";
  return iso ? fmtDateShort(iso, tz) : "—";
}

/** 下拉選項文字：「10/10 出差・台中客戶公司｜預支 NT$ 3,000（已撥款）」。 */
export function advanceOptionLabel(a: AdvanceLike, tz?: string): string {
  const state = a.status === "paid" ? "已撥款" : "尚未撥款";
  return `${advanceDate(a, tz)} ${advanceSubject(a)}｜預支 ${fmtMoney(a.amount)}（${state}）`;
}

/** 可綁的預支（尚未核銷），新的在前（依申請單起日；沒有就依建立日）。 */
export function bindableAdvances<T extends AdvanceLike>(advances: readonly T[]): T[] {
  const key = (a: AdvanceLike) => a.request?.start_at ?? a.created_at ?? a.paid_at ?? "";
  return advances.filter(isUnsettledAdvance).sort((x, y) => key(y).localeCompare(key(x)));
}

/* ------------------------------------------------------- 報銷頁錯誤 --- */

/** POST /expenses 的錯誤碼 → 中文（找不到的碼由呼叫端退回 fallback）。 */
export const EXPENSE_ERROR_MESSAGES: Record<string, string> = {
  invalid_advance: "選的預支已不能綁定（已核銷、已取消，或不是你的預支），請重新整理頁面後再選",
  invalid_trip_request: "選的出差單不能綁定（不是你的，或還沒核准），請重新整理頁面後再選",
  trip_request_required: "這個類別的費用必須綁定一張已核准的出差單",
  period_settled: "該月份已月結鎖定，不能再送出；請聯絡 HR",
  // 發薪鎖定（2026-10-11）：歸屬期已結算（送出、修改、撤回都會）。有月份時走 describePeriodClosed 的
  // 「YYYY-MM 已結算，請洽管理者」；這條是只有錯誤碼時的通用說法。
  period_closed: periodClosedMessage(),
  advance_settled: "這筆已隨預支核銷結算，不能再修改或撤回；有誤請聯絡 HR",
  invalid_category: "這個費用類別已停用，請重新選擇",
  filing_on_behalf_removed: "代為填報功能已移除，只能以本人身分送出",
  not_an_employee: "找不到你的員工資料，請聯絡 HR",
  // 憑證上傳（POST /expenses/:id/attachments）：API 收 5 MB，但經 Vercel 實際只傳得動約 3 MB（見 lib/upload-prep.ts），
  // 前端已先壓縮照片、擋下超過 3 MB 的檔，這條是保底。
  file_too_large: "檔案太大，單檔請在 3 MB 以內；請縮小或改傳照片／截圖",
};

/** apiFetch 的錯誤碼（`.code`，沒有就從 `[status] code` 的 message 取）；不是 Error → null。 */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  const fromMessage = err.message.replace(/^\[\d+\]\s*/, "").trim();
  return fromMessage || null;
}

/** 報銷頁的各個步驟：建單、上傳憑證、撤回、載入。斷線時只有上傳憑證會提「可能是檔案太大」。 */
export type ExpenseStep = "create" | "upload" | "cancel" | "load";

/**
 * 錯誤的中文原因（認得的才回）：歸屬期已發薪鎖定（409 period_closed）→「YYYY-MM 已結算，請洽管理者」；
 * 連線本身失敗（Failed to fetch／Load failed…）→ {@link NETWORK_FAILURE_MESSAGE}，上傳憑證時改用
 * {@link UPLOAD_NETWORK_FAILURE_MESSAGE}；前端準備憑證時擋下的（{@link UploadPrepError}，本來就是中文）→ 原樣；
 * 其餘查 {@link EXPENSE_ERROR_MESSAGES}。認不得（例如 `[500] upload_failed`）→ null：畫面不露出英文代碼，
 * 呼叫端改用該步驟的中文說法，原始錯誤記在 console。
 */
export function expenseErrorReason(err: unknown, step: ExpenseStep): string | null {
  const closed = describePeriodClosed(err);
  if (closed) return closed;
  if (isNetworkFailure(err)) return step === "upload" ? UPLOAD_NETWORK_FAILURE_MESSAGE : NETWORK_FAILURE_MESSAGE;
  if (err instanceof UploadPrepError) return err.message;
  const code = apiErrorCode(err);
  return code && EXPENSE_ERROR_MESSAGES[code] ? EXPENSE_ERROR_MESSAGES[code] : null;
}

/** 報銷送出／撤回失敗的中文說明：{@link expenseErrorReason}，認不得就用 fallback（該步驟的中文說法）。 */
export function expenseErrorMessage(err: unknown, fallback: string, step: ExpenseStep = "create"): string {
  return expenseErrorReason(err, step) ?? fallback;
}

/** 載入報銷資料（類別、我的報銷、出差單、預支）失敗的說明：一律中文，不露出「Load failed」「[500] …」。 */
export function expenseLoadErrorMessage(err: unknown): string {
  const reason = expenseErrorReason(err, "load");
  return reason ? `無法載入報銷資料：${reason}` : "無法載入報銷資料，請重新整理頁面再試";
}

/** 憑證上傳失敗時自動撤回剛建的單，寫進 status_reason 的理由（HR 在後台看得到）。 */
export const RECEIPT_AUTO_CANCEL_REASON = "憑證上傳失敗，系統自動撤回";

/**
 * 報銷送出時單已建好、憑證卻上傳失敗的說明（只有中文：括號附認得的原因，認不得就不附）：
 *   • 已自動撤回 → 請重新送出（表單保留，直接再按送出即可）；
 *   • 撤回也失敗 → 單還在、沒有憑證。頁面會記住這筆，下次送出先撤回它再建新單（說明見 {@link leftoverClaimNotice}）。
 */
export function receiptUploadFailedMessage(err: unknown, rolledBack: boolean): string {
  const reason = expenseErrorReason(err, "upload");
  const why = reason ? `（${reason}）` : "";
  return rolledBack
    ? `憑證上傳失敗，這筆報銷已自動撤回，請重新送出。${why}`
    : `憑證上傳失敗，自動撤回也沒有成功，這筆報銷目前沒有憑證。${why}`;
}

/** 有一筆留下的單（沒有憑證、還沒撤回）時，送出按鈕上方常駐的說明：再按送出會先撤回它，不會重複。 */
export function leftoverClaimNotice(period: string): string {
  return `${period} 有一筆報銷沒附到憑證、還沒撤回。直接再按「送出」會先撤回那一筆再重新送出，不會重複；也可以在下方列表自己撤回。`;
}

/** 送出前要先撤回留下的單、卻撤不掉：這次沒有建新單（免得重複）。 */
export function leftoverCancelFailedMessage(err: unknown): string {
  const reason = expenseErrorReason(err, "cancel");
  return `上一筆沒附到憑證的報銷還沒撤回成功，這次先不送出，免得重複。${reason ? `（${reason}）` : "請稍後再試。"}`;
}

/**
 * 送出前重試撤回留下的單，伺服器說再撤也撤不掉（404 那筆已不存在；409 已核銷、月份已結算…，見 upload-prep.ts 的
 * isLeftoverGone）：記錄已清掉、這次沒有建新單。請員工確認後再按一次送出——不然會永遠卡在「先撤回上一筆」。
 * `period` 是那一筆的歸屬月份（YYYY-MM）。
 */
export function leftoverGoneMessage(err: unknown, period: string): string {
  return apiErrorStatus(err) === 404
    ? `上一筆（${period}）沒附到憑證的報銷已經不存在（可能已被刪除），不用再撤回。這次先不送出，請看一下下方列表，沒問題的話再按一次送出。`
    : `上一筆（${period}）沒附到憑證的報銷已無法撤回（可能已月結或已核銷），這次先不送出。請洽 HR 確認，確認後再按一次送出。`;
}

/* ------------------------------- 留下的單：記在 sessionStorage（重新整理仍記得） --- */

/** 留下的單要記住的欄位：撤回用 id，說明文字用 period。 */
export interface LeftoverClaim {
  id: string;
  period: string;
}

/**
 * sessionStorage 的 key：固定前綴，不帶租戶或員工。sessionStorage 只在這個分頁、這個網站內，重新整理還在、關掉分頁就沒了。
 * 讀回來的單若撤不掉（不存在、已月結…）會被清掉，不會一直卡著（見 {@link leftoverGoneMessage}）。
 */
export const LEFTOVER_STORAGE_KEY = "aster.ess.expenses.leftover";

/** 只用到 getItem／setItem／removeItem（window.sessionStorage 符合；測試換成假的）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 單的 id 會放進撤回的網址（PATCH /expenses/:id），只收英數、底線與連字號。 */
const LEFTOVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 把存起來的字串還原成留下的單；不是 JSON、欄位缺或格式不對（壞值）→ null。 */
export function parseLeftoverClaim(raw: string | null | undefined): LeftoverClaim | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const { id, period } = value as { id?: unknown; period?: unknown };
    if (typeof id !== "string" || !LEFTOVER_ID_RE.test(id)) return null;
    if (typeof period !== "string" || !isValidPeriod(period)) return null;
    return { id, period: period.trim() };
  } catch {
    return null;
  }
}

/** 讀回留下的單：沒有儲存空間、讀不到（被擋、丟錯）、壞值 → null（當作沒有）。 */
export function readLeftoverClaim(storage: StorageLike | null): LeftoverClaim | null {
  if (!storage) return null;
  try {
    return parseLeftoverClaim(storage.getItem(LEFTOVER_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 記下（或清掉：null）留下的單，只存 id 與 period。寫不進去（被擋、額度滿）不丟錯，只是重新整理後就不記得了。 */
export function saveLeftoverClaim(storage: StorageLike | null, claim: LeftoverClaim | null): void {
  if (!storage) return;
  try {
    if (claim) storage.setItem(LEFTOVER_STORAGE_KEY, JSON.stringify({ id: claim.id, period: claim.period }));
    else storage.removeItem(LEFTOVER_STORAGE_KEY);
  } catch {
    // 寫不進去就只剩頁面記憶體這一份
  }
}

/* ------------------------------------------------------ 核銷前預覽 --- */

/** GET /advances/:id/settlement-preview 的一筆憑證（services/advance-settlement.ts SettlementPreviewClaim）。 */
export interface PreviewClaim {
  id: string;
  amount: number;
  incurredOn: string;
  period: string;
  status: string;
  /** 計入實支（submitted／settled）；false＝已撤回／退件，只列出來不算數。 */
  counted: boolean;
  categoryId: string | null;
  categoryName: string | null;
  nature: string;
  note: string | null;
  tripRequestId: string | null;
  /** 附了幾份單據檔案；0＝缺憑證。 */
  receiptCount: number;
}

export interface SettlementPreview {
  /** 預支列（含 `request` 摘要）。 */
  advance: AdvanceLike & { employee_id: string };
  amount: number;
  claims: PreviewClaim[];
  countedCount: number;
  actualTotal: number;
  /** actualTotal − amount；正＝公司補給員工、負＝員工應退。 */
  balance: number;
  direction: string;
  /** 只有 `paid`（已撥款、未核銷）才能核銷。 */
  settleable: boolean;
}

export type BalanceTone = "green" | "amber" | "gray";

/**
 * 差額一句話：「公司補給員工 NT$ 500」「員工應退 NT$ 1,000」「剛好結清」＋ 色調。
 * `format` 可換金額寫法（後台用「500 元」）。
 */
export function describeBalance(
  balance: number,
  format: (amount: number) => string = fmtMoney,
): { text: string; tone: BalanceTone } {
  if (balance > 0) return { text: `公司補給員工 ${format(balance)}`, tone: "green" };
  if (balance < 0) return { text: `員工應退 ${format(Math.abs(balance))}`, tone: "amber" };
  return { text: "剛好結清", tone: "gray" };
}

/**
 * 憑證狀態（核銷預覽用）：計入實支的 submitted／settled 都寫「已送出」——綁預支的憑證不走月結付款，
 * 寫「待月結／已月結」會讓人以為它還會隨月薪另外發；「核銷」一詞留給預支本身。
 */
const CLAIM_STATUS_LABEL: Record<string, string> = {
  submitted: "已送出",
  settled: "已送出",
  cancelled: "已撤回",
  rejected: "已退件",
};

export function claimStatusLabel(status: string): string {
  return CLAIM_STATUS_LABEL[status] ?? status;
}

/**
 * 核銷前要請財務留意的事（空陣列＝沒有）：
 *   • 沒有任何憑證 → 整筆預支會被算成員工應退（最常見的漏綁）；
 *   • 計入的憑證裡有缺單據檔案的（稅上要主張非所得的代墊費用需要憑證）；
 *   • 另有已撤回／退件而不計入的單（讓人知道它們在、但沒算）。
 */
export function settlementWarnings(preview: Pick<SettlementPreview, "claims" | "countedCount" | "amount">): string[] {
  const warnings: string[] = [];
  if (preview.countedCount === 0) {
    warnings.push(
      `這筆預支沒有綁定任何憑證，核銷會把整筆 ${fmtMoney(preview.amount)} 算成員工應退。請先確認員工已在「報銷」頁新增單據並選這筆預支。`,
    );
  }
  const missingReceipt = preview.claims.filter((c) => c.counted && c.receiptCount === 0).length;
  if (missingReceipt > 0) warnings.push(`有 ${missingReceipt} 筆憑證沒有附單據檔案。`);
  const ignored = preview.claims.filter((c) => !c.counted).length;
  if (ignored > 0) warnings.push(`另有 ${ignored} 筆已撤回或退件的單，不計入實支。`);
  return warnings;
}

/** 薪資期別 `YYYY-MM`（月份 01–12）。 */
export function isValidPeriod(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value.trim());
}
