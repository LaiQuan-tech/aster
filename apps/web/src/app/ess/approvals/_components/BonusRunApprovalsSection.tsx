"use client";

import { useCallback, useEffect, useState } from "react";
import { BottomSheet, Button, Card, ConfirmDialog, Field, InlineError, Pill, SectionTitle, Textarea, useToast } from "@/components/ess-ui";
import { invalidateEssState } from "@/lib/ess-state";
import {
  approveBonusRun,
  BONUS_BASIS_LABELS,
  fmtMoney,
  getMyBonusApprovals,
  humanizeBonusError,
  returnBonusRun,
  type BonusRunDetail,
  type BonusRunItem,
} from "@/lib/bonus-api";

/**
 * 簽核頁的「獎金批次」段（2026-10-26 專案分潤改版 #7）：
 *   老闆（features.approval.fallbackApproverEmpId）在這裡核准／退回 HR 送審的獎金批次，不必進後台
 *   （老闆不一定是 HR，進不了 /admin）。platform_admin 也能核准（2026-10-27）。其他人 API 回空清單，整段不顯示。
 *   每張卡列：本批合計、人數案數、每案的入帳／成本／毛利／比例／本次獎金、每人本次金額、超過合約警示。
 */

type ProjectLine = {
  projectId: string;
  title: string;
  basis: string;
  isProfit: boolean;
  revenue: number;
  taxInclusiveRevenue: number | null;
  cost: number | null;
  grossProfit: number | null;
  bonusRatePct: number | null;
  amount: number;
};

function projectLines(items: BonusRunItem[]): ProjectLine[] {
  const map = new Map<string, ProjectLine>();
  for (const it of items) {
    const line = map.get(it.projectId) ?? {
      projectId: it.projectId,
      title: `${it.projectCode ? `${it.projectCode} ` : ""}${it.projectName ?? ""}`.trim() || it.projectId,
      basis: it.basis ? BONUS_BASIS_LABELS[it.basis] : "—",
      isProfit: it.basis === "gross_profit",
      revenue: it.revenue ?? it.receivedTotal,
      taxInclusiveRevenue: it.basis === "tax_inclusive_receipts" ? (it.taxInclusiveRevenue ?? null) : null,
      cost: it.cost ?? null,
      grossProfit: it.grossProfit ?? null,
      bonusRatePct: it.bonusRatePct ?? null,
      amount: 0,
    };
    line.amount += it.amount;
    map.set(it.projectId, line);
  }
  return [...map.values()];
}

function employeeLines(items: BonusRunItem[]): Array<{ employeeId: string; name: string; amount: number }> {
  const map = new Map<string, { employeeId: string; name: string; amount: number }>();
  for (const it of items) {
    const row = map.get(it.employeeId) ?? { employeeId: it.employeeId, name: it.employeeName ?? it.employeeId, amount: 0 };
    row.amount += it.amount;
    map.set(it.employeeId, row);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

export function BonusRunApprovalsSection() {
  const toast = useToast();
  const [runs, setRuns] = useState<BonusRunDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approving, setApproving] = useState<BonusRunDetail | null>(null);
  const [returning, setReturning] = useState<BonusRunDetail | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const res = await getMyBonusApprovals();
    setRuns(res.canApprove ? res.runs : []);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await load();
        if (active) setError(null);
      } catch (err) {
        // 舊 API 沒有這支（404）→ 當作沒有待核准的批次，不打擾。
        if (active && !(err instanceof Error && /not_found|404/.test(err.message))) setError(humanizeBonusError(err, "載入獎金批次失敗"));
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function doApprove() {
    const target = approving;
    if (!target) return;
    setBusyId(target.run.id);
    try {
      await approveBonusRun(target.run.id);
      toast.show(`已核准獎金批次 ${target.run.label}`, "success");
      setApproving(null);
      await load();
      invalidateEssState();
    } catch (err) {
      setError(humanizeBonusError(err, "核准失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function doReturn() {
    const target = returning;
    if (!target) return;
    if (!reason.trim()) {
      setError("退回原因必填");
      return;
    }
    setBusyId(target.run.id);
    try {
      await returnBonusRun(target.run.id, reason.trim());
      toast.show(`已退回獎金批次 ${target.run.label}`, "success");
      setReturning(null);
      setReason("");
      await load();
      invalidateEssState();
    } catch (err) {
      setError(humanizeBonusError(err, "退回失敗"));
    } finally {
      setBusyId(null);
    }
  }

  if (runs.length === 0 && !error) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <SectionTitle>獎金批次待核准</SectionTitle>
        {runs.length > 0 && <span className="text-xs text-gray-400">{runs.length} 批</span>}
      </div>
      {error && (
        <Card>
          <InlineError>{error}</InlineError>
        </Card>
      )}
      {runs.map((d) => {
        const { run, items } = d;
        const warnings = d.snapshot?.warnings ?? run.totals.warnings ?? [];
        return (
          <Card key={run.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900">
                  {run.label}
                  {run.kind === "reversal" && <Pill tone="red" className="ml-2">沖銷</Pill>}
                </p>
                <p className="mt-0.5 text-sm text-gray-600">
                  合計 {fmtMoney(run.totals.amount)} 元・{run.totals.employeeCount} 人・{run.totals.projectCount} 案・基準日 {run.asOf}
                </p>
              </div>
              <Pill tone="amber">送審中</Pill>
            </div>

            {warnings.length > 0 && (
              <ul className="mt-2 space-y-0.5 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                {warnings.map((w) => (
                  <li key={`${w.projectId}-${w.kind}`}>
                    {w.code ?? w.name ?? "專案"}：{w.message}
                  </li>
                ))}
              </ul>
            )}
            {run.totals.overpaidCount > 0 && (
              <p className="mt-2 text-sm text-red-600">有 {run.totals.overpaidCount} 列超發（累計應得少於已發，本次 0，不自動追討）</p>
            )}

            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-gray-700">每案怎麼算的</summary>
              <ul className="mt-2 space-y-2 text-sm">
                {projectLines(items).map((p) => (
                  <li key={p.projectId} className="rounded-lg bg-gray-50 p-2">
                    <p className="font-medium text-gray-800">{p.title}</p>
                    <p className="text-gray-600">
                      {p.basis}・入帳 {fmtMoney(p.revenue)}
                      {p.taxInclusiveRevenue != null && `（含稅 ${fmtMoney(p.taxInclusiveRevenue)}）`}
                      {p.isProfit && p.cost != null && `・成本 ${fmtMoney(p.cost)}`}
                      {p.isProfit && p.grossProfit != null && `・毛利 ${fmtMoney(p.grossProfit)}`}
                      {p.bonusRatePct != null && `・比例 ${p.bonusRatePct}%`}
                    </p>
                    <p className="text-gray-800">本次獎金 {fmtMoney(p.amount)} 元</p>
                  </li>
                ))}
              </ul>
            </details>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium text-gray-700">每人本次金額</summary>
              <ul className="mt-2 divide-y text-sm">
                {employeeLines(items).map((e) => (
                  <li key={e.employeeId} className="flex justify-between py-1">
                    <span className="text-gray-700">{e.name}</span>
                    <span className="font-medium text-gray-900">{fmtMoney(e.amount)}</span>
                  </li>
                ))}
              </ul>
            </details>

            <div className="mt-3 flex gap-2">
              <Button block onClick={() => setApproving(d)} disabled={busyId !== null}>
                核准
              </Button>
              <Button
                block
                variant="secondary"
                onClick={() => {
                  setReason("");
                  setReturning(d);
                }}
                disabled={busyId !== null}
              >
                退回
              </Button>
            </div>
          </Card>
        );
      })}

      <ConfirmDialog
        open={approving !== null}
        title={`核准獎金批次 ${approving?.run.label ?? ""}？`}
        message={approving ? `本批合計 ${fmtMoney(approving.run.totals.amount)} 元。核准後 HR 才能發放；之後入帳或成本變動使金額改變，會自動退回重新送審。` : undefined}
        confirmLabel="核准"
        busy={busyId !== null}
        onConfirm={() => void doApprove()}
        onCancel={() => setApproving(null)}
      />
      <BottomSheet open={returning !== null} onClose={() => setReturning(null)} title={`退回 ${returning?.run.label ?? ""}`}>
        <div className="space-y-3">
          <Field label="退回原因" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="例如：某案比例要再確認" />
          </Field>
          <Button block onClick={() => void doReturn()} disabled={busyId !== null || !reason.trim()}>
            確定退回
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
