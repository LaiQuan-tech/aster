/**
 * 公出／出差「自行墊付」× 報銷（2026-10-16）。
 *
 * 以前員工在公出表單選「自行墊付，回來報銷」只看到一句「回來後到『報銷』頁填報單據」，得自己記得換頁、
 * 重打日期事由。現在三個入口：
 *   1. 公出表單內「現在就填報銷明細（選填）」：送出時先建公出單、再逐筆建報銷單（綁這張公出單、事由自動帶入）——
 *      {@link fileTripWithExpenses}。公出單建好後表單就換成成功畫面，報銷失敗也不會重送公出單；沒送成的明細
 *      從成功畫面／「我的申請」的「填報銷單」補。
 *   2. 成功畫面、「我的申請」裡自行墊付的公出／出差單 →「填報銷單」連到報銷頁（{@link tripExpenseHref}，網址只帶單號）。
 *   3. 報銷頁讀 `?trip=`（{@link parseTripParam}），從自己的出差單清單找到那張，預填日期、備註、綁定出差單，
 *      並顯示「來自 MM/DD 公出申請」（{@link tripOriginLabel}）。
 *
 * 綁定規則（API services/expense-binding.ts）：簽核中的出差單只有「類別沒要求出差核准」的費用能綁；
 * 要求出差核准的類別仍須等核准（{@link isCategoryUsableForTrip}）。
 * 這裡只放純函式與流程編排（依賴由呼叫端注入），單元測試見 __tests__/trip-expense.test.ts。
 */
import { fmtMoney, localDateKey } from "./ess-format";
import { createThenUpload, pickedFileError, prepareUploadFile } from "./upload-prep";

/* ------------------------------------------------------------ 型別 --- */

/** 判斷用到的出差單欄位（LeaveRequest／MyTrip 都符合）。 */
export interface TripLike {
  id: string;
  kind?: string;
  status: string;
  start_at: string;
  end_at?: string;
  trip_type?: string | null;
  location?: string | null;
  reason?: string | null;
  advance_requested?: string | number | null;
}

/** 判斷用到的報銷類別欄位（MyExpenseCategory 符合）。 */
export interface CategoryLike {
  id: string;
  name: string;
  active: boolean;
  requires_trip_approval: boolean;
}

/** 判斷用到的報銷單欄位（GET /expenses 的列）。 */
export interface ClaimLike {
  amount: string | number;
  status: string;
  trip_request_id?: string | null;
}

/** 公出表單裡的一筆報銷明細（畫面狀態）。 */
export interface ExpenseDraft {
  key: string;
  categoryId: string;
  amount: string;
  incurredOn: string;
  note: string;
  receipt: File | null;
}

/** 驗證過、可以送出的一筆（POST /expenses 的 body 去掉 tripRequestId，建公出單後才知道）。 */
export interface ReadyExpense {
  categoryId: string;
  amount: number;
  incurredOn: string;
  note?: string;
  receipt: File | null;
}

/* ---------------------------------------------------------- 判斷 --- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** POST /expenses 的 note 上限。 */
export const EXPENSE_NOTE_MAX = 250;

/** 自行墊付的公出／出差單：kind=business_trip、沒有預支金額（null／0）。 */
export function isSelfPaidTrip(r: Pick<TripLike, "kind" | "advance_requested">): boolean {
  if (r.kind !== undefined && r.kind !== "business_trip") return false;
  const adv = r.advance_requested == null || r.advance_requested === "" ? 0 : Number(r.advance_requested);
  return !(Number.isFinite(adv) && adv > 0);
}

/** 這張出差單現在能不能拿來填報銷（簽核中或已核准；駁回、撤回的不行）。 */
export function isTripOpenForExpenses(r: Pick<TripLike, "status">): boolean {
  return r.status === "pending" || r.status === "approved";
}

/** 「我的申請」該不該顯示「填報銷單」：自行墊付、簽核中或已核准的公出／出差單。 */
export function showFillExpense(r: Pick<TripLike, "kind" | "status" | "advance_requested">): boolean {
  return r.kind === "business_trip" && isSelfPaidTrip(r) && isTripOpenForExpenses(r);
}

/**
 * 這個類別能不能綁這張出差單送出：類別要停用以外；要求出差核准的類別只能綁已核准的（API 對簽核中回
 * 400 trip_not_approved）。`tripStatus` 省略＝剛要送出、還沒建單（等同簽核中）。
 */
export function isCategoryUsableForTrip(cat: Pick<CategoryLike, "active" | "requires_trip_approval">, tripStatus = "pending"): boolean {
  if (!cat.active) return false;
  return !cat.requires_trip_approval || tripStatus === "approved";
}

/* ---------------------------------------------------------- 文案 --- */

function tripTypeLabel(t: Pick<TripLike, "trip_type">): string {
  return t.trip_type === "business_trip" ? "出差" : t.trip_type === "outing" ? "公出" : "公出／出差";
}

/** 出差單的起日（本地日期 YYYY-MM-DD）：報銷「發生日期」的預設值。 */
export function tripStartDate(t: Pick<TripLike, "start_at">): string {
  return localDateKey(t.start_at);
}

/** 報銷單備註的預設值：「公出：台中客戶公司（客戶拜訪）」；截到 250 字。 */
export function tripExpenseNote(t: Pick<TripLike, "trip_type" | "location" | "reason">): string {
  const location = (t.location ?? "").trim();
  const reason = (t.reason ?? "").trim();
  const head = `${tripTypeLabel(t)}${location ? `：${location}` : ""}`;
  const text = reason ? `${head}（${reason}）` : head;
  return text.length > EXPENSE_NOTE_MAX ? `${text.slice(0, EXPENSE_NOTE_MAX - 1)}…` : text;
}

/** 報銷頁頂部提示：「來自 10/16 公出申請・台中客戶公司（簽核中）」。 */
export function tripOriginLabel(t: Pick<TripLike, "start_at" | "trip_type" | "location" | "status">): string {
  const d = tripStartDate(t);
  const md = d ? `${d.slice(5, 7)}/${d.slice(8, 10)} ` : "";
  const location = (t.location ?? "").trim();
  const status = t.status === "pending" ? "（簽核中）" : "";
  return `來自 ${md}${tripTypeLabel(t)}申請${location ? `・${location}` : ""}${status}`;
}

/** 報銷頁「綁定出差單」下拉的選項文字：「2026-10-16 · 台中客戶公司（簽核中）」。 */
export function tripOptionLabel(t: Pick<TripLike, "start_at" | "location" | "status">): string {
  const location = (t.location ?? "").trim();
  return `${tripStartDate(t)}${location ? ` · ${location}` : ""}${t.status === "pending" ? "（簽核中）" : ""}`;
}

/* ------------------------------------------------------ 深連結 --- */

export const EXPENSES_PATH = "/ess/expenses";

/** 「填報銷單」連結：只帶出差單號（日期、地點由報銷頁從自己的出差單清單讀，不放進網址）。 */
export function tripExpenseHref(tripId: string): string {
  return `${EXPENSES_PATH}?trip=${encodeURIComponent(tripId)}`;
}

/** 報銷頁讀 `?trip=`：是 uuid 才回，其他（空、亂碼）→ null。 */
export function parseTripParam(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("trip");
  return raw && UUID_RE.test(raw.trim()) ? raw.trim() : null;
}

/* ------------------------------------------------------ 已報銷 --- */

export interface TripClaimSummary {
  count: number;
  total: number;
}

/** 每張出差單已報銷幾筆、多少錢（撤回、退件的不算）。 */
export function summarizeTripClaims(claims: readonly ClaimLike[]): Map<string, TripClaimSummary> {
  const out = new Map<string, TripClaimSummary>();
  for (const c of claims) {
    if (!c.trip_request_id || c.status === "cancelled" || c.status === "rejected") continue;
    const amount = Number(c.amount);
    const cur = out.get(c.trip_request_id) ?? { count: 0, total: 0 };
    out.set(c.trip_request_id, { count: cur.count + 1, total: cur.total + (Number.isFinite(amount) ? amount : 0) });
  }
  return out;
}

/** 「已報銷 2 筆・$1,350」。 */
export function tripClaimSummaryText(s: TripClaimSummary): string {
  return `已報銷 ${s.count} 筆・${fmtMoney(s.total)}`;
}

/* ------------------------------------------------------ 明細驗證 --- */

let draftSeq = 0;
/** 新的一筆空白明細：日期預設＝出差起日。 */
export function newExpenseDraft(incurredOn: string): ExpenseDraft {
  draftSeq += 1;
  return { key: `d${Date.now().toString(36)}${draftSeq}`, categoryId: "", amount: "", incurredOn, note: "", receipt: null };
}

/** 整筆都沒填（類別、金額、備註、憑證都空）→ 當作沒有這筆，送出時略過。日期有預設值，不算。 */
export function isBlankDraft(d: ExpenseDraft): boolean {
  return !d.categoryId && !d.amount.trim() && !d.note.trim() && !d.receipt;
}

export type DraftValidation = { ok: true; ready: ReadyExpense[] } | { ok: false; index: number; error: string };

/**
 * 送出前驗證全部明細（規則同報銷頁：類別必選、金額正整數、日期必填；憑證選填但選了要過大小檢查）。
 * 空白的略過；`defaultNote` 是沒填備註時帶入的事由（{@link tripExpenseNote}）。
 * 錯誤訊息前面加「第 N 筆」，`index` 是畫面上的順序（0 起算）。
 */
export function validateExpenseDrafts(
  drafts: readonly ExpenseDraft[],
  categories: readonly CategoryLike[],
  defaultNote: string,
): DraftValidation {
  const ready: ReadyExpense[] = [];
  const many = drafts.filter((d) => !isBlankDraft(d)).length > 1;
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (isBlankDraft(d)) continue;
    const prefix = many ? `報銷第 ${i + 1} 筆：` : "報銷明細：";
    const fail = (error: string): DraftValidation => ({ ok: false, index: i, error: `${prefix}${error}` });
    const cat = categories.find((c) => c.id === d.categoryId);
    if (!cat) return fail("請選擇類別");
    if (!isCategoryUsableForTrip(cat)) {
      return fail(cat.active ? `「${cat.name}」須等出差核准後再到報銷頁填` : `「${cat.name}」已停用，請重新選擇`);
    }
    const amount = Number(d.amount.replace(/,/g, "").trim());
    if (!d.amount.trim() || !Number.isFinite(amount) || amount <= 0) return fail("請填寫金額");
    if (!Number.isInteger(amount)) return fail("金額請填整數");
    if (!DATE_RE.test(d.incurredOn)) return fail("請選擇發生日期");
    if (d.receipt) {
      const problem = pickedFileError(d.receipt);
      if (problem) return fail(problem);
    }
    const note = (d.note.trim() || defaultNote).slice(0, EXPENSE_NOTE_MAX);
    ready.push({ categoryId: cat.id, amount, incurredOn: d.incurredOn, ...(note ? { note } : {}), receipt: d.receipt });
  }
  return { ok: true, ready };
}

/* ------------------------------------------------------ 送出編排 --- */

export interface FiledExpense<C> {
  index: number;
  amount: number;
  claim: C;
}

export interface FailedExpense<C> {
  index: number;
  amount: number;
  /** create＝建單失敗（沒有留下單）；upload＝憑證沒傳上（rolledBack＝已自動撤回；否則單還在、沒有憑證）。 */
  stage: "create" | "upload";
  error: unknown;
  rolledBack?: boolean;
  /** stage=upload 且撤回也失敗時留下的單。 */
  leftover?: C;
}

export type TripWithExpensesResult<T, C> =
  | { ok: false; stage: "prepare"; index: number; error: unknown }
  | { ok: false; stage: "trip"; error: unknown }
  | { ok: true; trip: T; filed: FiledExpense<C>[]; failed: FailedExpense<C>[] };

/**
 * 公出單＋報銷明細一起送出：
 *   1. 先準備每張憑證（壓縮＋3 MB 檢查）——任一張不過就停，什麼單都不建（stage "prepare"，index＝第幾筆）；
 *   2. 建公出單；失敗就停（stage "trip"，也沒有報銷單）；
 *   3. 逐筆建報銷單（綁這張公出單）＋傳憑證（lib/upload-prep.ts createThenUpload：傳失敗就撤回剛建的報銷單）。
 *      某筆失敗其餘照送，結果分成 filed／failed。公出單已建好，所以第 3 步的失敗**不會**讓呼叫端重送公出單——
 *      呼叫端顯示成功畫面＋哪幾筆沒送成，讓員工從「填報銷單」補。
 * 不丟錯（建單函式丟的錯都收在結果裡）。
 */
export async function fileTripWithExpenses<T, C>(steps: {
  expenses: readonly ReadyExpense[];
  createTrip: () => Promise<T>;
  tripId: (trip: T) => string;
  fileExpense: (body: Omit<ReadyExpense, "receipt"> & { tripRequestId: string }) => Promise<C>;
  upload: (claim: C, file: File) => Promise<unknown>;
  rollback: (claim: C) => Promise<unknown>;
  prepare?: (file: File) => Promise<File>;
}): Promise<TripWithExpensesResult<T, C>> {
  const prepare = steps.prepare ?? ((file: File) => prepareUploadFile(file));
  const prepared: (File | null)[] = [];
  for (let i = 0; i < steps.expenses.length; i++) {
    const file = steps.expenses[i].receipt;
    if (!file) {
      prepared.push(null);
      continue;
    }
    try {
      prepared.push(await prepare(file));
    } catch (error) {
      return { ok: false, stage: "prepare", index: i, error };
    }
  }

  let trip: T;
  try {
    trip = await steps.createTrip();
  } catch (error) {
    return { ok: false, stage: "trip", error };
  }
  const tripRequestId = steps.tripId(trip);

  const filed: FiledExpense<C>[] = [];
  const failed: FailedExpense<C>[] = [];
  for (let i = 0; i < steps.expenses.length; i++) {
    const { receipt: _receipt, ...body } = steps.expenses[i];
    const result = await createThenUpload<C>({
      file: prepared[i],
      create: () => steps.fileExpense({ ...body, tripRequestId }),
      upload: steps.upload,
      rollback: steps.rollback,
      // 第 1 步已準備過，這裡原樣用
      prepare: async (file) => file,
    });
    if (result.ok) filed.push({ index: i, amount: body.amount, claim: result.created });
    else if (result.stage === "upload")
      failed.push({
        index: i,
        amount: body.amount,
        stage: "upload",
        error: result.error,
        rolledBack: result.rolledBack,
        ...(result.rolledBack ? {} : { leftover: result.created }),
      });
    else failed.push({ index: i, amount: body.amount, stage: "create", error: result.error });
  }
  return { ok: true, trip, filed, failed };
}

/**
 * 成功畫面上報銷的結果一行（null＝這次沒有填明細）：
 *   • 全部成功 →「已一併送出 2 筆報銷，共 $1,350，隨月結給付」；
 *   • 有失敗 → 前半說成功幾筆，後半說哪幾筆沒送成（原因由 `reason` 翻成中文）＋「申請單已送出，請按『填報銷單』補填」。
 */
export function tripExpenseOutcome<C>(
  filed: readonly FiledExpense<C>[],
  failed: readonly FailedExpense<C>[],
  reason: (f: FailedExpense<C>) => string,
): { tone: "success" | "warning"; text: string } | null {
  if (filed.length === 0 && failed.length === 0) return null;
  const total = filed.reduce((a, f) => a + f.amount, 0);
  const okText = filed.length > 0 ? `已一併送出 ${filed.length} 筆報銷，共 ${fmtMoney(total)}，隨月結給付。` : "";
  if (failed.length === 0) return { tone: "success", text: okText };
  const many = filed.length + failed.length > 1;
  const failText = failed
    .map((f) => `${many ? `第 ${f.index + 1} 筆` : "報銷"}（${fmtMoney(f.amount)}）沒送成：${reason(f)}`)
    .join("；");
  return {
    tone: "warning",
    text: `${okText}${failText}。申請單已送出、不用重填，請按「填報銷單」補上沒送成的。`,
  };
}
