"use client";

import { Fragment } from "react";
import { Card, PrimaryButton, ErrorText, inputCls } from "@/components/admin-ui";
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
  RECEIVABLE_STATE_LABELS,
  RECEIVABLE_STATE_BADGE_CLASS,
  type BillingScheduleExt,
  type InstallmentInputExt,
  type BillingKind,
} from "@/lib/projects-ext-api";
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
}

/** 分期請款期程（模組四第 4 條）＋ P3 開票／收款。金額一律系統算，不手動拉格。 */
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
}: BillingsCardProps) {
  function patchDraft(idx: number, patch: Partial<InstallmentInputExt>) {
    setDraft((d) => d.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  function addRow() {
    const nextNo = draft.reduce((m, r) => Math.max(m, r.installmentNo), 0) + 1;
    setDraft((d) => [...d, { installmentNo: nextNo, percentage: null, milestone: "" }]);
  }

  function removeRow(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }

  /** 平均分配百分比——這正是客戶說的「不要用 Excel 拉格」。 */
  function splitEvenly() {
    if (draft.length === 0) return;
    const pct = Math.round((100 / draft.length) * 1000) / 1000;
    setDraft((d) => d.map((row) => ({ ...row, percentage: pct })));
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setError(null);
    try {
      const res = await saveBillingSchedule(projectId, draft);
      setSchedule(res);
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, humanError(err, "儲存期程失敗")));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function markBilled(id: string) {
    setError(null);
    try {
      setSchedule(await billInstallmentExt(id));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, humanError(err, "標記請款失敗")));
    }
  }

  async function cancelBilled(id: string) {
    const reason = window.prompt("取消請款的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await unbillInstallmentExt(id, reason.trim()));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "取消請款失敗"));
    }
  }

  async function submitInvoice(id: string) {
    if (!invoiceNo.trim()) {
      setError("請輸入發票號碼");
      return;
    }
    setError(null);
    try {
      setSchedule(await invoiceBilling(id, { invoiceNo: invoiceNo.trim(), invoicedOn }));
      setInvoiceFormId(null);
      setInvoiceNo("");
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "標記開票失敗"));
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
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-2 pr-2 w-14">期</th>
              <th className="py-2 pr-2">階段</th>
              <th className="py-2 pr-2 w-24">百分比</th>
              <th className="py-2 pr-2 w-36">預定日</th>
              <th className="py-2 pr-2 text-right">系統試算</th>
              <th className="py-2 pr-2 w-32 text-right">人工指定</th>
              <th className="py-2 pr-2">狀態</th>
              <th className="py-2 pr-2"></th>
            </tr>
          </thead>
          <tbody>
            {draft.map((rowDraft, idx) => {
              const saved = schedule?.installments.find((i) => i.id === rowDraft.id);
              const billed = !!saved?.billedOn;
              const received = !!saved?.receivedOn;
              const locked = billed || received;
              // B5：同一套三段狀態＋逾期 badge（跟 /admin/projects/receivables 共用顏色）。
              // 這支 schedule API 沒有租戶逾期基準，固定用 'billed'（見 computeReceivableState 註解）。
              // today 用 localTodayKey()，不是這檔案原本的 todayKey()——後者取 UTC 日期，
              // 在 UTC+8 每天凌晨會少算一天，會把「逾期一天」誤判成「還沒逾期」。
              const rowState = computeReceivableState({
                billedOn: saved?.billedOn ?? null,
                invoicedOn: saved?.invoicedOn ?? null,
                receivedOn: saved?.receivedOn ?? null,
                today: localTodayKey(),
              });
              return (
                <Fragment key={rowDraft.id ?? `new-${idx}`}>
                  <tr className="border-b last:border-0">
                    <td className="py-2 pr-2">
                      <input
                        className={`${inputCls} w-12`}
                        type="number"
                        min="1"
                        value={rowDraft.installmentNo}
                        disabled={locked}
                        onChange={(e) => patchDraft(idx, { installmentNo: Number(e.target.value) })}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        className={inputCls}
                        value={rowDraft.milestone ?? ""}
                        placeholder="開工款／完成 50%／驗收款／保留款"
                        onChange={(e) => patchDraft(idx, { milestone: e.target.value })}
                      />
                      <select
                        className="mt-1 w-full rounded border border-gray-200 px-1 py-0.5 text-[11px] text-gray-500"
                        value={rowDraft.kind ?? "installment"}
                        disabled={locked}
                        onChange={(e) => patchDraft(idx, { kind: e.target.value as BillingKind })}
                      >
                        <option value="installment">一般分期</option>
                        <option value="guild_advance">技師公會代墊</option>
                      </select>
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        className={inputCls}
                        type="number"
                        step="0.001"
                        min="0"
                        max="100"
                        value={rowDraft.percentage ?? ""}
                        disabled={locked}
                        onChange={(e) =>
                          patchDraft(idx, {
                            percentage: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        className={inputCls}
                        type="date"
                        value={rowDraft.plannedOn ?? ""}
                        onChange={(e) => patchDraft(idx, { plannedOn: e.target.value || null })}
                      />
                    </td>
                    <td className="py-2 pr-2 text-right text-gray-600">
                      {saved?.calculatedAmount == null ? (
                        "—"
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
                      <input
                        className={`${inputCls} text-right`}
                        type="number"
                        placeholder="—"
                        value={rowDraft.overrideAmount ?? ""}
                        disabled={locked}
                        onChange={(e) =>
                          patchDraft(idx, {
                            overrideAmount: e.target.value === "" ? null : Number(e.target.value),
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
                    <td className="py-2 pr-2 text-right">
                      {!locked && (
                        <button
                          type="button"
                          className="text-xs text-gray-400 hover:text-red-600"
                          onClick={() => removeRow(idx)}
                        >
                          移除
                        </button>
                      )}
                    </td>
                  </tr>
                  {saved && (
                    <tr className="border-b bg-gray-50/60 text-xs last:border-0">
                      <td colSpan={8} className="py-1.5 pl-8 pr-2">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                          {saved.kind === "guild_advance" && (
                            <span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-700">
                              {BILLING_KIND_LABELS.guild_advance}
                            </span>
                          )}
                          {/* 開票 */}
                          {saved.invoicedOn ? (
                            <button type="button" className="text-green-700 hover:underline" onClick={() => cancelInvoice(saved.id)}>
                              已開票 {saved.invoiceNo}／{saved.invoicedOn}（點取消）
                            </button>
                          ) : !billed ? (
                            <span className="text-gray-300">未請款，尚無法開票</span>
                          ) : invoiceFormId === saved.id ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <input className="w-28 rounded border border-gray-300 px-1.5 py-0.5" placeholder="發票號碼" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
                              <input className="rounded border border-gray-300 px-1.5 py-0.5" type="date" value={invoicedOn} onChange={(e) => setInvoicedOn(e.target.value)} />
                              <button type="button" className="rounded bg-gray-700 px-2 py-0.5 text-white" onClick={() => submitInvoice(saved.id)}>確認</button>
                              <button type="button" className="text-gray-400" onClick={() => setInvoiceFormId(null)}>取消</button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rounded border border-gray-200 bg-white px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                              onClick={() => { setInvoiceFormId(saved.id); setInvoiceNo(""); setInvoicedOn(todayKey()); }}
                            >
                              標記開票
                            </button>
                          )}
                          {/* 入帳 */}
                          {saved.receivedOn ? (
                            <button type="button" className="text-green-700 hover:underline" onClick={() => cancelReceive(saved.id)}>
                              已入帳 {fmtMoney(saved.receivedAmount)}／{saved.receivedOn}（點取消）
                            </button>
                          ) : receiveFormId === saved.id ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <input className="rounded border border-gray-300 px-1.5 py-0.5" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
                              <input className="w-24 rounded border border-gray-300 px-1.5 py-0.5 text-right" type="number" placeholder={fmtMoney(saved.effectiveAmount)} value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)} />
                              <button type="button" className="rounded bg-gray-700 px-2 py-0.5 text-white" onClick={() => submitReceive(saved.id)}>確認</button>
                              <button type="button" className="text-gray-400" onClick={() => setReceiveFormId(null)}>取消</button>
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
                <td className="py-2 pr-2" colSpan={2}>合計</td>
                <td className="py-2 pr-2">
                  <span className={schedule.summary.percentageTotal === 100 ? "text-gray-700" : "text-amber-600"}>
                    {schedule.summary.percentageTotal}%
                    {schedule.summary.percentageTotal !== 100 && " ⚠️"}
                  </span>
                </td>
                <td className="py-2 pr-2"></td>
                <td className="py-2 pr-2 text-right" colSpan={2}>
                  {fmtMoney(schedule.summary.effectiveTotal)}
                </td>
                <td className="py-2 pr-2 text-xs text-gray-500" colSpan={2}>
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
          請新增一期，或調整人工指定的金額。
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={saveSchedule} disabled={savingSchedule}>
          {savingSchedule ? "儲存中…" : "儲存期程"}
        </PrimaryButton>
        <button
          type="button"
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          onClick={addRow}
        >
          ＋ 新增一期
        </button>
        <button
          type="button"
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          onClick={splitEvenly}
          disabled={draft.length === 0}
        >
          平均分配百分比
        </button>
        <span className="text-xs text-gray-400">
          金額一律由系統算：末期自動吸收四捨五入的尾差，合計必然等於合約金額。
        </span>
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
