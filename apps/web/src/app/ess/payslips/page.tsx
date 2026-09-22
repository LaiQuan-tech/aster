"use client";

import { useEffect, useState } from "react";
import { Card, InlineError, Pill } from "@/components/ess-ui";
import { getMyPayslips, type MyPayslip } from "@/lib/ess-api";
import type { PayslipSendFields } from "@/lib/cash-payouts-api";

/** M3：`sent_at`／`sent_to` 在 migration 0050 之後才有（lib/ess-api.ts 是 WP0 的檔，不改）。 */
type MyPayslipRow = MyPayslip & PayslipSendFields;

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

  useEffect(() => {
    getMyPayslips()
      .then((r) => setRows(r.payslips as MyPayslipRow[]))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="space-y-4">
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
              <th className="py-2">寄送</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-gray-50">
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
                <td className="py-2 text-xs text-gray-500">
                  {sentLabel(p) ? <span className="text-emerald-700">{sentLabel(p)}</span> : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-gray-400">尚無薪資單</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
