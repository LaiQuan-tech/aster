"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import AuditDrawer from "@/components/AuditDrawer";
import {
  deleteBonusRun,
  exportBonusRunXlsx,
  fmtMoney,
  getBonusRun,
  humanizeBonusError,
  patchBonusRun,
  payBonusRun,
  todayKey,
  type BonusRunDetail,
} from "@/lib/bonus-api";
import { ItemsTable, SkippedList, Stat, StatusBadge } from "../_components";

/**
 * 批次明細：items 表（專案／員工／入帳比例／累計應發／已發／本季應發／超發紅字）。
 * draft：可改期別／基準日並重算、改備註、標記已發放（填發放日）、刪除（填理由）。
 * paid：唯讀＋匯出 Excel（草稿也能匯出，方便先拿去對）。
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

  const run = detail?.run ?? null;
  const isDraft = run?.status === "draft";

  async function recompute() {
    await act("recompute", async () => {
      const d = await patchBonusRun(id, { asOf: fAsOf, label: fLabel.trim(), recompute: true });
      setDetail(d);
    });
  }
  async function saveNote() {
    await act("note", async () => {
      const d = await patchBonusRun(id, { note: fNote.trim() || null, label: fLabel.trim() });
      setDetail(d);
    });
  }
  async function pay() {
    if (!run) return;
    if (!confirm(`確定將 ${run.label} 標記為已發放？發放後即凍結，不能再修改或刪除（金額 ${fmtMoney(run.totals.amount)} 元）。`)) return;
    await act("pay", async () => {
      const d = await payBonusRun(id, { paidOn: fPaidOn });
      setDetail(d);
      setShowPay(false);
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
        <PageHeader title="獎金季發放" />
        <Card>
          <Empty>載入中…</Empty>
        </Card>
      </div>
    );
  }
  if (!run || !detail) {
    return (
      <div className="space-y-4">
        <PageHeader title="獎金季發放" />
        <Card>
          <ErrorText>{error ?? "找不到這筆批次"}</ErrorText>
          <p className="mt-2 text-sm">
            <Link href="/admin/bonus-runs" style={{ color: "var(--brand)" }}>
              ← 回批次列表
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  const skipped = run.totals.skipped.map((s) => ({ ...s, ...(detail.snapshot?.skipped ?? []).find((x) => x.projectId === s.projectId) }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm">
            <Link href="/admin/bonus-runs" style={{ color: "var(--brand)" }}>
              ← 回批次列表
            </Link>
          </p>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900 md:text-xl">獎金季發放 {run.label}</h1>
            <StatusBadge status={run.status} />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            基準日 {run.asOf}（入帳截至此日）　發放日 {run.paidOn ?? "—"}
            {run.note ? `　備註：${run.note}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
        </div>
      </div>
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

      {isDraft ? (
        <Card>
          <h2 className="mb-3 text-base font-semibold text-gray-800">草稿設定</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className={labelCls}>期別</label>
              <input className={inputCls} value={fLabel} onChange={(e) => setFLabel(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>試算基準日</label>
              <input type="date" className={inputCls} value={fAsOf} onChange={(e) => setFAsOf(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>備註</label>
              <input className={inputCls} value={fNote} onChange={(e) => setFNote(e.target.value)} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
              onClick={recompute}
              disabled={busy !== null || !fAsOf}
            >
              {busy === "recompute" ? "重算中…" : "重算明細（用最新入帳／成員）"}
            </button>
            <button
              type="button"
              className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
              onClick={saveNote}
              disabled={busy !== null}
            >
              {busy === "note" ? "儲存中…" : "儲存期別／備註"}
            </button>
            <PrimaryButton onClick={() => setShowPay((v) => !v)} disabled={busy !== null}>
              標記已發放…
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
          <p className="text-sm text-gray-600">
            已發放批次是凍結快照：不能修改或刪除。發錯了請在下一季重算——累計口徑會自動補發少發的、標出多發的（不自動追討）。
          </p>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-base font-semibold text-gray-800">明細（{detail.items.length} 列）</h2>
        <ItemsTable items={detail.items} />
        <div className="mt-3">
          <SkippedList skipped={skipped} />
        </div>
      </Card>
    </div>
  );
}
