"use client";

import { useEffect, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  isAdminRole,
  getLeaveBalances,
  getLeaveTypes,
  type Branding,
  type LeaveBalance,
  type LeaveType,
} from "@/lib/ess-api";

// "X 時 Y 分" from decimal hours (Apollo displays hours+minutes).
function fmt(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h} 時 ${m} 分`;
}

function BalancesInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    Promise.all([getLeaveBalances(), getLeaveTypes()])
      .then(([b, t]) => {
        setBalances(b.balances);
        setTypes(t.leaveTypes);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="balances" isAdmin={isAdmin} />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">剩餘假別</h2>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
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
                      <p className="text-xs text-gray-400">{b.year}</p>
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
                    <td className="py-2 pr-4 font-medium text-gray-800">
                      {typeName(b.leave_type_id)}
                      <span className="ml-1 text-xs text-gray-400">{b.year}</span>
                    </td>
                    <td className="py-2 pr-4">{fmt(entitled)}</td>
                    <td className="py-2 pr-4">{fmt(used)}</td>
                    <td className="py-2 font-medium">{fmt(Math.max(0, entitled - used))}</td>
                  </tr>
                );
              })}
              {balances.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-gray-400">尚無假別額度資料</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

export default function BalancesPage() {
  return (
    <EssTabGate tab="balances">
      <BalancesInner />
    </EssTabGate>
  );
}
