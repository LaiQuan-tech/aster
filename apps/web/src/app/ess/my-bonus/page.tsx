"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, InlineError } from "@/components/ess-ui";
import { getMyProjectShares, memberRoleLabel, type MyProjectShare } from "@/lib/projects-api";
import { getMyBonusHistory, type MyBonusHistoryRow } from "@/lib/bonus-api";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("zh-TW");
}

export default function MyBonusPage() {
  const [shares, setShares] = useState<MyProjectShare[]>([]);
  // 專案毛利只有老闆／platform_admin／授權 HR 看得到（業主 2026-10-26）；其他人不顯示這一欄。
  const [canSeeProfit, setCanSeeProfit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ rows: MyBonusHistoryRow[]; total: number } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    getMyProjectShares()
      .then((r) => {
        setShares(r.shares);
        setCanSeeProfit(r.canSeeProfit === true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
    // D1 已發放紀錄：只列已發放（paid）批次裡自己的明細；草稿看不到。
    getMyBonusHistory()
      .then((h) => setHistory(h))
      .catch((err) => setHistoryError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  // 分潤改版 #1：預估應得（累計）＝估算服務；已發＝歷來已發放；待發＝兩者相減（下限 0）。
  // 毛利欄只在毛利制有意義：Excel 含稅入帳制（預設）整欄不顯示。
  const showProfitCol = canSeeProfit && shares.some((x) => x.basis === "gross_profit");
  const total = shares.reduce((s, x) => s + (x.estimatedAmount ?? x.computedAmount ?? 0), 0);
  const paidTotal = shares.reduce((s, x) => s + (x.paidAmount ?? 0), 0);
  const pendingTotal = shares.reduce((s, x) => s + (x.pendingAmount ?? 0), 0);

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-4 text-sm text-gray-500">各專案分給你的獎金（僅你自己與主管可見）。</p>
        {error && <InlineError className="mb-3">{error}</InlineError>}

        {shares.length === 0 ? (
          <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">目前沒有任何專案分潤</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-xs text-gray-400">預估應得合計</p>
                <p className="text-xl font-bold text-gray-900">{money(total)}</p>
              </div>
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-xs text-gray-400">已發</p>
                <p className="text-xl font-bold text-gray-900">{money(paidTotal)}</p>
              </div>
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-xs text-gray-400">待發</p>
                <p className="text-xl font-bold text-gray-900">{money(pendingTotal)}</p>
              </div>
            </div>
            <p className="mb-3 text-xs text-gray-400">
              {shares.some((s) => s.basis === "gross_profit")
                ? "預估應得＝依專案目前毛利 × 獎金比例 × 你的趴數，累計算到今天的金額，會隨入帳與成本變動；實際以每季發放為準。"
                : "預估應得＝專案累計含稅入帳 × 獎金比例 × 你的趴數，累計算到今天的金額，會隨入帳變動；實際以每季發放為準。"}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-gray-500">
                    <th className="py-2 pr-3">專案</th>
                    <th className="py-2 pr-3">角色</th>
                    <th className="py-2 pr-3">趴數</th>
                    {showProfitCol && <th className="py-2 pr-3 text-right">目前毛利</th>}
                    <th className="py-2 pr-3 text-right">預估應得</th>
                    <th className="py-2 pr-3 text-right">已發</th>
                    <th className="py-2 pr-3 text-right">待發</th>
                  </tr>
                </thead>
                <tbody>
                  {shares.map((s) => (
                    <tr key={s.memberId} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium text-gray-800">
                        <Link href={`/ess/projects/${s.projectId}`} style={{ color: "var(--brand)" }}>
                          {s.projectName ?? s.projectId}
                        </Link>
                        {s.legacy && <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600" title="手填獎金池、未設獎金比例的舊制專案">舊制</span>}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">{memberRoleLabel(s.roleInProject)}</td>
                      <td className="py-2 pr-3 text-gray-700">
                        {s.shareMode === "pool_pct" ? (s.sharePct != null ? `${s.sharePct}%` : "—") : money(s.shareAmount)}
                      </td>
                      {showProfitCol && <td className="py-2 pr-3 text-right text-gray-700">{s.basis === "gross_profit" ? money(s.grossProfit ?? null) : "—"}</td>}
                      <td className="py-2 pr-3 text-right font-medium text-gray-900">{money(s.estimatedAmount ?? s.computedAmount)}</td>
                      <td className="py-2 pr-3 text-right text-gray-700">{money(s.paidAmount ?? null)}</td>
                      <td className="py-2 pr-3 text-right text-gray-700">{money(s.pendingAmount ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title="已發放紀錄">
        <p className="mb-4 text-sm text-gray-500">每季依專案入帳進度拆算、已實際發放給你的獎金（各季獨立快照，不會回頭改）。</p>
        {historyError && <InlineError className="mb-3">{historyError}</InlineError>}
        {!history ? (
          <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">載入中…</p>
        ) : history.rows.length === 0 ? (
          <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">還沒有已發放的季獎金</p>
        ) : (
          <>
            <div className="mb-4 rounded-xl bg-gray-50 p-4">
              <p className="text-xs text-gray-400">歷年已發放合計</p>
              <p className="text-2xl font-bold text-gray-900">{money(history.total)} 元</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-gray-500">
                    <th className="py-2 pr-3">期別</th>
                    <th className="py-2 pr-3">發放日</th>
                    <th className="py-2 pr-3">專案</th>
                    <th className="py-2 pr-3">我的趴數</th>
                    <th className="py-2 pr-3">本季發放</th>
                    <th className="py-2 pr-3">累計已發</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium text-gray-800">{r.label}</td>
                      <td className="py-2 pr-3 text-gray-600">{r.paidOn ?? "—"}</td>
                      <td className="py-2 pr-3 text-gray-700">
                        <Link href={`/ess/projects/${r.projectId}`} style={{ color: "var(--brand)" }}>
                          {r.projectCode ? `${r.projectCode} ` : ""}
                          {r.projectName ?? r.projectId}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-gray-600">
                        {r.shareMode === "fixed_amount" ? `固定 ${money(r.shareAmount)}` : r.sharePct == null ? "—" : `${r.sharePct}%`}
                        {r.basis === "legacy_pool" && <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">舊制</span>}
                        {r.kind === "reversal" && <span className="ml-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">沖銷</span>}
                      </td>
                      <td className="py-2 pr-3 font-medium text-gray-900">{money(r.amount)}</td>
                      <td className="py-2 pr-3 text-gray-600">{money(r.paidCumulative)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
