"use client";

import { useCallback, useEffect, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import { KpiScoreForm } from "@/components/KpiScoreForm";
import { getBranding, getMe, isAdminRole, type Branding, type Me } from "@/lib/ess-api";
import { getEmployees, type Employee } from "@/lib/admin-api";
import {
  listKpiTemplates,
  listKpiReviews,
  scoreKpiReview,
  submitKpiReview,
  REVIEW_STATUS_LABEL,
  type KpiTemplate,
  type KpiReview,
} from "@/lib/kpi-api";

/**
 * ESS 我的考核：兩塊——「我要評的」（我是考核者，評分中／已送出）與
 * 「我的考核結果」（我是受評者，只有定案的會出現；後端就是這樣過濾的）。
 */
function KpiInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [templates, setTemplates] = useState<KpiTemplate[]>([]);
  const [reviews, setReviews] = useState<KpiReview[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([listKpiTemplates(), listKpiReviews()]);
      setTemplates(t.templates);
      setReviews(r.reviews);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, []);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then(setMe).catch(() => null);
    // 員工清單只有 HR 拿得到；一般考核者拿不到就顯示編號前 8 碼，不擋功能
    getEmployees().then((r) => setEmployees(r.employees)).catch(() => null);
    void load();
  }, [load]);

  const name = (id: string) => employees.find((e) => e.id === id)?.name ?? id.slice(0, 8);
  const templateOf = (r: KpiReview) => templates.find((t) => t.id === r.template_id);
  const toReview = me ? reviews.filter((r) => r.reviewer_emp_id === me.id && r.status !== "finalized") : [];
  const mine = me ? reviews.filter((r) => r.employee_id === me.id && r.status === "finalized") : [];

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="kpi" isAdmin={me ? isAdminRole(me.role) : false} />
      <main className="mx-auto max-w-3xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        {error && <p className="text-sm text-red-600">{error}</p>}

        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-800">我要評的</h2>
          <p className="mb-4 text-sm text-gray-500">每一項都填分數後送出；送出後由 HR 定案。定案前還可以修改分數。</p>
          {toReview.length === 0 ? (
            <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">目前沒有指派給你的考核</p>
          ) : (
            <ul className="space-y-2">
              {toReview.map((r) => (
                <li key={r.id} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                  <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} className="flex w-full items-center justify-between text-left">
                    <span>
                      <span className="font-medium text-gray-900">{name(r.employee_id)}</span>
                      <span className="ml-2 text-sm text-gray-500">{r.period}・{templateOf(r)?.name ?? "—"}</span>
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${r.status === "submitted" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"}`}>{REVIEW_STATUS_LABEL[r.status]}</span>
                  </button>
                  {openId === r.id && (
                    <div className="mt-3 rounded-lg bg-white p-3">
                      <KpiScoreForm key={r.updated_at} review={r} template={templateOf(r)} readOnly={false}
                        onSave={async (scores) => { await scoreKpiReview(r.id, scores); await load(); }}
                        onSubmit={async () => { await submitKpiReview(r.id); await load(); }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-800">我的考核結果</h2>
          <p className="mb-4 text-sm text-gray-500">只顯示 HR 已定案的考核。</p>
          {mine.length === 0 ? (
            <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">尚無定案的考核</p>
          ) : (
            <ul className="space-y-2">
              {mine.map((r) => (
                <li key={r.id} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                  <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} className="flex w-full items-center justify-between text-left">
                    <span className="text-sm text-gray-700">{r.period}・{templateOf(r)?.name ?? "—"}</span>
                    <span className="text-lg font-semibold text-gray-900">{r.total_score != null ? Number(r.total_score) : "—"}</span>
                  </button>
                  {openId === r.id && (
                    <div className="mt-3 rounded-lg bg-white p-3">
                      <KpiScoreForm review={r} template={templateOf(r)} readOnly onSave={async () => {}} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default function KpiPage() {
  return (
    <EssTabGate tab="kpi">
      <KpiInner />
    </EssTabGate>
  );
}
