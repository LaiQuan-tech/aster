"use client";

import { useEffect, useState } from "react";
import { Card, InlineError } from "@/components/ess-ui";
import { getLeaveBalances, getLeaveTypes, type LeaveBalance, type LeaveType } from "@/lib/ess-api";
import { balancePeriodLabel } from "@/lib/leave-balances-api";
import { formatLeaveDuration } from "@/lib/leave-duration";

/**
 * 我的假別額度：`leave_balances` 一列一個「期間桶」。特休週年制（W1，2026-09-23）後
 * 期間是到職日週年（例：2026-05-10 ～ 2027-05-09），不再是曆年，所以顯示期間而不是年度；
 * API 還沒回期間欄的舊資料由 balancePeriodLabel 退回顯示年度。
 *
 * 時數顯示成「天＋時」（2026-10-11 業主決定，例：剩 6 天、可用 7 天、已用 1 天；13 天 4 時），
 * 1 天 ＝ `dailyRegularHours` 小時（API 隨 /leave-balances 回，缺席用 8）。**只改顯示**：餘額桶與 API 欄位仍是小時。
 */

export default function BalancesPage() {
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [hoursPerDay, setHoursPerDay] = useState<number | undefined>(undefined);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getLeaveBalances(), getLeaveTypes()])
      .then(([b, t]) => {
        setBalances(b.balances);
        setHoursPerDay(b.dailyRegularHours);
        setTypes(t.leaveTypes);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? id.slice(0, 8);
  const fmt = (hours: number) => formatLeaveDuration(hours, hoursPerDay);

  return (
    <div className="space-y-4">
      <Card>
        {error && <InlineError className="mb-3">{error}</InlineError>}
        <div className="space-y-3 md:hidden">
          {balances.map((b) => {
            const entitled = Number(b.entitled) + Number(b.deferred);
            const used = Number(b.used);
            const remaining = Math.max(0, entitled - used);
            const percent = entitled > 0 ? Math.min(100, Math.round((used / entitled) * 100)) : 0;
            return (
              <article key={b.id} className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">{typeName(b.leave_type_id)}</h3>
                    <p className="text-xs text-gray-400">{balancePeriodLabel(b)}</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold" style={{ color: "var(--brand)" }}>
                    剩 {fmt(remaining)}
                  </span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: "var(--brand)" }} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs text-gray-400">可用</dt><dd className="font-medium text-gray-800">{fmt(entitled)}</dd></div>
                  <div><dt className="text-xs text-gray-400">已用</dt><dd className="font-medium text-gray-800">{fmt(used)}</dd></div>
                </dl>
              </article>
            );
          })}
          {balances.length === 0 && <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">尚無假別額度資料</p>}
        </div>
        <table className="hidden w-full text-left text-sm md:table">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="py-2 pr-4">假別</th>
              <th className="py-2 pr-4">期間</th>
              <th className="py-2 pr-4">可用</th>
              <th className="py-2 pr-4">已用</th>
              <th className="py-2">剩餘</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => {
              const entitled = Number(b.entitled) + Number(b.deferred);
              const used = Number(b.used);
              return (
                <tr key={b.id} className="border-b border-gray-50">
                  <td className="py-2 pr-4 font-medium text-gray-800">{typeName(b.leave_type_id)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-xs text-gray-500">{balancePeriodLabel(b)}</td>
                  <td className="py-2 pr-4">{fmt(entitled)}</td>
                  <td className="py-2 pr-4">{fmt(used)}</td>
                  <td className="py-2 font-medium">{fmt(Math.max(0, entitled - used))}</td>
                </tr>
              );
            })}
            {balances.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-gray-400">尚無假別額度資料</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
