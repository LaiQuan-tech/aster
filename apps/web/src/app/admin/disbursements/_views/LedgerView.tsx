"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Card, Empty, ErrorText, inputCls } from "@/components/admin-ui";
import { FitToWidth } from "@/components/FitToWidth";
import {
  BILLING_KIND_LABELS,
  RECEIVABLE_STATE_BADGE_CLASS,
  RECEIVABLE_STATE_LABELS,
} from "@/lib/projects-ext-api";
import {
  batchPayDisbursements,
  describeBatchPayError,
  humanizeDisbursementError,
  type Disbursement,
} from "@/lib/disbursements-api";
import {
  LEDGER_CHIPS,
  VENDOR_ROW_STATE_LABELS,
  VENDOR_ROW_STATE_TONE,
  applyBatchPayResults,
  filterLedger,
  markPaidCheck,
  validateBatchPay,
  type LedgerChip,
  type ProjectLedger,
  type VendorRow,
} from "@/lib/billing-disbursement";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

/** 兩張子表固定欄寬（colgroup 合計 1074px＝外框 1100 扣邊框與內距），所有專案上下對齊；1280 寬由 FitToWidth 縮放。 */
const TABLE_W = "w-full table-fixed text-[13px]";
const TH = "py-1.5 pr-2 font-normal";

/** 未勾選時說明為什麼不能勾。 */
function blockedReason(row: VendorRow, checkReason: string | null): string {
  if (!row.disbursement) {
    return row.state === "unaccepted"
      ? "未驗收：先在專案頁按「驗收確認」，再到「應付建單」建立放款單送簽"
      : "還沒建放款單：到「應付建單」建立放款單並送簽，核准後才能放款";
  }
  if (row.state === "paid") return "已放款";
  return checkReason ?? VENDOR_ROW_STATE_LABELS[row.state];
}

type RowResult = { ok: true } | { ok: false; reason: string };

/**
 * 「請款與放款」頁的主檢視：每個專案一塊——上面客戶請款（期別／金額／請款日／發票／入帳／未收），
 * 下面廠商付款（請款依據／驗收／毛額／扣繳／實付／狀態／放款單／放款公司／收據），可放款的列打勾，
 * 底部固定列「標記已放款」→ 填放款日（預設今天）與實付（預設核准金額）→ POST /disbursements/batch-pay，
 * 逐筆顯示結果；成功的自動取消勾選、不會重送。規則見 lib/billing-disbursement.ts 與後端 disbursement-batch-pay.ts。
 */
export default function LedgerView({
  ledger,
  disbursements,
  payablesAcceptance,
  acceptanceTracked,
  today,
  loading,
  q,
  scope,
  onScopeChange,
  onPaid,
}: {
  ledger: ProjectLedger[];
  disbursements: Disbursement[];
  /** 未付期款 id → 驗收日／期別（打勾預檢用）。 */
  payablesAcceptance: ReadonlyMap<string, { acceptedOn?: string | null; installmentNo: number }>;
  acceptanceTracked: boolean;
  today: string;
  loading: boolean;
  q: string;
  scope: "open" | "all";
  onScopeChange: (scope: "open" | "all") => void;
  /** 批次送出、拿到逐筆結果後呼叫（頁面重抓資料，以伺服器為準）。 */
  onPaid: () => Promise<void> | void;
}) {
  const [chip, setChip] = useState<LedgerChip>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [paidOn, setPaidOn] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [panelError, setPanelError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(disbursements.map((d) => [d.id, d])), [disbursements]);
  const checks = useMemo(() => {
    const m = new Map<string, ReturnType<typeof markPaidCheck>>();
    for (const d of disbursements) m.set(d.id, markPaidCheck(d, payablesAcceptance, acceptanceTracked));
    return m;
  }, [disbursements, payablesAcceptance, acceptanceTracked]);

  const shown = useMemo(() => filterLedger(ledger, { q, chip }), [ledger, q, chip]);
  /** 畫面上看得到、可以勾的放款單。 */
  const selectableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of shown) for (const v of p.vendorRows) if (v.state === "ready_to_pay" && v.disbursement) ids.add(v.disbursement.id);
    return [...ids];
  }, [shown]);

  // 資料重抓後（例如別人剛撤回簽核、或這張已放款），不再可放款的單自動取消勾選。
  useEffect(() => {
    setSelected((cur) => {
      const next = new Set([...cur].filter((id) => checks.get(id)?.ok === true));
      return next.size === cur.size ? cur : next;
    });
  }, [checks]);

  /** 勾了但被目前篩選／關鍵字藏起來的單（仍會一起送出，底部列提示）。 */
  const hiddenSelected = useMemo(() => {
    const visible = new Set(selectableIds);
    return [...selected].filter((id) => !visible.has(id)).length;
  }, [selected, selectableIds]);

  const selectedList = useMemo(() => [...selected].map((id) => byId.get(id)).filter((d): d is Disbursement => !!d), [selected, byId]);
  const selectedTotal = selectedList.reduce((s, d) => s + d.amount, 0);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectMany(ids: string[], on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function openPanel() {
    setPaidOn(today);
    setAmounts(Object.fromEntries(selectedList.map((d) => [d.id, String(d.amount)])));
    setResults({});
    setPanelError(null);
    setPanelOpen(true);
  }

  async function confirmPay() {
    const rows = selectedList.map((d) => {
      const raw = (amounts[d.id] ?? String(d.amount)).replace(/,/g, "").trim();
      return { id: d.id, disbursementNo: d.disbursementNo, approvedAmount: d.amount, amount: raw === "" ? null : Number(raw) };
    });
    const { dateError, rowErrors } = validateBatchPay(paidOn, rows);
    if (dateError) {
      setPanelError(dateError);
      return;
    }
    setPanelError(null);
    const next: Record<string, RowResult> = {};
    for (const [id, reason] of Object.entries(rowErrors)) next[id] = { ok: false, reason };
    const toSend = rows.filter((r) => !rowErrors[r.id]);
    if (toSend.length === 0) {
      setResults(next);
      return;
    }
    setBusy(true);
    try {
      const res = await batchPayDisbursements({ paidOn, items: toSend.map((r) => ({ id: r.id, amount: r.amount ?? undefined })) });
      const applied = applyBatchPayResults(selected, res.results, describeBatchPayError);
      for (const id of applied.succeeded) next[id] = { ok: true };
      for (const [id, reason] of Object.entries(applied.failures)) next[id] = { ok: false, reason };
      setResults(next);
      setSelected(applied.remaining);
      // 不論成敗都重抓：有的單可能已寫成已放款但回報失敗（例如寫完之後的步驟出錯），畫面要以伺服器為準。
      await onPaid();
    } catch (err) {
      // 整批請求失敗（網路／權限）：一筆都沒確認，勾選保留，可以再按一次。
      setPanelError(humanizeDisbursementError(err, "送出失敗，請再試一次"));
      setResults(next);
    } finally {
      setBusy(false);
    }
  }

  /** 結果列（包含剛成功、已不在勾選裡的單）。 */
  const panelRows = useMemo(() => {
    const ids = new Set([...selected, ...Object.keys(results)]);
    return [...ids].map((id) => byId.get(id)).filter((d): d is Disbursement => !!d);
  }, [selected, results, byId]);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="radio" name="ledger-scope" checked={scope === "open"} onChange={() => onScopeChange("open")} />
            只看未完成
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600" title="含已收完的請款期別與近 90 天已放款">
            <input type="radio" name="ledger-scope" checked={scope === "all"} onChange={() => onScopeChange("all")} />
            全部（含近 90 天已放款）
          </label>
          <span className="mx-1 h-4 w-px bg-gray-200" />
          {LEDGER_CHIPS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setChip(c.value)}
              className={`rounded-full px-2.5 py-1 text-xs ${chip === c.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {c.label}
            </button>
          ))}
          <div className="grow" />
          <span className="text-xs text-gray-500">{shown.length} 個專案</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={selectableIds.length === 0}
            onClick={() => selectMany(selectableIds, !selectableIds.every((id) => selected.has(id)))}
          >
            {selectableIds.length > 0 && selectableIds.every((id) => selected.has(id)) ? "取消全選" : `全選可放款（${selectableIds.length}）`}
          </Button>
        </div>
      </Card>

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : shown.length === 0 ? (
          <Empty>{q.trim() || chip !== "all" ? "沒有符合條件的專案" : "目前沒有未完成的請款或放款"}</Empty>
        ) : (
          <FitToWidth baseFontPx={13}>
            <div className="w-[1100px] space-y-6">
              {shown.map((p) => (
                <ProjectBlock
                  key={p.projectId}
                  p={p}
                  selected={selected}
                  checks={checks}
                  onToggle={toggle}
                  onSelectProject={(ids, on) => selectMany(ids, on)}
                />
              ))}
            </div>
          </FitToWidth>
        )}
      </Card>

      {(selected.size > 0 || panelOpen) && (
        <div className="sticky bottom-0 z-20 -mx-1 rounded-t-2xl border border-gray-200 bg-white px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]">
          {!panelOpen ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-700">
                已勾 <b>{selected.size}</b> 張放款單・實付合計 <b className="tabular-nums">{fmtMoney(selectedTotal)}</b>
                {hiddenSelected > 0 && <span className="ml-2 text-xs text-amber-600">（其中 {hiddenSelected} 張不在目前篩選內，也會一起送出）</span>}
              </span>
              <div className="grow" />
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>清除勾選</Button>
              <Button size="sm" onClick={openPanel}>標記已放款…</Button>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-semibold text-gray-800">標記已放款</h3>
                <label className="flex items-center gap-2 whitespace-nowrap text-sm text-gray-600">
                  放款日
                  <input type="date" className={`${inputCls} w-40`} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                </label>
                <span className="text-xs text-gray-400">實付預設＝核准金額；已核准的金額不能直接改（要改請撤回簽核改單）。強制付款、未驗收放行請到放款單明細逐張處理。</span>
              </div>
              <ErrorText>{panelError}</ErrorText>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b text-left text-xs text-gray-500">
                      <th className={TH}>放款單</th>
                      <th className={TH}>收款方</th>
                      <th className={TH}>分攤</th>
                      <th className={`${TH} text-right`}>代扣</th>
                      <th className={`${TH} text-right`}>核准實付</th>
                      <th className={`${TH} w-36 text-right`}>實付</th>
                      <th className={TH}>結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panelRows.map((d) => {
                      const r = results[d.id];
                      const done = r?.ok === true;
                      return (
                        <tr key={d.id} className="border-b last:border-0">
                          <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-xs">
                            <Link href={`/admin/disbursements/${d.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{d.disbursementNo}</Link>
                          </td>
                          <td className="py-1.5 pr-2 text-gray-800">{d.payeeName}</td>
                          <td className="py-1.5 pr-2 text-gray-500">{d.allocationLabel ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums text-gray-500">{fmtMoney(d.withheldAmount)}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums text-gray-700">{fmtMoney(d.amount)}</td>
                          <td className="py-1.5 pr-2 text-right">
                            <input
                              className={`${inputCls} w-32 text-right tabular-nums`}
                              inputMode="decimal"
                              aria-label={`${d.disbursementNo} 實付`}
                              value={amounts[d.id] ?? String(d.amount)}
                              disabled={done || busy}
                              onChange={(e) => setAmounts((a) => ({ ...a, [d.id]: e.target.value }))}
                            />
                          </td>
                          <td className="py-1.5 pr-2 text-xs">
                            {!r ? (
                              <span className="text-gray-400">待送出</span>
                            ) : r.ok ? (
                              <span className="font-medium text-emerald-700">✓ 已放款</span>
                            ) : (
                              <span className="text-red-600">✗ {r.reason}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-600">
                  待送出 {selected.size} 張・實付合計 <b className="tabular-nums">{fmtMoney(selectedTotal)}</b>
                </span>
                <div className="grow" />
                <Button variant="ghost" size="sm" onClick={() => { setPanelOpen(false); setResults({}); }} disabled={busy}>
                  {Object.keys(results).length > 0 ? "關閉" : "取消"}
                </Button>
                <Button size="sm" onClick={() => void confirmPay()} loading={busy} disabled={selected.size === 0}>
                  確認放款（{selected.size} 張）
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ProjectBlock({
  p,
  selected,
  checks,
  onToggle,
  onSelectProject,
}: {
  p: ProjectLedger;
  selected: ReadonlySet<string>;
  checks: ReadonlyMap<string, { ok: boolean; reason: string | null }>;
  onToggle: (id: string) => void;
  onSelectProject: (ids: string[], on: boolean) => void;
}) {
  const projectSelectable = [...new Set(p.vendorRows.filter((v) => v.state === "ready_to_pay" && v.disbursement).map((v) => v.disbursement!.id))];
  const allOn = projectSelectable.length > 0 && projectSelectable.every((id) => selected.has(id));

  return (
    <section className="rounded-xl border border-gray-200">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-t-xl bg-gray-50 px-3 py-2">
        <Link href={`/admin/projects/${p.projectId}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>
          {p.code ?? "—"}
        </Link>
        <span className="font-semibold text-gray-900">{p.name}</span>
        {p.archived && <span className="rounded bg-gray-200 px-1 text-[10px] text-gray-600">已封存</span>}
        <span className="text-xs text-gray-500">{p.clientName ?? ""}</span>
        <div className="grow" />
        <span className="text-xs text-gray-600">
          收款進度 <b className="tabular-nums">{p.receiptProgressPct == null ? "—" : `${p.receiptProgressPct}%`}</b>
        </span>
        <span className="text-xs text-gray-600">
          未收 <b className="tabular-nums text-red-600">{fmtMoney(p.totals.unreceived)}</b>
          {p.totals.overdueCount > 0 && <span className="ml-1 text-amber-600">（逾期 {p.totals.overdueCount}）</span>}
        </span>
        <span className="text-xs text-gray-600">
          未放款 <b className="tabular-nums text-gray-900">{fmtMoney(p.totals.unpaidNet)}</b>
          {p.totals.unpaidNetUnlinked !== 0 && (
            <span
              className="ml-1 text-amber-700"
              title="應付清單只算掛在複委託期款上的金額；這裡另外含沒有掛期款的放款單分攤，所以會比應付清單多。"
            >
              （含未掛期款的放款單 {fmtMoney(p.totals.unpaidNetUnlinked)}）
            </span>
          )}
        </span>
        <span className="text-xs text-gray-600">
          可放款 <b className="tabular-nums text-emerald-700">{fmtMoney(p.totals.readyToPayNet)}</b>
        </span>
      </header>

      <div className="px-3 pb-3 pt-2">
        <h4 className="mb-1 text-xs font-semibold text-gray-500">客戶請款</h4>
        {p.billings.length === 0 ? (
          <p className="py-1 text-xs text-gray-400">沒有請款期別（或都已收完）</p>
        ) : (
          <table className={TABLE_W}>
            <colgroup>
              {[50, 150, 40, 100, 90, 170, 90, 95, 100, 64, 125].map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className={TH}>期別</th>
                <th className={TH}>階段</th>
                <th className={`${TH} text-right`}>%</th>
                <th className={`${TH} text-right`}>請款金額</th>
                <th className={TH}>請款日</th>
                <th className={TH}>開票日／發票</th>
                <th className={TH}>入帳日</th>
                <th className={`${TH} text-right`}>已收</th>
                <th className={`${TH} text-right`}>未收</th>
                <th className={`${TH} text-right`}>逾期天數</th>
                <th className={TH}>狀態</th>
              </tr>
            </thead>
            <tbody>
              {p.billings.map((b) => (
                <tr key={b.billingId} className="border-b align-top last:border-0">
                  <td className="py-1 pr-2 text-gray-600">
                    {b.installmentNo}
                    {b.kind === "guild_advance" && (
                      <span className="ml-1 inline-block whitespace-nowrap rounded bg-purple-50 px-1 text-[10px] text-purple-700">{BILLING_KIND_LABELS.guild_advance}</span>
                    )}
                  </td>
                  <td className="truncate py-1 pr-2 text-gray-600" title={b.milestone ?? undefined}>{b.milestone ?? "—"}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-gray-500">{b.percentage ?? "—"}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-gray-800">{fmtMoney(b.amount)}</td>
                  <td className="py-1 pr-2 tabular-nums text-gray-500">{b.billedOn ?? "—"}</td>
                  <td className="py-1 pr-2 tabular-nums text-gray-500">
                    {b.invoicedOn ?? "—"}
                    {b.invoiceNo && <span className="ml-1 text-xs text-gray-400">{b.invoiceNo}</span>}
                  </td>
                  <td className="py-1 pr-2 tabular-nums text-gray-500">{b.receivedOn ?? "—"}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-gray-600">{fmtMoney(b.receivedAmount)}</td>
                  <td className="py-1 pr-2 text-right font-medium tabular-nums text-red-600">{fmtMoney(b.unreceived)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {b.overdueDays != null && b.overdueDays > 0 ? <span className="font-medium text-red-600">{b.overdueDays}</span> : <span className="text-gray-400">{b.overdueDays ?? "—"}</span>}
                  </td>
                  <td className="py-1 pr-2">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${RECEIVABLE_STATE_BADGE_CLASS[b.state]}`}>{RECEIVABLE_STATE_LABELS[b.state]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mb-1 mt-3 flex items-center gap-3">
          <h4 className="text-xs font-semibold text-gray-500">廠商付款</h4>
          {projectSelectable.length > 0 && (
            <button type="button" className="text-xs hover:underline" style={{ color: "var(--brand)" }} onClick={() => onSelectProject(projectSelectable, !allOn)}>
              {allOn ? "取消此案勾選" : `勾選此案可放款（${projectSelectable.length}）`}
            </button>
          )}
        </div>
        {p.vendorRows.length === 0 ? (
          <p className="py-1 text-xs text-gray-400">沒有待付或近期已付的廠商款</p>
        ) : (
          <table className={TABLE_W}>
            <colgroup>
              {[28, 170, 40, 110, 82, 86, 66, 86, 120, 108, 110, 68].map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className={TH}><span className="sr-only">放款勾選</span></th>
                <th className={TH}>廠商／項目</th>
                <th className={TH}>期別</th>
                <th className={TH}>請款依據</th>
                <th className={TH}>驗收</th>
                <th className={`${TH} text-right`}>應付毛額</th>
                <th className={`${TH} text-right`}>扣繳</th>
                <th className={`${TH} text-right`}>實付</th>
                <th className={TH}>狀態</th>
                <th className={TH}>放款單</th>
                <th className={TH}>放款公司／收據</th>
                <th className={TH}>放款日</th>
              </tr>
            </thead>
            <tbody>
              {p.vendorRows.map((v) => {
                const d = v.disbursement;
                const canPick = v.state === "ready_to_pay" && !!d;
                const reason = canPick ? null : blockedReason(v, d ? (checks.get(d.id)?.reason ?? null) : null);
                return (
                  <tr key={v.key} className={`border-b align-top last:border-0 ${v.state === "paid" ? "text-gray-400" : ""}`}>
                    <td className="py-1 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`勾選放款 ${v.vendorName}${v.installmentNo ? ` 第 ${v.installmentNo} 期` : ""}`}
                        checked={!!d && selected.has(d.id)}
                        disabled={!canPick}
                        title={reason ?? "勾選後可批次標記已放款"}
                        onChange={() => d && onToggle(d.id)}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <div className="truncate text-gray-800" title={v.vendorName}>{v.vendorName}</div>
                      {v.item && <div className="truncate text-xs text-gray-400" title={v.item}>{v.item}</div>}
                    </td>
                    <td className="py-1 pr-2 text-gray-600">{v.installmentNo ?? "—"}</td>
                    <td className="truncate py-1 pr-2 text-gray-500" title={v.dueWhen ?? undefined}>{v.dueWhen ?? "—"}</td>
                    <td className="py-1 pr-2 text-xs tabular-nums">
                      {v.acceptedOn ? <span className="text-emerald-700">{v.acceptedOn}</span> : v.state === "paid" || !v.subcontractPaymentId ? <span className="text-gray-400">—</span> : <span className="text-orange-700">未驗收</span>}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtMoney(v.grossAmount)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-gray-500">{fmtMoney(v.withheldAmount)}</td>
                    <td className="py-1 pr-2 text-right font-medium tabular-nums">{fmtMoney(v.netAmount)}</td>
                    <td className="py-1 pr-2">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${VENDOR_ROW_STATE_TONE[v.state]}`} title={reason ?? undefined}>
                        {VENDOR_ROW_STATE_LABELS[v.state]}
                        {v.state === "pending_approval" && d?.currentStep ? `・第 ${d.currentStep} 關` : ""}
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-xs">
                      {d ? (
                        <>
                          <Link href={`/admin/disbursements/${d.id}`} className="font-mono hover:underline" style={{ color: "var(--brand)" }}>
                            {d.disbursementNo}
                          </Link>
                          {d.projectCount > 1 && <div className="text-[10px] text-gray-400" title="一張放款單分攤到多個專案，勾選＝整張單一起放款">跨 {d.projectCount} 案・整張放款</div>}
                        </>
                      ) : (
                        <span className="text-gray-400">未建單</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-xs text-gray-500">
                      {d ? (
                        <>
                          <div className="truncate" title={d.payingCompanyName ?? undefined}>{d.payingCompanyName ?? "—"}</div>
                          <div className="truncate text-gray-400">
                            {d.receiptRef ? `收據 ${d.receiptRef}` : d.hasInvoice ? `發票 ${d.invoiceNo ?? "✓"}` : "收據／發票未填"}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-1 pr-2 text-xs tabular-nums text-gray-500">{d?.status === "paid" ? d.paidOn ?? "—" : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
