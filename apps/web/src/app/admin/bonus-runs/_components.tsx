"use client";

import { Fragment } from "react";
import Link from "next/link";
import { Empty } from "@/components/admin-ui";
import { BONUS_RUN_STATUS_LABELS, BONUS_SKIP_REASON_LABELS, fmtMoney, fmtPct, type BonusRun, type BonusRunPreview } from "@/lib/bonus-api";
import { buildBonusRegisterRows } from "@/lib/bonus-register";

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

export function ItemsTable({ items, label = "" }: { items: BonusRunPreview["items"]; label?: string }) {
  if (items.length === 0) return <Empty>沒有可發放的明細（沒有「未封存、有成員、有合約」的專案）</Empty>;
  const rows = buildBonusRegisterRows(items);
  const slotHeaders = ["經理", "組員1", "組員2", "組員3", "組員4", "支援"];
  return (
    <div className="overflow-x-auto">
      <table className="min-w-max border-collapse whitespace-nowrap text-xs">
        <thead>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            <th className="border border-black px-2 py-2" rowSpan={2}>序號</th><th className="border border-black px-2 py-2" rowSpan={2}>{label || "期別"}</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>專案單號</th><th className="border border-black px-2 py-2" rowSpan={2}>工程名稱</th><th className="border border-black px-2 py-2" rowSpan={2}>含稅</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>之前請領</th><th className="border border-black px-2 py-2" rowSpan={2}>之前請領%</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>本次請款</th><th className="border border-black px-2 py-2" rowSpan={2}>本次款%</th><th className="border border-black px-2 py-2" rowSpan={2}>累積 %</th>
            <th className="border border-black px-2 py-1" colSpan={3}>獎金比例</th>
            {slotHeaders.flatMap((header) => [<th key={`${header}-name`} className="border border-black px-2 py-2" rowSpan={2}>{header}</th>, <th key={`${header}-pct`} className="border border-black px-2 py-2" rowSpan={2} aria-label={`${header}比例`} />])}
            <th className="border border-black px-2 py-2" rowSpan={2}>尚未分配</th><th className="border border-black px-2 py-2" rowSpan={2}>備註</th>
          </tr>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            <th className="border border-black px-2 py-1">%</th><th className="border border-black px-2 py-1">總獎金</th><th className="border border-black px-2 py-1">本次獎金</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((register, index) => {
            const it = register.project;
            const previousReceived = it.previousReceived ?? 0;
            const currentReceived = it.currentReceived ?? Math.max(0, it.receivedTotal - previousReceived);
            const unallocatedPct = it.unallocatedPct ?? 0;
            const members = [register.manager, ...register.team, register.support];
            const overpaid = register.items.reduce((sum, item) => sum + (item.overpaid ? item.overpaidBy : 0), 0);
            return (
            <tr key={it.projectId} className={overpaid > 0 ? "bg-red-50/60" : "bg-white"}>
              <td className="border border-black px-2 py-1.5 text-center">{index + 1}</td><td className="border border-black px-2 py-1.5 text-center">{label || "—"}</td>
              <td className="border border-black px-2 py-1.5">
                <Link href={`/admin/projects/${it.projectId}`} style={{ color: "var(--brand)" }}>
                  {it.projectCode ?? "—"}
                </Link>
              </td>
              <td className="border border-black px-2 py-1.5 text-gray-800">{it.projectName ?? it.projectId}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtMoney(it.contractTotal)}</td><td className="border border-black px-2 py-1.5 text-right">{fmtMoney(previousReceived)}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtPct(it.previousReceivedPct ?? (it.contractTotal ? previousReceived / it.contractTotal : 0))}</td><td className="border border-black px-2 py-1.5 text-right">{fmtMoney(currentReceived)}</td>
              <td className="border border-black px-2 py-1.5 text-right">{fmtPct(it.currentReceivedPct ?? (it.contractTotal ? currentReceived / it.contractTotal : 0))}</td><td className="border border-black px-2 py-1.5 text-right">{fmtPct(it.receivedPct)}</td>
              <td className="border border-black px-2 py-1.5 text-right">{it.bonusRatePct == null ? "—" : `${it.bonusRatePct}%`}</td><td className="border border-black px-2 py-1.5 text-right">{fmtMoney(it.bonusPool)}</td>
              <td className={`border border-black px-2 py-1.5 text-right font-semibold ${overpaid > 0 ? "text-red-600" : ""}`}>{fmtMoney(register.currentBonus)}</td>
              {members.map((member, memberIndex) => <Fragment key={member?.employeeId ?? `empty-${memberIndex}`}><td className="border border-black px-2 py-1.5">{member?.employeeName ?? ""}</td><td className="border border-black px-2 py-1.5 text-right">{member ? (member.shareMode === "pool_pct" ? `${member.sharePct ?? 0}%` : fmtMoney(member.shareAmount)) : ""}</td></Fragment>)}
              <td className={`border border-black px-2 py-1.5 text-right ${unallocatedPct > 0 ? "font-semibold text-red-600" : ""}`}>{unallocatedPct}%</td>
              <td className="border border-black px-2 py-1.5">
                {overpaid > 0 ? <span className="font-medium text-red-600">超發 {fmtMoney(overpaid)}</span> : (it.projectNote ?? "—")}
              </td>
            </tr>
          )})}
        </tbody>
        <tfoot><tr className="bg-blue-50 font-semibold"><td className="border border-black px-2 py-2 text-right" colSpan={12}>合計（{rows.length} 案）</td><td className="border border-black px-2 py-2 text-right">{fmtMoney(rows.reduce((sum, row) => sum + row.currentBonus, 0))}</td><td className="border border-black" colSpan={14} /></tr></tfoot>
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
