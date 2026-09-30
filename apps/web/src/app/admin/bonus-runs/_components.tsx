"use client";

import Link from "next/link";
import { Empty } from "@/components/admin-ui";
import { BONUS_RUN_STATUS_LABELS, BONUS_SKIP_REASON_LABELS, fmtMoney, fmtPct, type BonusRun, type BonusRunPreview } from "@/lib/bonus-api";
import { memberRoleLabel } from "@/lib/projects-api";

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
      <table className="min-w-max border-collapse whitespace-nowrap text-xs">
        <thead>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            <th className="border border-black px-2 py-2" rowSpan={2}>專案單號</th><th className="border border-black px-2 py-2" rowSpan={2}>專案名稱</th><th className="border border-black px-2 py-2" rowSpan={2}>合約額</th>
            <th className="border border-black px-2 py-1" colSpan={2}>之前請領</th><th className="border border-black px-2 py-1" colSpan={2}>本次請款</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>累積比例</th><th className="border border-black px-2 py-2" rowSpan={2}>獎金比例</th><th className="border border-black px-2 py-2" rowSpan={2}>總獎金</th><th className="border border-black px-2 py-2" rowSpan={2}>本次獎金</th>
            <th className="border border-black px-2 py-1" colSpan={3}>成員分配</th><th className="border border-black px-2 py-2" rowSpan={2}>尚未分配</th><th className="border border-black px-2 py-2" rowSpan={2}>備註</th>
          </tr>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            <th className="border border-black px-2 py-1">金額</th><th className="border border-black px-2 py-1">比例</th><th className="border border-black px-2 py-1">金額</th><th className="border border-black px-2 py-1">比例</th>
            <th className="border border-black px-2 py-1">成員／角色</th><th className="border border-black px-2 py-1">比例</th><th className="border border-black px-2 py-1">金額</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const previousReceived = it.previousReceived ?? 0;
            const currentReceived = it.currentReceived ?? Math.max(0, it.receivedTotal - previousReceived);
            const unallocatedPct = it.unallocatedPct ?? 0;
            const unallocatedAmount = it.bonusPool == null ? null : Math.round(it.bonusPool * unallocatedPct / 100);
            return (
            <tr key={`${it.projectId}:${it.employeeId}`} className={it.overpaid ? "bg-red-50/60" : "bg-white"}>
              <td className="border border-black px-2 py-1.5">
                <Link href={`/admin/projects/${it.projectId}`} style={{ color: "var(--brand)" }}>
                  {it.projectCode ?? "—"}
                </Link>
              </td>
              <td className="border border-black px-2 py-1.5 text-gray-800">{it.projectName ?? it.projectId}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtMoney(it.contractTotal)}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtMoney(previousReceived)}</td><td className="border border-black px-2 py-1.5 text-right">{fmtPct(it.previousReceivedPct ?? (it.contractTotal ? previousReceived / it.contractTotal : 0))}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtMoney(currentReceived)}</td><td className="border border-black px-2 py-1.5 text-right">{fmtPct(it.currentReceivedPct ?? (it.contractTotal ? currentReceived / it.contractTotal : 0))}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtPct(it.receivedPct)}</td><td className="border border-black px-2 py-1.5 text-right">{it.bonusRatePct == null ? "—" : `${it.bonusRatePct}%`}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtMoney(it.bonusPool)}</td><td className={`border border-black px-2 py-1.5 text-right font-semibold ${it.overpaid ? "text-red-600" : ""}`}>{fmtMoney(it.amount)}</td>
              <td className="border border-black px-2 py-1.5 text-gray-800">{it.employeeName ?? it.employeeId}<span className="ml-1 text-gray-400">{it.roleInProject ? memberRoleLabel(it.roleInProject) : ""}</span></td>
              <td className="border border-black px-2 py-1.5 text-right">{it.shareMode === "pool_pct" ? `${it.sharePct ?? 0}%` : "固定"}</td><td className="border border-black px-2 py-1.5 text-right">{fmtMoney(it.amount)}</td>
              <td className="border border-black px-2 py-1.5 text-right"><div>{unallocatedPct}%</div><div className="text-gray-500">{fmtMoney(unallocatedAmount)}</div></td>
              <td className="border border-black px-2 py-1.5">
                {it.overpaid ? <span className="font-medium text-red-600">超發 {fmtMoney(it.overpaidBy)}</span> : (it.projectNote ?? "—")}
              </td>
            </tr>
          )})}
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
