"use client";

import { useEffect, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  isAdminRole,
  getMyPayslips,
  type Branding,
  type MyPayslip,
} from "@/lib/ess-api";

function money(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString("zh-TW") : value;
}

function PayslipsInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<MyPayslip[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    getMyPayslips()
      .then((r) => setRows(r.payslips))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="payslips" isAdmin={isAdmin} />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">我的薪資單</h2>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          <div className="space-y-3 md:hidden">
            {rows.map((p) => (
              <article key={p.id} className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-gray-900">{p.period}</h3>
                    <p className="text-xs text-gray-400">我的薪資單</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${p.status === "finalized" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                    {p.status === "finalized" ? "已定案" : "草稿"}
                  </span>
                </div>
                <p className="text-2xl font-bold text-gray-900">{money(p.gross)} 元</p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-gray-400">本薪</dt><dd className="font-medium text-gray-800">{money(p.base)}</dd></div>
                  <div><dt className="text-xs text-gray-400">加班</dt><dd className="font-medium text-gray-800">{money(p.overtime_pay)}</dd></div>
                  <div><dt className="text-xs text-gray-400">全勤</dt><dd className="font-medium text-gray-800">{money(p.attendance_bonus)}</dd></div>
                </dl>
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
                <th className="py-2">狀態</th>
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
                  <td className="py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "finalized" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                      {p.status === "finalized" ? "已定案" : "草稿"}
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-gray-400">尚無薪資單</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}

export default function PayslipsPage() {
  return (
    <EssTabGate tab="payslips">
      <PayslipsInner />
    </EssTabGate>
  );
}
