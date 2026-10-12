"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Field, InlineError, Input, Select } from "@/components/ess-ui";
import {
  getMyExpenseCategories,
  getMyExpenses,
  fileExpense,
  cancelExpense,
  uploadExpenseReceipt,
  getMyApprovedTrips,
  getMyAdvances,
  type MyExpenseCategory,
  type MyExpenseClaim,
  type MyTrip,
  type MyAdvance,
} from "@/lib/ess-api";
import {
  advanceDate,
  advanceOptionLabel,
  advanceStatusLabel,
  advanceSubject,
  bindableAdvances,
  expenseErrorMessage,
  expenseLoadErrorMessage,
  leftoverCancelFailedMessage,
  leftoverClaimNotice,
  leftoverGoneMessage,
  readLeftoverClaim,
  receiptUploadFailedMessage,
  RECEIPT_AUTO_CANCEL_REASON,
  saveLeftoverClaim,
  type AdvanceRequestInfo,
  type LeftoverClaim,
  type StorageLike,
} from "@/lib/advance-view";
import { localDateKey, todayKey } from "@/lib/ess-format";
import { createThenUpload, leftoverAfter, pickedFileError } from "@/lib/upload-prep";

/** GET /advances 每列附對應申請單的摘要（2026-10-11）；MyAdvance 沒宣告，這裡補。 */
type AdvanceRow = MyAdvance & { request?: AdvanceRequestInfo | null; created_at?: string };
/** GET /expenses 的列另外有 advance_id／trip_request_id；MyExpenseClaim 沒宣告，這裡補。 */
type ClaimRow = MyExpenseClaim & { advance_id?: string | null; trip_request_id?: string | null };

// 本地日期（不用 UTC 切片：台北每月 1 日 00:00–08:00 UTC 還在上個月，預設日期／月份會差一個月）。
function thisPeriod(): string {
  return todayKey().slice(0, 7);
}

function today(): string {
  return todayKey();
}

function money(n: number): string {
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "待核銷",
  settled: "已核銷",
  cancelled: "已撤回",
  rejected: "已退件",
};

/** 這個分頁的 sessionStorage；瀏覽器擋住存取（有的設定一碰就丟 SecurityError）→ null。只在 effect 裡呼叫（伺服器端沒有 window）。 */
function sessionStore(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * 憑證沒傳上、自動撤回也失敗而留下的單（還在、沒有憑證）：用法同 useState，另外記在 sessionStorage——
 * 重新整理同一分頁仍記得，下次按送出照樣先重試撤回（關掉分頁才忘；讀寫失敗、壞值都當沒有，見 lib/advance-view.ts）。
 * 掛載後才讀回來（伺服器端渲染沒有 sessionStorage，一開始就讀會讓 hydration 對不上）；讀回之前不寫，免得把還沒讀的紀錄蓋掉。
 */
function useLeftoverClaim() {
  const [leftover, setLeftover] = useState<LeftoverClaim | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setLeftover(readLeftoverClaim(sessionStore()));
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored) saveLeftoverClaim(sessionStore(), leftover);
  }, [leftover, restored]);

  return [leftover, setLeftover] as const;
}

export default function EssExpensesPage() {
  const [categories, setCategories] = useState<MyExpenseCategory[]>([]);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [period, setPeriod] = useState(thisPeriod);
  // 三種錯誤各放一格，互不覆蓋：載入失敗（卡片上方）、列表撤回失敗（那一列下方）、送出失敗（送出按鈕上方）。
  // 以前共用一格：送出時憑證上傳＋撤回都失敗、切月份重新載入又失敗，「請先撤回」的提示就被「Load failed」蓋掉。
  // 列表撤回失敗的訊息跟著按下的那一列（以前放在第一張卡片頂端，手機上要往上捲才看得到）。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; message: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 憑證沒傳上、自動撤回也失敗而留下的單（還在、沒有憑證）：下次按送出先撤回它、撤不掉就不建新單，
  // 員工不知道單已建好、再按一次也不會多一筆（見 lib/upload-prep.ts createThenUpload 的 leftover）。
  const [leftover, setLeftover] = useLeftoverClaim();

  // 填報表單
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [incurredOn, setIncurredOn] = useState(today);
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  // 憑證欄是非受控的 <input type="file">：送出成功後換 key 讓它重建，才不會還顯示上一張的檔名。
  const [receiptInputKey, setReceiptInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // 出差軌（模組三第 2 條）：這類報銷必須綁一張已核准的出差單。
  const [trips, setTrips] = useState<MyTrip[]>([]);
  const [tripRequestId, setTripRequestId] = useState("");
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);
  // 這筆是哪次預支的花費（選填）：員工選了「先預支」的出差／零用金，回來報銷時在這裡選對應那一次，
  // 公司核銷預支時才算得到這筆（多退少補）；自行墊付的留空，走月報銷。
  const [advanceId, setAdvanceId] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, e, t, a] = await Promise.all([
        getMyExpenseCategories(),
        getMyExpenses(period),
        getMyApprovedTrips(),
        getMyAdvances(),
      ]);
      setCategories(c.categories.filter((x) => x.active));
      setClaims(e.claims);
      setTrips(t.requests);
      setAdvances(a.advances);
      setLoadError(null);
    } catch (err) {
      console.warn("[報銷] 載入失敗", err);
      setLoadError(expenseLoadErrorMessage(err));
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = categories.find((c) => c.id === categoryId);
  // 尚未核銷（已核准待撥款、已撥款待核銷）的預支，新的在前。
  const bindable = useMemo(() => bindableAdvances(advances), [advances]);
  // 已核銷的預支：綁它的憑證已鎖（API 回 409 advance_settled），畫面不再給「撤回」。
  const settledAdvanceIds = useMemo(
    () => new Set(advances.filter((a) => a.status === "settled").map((a) => a.id)),
    [advances],
  );
  // 定額補貼（屬薪資所得）不能綁預支：不顯示預支欄位、送出也不帶。
  const allowanceSelected = selected?.nature === "allowance";
  // 選的項目若已不在清單裡（例如頁面開著時那筆預支剛被核銷、重新載入後不見了），視為沒選——
  // 否則 <select> 顯示「不是預支的花費」，送出卻還帶著舊 id 被 API 擋（invalid_advance）而且重送也一樣。
  const effectiveAdvanceId = !allowanceSelected && bindable.some((a) => a.id === advanceId) ? advanceId : "";
  const effectiveTripId = trips.some((t) => t.id === tripRequestId) ? tripRequestId : "";
  // 選的出差單若已開了預支，送出時後端會自動綁上（沒選預支也一樣；定額補貼不綁）。
  const tripAdvance =
    effectiveTripId && !allowanceSelected ? bindable.find((a) => a.request_id === effectiveTripId) : undefined;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCancelError(null);
    setSubmitError(null);
    setMessage(null);
    const hadLeftover = leftover !== null;
    try {
      // 憑證跟著單子一起送：事前審核可以省，憑證不能省。
      // 順序（2026-10-12）：先準備憑證（照片壓縮＋3 MB 檢查），過不了就不建單；建單後才上傳，上傳失敗就撤回剛建的單。
      // 以前先建單再傳，傳失敗時單已存在、表單又沒清，員工再按送出就多一筆沒有憑證的重複單。
      // 上一次留下的單（撤回也失敗）在建新單前先撤回；選「撤回再重建」而不是「把憑證補傳到舊單」：
      // 新單一定是員工現在表單上的內容（失敗後可能改過金額、日期），也不會把憑證掛到員工已自己撤回的舊單上。
      const result = await createThenUpload({
        file: receipt,
        leftover,
        create: () =>
          fileExpense({
            categoryId,
            amount: Number(amount),
            incurredOn,
            note: note.trim() || undefined,
            // 類別要求出差單時必帶；沒要求時選了就帶（自行墊付的出差憑證靠它對回哪一趟）。
            tripRequestId: effectiveTripId || undefined,
            advanceId: effectiveAdvanceId || undefined,
          }),
        upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
        rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
      });
      setLeftover((current) => leftoverAfter(current, result));
      if (!result.ok) {
        // 畫面只放依步驟的中文說明；原始錯誤（[500] upload_failed 之類）記在 console 給除錯用。
        console.warn(`[報銷] 送出失敗（${result.stage}）`, result.error);
        if (result.stage === "prepare") {
          setSubmitError(expenseErrorMessage(result.error, "這個憑證檔案無法使用，請換一個檔案", "upload"));
        } else if (result.stage === "leftover") {
          setSubmitError(leftoverCancelFailedMessage(result.error));
        } else if (result.stage === "leftover-gone") {
          // 上一筆再撤也撤不掉（已不存在、已核銷或月份已結算）：記錄已清掉、這次不送出，請員工確認後再按一次送出。
          // 重新載入，列表才看得到那一筆現在的狀態。
          setSubmitError(leftoverGoneMessage(result.error, result.leftover.period));
          await load();
        } else if (result.stage === "create") {
          setSubmitError(expenseErrorMessage(result.error, "送出失敗，請稍後再試", "create"));
          // 上一筆已在建單前撤回：重新載入，列表才看得到它變成已撤回。
          if (hadLeftover) await load();
        } else {
          setSubmitError(receiptUploadFailedMessage(result.error, result.rolledBack));
          // 表單保留，換個檔或稍後直接再按送出。撤回也失敗＝單還在：列表切到那筆的月份，員工才看得到、撤得掉。
          if (!result.rolledBack && result.created.period !== period) setPeriod(result.created.period);
          else await load();
        }
        return;
      }
      const created = result.created;
      // 綁了預支（自己選的，或該趟出差的預支被自動綁上）→ 隨預支核銷；否則歸屬月結。
      const boundAdvance = effectiveAdvanceId || (created as { advanceId?: string | null }).advanceId;
      setMessage(
        boundAdvance
          ? "已送出，這筆會隨預支一起核銷（多退少補），不會再隨月結另外發放"
          : `已送出，歸屬 ${created.period} 月結`,
      );
      setAmount("");
      setNote("");
      setReceipt(null);
      setReceiptInputKey((k) => k + 1);
      setTripRequestId("");
      setAdvanceId("");
      await load();
    } catch (err) {
      console.warn("[報銷] 送出失敗", err);
      setSubmitError(expenseErrorMessage(err, "送出失敗，請稍後再試", "create"));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel(id: string) {
    const reason = window.prompt("撤回理由（必填）：");
    if (reason === null) return;
    setCancelError(null);
    if (!reason.trim()) {
      setCancelError({ id, message: "撤回理由為必填" });
      return;
    }
    try {
      await cancelExpense(id, reason.trim());
      // 員工自己撤回了留下的那一筆 → 下次送出不必再撤
      setLeftover((current) => (current?.id === id ? null : current));
      await load();
    } catch (err) {
      console.warn("[報銷] 撤回失敗", err);
      setCancelError({ id, message: expenseErrorMessage(err, "撤回失敗，請稍後再試", "cancel") });
    }
  }

  const total = claims
    .filter((c) => c.status === "submitted" || c.status === "settled")
    .reduce((a, c) => a + Number(c.amount), 0);

  return (
    <div className="space-y-4">
      <Card title="填報日常支出">
        <p className="mb-4 text-xs text-gray-500">
          送出後不需逐筆審核，由管理者於月結時一次核銷。請附上憑證。
        </p>

        {loadError && <InlineError className="mb-3">{loadError}</InlineError>}
        {message && <p className="mb-3 text-sm text-green-700">{message}</p>}

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Field label="類別" htmlFor="cat">
              <Select
                id="cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
              >
                <option value="">請選擇</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {selected?.nature === "allowance" && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                此類別為<strong>定額補貼</strong>，屬薪資所得，會併入當月薪資扣繳。
              </p>
            )}
            {selected && selected.nature === "reimbursement" && selected.requires_receipt && (
              <p className="mt-2 text-xs text-gray-500">此類別需附憑證。</p>
            )}
          </div>

          {/* 出差軌：日常費用不必事前審核，長途出差必須先核准——類別要求時必選；沒要求時選填
              （自行墊付的出差憑證靠它對回哪一趟；日常費用留空）。 */}
          {selected?.requires_trip_approval && (
            <div>
              {trips.length === 0 ? (
                <Field label="綁定出差單">
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    你目前沒有已核准的出差單。此類別的費用必須先提出「公出/出差」
                    申請並經簽核，核准後才能報銷。
                  </p>
                </Field>
              ) : (
                <Field label="綁定出差單" htmlFor="trip" hint="此類別的費用須掛在已核准的出差之下。">
                  <Select
                    id="trip"
                    value={effectiveTripId}
                    onChange={(e) => setTripRequestId(e.target.value)}
                    required
                  >
                    <option value="">請選擇</option>
                    {trips.map((t) => (
                      <option key={t.id} value={t.id}>
                        {localDateKey(t.start_at)}
                        {t.location ? ` · ${t.location}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          )}
          {selected && !selected.requires_trip_approval && trips.length > 0 && (
            <Field label="綁定出差單（選填）" htmlFor="trip-optional" hint="這筆是出差的花費就選對應那一趟；日常費用留空。">
              <Select id="trip-optional" value={effectiveTripId} onChange={(e) => setTripRequestId(e.target.value)}>
                <option value="">不綁定</option>
                {trips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {localDateKey(t.start_at)}
                    {t.location ? ` · ${t.location}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* 預支沖抵：有未核銷預支的人才會出現。選了，這筆在預支核銷時一起算（多退少補），不再隨月薪另外發放。 */}
          {bindable.length > 0 && !allowanceSelected && (
            <Field
              label="這筆是哪次預支的花費？（選填）"
              htmlFor="adv"
              hint={
                effectiveAdvanceId
                  ? "這筆會跟著該次預支一起核銷（多退少補），不會再隨月結另外發放。"
                  : tripAdvance
                    ? "你選的出差單有預支，送出時會自動綁到該筆預支。"
                    : "用預支的錢付的，請選對應那一次，公司核銷時才算得到；自行墊付的留空即可。"
              }
            >
              <Select id="adv" value={effectiveAdvanceId} onChange={(e) => setAdvanceId(e.target.value)}>
                <option value="">不是預支的花費（自行墊付，隨月結報銷）</option>
                {bindable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {advanceOptionLabel(a)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="金額" htmlFor="amt">
              <Input
                id="amt"
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <Field label="發生日期" htmlFor="date" hint="填實際發生日。該月份若已月結鎖定就不能再送出；用預支的錢付的（選了預支）會自動歸入本月。">
              <Input
                id="date"
                type="date"
                value={incurredOn}
                onChange={(e) => setIncurredOn(e.target.value)}
                required
              />
            </Field>
          </div>

          <Field label="備註（選填）" htmlFor="note">
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={250}
            />
          </Field>

          <Field
            label="憑證（發票／收據／乘車明細）"
            htmlFor="receipt"
            hint="照片會自動壓縮後上傳；PDF 單檔 3 MB 以內"
            error={receipt ? (pickedFileError(receipt) ?? undefined) : undefined}
          >
            <input
              key={receiptInputKey}
              id="receipt"
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </Field>

          {/* 送出失敗的說明放在按鈕正上方：手機上按完送出畫面停在這裡，放卡片頂端要往上捲才看得到。 */}
          <InlineError>{submitError}</InlineError>
          {leftover && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {leftoverClaimNotice(leftover.period)}
            </p>
          )}

          <Button
            type="submit"
            block
            size="lg"
            loading={busy}
            disabled={!categoryId || (selected?.requires_trip_approval === true && !effectiveTripId)}
          >
            {busy ? "送出中…" : "送出"}
          </Button>
        </form>
      </Card>

      {advances.length > 0 && (
        <Card title="我的預支">
          <p className="mb-4 text-xs text-gray-500">
            已撥款但尚未核銷的金額，請憑單據報銷後由公司沖抵，多退少補。新增單據時，在「這筆是哪次預支的花費？」
            選對應那一次。
          </p>
          <ul className="space-y-2">
            {advances.map((a) => {
              const bal = a.balance === null ? null : Number(a.balance);
              return (
                <li
                  key={a.id}
                  className="rounded-2xl border border-gray-100 bg-gray-50 p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">
                        {money(Number(a.amount))} 元
                        <span className="ml-2 text-xs font-normal text-gray-500">
                          {advanceDate(a)} {advanceSubject(a)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {a.status === "paid"
                          ? `已撥款 ${a.paid_at?.slice(0, 10) ?? ""}・待核銷`
                          : a.status === "settled"
                            ? `已核銷 ${a.settled_at?.slice(0, 10) ?? ""}`
                            : advanceStatusLabel(a.status)}
                      </div>
                    </div>
                    {a.status === "settled" && bal !== null && (
                      <span className="text-xs text-gray-600">
                        {bal === 0
                          ? "剛好結清"
                          : bal > 0
                            ? `公司補你 ${money(bal)}`
                            : `應退回 ${money(Math.abs(bal))}`}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card
        title="我的報銷"
        action={
          <input
            type="month"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setCancelError(null);
            }}
            className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
          />
        }
      >

        {claims.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">本期沒有報銷紀錄。</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">
              本期合計 <strong>{money(total)}</strong> 元
            </p>
            <ul className="space-y-2">
              {claims.map((c) => (
                <li
                  key={c.id}
                  className="rounded-2xl border border-gray-100 bg-gray-50 p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">
                        {money(Number(c.amount))} 元
                        {c.nature === "allowance" && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                            補貼
                          </span>
                        )}
                        {c.advance_id && (
                          <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                            隨預支核銷
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">
                        {c.incurred_on}
                        {c.note ? ` · ${c.note}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-500">
                        {STATUS_LABEL[c.status] ?? c.status}
                      </span>
                      {c.status === "submitted" && !(c.advance_id && settledAdvanceIds.has(c.advance_id)) && (
                        <button
                          type="button"
                          onClick={() => void onCancel(c.id)}
                          className="mt-1 block text-xs text-red-600 underline"
                        >
                          撤回
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 撤回失敗的說明放在按下的那一列：手機上列表一長，放卡片頂端要往上捲才看得到。 */}
                  {cancelError?.id === c.id && <InlineError className="mt-2">{cancelError.message}</InlineError>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
