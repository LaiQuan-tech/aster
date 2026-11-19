"use client";

import { Fragment } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { useInvoicedAck } from "@/components/InvoicedAckDialog";
import { billingScheduleVersion } from "@/lib/billing-version";
import { estimatedStageAmount } from "@/lib/project-application-stage-amounts";
import { Button, Card, PrimaryButton, ErrorText, inputCls } from "@/components/admin-ui";
import {
  saveBillingSchedule,
  billInstallmentExt,
  unbillInstallmentExt,
  invoiceBilling,
  uninvoiceBilling,
  receiveBilling,
  unreceiveBilling,
  humanizeBillingError,
  BILLING_KIND_LABELS,
  computeReceivableState,
  localTodayKey,
  RECEIVED_AMOUNT_HINT,
  RECEIVED_AMOUNT_LABEL,
  receivedAmountPlaceholder,
  RECEIVABLE_STATE_LABELS,
  RECEIVABLE_STATE_BADGE_CLASS,
  type BillingScheduleExt,
  type InstallmentInputExt,
  type ProjectMoney,
} from "@/lib/projects-ext-api";
import { billingRowTag, receiptSummaryText } from "@/lib/project-application-sheet";
import { INVOICED_AMOUNT_CHANGED_NOTICE, isBillingInvoiced } from "@/lib/billing-invoice";
import {
  billingUpdateFailedIds,
  billingSaveNotices,
  keepFailedBillingDraftRows,
} from "@/lib/project-application-sheet-save";
import { fmtMoney, todayKey, humanError, type Setter } from "./shared";

interface BillingsCardProps {
  projectId: string;
  schedule: BillingScheduleExt | null;
  setSchedule: Setter<BillingScheduleExt | null>;
  /** 期程是整批存的，所以編輯中的狀態獨立於已存檔的 schedule。 */
  draft: InstallmentInputExt[];
  setDraft: Setter<InstallmentInputExt[]>;
  savingSchedule: boolean;
  setSavingSchedule: Setter<boolean>;
  invoiceFormId: string | null;
  setInvoiceFormId: Setter<string | null>;
  invoiceNo: string;
  setInvoiceNo: Setter<string>;
  invoicedOn: string;
  setInvoicedOn: Setter<string>;
  receiveFormId: string | null;
  setReceiveFormId: Setter<string | null>;
  receivedOn: string;
  setReceivedOn: Setter<string>;
  receivedAmount: string;
  setReceivedAmount: Setter<string>;
  error: string | null;
  setError: Setter<string | null>;
  load: () => Promise<void>;
  /** 收款彙總（GET /projects/:id 的 money；金額卡移除後在標題列顯示「已收／未收（收款%）」）。 */
  money?: ProjectMoney | null;
}

/**
 * 分期請款期程（模組四第 4 條）＋ P3 開票／收款。金額一律系統算，不手動拉格。
 *
 * 2026-10-29 申請單改成整張表直接編輯後，期別、項目說明、百分比、一般分期／公會代墊、新增一期
 * 都改在上方申請單「付款階段」；這張卡只留申請單做不到的動作：標記請款／取消、標記開票／取消、
 * 標記入帳（入帳日、金額）／取消、人工指定金額與理由、合計與百分比警告。「預定日」欄已移除。
 */
export function BillingsCard({
  projectId,
  schedule,
  setSchedule,
  draft,
  setDraft,
  savingSchedule,
  setSavingSchedule,
  invoiceFormId,
  setInvoiceFormId,
  invoiceNo,
  setInvoiceNo,
  invoicedOn,
  setInvoicedOn,
  receiveFormId,
  setReceiveFormId,
  receivedOn,
  setReceivedOn,
  receivedAmount,
  setReceivedAmount,
  error,
  setError,
  load,
  money,
}: BillingsCardProps) {
  const receiptSummary = receiptSummaryText(money);
  /** 請款／取消請款／改人工金額會讓已開票期別金額改變時（409），跳確認視窗、填理由後重送。 */
  const invoicedAck = useInvoicedAck();
  function patchDraft(idx: number, patch: Partial<InstallmentInputExt>) {
    setDraft((d) => d.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  /** 人工指定金額或理由跟已存檔的不同（才顯示儲存鈕）。 */
  const overrideDirty = draft.some((row) => {
    const saved = schedule?.installments.find((i) => i.id === row.id);
    return !!saved && ((row.overrideAmount ?? null) !== (saved.overrideAmount ?? null) || (row.overrideReason ?? "") !== (saved.overrideReason ?? ""));
  });

  /**
   * 出錯後重新載入再顯示訊息（2026-11-18）：409 conflict_retry 若 committed（後端其實已寫入）要清掉草稿、不能重送；
   * 其他錯誤也重新載入，畫面跟後端一致（load() 會用已存檔的值重建草稿）。
   */
  async function failAndReload(err: unknown, fallback: string) {
    const message = humanizeBillingError(err, humanError(err, fallback));
    try {
      await load();
    } catch {
      // 重新載入失敗：至少把原本的錯誤訊息顯示出來
    }
    setError(message);
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setError(null);
    try {
      // 整批端點：draft 是由已存檔的期程建出來的（含期別、說明、百分比、預定日原值），這裡只改了人工指定金額與理由。
      const sent = draft;
      // 樂觀鎖：帶讀取時的期程版本（別人剛改過期程 → 409 conflict_retry，不會把對方新增的期別刪掉）。
      const expectedVersion = schedule ? (schedule.version ?? billingScheduleVersion(schedule.installments)) : undefined;
      let acked = false;
      const res = await invoicedAck.run((ack) => {
        if (ack) acked = true;
        return saveBillingSchedule(projectId, sent, { expectedVersion, ack });
      });
      setSchedule(res);
      await load();
      // 後端回 update_failed 的期別沒寫成：load() 會用已存檔的值重建草稿，這幾期要把剛才的輸入放回去。
      const failed = billingUpdateFailedIds(res.warnings);
      if (failed.size > 0) setDraft((fresh) => keepFailedBillingDraftRows(fresh, sent, failed));
      // 有期別寫入失敗（update_failed）與有期別在讀取後被刪除（row_gone）可能同時發生：兩個提示都顯示。
      const notices = billingSaveNotices(res.warnings);
      if (acked) notices.push(INVOICED_AMOUNT_CHANGED_NOTICE);
      if (notices.length > 0) setError(notices.join(" "));
    } catch (err) {
      await failAndReload(err, "儲存人工指定金額失敗");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function markBilled(id: string) {
    setError(null);
    try {
      setSchedule(await invoicedAck.run((ack) => billInstallmentExt(id, {}, ack)));
      await load();
    } catch (err) {
      await failAndReload(err, "標記請款失敗");
    }
  }

  async function cancelBilled(id: string) {
    const reason = window.prompt("取消請款的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await invoicedAck.run((ack) => unbillInstallmentExt(id, reason.trim(), ack)));
      await load();
    } catch (err) {
      await failAndReload(err, "取消請款失敗");
    }
  }

  async function submitInvoice(id: string) {
    if (!invoiceNo.trim()) {
      setError("請輸入發票號碼");
      return;
    }
    setError(null);
    try {
      const expectedVersion = schedule ? (schedule.version ?? billingScheduleVersion(schedule.installments)) : undefined;
      // 畫面上看到的這一期金額：期間被改過（合約、別期請款讓尾差換人）→ 409 invoiced_amount_mismatch，不會開出跟畫面不同的金額。
      const shown = schedule?.installments.find((i) => i.id === id);
      const expectedAmount = shown ? shown.effectiveAmount : undefined;
      setSchedule(await invoiceBilling(id, { invoiceNo: invoiceNo.trim(), invoicedOn, expectedVersion, expectedAmount }));
      setInvoiceFormId(null);
      setInvoiceNo("");
      await load();
    } catch (err) {
      await failAndReload(err, "標記開票失敗");
    }
  }
  async function cancelInvoice(id: string) {
    const reason = window.prompt("取消開票的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await uninvoiceBilling(id, reason.trim()));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "取消開票失敗"));
    }
  }
  async function submitReceive(id: string) {
    setError(null);
    try {
      setSchedule(await receiveBilling(id, { receivedOn, receivedAmount: receivedAmount === "" ? undefined : Number(receivedAmount) }));
      setReceiveFormId(null);
      setReceivedAmount("");
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "標記入帳失敗"));
    }
  }
  async function cancelReceive(id: string) {
    const reason = window.prompt("取消入帳的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await unreceiveBilling(id, reason.trim()));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "取消入帳失敗"));
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-700">分期請款期程</h2>
        {schedule?.contract.total == null ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
            還沒有合約，無法計算金額
          </span>
        ) : (
          <span className="text-xs text-gray-500">
            分母 {fmtMoney(schedule.contract.total)}
            <span className="text-gray-400">
              （主約 {fmtMoney(schedule.contract.base)}
              {schedule.contract.changeOrders !== 0 &&
                ` ＋追加減 ${schedule.contract.changeOrders > 0 ? "+" : ""}${schedule.contract.changeOrders.toLocaleString()}`}
              ）
            </span>
          </span>
        )}
        {receiptSummary && (
          <span className="text-xs text-gray-500 sm:ml-auto" data-testid="receipt-summary">
            {receiptSummary}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-2">期別</th>
              <th className="py-2 pr-2 text-right">系統試算</th>
              <th className="py-2 pr-2 w-40 text-right">人工指定</th>
              <th className="py-2 pr-2">狀態</th>
            </tr>
          </thead>
          <tbody>
            {draft.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-sm text-gray-400">還沒有期別——請在上方申請單「付款階段」直接填寫後儲存。</td>
              </tr>
            )}
            {draft.map((rowDraft, idx) => {
              const saved = schedule?.installments.find((i) => i.id === rowDraft.id);
              const billed = !!saved?.billedOn;
              const received = !!saved?.receivedOn;
              // 已開票的期別可以改人工金額，但存檔時要確認（後端 409 invoiced_amount_would_change → 確認視窗填理由）。
              const locked = billed || received;
              const invoicedNeedsConfirm = !locked && !!saved && isBillingInvoiced(saved);
              // B5：同一套三段狀態＋逾期 badge（跟 /admin/projects/receivables 共用顏色）。
              // API 有回 state 就用 API 的（後端依租戶逾期基準＋收足規則算好）；沒有才在前端算，
              // 前端版固定 'billed' 基準，並帶實收／有效金額讓部分入帳不被當成已收
              // （見 computeReceivableState 註解）。
              // today 用 localTodayKey()，不是這檔案原本的 todayKey()——後者取 UTC 日期，
              // 在 UTC+8 每天凌晨會少算一天，會把「逾期一天」誤判成「還沒逾期」。
              const rowState =
                saved?.state ??
                computeReceivableState({
                  billedOn: saved?.billedOn ?? null,
                  invoicedOn: saved?.invoicedOn ?? null,
                  receivedOn: saved?.receivedOn ?? null,
                  receivedAmount: saved?.receivedAmount ?? null,
                  effectiveAmount: saved?.effectiveAmount ?? null,
                  today: localTodayKey(),
                });
              return (
                <Fragment key={rowDraft.id ?? `new-${idx}`}>
                  <tr className="border-b last:border-0">
                    <td className="py-2 pr-2 text-gray-700">
                      {/* 期別與說明只讀：改在上方申請單「付款階段」。 */}
                      {/* 標籤文字來自期別名稱（跟申請單同步），公會代墊只用紫色區分；名稱空白不印固定字樣。 */}
                      <span>第 {rowDraft.installmentNo} 期</span>
                      {(() => {
                        const tag = billingRowTag(rowDraft);
                        if (!tag) return null;
                        return tag.tone === "guild" ? (
                          <span className="ml-1 rounded bg-purple-50 px-1.5 py-0.5 text-xs text-purple-700" title={BILLING_KIND_LABELS.guild_advance}>{tag.text}</span>
                        ) : (
                          <span className="ml-1">{tag.text}</span>
                        );
                      })()}
                    </td>
                    <td className="py-2 pr-2 text-right text-gray-600">
                      {saved?.calculatedAmount == null ? (
                        (() => {
                          // 沒有合約（只有報價單）時後端算不出金額：以銷售金額 × % 顯示試算（灰字，僅供參考）。
                          const est = estimatedStageAmount(saved?.overrideAmount ?? null, rowDraft.percentage ?? null, money?.amountUntaxed);
                          return est.value === null ? "—" : est.estimated ? (
                            <span className="text-gray-400" title="沒有合約，以銷售金額（未稅）× % 試算，僅供參考">試算 {fmtMoney(est.value)}</span>
                          ) : fmtMoney(est.value);
                        })()
                      ) : (
                        <>
                          {fmtMoney(saved.calculatedAmount)}
                          {saved.residueApplied !== 0 && (
                            <span
                              className="block text-xs text-amber-600"
                              title="尾差落在最後一個未請款的期別，讓合計等於合約金額"
                            >
                              含尾差 {saved.residueApplied > 0 ? "+" : ""}
                              {saved.residueApplied.toLocaleString()}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <MoneyInput
                        className={`${inputCls} text-right`}
                        placeholder="—"
                        value={rowDraft.overrideAmount ?? ""}
                        disabled={locked}
                        title={invoicedNeedsConfirm ? "這一期已開發票：改金額存檔時要確認並填理由，改完請確認是否需要修正發票（作廢／重開）" : undefined}
                        onValueChange={(v) =>
                          patchDraft(idx, {
                            overrideAmount: v === "" ? null : Number(v),
                          })
                        }
                      />
                      {rowDraft.overrideAmount != null && (
                        <input
                          className={`${inputCls} mt-1`}
                          placeholder="理由 *"
                          value={rowDraft.overrideReason ?? ""}
                          onChange={(e) => patchDraft(idx, { overrideReason: e.target.value })}
                        />
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <span
                        className={`mb-1 inline-block rounded-full px-1.5 py-0.5 text-[10px] ${RECEIVABLE_STATE_BADGE_CLASS[rowState]}`}
                      >
                        {RECEIVABLE_STATE_LABELS[rowState]}
                      </span>
                      <br />
                      {billed ? (
                        <button
                          type="button"
                          className="text-xs text-green-700 hover:underline"
                          onClick={() => rowDraft.id && cancelBilled(rowDraft.id)}
                          title={`已請款 ${fmtMoney(saved?.billedAmount ?? null)}，點一下取消`}
                        >
                          已請款 {saved?.billedOn}
                        </button>
                      ) : rowDraft.id ? (
                        <button
                          type="button"
                          className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                          onClick={() => rowDraft.id && markBilled(rowDraft.id)}
                        >
                          標記請款
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">存檔後可請款</span>
                      )}
                    </td>
                  </tr>
                  {saved && (
                    <tr className="border-b bg-gray-50/60 text-xs last:border-0">
                      <td colSpan={4} className="py-1.5 pl-8 pr-2">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                          {/* 開票 */}
                          {/* 已開票＝號碼或日期任一有值（2026-11-18：有號無日期的舊資料也撤銷得了）；
                              未請款也可以先標記開票（先開票再請款在工程業會發生，後端只提醒不擋）。 */}
                          {isBillingInvoiced(saved) ? (
                            <button type="button" className="text-green-700 hover:underline" onClick={() => cancelInvoice(saved.id)}>
                              已開票 {saved.invoiceNo || "（未填號碼）"}／{saved.invoicedOn || "（未填日期）"}（點取消）
                            </button>
                          ) : saved.kind === "guild_advance" ? (
                            <span className="text-gray-400">代墊款不開發票</span>
                          ) : invoiceFormId === saved.id ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <input className="w-28 rounded border border-gray-300 px-1.5 py-0.5" placeholder="發票號碼" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
                              <input className="rounded border border-gray-300 px-1.5 py-0.5" type="date" value={invoicedOn} onChange={(e) => setInvoicedOn(e.target.value)} />
                              <Button type="button" variant="secondary" size="sm" onClick={() => setInvoiceFormId(null)}>取消</Button>
                              <Button type="button" size="sm" onClick={() => submitInvoice(saved.id)}>確認</Button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rounded border border-gray-200 bg-white px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                              onClick={() => { setInvoiceFormId(saved.id); setInvoiceNo(""); setInvoicedOn(todayKey()); }}
                            >
                              標記開票{billed ? "" : "（尚未請款）"}
                            </button>
                          )}
                          {/* 入帳 */}
                          {saved.receivedOn ? (
                            <button type="button" className="text-green-700 hover:underline" onClick={() => cancelReceive(saved.id)}>
                              已入帳 {fmtMoney(saved.receivedAmount)}（未稅）／{saved.receivedOn}（點取消）
                            </button>
                          ) : receiveFormId === saved.id ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <input className="rounded border border-gray-300 px-1.5 py-0.5" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
                              <label className="flex items-center gap-1 text-gray-600">
                                <span>{RECEIVED_AMOUNT_LABEL}</span>
                                <MoneyInput
                                  className="w-28 rounded border border-gray-300 px-1.5 py-0.5 text-right"
                                  aria-label={RECEIVED_AMOUNT_LABEL}
                                  title={RECEIVED_AMOUNT_HINT}
                                  placeholder={receivedAmountPlaceholder(saved.effectiveAmount)}
                                  value={receivedAmount}
                                  onValueChange={(v) => setReceivedAmount(v)}
                                />
                              </label>
                              <Button type="button" variant="secondary" size="sm" onClick={() => setReceiveFormId(null)}>取消</Button>
                              <Button type="button" size="sm" onClick={() => submitReceive(saved.id)}>確認</Button>
                              <span className="basis-full text-[11px] text-amber-700">{RECEIVED_AMOUNT_HINT}</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rounded border border-gray-200 bg-white px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                              onClick={() => { setReceiveFormId(saved.id); setReceivedOn(todayKey()); setReceivedAmount(""); }}
                            >
                              標記入帳
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {schedule && draft.length > 0 && (
            <tfoot>
              <tr className="border-t-2 font-medium">
                <td className="py-2 pr-2">
                  合計
                  <span className={`ml-2 ${schedule.summary.percentageTotal === 100 ? "text-gray-700" : "text-amber-600"}`}>
                    {schedule.summary.percentageTotal}%
                    {schedule.summary.percentageTotal !== 100 && " ⚠️"}
                  </span>
                </td>
                <td className="py-2 pr-2 text-right" colSpan={2}>
                  {fmtMoney(schedule.summary.effectiveTotal)}
                </td>
                <td className="py-2 pr-2 text-xs text-gray-500">
                  已請款 {fmtMoney(schedule.summary.billedTotal)}／
                  未請款 {fmtMoney(schedule.summary.unbilledTotal)}
                  {schedule.summary.guildAdvanceTotal !== 0 && `／公會代墊 ${fmtMoney(schedule.summary.guildAdvanceTotal)}`}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {schedule && schedule.summary.percentageTotal !== 100 && draft.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          百分比合計為 {schedule.summary.percentageTotal}%，不是 100%。
          金額仍會補平到合約總額（差額落在最後一個未請款的期別），但期程本身可能還沒設定完。
        </p>
      )}
      {schedule && schedule.summary.unallocatedResidue !== 0 && (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
          有 {fmtMoney(schedule.summary.unallocatedResidue)} 元無法分配——
          所有期別都已請款或已人工指定金額，沒有期別可以吸收差額。
          請在上方申請單「付款階段」新增一期，或調整人工指定的金額。
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {overrideDirty && (
          <PrimaryButton onClick={saveSchedule} disabled={savingSchedule}>
            {savingSchedule ? "儲存中…" : "儲存人工指定金額"}
          </PrimaryButton>
        )}
        <span className="text-xs text-gray-400">
          期別、項目說明、百分比與新增一期請在上方申請單「付款階段」修改。金額一律由系統算：末期自動吸收四捨五入的尾差，合計必然等於合約金額。
        </span>
      </div>
      <ErrorText>{error}</ErrorText>
      {invoicedAck.dialog}
    </Card>
  );
}
