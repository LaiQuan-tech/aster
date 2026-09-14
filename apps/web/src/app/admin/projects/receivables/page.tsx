"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty, ErrorText } from "@/components/admin-ui";
import { getReceivables, BILLING_KIND_LABELS, type ReceivablesResponse } from "@/lib/projects-ext-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

/**
 * 未收款追蹤（模組五）：每期一列的應收／未收清單，預設只看還沒收完的。
 * 排序（後端已排好）：專案未收比例 desc → 逾期天數 desc → 編號 → 期別——
 * 「先追誰」看比例，不是看金額大小。
 */
export default function ReceivablesPage() {
  const [status, setStatus] = useState<"open" | "all">("open");
  const [data, setData] = useState<ReceivablesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getReceivables(status));
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="未收款追蹤" desc="每期一列的應收／未收清單；排序看的是專案未收比例與逾期天數，不是金額大小" />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="radio" name="status" checked={status === "open"} onChange={() => setStatus("open")} />
            只看未收完
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="radio" name="status" checked={status === "all"} onChange={() => setStatus("all")} />
            全部期別
          </label>
          {data && (
            <span className="text-xs text-gray-400">
              資料時間 {data.today}
              {data.scope === "mine" && "（僅顯示您有財務權限的專案）"}
            </span>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {data && (
        <Card>
          <div className="grid grid-cols-3 gap-4">
            <div><p className="text-xs text-gray-500">筆數</p><p className="text-xl font-semibold text-gray-900">{data.summary.count}</p></div>
            <div><p className="text-xs text-gray-500">未收合計</p><p className="text-xl font-semibold text-red-600">{fmtMoney(data.summary.unreceivedTotal)}</p></div>
            <div><p className="text-xs text-gray-500">逾期筆數</p><p className="text-xl font-semibold text-amber-600">{data.summary.overdueCount}</p></div>
          </div>
        </Card>
      )}

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : !data || data.receivables.length === 0 ? (
          <Empty>{status === "open" ? "目前沒有未收完的期別" : "沒有資料"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">編號</th>
                  <th className="py-2 pr-2">專案</th>
                  <th className="py-2 pr-2">客戶</th>
                  <th className="py-2 pr-2">期別</th>
                  <th className="py-2 pr-2">階段</th>
                  <th className="py-2 pr-2 text-right">%</th>
                  <th className="py-2 pr-2 text-right">金額</th>
                  <th className="py-2 pr-2">請款日</th>
                  <th className="py-2 pr-2">開票日</th>
                  <th className="py-2 pr-2">發票號碼</th>
                  <th className="py-2 pr-2">入帳日</th>
                  <th className="py-2 pr-2 text-right">已收</th>
                  <th className="py-2 pr-2 text-right">未收</th>
                  <th className="py-2 pr-2 text-right">逾期天數</th>
                </tr>
              </thead>
              <tbody>
                {data.receivables.map((r) => (
                  <tr key={r.billingId} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-mono text-xs">
                      <Link href={`/admin/projects/${r.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                        {r.code ?? "—"}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2 font-medium text-gray-900">{r.projectName}</td>
                    <td className="py-1.5 pr-2 text-gray-600">{r.clientName ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-gray-600">
                      {r.installmentNo}
                      {r.kind === "guild_advance" && <span className="ml-1 rounded bg-purple-50 px-1 text-[10px] text-purple-700">{BILLING_KIND_LABELS.guild_advance}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-gray-600">{r.milestone ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{r.percentage ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(r.amount)}</td>
                    <td className="py-1.5 pr-2 text-gray-500">{r.billedOn ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-gray-500">{r.invoicedOn ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-gray-500">{r.invoiceNo ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-gray-500">{r.receivedOn ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{fmtMoney(r.receivedAmount)}</td>
                    <td className="py-1.5 pr-2 text-right font-medium text-red-600">{fmtMoney(r.unreceived)}</td>
                    <td className="py-1.5 pr-2 text-right">
                      {r.overdueDays != null && r.overdueDays > 0 ? (
                        <span className="font-medium text-red-600">{r.overdueDays}</span>
                      ) : (
                        <span className="text-gray-400">{r.overdueDays ?? "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
