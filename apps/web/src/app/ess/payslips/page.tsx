"use client";

import { Fragment, useEffect, useState } from "react";
import { Card, InlineError, Pill } from "@/components/ess-ui";
import { getMyPayslips, type MyPayslip } from "@/lib/ess-api";
import type { PayslipSendFields } from "@/lib/cash-payouts-api";
import { adjustmentDisplayOf, signedMoney, TREATMENT_LABEL } from "@/lib/payroll-adjustments-api";
import { MyPayslipStatementCard } from "./MyPayslipStatementCard";

/** 薪資單 breakdown 上員工端用得到的欄位（API 的 GET /payslips?scope=mine 本來就帶 breakdown；舊資料可能是 {}）。 */
interface MyBreakdown {
  totalDeductions?: number;
  expenses?: number;
  net?: number;
  lines?: Array<{ label: string; amount: number }>;
}

/** M3：`sent_at`／`sent_to` 在 migration 0050 之後才有（lib/ess-api.ts 是 WP0 的檔，不改）。 */
type MyPayslipRow = MyPayslip & PayslipSendFields & { breakdown?: MyBreakdown | null };

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "—";
}

/**
 * 這張薪資單的逐項明細（員工看得到每一筆）：一次性加減項（前期更正）單獨列一塊，標題帶「(更正 YYYY-MM)」，
 * 再來是應發合計／應扣合計／實發，最後是逐項明細（正加項、負扣項；加減項也在裡面）。
 * 沒有 breakdown 的舊薪資單沒有明細可看。
 */
function PayslipDetail({ p }: { p: MyPayslipRow }) {
  const b = p.breakdown ?? null;
  const adjustments = adjustmentDisplayOf(b);
  const lines = b?.lines ?? [];
  if (!b || (lines.length === 0 && adjustments.all.length === 0)) {
    return <p className="text-sm text-gray-400">這張薪資單沒有逐項明細。</p>;
  }
  return (
    <div className="space-y-3 text-sm" data-testid="my-payslip-detail">
      {adjustments.all.length > 0 && (
        <div data-testid="my-payslip-adjustments">
          <p className="mb-1 text-xs font-semibold text-gray-500">加減項（前期更正）</p>
          <ul className="divide-y divide-gray-100">
            {adjustments.all.map((a, i) => (
              <li key={a.id ?? i} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1">
                <span className="text-gray-800">{a.label}</span>
                <span className="text-xs text-gray-400">{TREATMENT_LABEL[a.treatment]}</span>
                <span className={`tabular-nums ${a.signed < 0 ? "text-rose-700" : "text-emerald-700"}`}>{signedMoney(a.signed)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-gray-500">應發合計</dt>
        <dd className="text-right tabular-nums">{fmt(Number(p.gross))}</dd>
        <dt className="text-gray-500">應扣合計</dt>
        <dd className="text-right tabular-nums">{fmt(Number(b.totalDeductions ?? 0))}</dd>
        {Number(b.expenses ?? 0) !== 0 && (
          <>
            <dt className="text-gray-500">代墊支出（不計薪資所得）</dt>
            <dd className="text-right tabular-nums">{fmt(Number(b.expenses))}</dd>
          </>
        )}
        <dt className="font-medium text-gray-700">實發金額</dt>
        <dd className="text-right font-medium tabular-nums">{fmt(typeof b.net === "number" ? b.net : Number(p.gross))}</dd>
      </dl>
      {lines.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-gray-500">逐項明細</p>
          <ul className="divide-y divide-gray-100">
            {lines.map((l, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-1">
                <span className="text-gray-700">{l.label}</span>
                <span className={`tabular-nums ${l.amount < 0 ? "text-rose-700" : ""}`}>{fmt(l.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function money(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString("zh-TW") : value;
}

/** 「已寄至 xxx（09/23 10:05）」——收件地址讓同仁自己確認信箱對不對。 */
function sentLabel(p: MyPayslipRow): string | null {
  if (!p.sent_at) return null;
  const when = new Date(p.sent_at).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return p.sent_to ? `已寄至 ${p.sent_to}（${when}）` : `已寄送（${when}）`;
}

export default function PayslipsPage() {
  const [rows, setRows] = useState<MyPayslipRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    getMyPayslips()
      .then((r) => setRows(r.payslips as MyPayslipRow[]))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="space-y-4">
      <MyPayslipStatementCard />
      <Card>
        {error && <InlineError className="mb-3">{error}</InlineError>}
        <div className="space-y-3 md:hidden">
          {rows.map((p) => (
            <article key={p.id} className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-gray-900">{p.period}</h3>
                  <p className="text-xs text-gray-400">我的薪資單</p>
                </div>
                <Pill tone={p.status === "finalized" ? "green" : "amber"}>
                  {p.status === "finalized" ? "已定案" : "草稿"}
                </Pill>
              </div>
              <p className="text-2xl font-bold text-gray-900">{money(p.gross)} 元</p>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                <div><dt className="text-xs text-gray-400">本薪</dt><dd className="font-medium text-gray-800">{money(p.base)}</dd></div>
                <div><dt className="text-xs text-gray-400">加班</dt><dd className="font-medium text-gray-800">{money(p.overtime_pay)}</dd></div>
                <div><dt className="text-xs text-gray-400">全勤</dt><dd className="font-medium text-gray-800">{money(p.attendance_bonus)}</dd></div>
              </dl>
              {sentLabel(p) && (
                <p className="mt-3 text-xs text-emerald-700">✉ {sentLabel(p)}</p>
              )}
              <button
                type="button"
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                aria-expanded={openId === p.id}
                className="mt-3 text-sm font-medium"
                style={{ color: "var(--brand)" }}
              >
                {openId === p.id ? "收合明細" : "看明細"}
              </button>
              {openId === p.id && (
                <div className="mt-3 border-t border-gray-200 pt-3">
                  <PayslipDetail p={p} />
                </div>
              )}
            </article>
          ))}
          {rows.length === 0 && <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">尚無薪資單</p>}
        </div>
        <table className="hidden w-full text-left text-sm md:table">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="py-2 pr-4">期間</th>
              <th className="py-2 pr-4">本薪</th>
              <th className="py-2 pr-4">加班費</th>
              <th className="py-2 pr-4">全勤獎金</th>
              <th className="py-2 pr-4">應發合計</th>
              <th className="py-2 pr-4">狀態</th>
              <th className="py-2 pr-4">寄送</th>
              <th className="py-2">明細</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Fragment key={p.id}>
              <tr className="border-b border-gray-50">
                <td className="py-2 pr-4 font-medium text-gray-800">{p.period}</td>
                <td className="py-2 pr-4">{p.base}</td>
                <td className="py-2 pr-4">{p.overtime_pay}</td>
                <td className="py-2 pr-4">{p.attendance_bonus}</td>
                <td className="py-2 pr-4 font-medium">{p.gross}</td>
                <td className="py-2 pr-4">
                  <Pill tone={p.status === "finalized" ? "green" : "amber"}>
                    {p.status === "finalized" ? "已定案" : "草稿"}
                  </Pill>
                </td>
                <td className="py-2 pr-4 text-xs text-gray-500">
                  {sentLabel(p) ? <span className="text-emerald-700">{sentLabel(p)}</span> : "—"}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => setOpenId(openId === p.id ? null : p.id)}
                    aria-expanded={openId === p.id}
                    className="text-sm font-medium hover:underline"
                    style={{ color: "var(--brand)" }}
                  >
                    {openId === p.id ? "收合" : "看明細"}
                  </button>
                </td>
              </tr>
              {openId === p.id && (
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <td colSpan={8} className="px-3 py-3">
                    <PayslipDetail p={p} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-3 text-gray-400">尚無薪資單</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
