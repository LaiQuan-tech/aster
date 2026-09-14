"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import { getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";
import { getMyProjectShares, type MyProjectShare } from "@/lib/projects-api";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("zh-TW");
}

function MyBonusInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [shares, setShares] = useState<MyProjectShare[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    getMyProjectShares()
      .then((r) => setShares(r.shares))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const total = shares.reduce((s, x) => s + (x.computedAmount ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="bonus" isAdmin={isAdmin} />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-800">我的分潤</h2>
          <p className="mb-4 text-sm text-gray-500">各專案分給你的獎金（僅你自己與主管可見）。</p>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

          {shares.length === 0 ? (
            <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">目前沒有任何專案分潤</p>
          ) : (
            <>
              <div className="mb-4 rounded-xl bg-gray-50 p-4">
                <p className="text-xs text-gray-400">目前分潤合計</p>
                <p className="text-2xl font-bold text-gray-900">{money(total)} 元</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-gray-500">
                      <th className="py-2 pr-3">專案</th>
                      <th className="py-2 pr-3">分潤</th>
                      <th className="py-2 pr-3">實得金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.map((s) => (
                      <tr key={s.memberId} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium text-gray-800">
                          <Link href={`/ess/projects/${s.projectId}`} style={{ color: "var(--brand)" }}>
                            {s.projectName ?? s.projectId}
                          </Link>
                          {s.roleInProject === "lead" && <span className="ml-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">負責人</span>}
                        </td>
                        <td className="py-2 pr-3 text-gray-700">
                          {s.shareMode === "pool_pct" ? (s.sharePct != null ? `${s.sharePct}%` : "—") : money(s.shareAmount)}
                        </td>
                        <td className="py-2 pr-3 font-medium text-gray-900">{money(s.computedAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default function MyBonusPage() {
  return (
    <EssTabGate tab="bonus">
      <MyBonusInner />
    </EssTabGate>
  );
}
