"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, DetailHeading, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import AuditDrawer from "@/components/AuditDrawer";
import {
  approveBonusRun,
  deleteBonusRun,
  exportBonusRunXlsx,
  fmtMoney,
  getBonusRun,
  humanizeBonusError,
  patchBonusRun,
  payBonusRun,
  returnBonusRun,
  reverseBonusRun,
  submitBonusRun,
  todayKey,
  withdrawBonusRun,
  type BonusRunDetail,
} from "@/lib/bonus-api";
import Link from "next/link";
import { ExcludedArchivedList, GrossProfitTable, ItemsTable, SkippedList, Stat, StatusBadge, WarningsList } from "../_components";

/**
 * 批次明細：毛利表（入帳／成本／毛利／比例）＋items 表（專案／員工／入帳比例／累計應發／已發／本季應發／超發紅字）。
 * 狀態（2026-10-26 加核准）：
 *   draft：可改期別／基準日並重算、改備註、送審（HR）、刪除（填理由）。
 *   pending_approval：老闆（canApprove）可核准／退回（需原因）；HR 可撤回（需原因）、可重算，金額變了自動退回草稿。
 *   approved：HR 標記已發放（填發放日）；老闆仍可退回。
 *   paid：唯讀＋匯出 Excel（草稿也能匯出，方便先拿去對）。
 */
export default function BonusRunDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [detail, setDetail] = useState<BonusRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const [fLabel, setFLabel] = useState("");
  const [fAsOf, setFAsOf] = useState("");
  const [fNote, setFNote] = useState("");
  const [fPaidOn, setFPaidOn] = useState(todayKey());
  const [showPay, setShowPay] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getBonusRun(id);
      setDetail(d);
      setFLabel(d.run.label);
      setFAsOf(d.run.asOf);
      setFNote(d.run.note ?? "");
    } catch (err) {
      setError(humanizeBonusError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(humanizeBonusError(err, "操作失敗"));
    } finally {
      setBusy(null);
    }
  }

  /** 寫入動作的回應不帶 canApprove（只有 GET 帶），沿用頁面載入時的值。 */
  const keepDetail = useCallback((d: BonusRunDetail) => {
    setDetail((prev) => ({ ...d, canApprove: d.canApprove ?? prev?.canApprove }));
  }, []);

  const run = detail?.run ?? null;
  const isDraft = run?.status === "draft";
  const isPending = run?.status === "pending_approval";
  const isApproved = run?.status === "approved";
  const canApprove = detail?.canApprove === true;

  async function submit() {
    if (!run) return;
    if (!confirm(`將 ${run.label} 送給老闆核准？（本批合計 ${fmtMoney(run.totals.amount)} 元）`)) return;
    await act("submit", async () => keepDetail(await submitBonusRun(id)));
  }
  async function approve() {
    if (!run) return;
    if (!confirm(`核准 ${run.label}？核准後 HR 才能發放（本批合計 ${fmtMoney(run.totals.amount)} 元）。`)) return;
    await act("approve", async () => keepDetail(await approveBonusRun(id)));
  }
  async function withdraw() {
    if (!run) return;
    const reason = prompt(`撤回 ${run.label} 的送審？（老闆會收到通知）請填撤回原因：`);
    if (reason === null) return;
    if (!reason.trim()) {
      setError("撤回原因必填");
      return;
    }
    await act("withdraw", async () => keepDetail(await withdrawBonusRun(id, reason.trim())));
  }
  async function sendBack() {
    if (!run) return;
    const reason = prompt(`退回 ${run.label} 給 HR？請填退回原因：`);
    if (reason === null) return;
    if (!reason.trim()) {
      setError("退回原因必填");
      return;
    }
    await act("return", async () => keepDetail(await returnBonusRun(id, reason.trim())));
  }

  async function recompute() {
    await act("recompute", async () => {
      const d = await patchBonusRun(id, { asOf: fAsOf, label: fLabel.trim(), recompute: true });
      keepDetail(d);
      if (d.returnedToDraft) setError("重算後金額有變動，已退回草稿，請確認後重新送審。");
    });
  }
  async function saveNote() {
    await act("note", async () => {
      const d = await patchBonusRun(id, { note: fNote.trim() || null, label: fLabel.trim() });
      keepDetail(d);
    });
  }
  async function pay() {
    if (!run) return;
    if (!confirm(`確定將 ${run.label} 標記為已發放？發放後即凍結，不能再修改或刪除（金額 ${fmtMoney(run.totals.amount)} 元）。`)) return;
    await act("pay", async () => {
      const d = await payBonusRun(id, { paidOn: fPaidOn });
      keepDetail(d);
      setShowPay(false);
    });
  }
  async function reverse() {
    if (!run) return;
    const reason = prompt(
      `對 ${run.label} 開沖銷批次？\n會建立一批金額全部取負的草稿（${fmtMoney(-run.totals.amount)} 元），你確認後再「發放」才生效；發放後這批在累計口徑上歸零。\n請填沖銷理由（會留在稽核紀錄）：`,
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError("沖銷理由必填");
      return;
    }
    await act("reverse", async () => {
      const d = await reverseBonusRun(id, reason.trim());
      router.push(`/admin/bonus-runs/${d.run.id}`);
    });
  }
  async function remove() {
    if (!run) return;
    const reason = prompt(`刪除草稿 ${run.label}？請填理由（會留在稽核紀錄）：`);
    if (reason === null) return;
    if (!reason.trim()) {
      setError("刪除理由必填");
      return;
    }
    await act("delete", async () => {
      await deleteBonusRun(id, reason.trim());
      router.push("/admin/bonus-runs");
    });
  }

  if (loading && !detail) {
    return (
      <div className="space-y-4">
        <Card>
          <Empty>載入中…</Empty>
        </Card>
      </div>
    );
  }
  if (!run || !detail) {
    return (
      <div className="space-y-4">
        <Card>
          <ErrorText>{error ?? "找不到這筆批次"}</ErrorText>
        </Card>
      </div>
    );
  }

  const skipped = run.totals.skipped.map((s) => ({ ...s, ...(detail.snapshot?.skipped ?? []).find((x) => x.projectId === s.projectId) }));

  return (
    <div className="space-y-4">
      <DetailHeading
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            獎金季發放 {run.label}
            <StatusBadge status={run.status} />
          </span>
        }
        desc={
          <>
            基準日 {run.asOf}（入帳截至此日）　發放日 {run.paidOn ?? "—"}
            {run.note ? `　備註：${run.note}` : ""}
          </>
        }
      >
        <button
          type="button"
          className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 md:rounded-md"
          onClick={() => void act("export", () => exportBonusRunXlsx(run))}
          disabled={busy !== null}
        >
          匯出 Excel
        </button>
        <button type="button" className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 md:rounded-md" onClick={() => setAuditOpen(true)}>
          異動紀錄
        </button>
      </DetailHeading>
      {auditOpen && <AuditDrawer table="bonus_runs" recordId={run.id} title={`批次 ${run.label} 的異動紀錄`} onClose={() => setAuditOpen(false)} />}

      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="本季應發合計" value={`${fmtMoney(run.totals.amount)} 元`} />
        <Stat label="人數／案數" value={`${run.totals.employeeCount} 人／${run.totals.projectCount} 案`} />
        <Stat label="累計應發／已發放" value={`${fmtMoney(run.totals.entitledCumulative)}／${fmtMoney(run.totals.paidBefore)}`} />
        <Stat label="超發列" value={run.totals.overpaidCount > 0 ? `${run.totals.overpaidCount} 列（不自動追討）` : "無"} tone={run.totals.overpaidCount > 0 ? "down" : undefined} />
      </div>

      {isDraft && run.returnReason && (
        <Card>
          <p className="text-sm text-amber-800">
            這批曾被退回／撤回{run.returnedAt ? `（${new Date(run.returnedAt).toLocaleString("zh-TW")}）` : ""}：{run.returnReason}
          </p>
        </Card>
      )}

      <WarningsList warnings={detail.snapshot?.warnings ?? run.totals.warnings} />

      {run.kind === "reversal" && (
        <Card>
          <p className="text-sm text-rose-800">
            這是<b>沖銷批次</b>：內容是{" "}
            {run.reversesRunId ? (
              <Link href={`/admin/bonus-runs/${run.reversesRunId}`} className="underline">被沖銷批次</Link>
            ) : (
              "被沖銷批次"
            )}{" "}
            的每一列金額取負。{run.status === "paid" ? "已發放，" : "發放後"}該批在累計口徑上歸零，下一季重算等於它沒發生過。沖銷批次不能重算、不能改期別。
          </p>
        </Card>
      )}

      {isDraft ? (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-gray-800">草稿設定</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className={labelCls}>期別</label>
              <input className={inputCls} value={fLabel} onChange={(e) => setFLabel(e.target.value)} disabled={run.kind === "reversal"} />
            </div>
            <div>
              <label className={labelCls}>試算基準日</label>
              <input type="date" className={inputCls} value={fAsOf} onChange={(e) => setFAsOf(e.target.value)} disabled={run.kind === "reversal"} />
            </div>
            <div>
              <label className={labelCls}>備註</label>
              <input className={inputCls} value={fNote} onChange={(e) => setFNote(e.target.value)} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {run.kind !== "reversal" && (
              <button
                type="button"
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
                onClick={recompute}
                disabled={busy !== null || !fAsOf}
              >
                {busy === "recompute" ? "重算中…" : "重算明細（用最新入帳／成員）"}
              </button>
            )}
            <button
              type="button"
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
              onClick={run.kind === "reversal" ? () => void act("note", async () => keepDetail(await patchBonusRun(id, { note: fNote.trim() || null }))) : saveNote}
              disabled={busy !== null}
            >
              {busy === "note" ? "儲存中…" : run.kind === "reversal" ? "儲存備註" : "儲存期別／備註"}
            </button>
            <PrimaryButton onClick={submit} disabled={busy !== null}>
              {busy === "submit" ? "送審中…" : "送老闆核准"}
            </PrimaryButton>
            <button
              type="button"
              className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 md:rounded-md"
              onClick={remove}
              disabled={busy !== null}
            >
              {busy === "delete" ? "刪除中…" : "刪除草稿"}
            </button>
          </div>
        </Card>
      ) : isPending || isApproved ? (
        <Card>
          <h2 className="mb-2 text-base font-semibold text-gray-800">{isPending ? "等待老闆核准" : "老闆已核准，可以發放"}</h2>
          <p className="text-sm text-gray-600">
            送審 {run.submittedAt ? new Date(run.submittedAt).toLocaleString("zh-TW") : "—"}
            {isApproved && run.approvedAt ? `　核准 ${new Date(run.approvedAt).toLocaleString("zh-TW")}` : ""}
            {isApproved && run.selfApproved ? "（送審人與核准人相同）" : ""}
            。入帳、成本或分潤設定變動時系統會自動重算；金額一變就退回草稿，需要重新送審。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canApprove && isPending && (
              <PrimaryButton onClick={approve} disabled={busy !== null}>
                {busy === "approve" ? "核准中…" : "核准"}
              </PrimaryButton>
            )}
            {isApproved && (
              <PrimaryButton onClick={() => setShowPay((v) => !v)} disabled={busy !== null}>
                標記已發放…
              </PrimaryButton>
            )}
            {canApprove && (
              <button
                type="button"
                className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 md:rounded-md"
                onClick={sendBack}
                disabled={busy !== null}
              >
                {busy === "return" ? "退回中…" : "退回草稿…"}
              </button>
            )}
            {run.kind !== "reversal" && (
              <button
                type="button"
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
                onClick={recompute}
                disabled={busy !== null}
              >
                {busy === "recompute" ? "重算中…" : "重算（金額變動會退回草稿）"}
              </button>
            )}
            {isPending && (
              <button
                type="button"
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
                onClick={withdraw}
                disabled={busy !== null}
              >
                {busy === "withdraw" ? "撤回中…" : "撤回送審…"}
              </button>
            )}
            {!canApprove && isPending && <span className="text-xs text-gray-500">只有老闆能核准或退回；送審中 HR 可撤回。</span>}
            {!canApprove && isApproved && <span className="text-xs text-gray-500">已核准後 HR 不能撤回，要改請老闆退回。</span>}
          </div>
          {showPay && (
            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl bg-gray-50 p-3">
              <div>
                <label className={labelCls}>發放日</label>
                <input type="date" className={inputCls} value={fPaidOn} onChange={(e) => setFPaidOn(e.target.value)} />
              </div>
              <PrimaryButton onClick={pay} disabled={busy !== null || !fPaidOn}>
                {busy === "pay" ? "發放中…" : "確認發放（凍結）"}
              </PrimaryButton>
              <span className="text-xs text-gray-500">發放後不可改、不可刪；下一季會自動扣掉這批已發金額。</span>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-gray-600">
              已發放批次是凍結快照：不能修改或刪除。
              {run.kind === "regular" && !run.reversedByRunId && "發錯了可以「沖銷」：另開一批金額取負的批次，發放後這批在累計口徑上歸零。"}
            </p>
            {run.kind === "regular" && !run.reversedByRunId && (
              <button
                type="button"
                className="ml-auto rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60 md:rounded-md"
                onClick={reverse}
                disabled={busy !== null}
              >
                {busy === "reverse" ? "建立中…" : "沖銷這一批…"}
              </button>
            )}
            {run.reversedByRunId && (
              <Link href={`/admin/bonus-runs/${run.reversedByRunId}`} className="ml-auto text-sm underline" style={{ color: "var(--brand)" }}>
                {run.reversedByStatus === "paid" ? "已被沖銷 → 看沖銷批次" : "沖銷草稿建立中 → 前往發放"}
              </Link>
            )}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-base font-semibold text-gray-800">明細（{detail.items.length} 列）</h2>
        <div className="mb-4">
          <GrossProfitTable items={detail.items} />
        </div>
        <ItemsTable items={detail.items} label={run.label} />
        <div className="mt-3 space-y-3">
          <SkippedList skipped={skipped} />
          <ExcludedArchivedList snapshot={detail.snapshot} />
        </div>
      </Card>
    </div>
  );
}
