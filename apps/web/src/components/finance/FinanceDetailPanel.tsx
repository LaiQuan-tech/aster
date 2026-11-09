"use client";

/**
 * 「費用與給付」待處理清單的明細面板（桌機在右側、手機在清單下方）。依類型顯示明細並提供該類型動作：
 *   - 報銷：明細＋憑證（點開才載入）＋待確認提示；「退件」（必填原因、再確認，呼叫既有 PATCH /expenses/:id）
 *   - 預支待撥款：選管道後「撥款」；預支待核銷：「核銷（含預覽）」→ 共用 AdvanceSettleSheet
 *   - 加班另計：編輯給付方式／金額／備註、「給付」（付款後整列凍結）
 *   - 三節獎金：逐人改實發金額與備註（批次的產生／發放／匯出在三節獎金區塊）
 * 錯誤訊息沿用各原頁的寫法（err.message；期別鎖定走 errorMessageOf）。
 */
import { useEffect, useState } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { Button, Empty, ErrorText, Pill } from "@/components/admin-ui";
import {
  getExpenseAttachments,
  payAdvance,
  rejectExpenseClaim,
  type ExpenseAttachment,
  type ExpenseClaim,
  type ExpenseReview,
} from "@/lib/admin-api";
import { getAdvanceSettlementPreview } from "@/lib/advances-api";
import { advanceDate, advanceSubject, apiErrorCode, type SettlementPreview } from "@/lib/advance-view";
import {
  FESTIVAL_LABEL,
  OT_CHANNELS,
  OT_CHANNEL_LABEL,
  OT_SOURCE_LABEL,
  minutesLabel,
  money,
  patchFestivalBonus,
  patchOvertimeSettlement,
  payOvertimeSettlement,
  todayKey,
  type Festival,
  type FestivalBonus,
  type OvertimeChannel,
  type OvertimeSettlement,
} from "@/lib/cash-payouts-api";
import {
  QUEUE_KIND_LABEL,
  QUEUE_WARNING_LABEL,
  normalizeRejectReason,
  type AdvanceRowLike,
  type QueueItem,
} from "@/lib/finance-hub";
import { errorMessageOf } from "@/lib/period-closed";
import { AdvanceSettleSheet, type AdvanceRow } from "@/components/finance/AdvanceSettleSheet";

const fieldCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

export interface DetailSources {
  claims: readonly ExpenseClaim[];
  review: ExpenseReview | null;
  categoryName: (id: string) => string;
  advances: readonly AdvanceRowLike[];
  overtime: readonly OvertimeSettlement[];
  festival: readonly FestivalBonus[];
}

export function FinanceDetailPanel({
  item,
  sources,
  empName,
  onDone,
  onClose,
}: {
  item: QueueItem | null;
  sources: DetailSources;
  empName: (item: QueueItem) => string;
  /** 動作成功：訊息交給合併頁顯示，並刷新清單與統計。 */
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  if (!item) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 p-5 text-sm text-gray-500">
        點左側（手機為上方）清單的一列，這裡會顯示明細與可做的動作。
      </div>
    );
  }
  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Pill tone="blue">{QUEUE_KIND_LABEL[item.kind]}</Pill>
          <h3 className="mt-2 break-words text-base font-semibold text-gray-900">{empName(item)}</h3>
          <p className="break-words text-sm text-gray-600">{item.summary}</p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-sm text-gray-500 hover:underline">
          關閉
        </button>
      </div>
      {item.warnings.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.warnings.map((w) => (
            <Pill key={w} tone={w === "attendanceMismatch" || w === "overdue" ? "red" : "amber"}>
              {QUEUE_WARNING_LABEL[w]}
            </Pill>
          ))}
        </div>
      )}
      {item.kind === "expense" && <ExpenseDetail key={item.key} item={item} sources={sources} onDone={onDone} />}
      {(item.kind === "advance_pay" || item.kind === "advance_settle") && (
        <AdvanceDetail key={item.key} item={item} sources={sources} name={empName(item)} onDone={onDone} />
      )}
      {item.kind === "overtime" && <OvertimeDetail key={item.key} item={item} sources={sources} name={empName(item)} onDone={onDone} />}
      {item.kind === "festival" && <FestivalDetail key={item.key} item={item} sources={sources} onDone={onDone} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words text-right text-gray-900">{children}</dd>
    </>
  );
}

/* ── 報銷 ─────────────────────────────────────────────────────────── */

const REJECT_ERROR: Record<string, string> = {
  already_settled: "這張單已月結核銷，不能退件。",
  advance_settled: "這張單綁的預支已核銷，不能退件。",
  forbidden: "沒有權限退件這張單。",
};

function ExpenseDetail({ item, sources, onDone }: { item: QueueItem; sources: DetailSources; onDone: (m: string) => void }) {
  const claim = sources.claims.find((c) => c.id === item.id);
  const [attachments, setAttachments] = useState<ExpenseAttachment[] | null>(null);
  const [attError, setAttError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getExpenseAttachments(item.id)
      .then((r) => active && setAttachments(r.attachments))
      .catch((err) => active && setAttError(err instanceof Error ? err.message : "載入憑證失敗"));
    return () => {
      active = false;
    };
  }, [item.id]);

  if (!claim) return <Empty>找不到這張單（可能已被處理），請重新整理。</Empty>;

  const hints = [
    ...(sources.review?.issues.attendanceMismatch ?? []).filter((r) => r.claimId === claim.id).map((r) => r.hint),
    ...(sources.review?.issues.tripNotApproved ?? []).filter((r) => r.claimId === claim.id).map((r) => r.hint),
  ];

  async function onReject() {
    const r = normalizeRejectReason(reason);
    if (!r) {
      setError("請填退件原因（員工會看到）。");
      return;
    }
    if (!window.confirm(`確定退件這張 ${money(Number(claim!.amount))} 元的報銷？\n\n原因：${r}\n\n退件後不會在月結時核銷，員工需重新填報。`)) return;
    setBusy(true);
    setError(null);
    try {
      await rejectExpenseClaim(claim!.id, r);
      onDone(`已退件：${money(Number(claim!.amount))} 元（${r}）`);
    } catch (err) {
      const code = apiErrorCode(err);
      setError((code && REJECT_ERROR[code]) || errorMessageOf(err, "退件失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-gray-50 px-3 py-2.5 text-sm">
        <Row label="發生日">{claim.incurred_on}</Row>
        <Row label="類別">{sources.categoryName(claim.category_id)}</Row>
        <Row label="性質">{claim.nature === "allowance" ? "定額補貼（屬薪資所得）" : "實報實銷"}</Row>
        <Row label="金額">{money(Number(claim.amount))} 元</Row>
        <Row label="期別">{claim.period}</Row>
        {claim.note ? <Row label="說明">{claim.note}</Row> : null}
      </dl>
      {hints.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          {hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      <div>
        <h4 className="mb-1 text-xs font-medium text-gray-500">憑證</h4>
        {attError ? (
          <ErrorText>{attError}</ErrorText>
        ) : attachments === null ? (
          <p className="text-xs text-gray-500">載入中…</p>
        ) : attachments.length === 0 ? (
          <p className="text-xs text-red-700">此單沒有憑證。沒有憑證的給付，國稅局傾向認定為薪資。</p>
        ) : (
          <ul className="space-y-1">
            {attachments.map((a) => (
              <li key={a.id} className="break-all text-xs">
                {a.fileName}
                <span className="ml-2 text-gray-500">{Math.round(a.sizeBytes / 1024)} KB</span>
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="ml-2 text-blue-600 underline">
                    開啟
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2 border-t border-gray-100 pt-3">
        <label className={labelCls} htmlFor="reject-reason">
          退件原因（必填，員工會看到）
        </label>
        <textarea
          id="reject-reason"
          rows={2}
          maxLength={250}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例：缺憑證，請補附發票後重新填報"
          className={fieldCls}
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Button variant="secondary" onClick={() => void onReject()} loading={busy}>
          退件
        </Button>
        <p className="text-xs text-gray-400">報銷不需逐筆核准；沒問題的單留著，月結時在報銷區塊一次核銷。</p>
      </div>
    </>
  );
}

/* ── 預支 ─────────────────────────────────────────────────────────── */

function AdvanceDetail({
  item,
  sources,
  name,
  onDone,
}: {
  item: QueueItem;
  sources: DetailSources;
  name: string;
  onDone: (m: string) => void;
}) {
  const a = sources.advances.find((x) => x.id === item.id) as (AdvanceRow & AdvanceRowLike) | undefined;
  const [channel, setChannel] = useState<"cash" | "transfer">("transfer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [settleTarget, setSettleTarget] = useState<AdvanceRow | null>(null);

  if (!a) return <Empty>找不到這筆預支（可能已被處理），請重新整理。</Empty>;
  const amount = Number(a.amount);

  async function onPay() {
    if (!window.confirm(`撥款 ${money(amount)} 元給 ${name}（${channel === "cash" ? "現金" : "匯款"}）？`)) return;
    setBusy(true);
    setError(null);
    try {
      await payAdvance(a!.id, { payoutChannel: channel });
      onDone(`已撥款 ${money(amount)} 元（${channel === "cash" ? "現金" : "匯款"}）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "撥款失敗");
    } finally {
      setBusy(false);
    }
  }

  async function onSettle() {
    setBusy(true);
    setError(null);
    try {
      const p = await getAdvanceSettlementPreview(a!.id);
      setPreview(p);
      setSettleTarget(a!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取核銷預覽失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-gray-50 px-3 py-2.5 text-sm">
        <Row label="種類">{a.kind === "petty_cash" ? "零用金預支" : "出差預支"}</Row>
        <Row label="事由">
          {advanceDate(a)} {advanceSubject(a)}
        </Row>
        <Row label="預支金額">{money(amount)} 元</Row>
        <Row label="核准於">{a.created_at.slice(0, 10)}</Row>
        {a.paid_at ? <Row label="撥款日">{a.paid_at.slice(0, 10)}</Row> : null}
        {a.payout_channel ? <Row label="管道">{a.payout_channel === "cash" ? "現金" : "匯款"}</Row> : null}
        {a.daysOutstanding !== undefined && a.daysOutstanding !== null ? (
          <Row label="已過天數">
            {a.daysOutstanding}
            {a.overdue ? "（逾期）" : ""}
          </Row>
        ) : null}
      </dl>
      {error && <ErrorText>{error}</ErrorText>}
      {item.kind === "advance_pay" ? (
        <div className="space-y-2 border-t border-gray-100 pt-3">
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className={labelCls}>撥款管道（必填，現金尤其要留痕）</legend>
            {(["transfer", "cash"] as const).map((c) => (
              <label key={c} className="flex min-h-9 items-center gap-2">
                <input type="radio" name="payout-channel" checked={channel === c} onChange={() => setChannel(c)} />
                {c === "cash" ? "現金" : "匯款"}
              </label>
            ))}
          </fieldset>
          <Button onClick={() => void onPay()} loading={busy}>
            撥款
          </Button>
        </div>
      ) : (
        <div className="space-y-2 border-t border-gray-100 pt-3">
          <Button onClick={() => void onSettle()} loading={busy}>
            核銷（含預覽）
          </Button>
          <p className="text-xs text-gray-400">先列出綁定的憑證、實支合計與差額，確認後才核銷。</p>
        </div>
      )}
      <AdvanceSettleSheet
        target={settleTarget}
        initialPreview={preview}
        empName={() => name}
        onClose={() => {
          setSettleTarget(null);
          setPreview(null);
        }}
        onSettled={(msg) => {
          setSettleTarget(null);
          setPreview(null);
          onDone(msg);
        }}
      />
    </>
  );
}

/* ── 加班超額另計 ─────────────────────────────────────────────────── */

function OvertimeDetail({
  item,
  sources,
  name,
  onDone,
}: {
  item: QueueItem;
  sources: DetailSources;
  name: string;
  onDone: (m: string) => void;
}) {
  const row = sources.overtime.find((o) => o.id === item.id);
  const [channel, setChannel] = useState<OvertimeChannel>((row?.channel as OvertimeChannel) ?? "cash");
  const [amount, setAmount] = useState(row?.amount === null || row?.amount === undefined ? "" : String(row.amount));
  const [note, setNote] = useState(row?.note ?? "");
  const [paidOn, setPaidOn] = useState(todayKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!row) return <Empty>找不到這筆（可能已被處理），請重新整理。</Empty>;

  const nextAmount = amount === "" ? null : Number(amount);
  const dirty = channel !== row.channel || nextAmount !== row.amount || note !== (row.note ?? "");

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    try {
      await patchOvertimeSettlement(row!.id, {
        ...(channel !== row!.channel ? { channel } : {}),
        ...(nextAmount !== row!.amount ? { amount: nextAmount } : {}),
        ...(note !== (row!.note ?? "") ? { note: note || null } : {}),
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
      return false;
    }
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    if (await save()) onDone(`已儲存：${name} ${row!.period}`);
    setBusy(false);
  }

  async function onPay() {
    if (!confirm(`確定標記「${name}」${row!.period} 這筆已付款？付款後整列凍結。`)) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await save())) return;
      await payOvertimeSettlement(row!.id, { paidOn, channel, amount: nextAmount });
      onDone(`已標記付款：${name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "標記付款失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-gray-50 px-3 py-2.5 text-sm">
        <Row label="月份">{row.period}</Row>
        <Row label="來源">{OT_SOURCE_LABEL[row.source] ?? row.source}</Row>
        <Row label="超額時數">{minutesLabel(row.minutes)}</Row>
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="ot-channel">給付方式</label>
          <select id="ot-channel" className={fieldCls} value={channel} onChange={(e) => setChannel(e.target.value as OvertimeChannel)}>
            {OT_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {OT_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ot-amount">金額</label>
          <MoneyInput id="ot-amount" className={fieldCls} value={amount} onValueChange={(v) => setAmount(v)} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="ot-note">備註</label>
          <input id="ot-note" className={fieldCls} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ot-paid-on">付款日</label>
          <input id="ot-paid-on" type="date" className={fieldCls} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void onSave()} loading={busy} disabled={!dirty}>
          儲存
        </Button>
        <Button onClick={() => void onPay()} loading={busy}>
          給付（標記付款）
        </Button>
      </div>
    </>
  );
}

/* ── 三節獎金 ─────────────────────────────────────────────────────── */

function FestivalDetail({ item, sources, onDone }: { item: QueueItem; sources: DetailSources; onDone: (m: string) => void }) {
  const row = sources.festival.find((f) => f.id === item.id);
  const [finalAmount, setFinalAmount] = useState(row?.final_amount === null || row?.final_amount === undefined ? "" : String(row.final_amount));
  const [note, setNote] = useState(row?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!row) return <Empty>找不到這筆（可能已發放），請重新整理。</Empty>;
  const next = finalAmount === "" ? null : Number(finalAmount);
  const dirty = next !== row.final_amount || note !== (row.note ?? "");

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await patchFestivalBonus(row!.id, {
        ...(next !== row!.final_amount ? { finalAmount: next } : {}),
        ...(note !== (row!.note ?? "") ? { note: note || null } : {}),
      });
      onDone(`已儲存：${row!.employee_name ?? ""} ${row!.year} ${FESTIVAL_LABEL[row!.festival as Festival] ?? row!.festival}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-gray-50 px-3 py-2.5 text-sm">
        <Row label="到職日">{row.hire_date ?? "—"}</Row>
        <Row label="折算月數">{row.prorate_months === null ? "—" : `${row.prorate_months} / 12`}</Row>
        <Row label="建議金額">{money(row.suggested_amount)}</Row>
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="fb-final">實發金額（留空＝照建議）</label>
          <MoneyInput id="fb-final" className={fieldCls} value={finalAmount} onValueChange={(v) => setFinalAmount(v)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="fb-note">備註</label>
          <input id="fb-note" className={fieldCls} value={note} placeholder="加減事由" onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <Button onClick={() => void onSave()} loading={busy} disabled={!dirty}>
        儲存
      </Button>
      <p className="text-xs text-gray-400">產生建議、一次發放並凍結、匯出 xlsx 在下方「三節獎金」區塊。</p>
    </>
  );
}
