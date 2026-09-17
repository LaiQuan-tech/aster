"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, InlineError } from "@/components/ess-ui";
import { getMyProjectShares, type MyProjectShare } from "@/lib/projects-api";
import { getMyBonusHistory, type MyBonusHistoryRow } from "@/lib/bonus-api";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("zh-TW");
}

export default function MyBonusPage() {
  const [shares, setShares] = useState<MyProjectShare[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ rows: MyBonusHistoryRow[]; total: number } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    getMyProjectShares()
      .then((r) => setShares(r.shares))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
    // D1 已發放紀錄：只列已發放（paid）批次裡自己的明細；草稿看不到。
    getMyBonusHistory()
      .then((h) => setHistory(h))
      .catch((err) => setHistoryError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const total = shares.reduce((s, x) => s + (x.computedAmount ?? 0), 0);

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-4 text-sm text-gray-500">各專案分給你的獎金（僅你自己與主管可見）。</p>
        {error && <InlineError className="mb-3">{error}</InlineError>}

        {shares.length === 0 ? (
          <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">目前沒有任何專案分潤</p>
        ) : (
          <>
            <div className="mb-4 rounded-xl bg-gray-50 p-4">
              <p className="text-xs text-gray-400">目前分潤合計</p>
              <p className="text-2xl font-bold text-gray-900">{money(total)} 元</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-gray-500">
                    <th className="py-2 pr-3">專案</th>
                    <th className="py-2 pr-3">分潤</th>
                    <th className="py-2 pr-3">實得金額</th>
                  </tr>
                </thead>
                <tbody>
                  {shares.map((s) => (
                    <tr key={s.memberId} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium text-gray-800">
                        <Link href={`/ess/projects/${s.projectId}`} style={{ color: "var(--brand)" }}>
                          {s.projectName ?? s.projectId}
                        </Link>
                        {s.roleInProject === "lead" && <span className="ml-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">負責人</span>}
                      </td>
                      <td className="py-2 pr-3 text-gray-700">
                        {s.shareMode === "pool_pct" ? (s.sharePct != null ? `${s.sharePct}%` : "—") : money(s.shareAmount)}
                      </td>
                      <td className="py-2 pr-3 font-medium text-gray-900">{money(s.computedAmount)}</td>
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
                    <th className="py-2 pr-3">入帳比例</th>
                    <th className="py-2 pr-3">本季發放</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((r) => (
                    <tr key={r.id ?? `${r.runId}:${r.projectId}`} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium text-gray-800">{r.label}</td>
                      <td className="py-2 pr-3 text-gray-600">{r.paidOn ?? "—"}</td>
                      <td className="py-2 pr-3 text-gray-700">
                        <Link href={`/ess/projects/${r.projectId}`} style={{ color: "var(--brand)" }}>
                          {r.projectCode ? `${r.projectCode} ` : ""}
                          {r.projectName ?? r.projectId}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-gray-600">{Math.round(r.receivedPct * 1000) / 10}%</td>
                      <td className="py-2 pr-3 font-medium text-gray-900">{money(r.amount)}</td>
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
