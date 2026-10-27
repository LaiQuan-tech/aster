"use client";

import { Fragment } from "react";
import Link from "next/link";
import { Empty } from "@/components/admin-ui";
import {
  BONUS_ARCHIVE_EXCLUDE_LABELS,
  BONUS_BASIS_LABELS,
  BONUS_RUN_STATUS_LABELS,
  BONUS_SKIP_REASON_LABELS,
  fmtMoney,
  fmtPct,
  type BonusRun,
  type BonusRunPreview,
  type BonusRunSnapshot,
  type BonusWarning,
} from "@/lib/bonus-api";
import { buildBonusRegisterRows } from "@/lib/bonus-register";

/**
 * 獎金批次（「獎金分潤」頁的發放批次區塊 bonus-sheet/_runs.tsx）與批次明細頁共用的小元件（放這裡而不是 page.tsx：app router 的
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
  const cls =
    status === "paid"
      ? "bg-emerald-50 text-emerald-700"
      : status === "approved"
        ? "bg-sky-50 text-sky-700"
        : status === "pending_approval"
          ? "bg-violet-50 text-violet-700"
          : "bg-amber-50 text-amber-700";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{BONUS_RUN_STATUS_LABELS[status] ?? status}</span>;
}

/**
 * `canSeeProfit=false`（未授權看集團財務的 HR，2026-10-26）：「獎金比例」只留「本次獎金」，% 與總獎金（＝累計獎金池，
 * 可反推毛利）兩欄不畫。發放要用的金額、入帳、趴數照常。
 */
export function ItemsTable({ items, label = "", canSeeProfit = true }: { items: BonusRunPreview["items"]; label?: string; canSeeProfit?: boolean }) {
  if (items.length === 0) return <Empty>沒有可發放的明細（沒有「有成員、可計算」的專案）</Empty>;
  const rows = buildBonusRegisterRows(items);
  const slotHeaders = ["經理", "組員1", "組員2", "組員3", "組員4", "支援"];
  return (
    <div className="overflow-x-auto">
      <table className="min-w-max border-collapse whitespace-nowrap text-xs">
        <thead>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            <th className="border border-black px-2 py-2" rowSpan={2}>序號</th><th className="border border-black px-2 py-2" rowSpan={2}>{label || "期別"}</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>專案單號</th><th className="border border-black px-2 py-2" rowSpan={2}>工程名稱</th><th className="border border-black px-2 py-2" rowSpan={2}>未稅金額</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>之前請領</th><th className="border border-black px-2 py-2" rowSpan={2}>之前請領%</th>
            <th className="border border-black px-2 py-2" rowSpan={2}>本次請款</th><th className="border border-black px-2 py-2" rowSpan={2}>本次款%</th><th className="border border-black px-2 py-2" rowSpan={2}>累積 %</th>
            <th className="border border-black px-2 py-1" colSpan={canSeeProfit ? 3 : 1}>獎金比例</th>
            {slotHeaders.flatMap((header) => [<th key={`${header}-name`} className="border border-black px-2 py-2" rowSpan={2}>{header}</th>, <th key={`${header}-pct`} className="border border-black px-2 py-2" rowSpan={2} aria-label={`${header}比例`} />])}
            <th className="border border-black px-2 py-2" rowSpan={2}>尚未分配</th><th className="border border-black px-2 py-2" rowSpan={2}>備註</th>
          </tr>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            {canSeeProfit && <><th className="border border-black px-2 py-1">%</th><th className="border border-black px-2 py-1">總獎金</th></>}<th className="border border-black px-2 py-1">本次獎金</th>
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
              {canSeeProfit && <><td className="border border-black px-2 py-1.5 text-right">{it.bonusRatePct == null ? "—" : `${it.bonusRatePct}%`}</td><td className="border border-black px-2 py-1.5 text-right">{fmtMoney(it.bonusPool)}</td></>}
              <td className={`border border-black px-2 py-1.5 text-right font-semibold ${overpaid > 0 ? "text-red-600" : ""}`}>{fmtMoney(register.currentBonus)}</td>
              {members.map((member, memberIndex) => <Fragment key={member?.employeeId ?? `empty-${memberIndex}`}><td className="border border-black px-2 py-1.5">{member?.employeeName ?? ""}</td><td className="border border-black px-2 py-1.5 text-right">{member ? (member.shareMode === "pool_pct" ? `${member.sharePct ?? 0}%` : fmtMoney(member.shareAmount)) : ""}</td></Fragment>)}
              <td className={`border border-black px-2 py-1.5 text-right ${unallocatedPct > 0 ? "font-semibold text-red-600" : ""}`}>{unallocatedPct}%</td>
              <td className="border border-black px-2 py-1.5">
                {overpaid > 0 ? <span className="font-medium text-red-600">超發 {fmtMoney(overpaid)}</span> : (it.projectNote ?? "—")}
                {register.overflowMembers.length > 0 && <div className="mt-1 text-amber-700">其他分配：{register.overflowMembers.map((member) => `${member.employeeName ?? member.employeeId} ${member.shareMode === "pool_pct" ? `${member.sharePct ?? 0}%` : fmtMoney(member.shareAmount)}`).join("、")}</div>}
              </td>
            </tr>
          )})}
        </tbody>
        <tfoot><tr className="bg-blue-50 font-semibold"><td className="border border-black px-2 py-2 text-right" colSpan={canSeeProfit ? 12 : 10}>合計（{rows.length} 案）</td><td className="border border-black px-2 py-2 text-right">{fmtMoney(rows.reduce((sum, row) => sum + row.currentBonus, 0))}</td><td className="border border-black" colSpan={14} /></tr></tfoot>
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

/**
 * 獎金怎麼算出來的：每案一列——用哪一制、入帳（未稅／含稅）、比例、獎金池；毛利制另列成本（放款＋複委託）與毛利。
 * 2026-10-27 起預設 Excel 含稅入帳制（不扣成本）：這時不顯示成本／毛利欄。舊批次（沒有 basis）整張不顯示。
 * 看不到集團財務的人（回應 canSeeProfit=false）呼叫端不畫這張表。
 */
export function GrossProfitTable({ items }: { items: BonusRunPreview["items"] }) {
  const byProject = new Map<string, BonusRunPreview["items"][number]>();
  for (const it of items) if (!byProject.has(it.projectId)) byProject.set(it.projectId, it);
  const rows = [...byProject.values()].filter((it) => it.basis != null);
  if (rows.length === 0) return null;
  const showProfit = rows.some((it) => it.basis === "gross_profit");
  const showTaxIncl = rows.some((it) => it.basis === "tax_inclusive_receipts");
  const th = "border border-gray-300 px-2 py-1.5";
  const td = "border border-gray-300 px-2 py-1";
  return (
    <div className="overflow-x-auto">
      <table className="min-w-max border-collapse whitespace-nowrap text-xs">
        <thead>
          <tr className="bg-gray-100 text-center font-semibold text-gray-700">
            <th className={th}>專案</th>
            <th className={th}>計算方式</th>
            <th className={th}>累計入帳（未稅）</th>
            {showTaxIncl && <th className={th}>累計入帳（含稅）</th>}
            {showProfit && <th className={th}>放款成本</th>}
            {showProfit && <th className={th}>複委託付款</th>}
            {showProfit && <th className={th}>累計毛利</th>}
            <th className={th}>獎金比例</th>
            <th className={th}>累計獎金池</th>
            <th className={th}>入帳／合約</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((it) => {
            const isProfit = it.basis === "gross_profit";
            const negative = isProfit && (it.grossProfit ?? 0) < 0;
            return (
              <tr key={it.projectId}>
                <td className={td}>
                  <Link href={`/admin/projects/${it.projectId}`} style={{ color: "var(--brand)" }}>
                    {it.projectCode ? `${it.projectCode} ` : ""}
                    {it.projectName ?? it.projectId}
                  </Link>
                </td>
                <td className={td}>{it.basis ? BONUS_BASIS_LABELS[it.basis] : "—"}</td>
                <td className={`${td} text-right`}>{fmtMoney(it.revenue ?? it.receivedTotal)}</td>
                {showTaxIncl && <td className={`${td} text-right`}>{it.basis === "tax_inclusive_receipts" ? fmtMoney(it.taxInclusiveRevenue) : "—"}</td>}
                {showProfit && <td className={`${td} text-right`}>{isProfit ? fmtMoney(it.disbursementCost) : "—"}</td>}
                {showProfit && <td className={`${td} text-right`}>{isProfit ? fmtMoney(it.subcontractCost) : "—"}</td>}
                {showProfit && (
                  <td className={`${td} text-right font-semibold ${negative ? "text-red-600" : ""}`}>
                    {isProfit ? fmtMoney(it.grossProfit) : "—"}
                    {negative && <span className="ml-1 font-normal">（負毛利，池以 0 計）</span>}
                  </td>
                )}
                <td className={`${td} text-right`}>{it.bonusRatePct == null ? "—" : `${it.bonusRatePct}%`}</td>
                <td className={`${td} text-right`}>{fmtMoney(it.bonusPool)}</td>
                <td className={`${td} text-right ${it.overContractPct ? "font-semibold text-amber-700" : ""}`}>
                  {it.contractTotal ? fmtPct(it.receivedPct) : "—（無合約）"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-gray-500">
        {showTaxIncl && (
          <>含稅入帳制（公司原 Excel）：每人累計應得＝累計含稅入帳 × 獎金比例 × 個人趴數，本次＝累計應得 − 已發（不扣成本）。</>
        )}
        {showProfit && (
          <>毛利制：每人累計應得＝max(0, 累計毛利) × 獎金比例 × 個人趴數，本次＝累計應得 − 已發。成本＝已匯款的放款（含代扣）＋沒經放款單、已標記付款的複委託期款。</>
        )}
        舊制（手填獎金池）：獎金池 × 入帳比例（最多 100%）× 個人趴數。
      </p>
    </div>
  );
}

export function WarningsList({ warnings }: { warnings: BonusWarning[] | undefined }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="mb-1 font-medium text-amber-900">請留意（{warnings.length}）</p>
      <ul className="space-y-0.5 text-amber-900">
        {warnings.map((w) => (
          <li key={`${w.projectId}-${w.kind}`}>
            <Link href={`/admin/projects/${w.projectId}`} className="underline">
              {w.code ? `${w.code} ` : ""}
              {w.name ?? w.projectId}
            </Link>
            <span className="ml-2">{w.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExcludedArchivedList({ snapshot }: { snapshot: BonusRunSnapshot | null | undefined }) {
  const list = snapshot?.excludedArchived ?? [];
  if (list.length === 0) return null;
  return (
    <details className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-gray-700">封存而未列入 {list.length} 個專案</summary>
      <ul className="mt-2 space-y-0.5 text-gray-700">
        {list.map((e) => (
          <li key={e.projectId}>
            <Link href={`/admin/projects/${e.projectId}`} className="underline">
              {e.code ? `${e.code} ` : ""}
              {e.name ?? e.projectId}
            </Link>
            <span className="ml-2 text-xs text-gray-500">{BONUS_ARCHIVE_EXCLUDE_LABELS[e.reason] ?? e.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
