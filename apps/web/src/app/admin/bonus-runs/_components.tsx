"use client";

import Link from "next/link";
import { Empty } from "@/components/admin-ui";
import { BONUS_RUN_STATUS_LABELS, BONUS_SKIP_REASON_LABELS, fmtMoney, fmtPct, type BonusRun, type BonusRunPreview } from "@/lib/bonus-api";

/**
 * 獎金季發放列表頁與明細頁共用的小元件（放這裡而不是 page.tsx：app router 的
 * page 檔只能 export default 與路由設定，多 export 會被型別檢查擋下）。
 */


export function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-emerald-700" : tone === "down" ? "text-red-600" : "text-gray-900";
  return (
    <div className="rounded-xl bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: BonusRun["status"] }) {
  const cls = status === "paid" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{BONUS_RUN_STATUS_LABELS[status] ?? status}</span>;
}

export function ItemsTable({ items }: { items: BonusRunPreview["items"] }) {
  if (items.length === 0) return <Empty>沒有可發放的明細（沒有「未封存、有成員、有合約」的專案）</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-gray-500">
            <th className="py-1.5 pr-2">專案</th>
            <th className="py-1.5 pr-2">員工</th>
            <th className="py-1.5 pr-2">分潤</th>
            <th className="py-1.5 pr-2 text-right">合約總額</th>
            <th className="py-1.5 pr-2 text-right">已入帳</th>
            <th className="py-1.5 pr-2 text-right">入帳比例</th>
            <th className="py-1.5 pr-2 text-right">累計應發</th>
            <th className="py-1.5 pr-2 text-right">已發放</th>
            <th className="py-1.5 pr-2 text-right">本季應發</th>
            <th className="py-1.5 pr-2">備註</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={`${it.projectId}:${it.employeeId}`} className={`border-b last:border-0 ${it.overpaid ? "bg-red-50/40" : ""}`}>
              <td className="py-1.5 pr-2">
                <Link href={`/admin/projects/${it.projectId}`} style={{ color: "var(--brand)" }}>
                  {it.projectCode ? `${it.projectCode} ` : ""}
                  {it.projectName ?? it.projectId}
                </Link>
              </td>
              <td className="py-1.5 pr-2 text-gray-800">
                {it.employeeName ?? it.employeeId}
                {it.empNo && <span className="ml-1 text-xs text-gray-400">{it.empNo}</span>}
                {it.roleInProject === "lead" && <span className="ml-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">負責人</span>}
              </td>
              <td className="py-1.5 pr-2 text-gray-600">
                {it.shareMode === "pool_pct" ? `${it.sharePct ?? 0}% × 池 ${fmtMoney(it.bonusPool)}` : `固定 ${fmtMoney(it.shareAmount)}`}
              </td>
              <td className="py-1.5 pr-2 text-right text-gray-600">{fmtMoney(it.contractTotal)}</td>
              <td className="py-1.5 pr-2 text-right text-gray-600">{fmtMoney(it.receivedTotal)}</td>
              <td className="py-1.5 pr-2 text-right text-gray-600">{fmtPct(it.receivedPct)}</td>
              <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(it.entitledCumulative)}</td>
              <td className="py-1.5 pr-2 text-right text-gray-700">{fmtMoney(it.paidBefore)}</td>
              <td className={`py-1.5 pr-2 text-right font-medium ${it.overpaid ? "text-red-600" : "text-gray-900"}`}>{fmtMoney(it.amount)}</td>
              <td className="py-1.5 pr-2">
                {it.overpaid ? <span className="text-xs font-medium text-red-600">超發 {fmtMoney(it.overpaidBy)}（不自動追討）</span> : <span className="text-xs text-gray-400">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkippedList({ skipped }: { skipped: Array<{ projectId: string; reason: "no_contract" | "no_pool"; code?: string | null; name?: string | null }> }) {
  if (skipped.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50/50 p-3 text-sm">
      <p className="mb-1 font-medium text-amber-800">跳過 {skipped.length} 個專案（有成員但算不出來）</p>
      <ul className="space-y-0.5 text-amber-900">
        {skipped.map((s) => (
          <li key={s.projectId}>
            <Link href={`/admin/projects/${s.projectId}`} className="underline">
              {s.code ? `${s.code} ` : ""}
              {s.name ?? s.projectId}
            </Link>
            <span className="ml-2 text-xs text-amber-700">{BONUS_SKIP_REASON_LABELS[s.reason] ?? s.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
