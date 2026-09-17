"use client";

import { useEffect, useState } from "react";
import { Card, InlineError } from "@/components/ess-ui";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { getCompanyPages, type CompanyPage } from "@/lib/company-api";

export default function CompanyInfoPage() {
  const [pages, setPages] = useState<CompanyPage[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCompanyPages()
      .then((r) => { setPages(r.pages); setSlug(r.pages[0]?.slug ?? null); })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const current = pages.find((p) => p.slug === slug);
  return (
    <div className="space-y-4">
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap gap-2">
        {pages.map((p) => (
          <button key={p.slug} type="button" onClick={() => setSlug(p.slug)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${slug === p.slug ? "text-white" : "border border-gray-200 bg-white text-gray-600"}`}
            style={slug === p.slug ? { backgroundColor: "var(--brand)" } : undefined}>
            {p.title}
          </button>
        ))}
      </div>
      <Card>
        {current ? (
          <>
            <h2 className="mb-3 text-lg font-semibold text-gray-800">{current.title}</h2>
            <SimpleMarkdown text={current.body} />
            {current.updatedAt && <p className="mt-4 text-xs text-gray-400">更新於 {new Date(current.updatedAt).toLocaleDateString("zh-TW")}</p>}
          </>
        ) : (
          <p className="text-sm text-gray-400">尚無內容</p>
        )}
      </Card>
    </div>
  );
}
