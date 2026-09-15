"use client";

import { useEffect, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";
import { getCompanyPages, type CompanyPage } from "@/lib/company-api";

function CompanyInfoInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pages, setPages] = useState<CompanyPage[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    getCompanyPages()
      .then((r) => { setPages(r.pages); setSlug(r.pages[0]?.slug ?? null); })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const current = pages.find((p) => p.slug === slug);
  return (
    <div className="min-h-dvh bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="company" isAdmin={isAdmin} />
      <main className="mx-auto max-w-3xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          {pages.map((p) => (
            <button key={p.slug} type="button" onClick={() => setSlug(p.slug)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${slug === p.slug ? "text-white" : "border border-gray-200 bg-white text-gray-600"}`}
              style={slug === p.slug ? { backgroundColor: "var(--brand)" } : undefined}>
              {p.title}
            </button>
          ))}
        </div>
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          {current ? (
            <>
              <h2 className="mb-3 text-lg font-semibold text-gray-800">{current.title}</h2>
              <SimpleMarkdown text={current.body} />
              {current.updatedAt && <p className="mt-4 text-xs text-gray-400">更新於 {new Date(current.updatedAt).toLocaleDateString("zh-TW")}</p>}
            </>
          ) : (
            <p className="text-sm text-gray-400">尚無內容</p>
          )}
        </section>
      </main>
    </div>
  );
}

export default function CompanyInfoPage() {
  return (
    <EssTabGate tab="company">
      <CompanyInfoInner />
    </EssTabGate>
  );
}
