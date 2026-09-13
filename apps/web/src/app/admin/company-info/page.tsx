"use client";
import { useEffect, useState } from "react";
import { Card, PageHeader, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { getCompanyPages, putCompanyPage, type CompanyPage } from "@/lib/company-api";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";

/**
 * 公司福利／職安資訊：固定兩頁（福利、職安衛），HR 在此編輯，員工在 ESS 讀。
 * 內容用簡化 Markdown（標題 #、清單 -、段落），預覽與 ESS 用同一個渲染器。
 */
export default function CompanyInfoAdminPage() {
  const [pages, setPages] = useState<CompanyPage[]>([]);
  const [slug, setSlug] = useState<string>("benefits");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);

  async function load() {
    try {
      const r = await getCompanyPages();
      setPages(r.pages);
      const cur = r.pages.find((p) => p.slug === slug) ?? r.pages[0];
      if (cur) {
        setSlug(cur.slug);
        setTitle(cur.title);
        setBody(cur.body);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(s: string) {
    const p = pages.find((x) => x.slug === s);
    if (!p) return;
    setSlug(s);
    setTitle(p.title);
    setBody(p.body);
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await putCompanyPage(slug, { title: title.trim() || pages.find((p) => p.slug === slug)?.defaultTitle || slug, body });
      setMsg("已儲存，員工端立即可見");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  const current = pages.find((p) => p.slug === slug);
  return (
    <>
      <PageHeader title="公司福利 / 職安資訊" desc="長期有效的說明頁：員工在 ESS「公司資訊」讀取。公告類請用最新消息。" />
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      <div className="mb-4 flex gap-2">
        {pages.map((p) => (
          <button key={p.slug} type="button" onClick={() => pick(p.slug)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${slug === p.slug ? "text-white" : "border border-gray-200 bg-white text-gray-600"}`}
            style={slug === p.slug ? { backgroundColor: "var(--brand)" } : undefined}>
            {p.defaultTitle}{!p.exists && <span className="ml-1 text-xs opacity-70">（未建）</span>}
          </button>
        ))}
      </div>
      <Card>
        <div className="mb-3">
          <label className={labelCls}>頁面標題</label>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={current?.defaultTitle} />
        </div>
        <div className="mb-2 flex items-center justify-between">
          <label className={labelCls}>內容（# 標題、- 清單、空行分段）</label>
          <button type="button" onClick={() => setPreview((v) => !v)} className="text-xs text-gray-500 hover:underline">{preview ? "回到編輯" : "預覽"}</button>
        </div>
        {preview ? (
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4"><SimpleMarkdown text={body} /></div>
        ) : (
          <textarea className={`${inputCls} min-h-[360px] font-mono text-[13px]`} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"# 勞保、健保與勞退\n- 到職即投保…\n\n# 休假\n- 特休依勞基法 §38…"} />
        )}
        <div className="mt-3 flex items-center gap-3">
          <PrimaryButton type="button" onClick={() => void save()} disabled={busy}>{busy ? "儲存中…" : "儲存"}</PrimaryButton>
          {current?.updatedAt && <span className="text-xs text-gray-400">上次更新 {new Date(current.updatedAt).toLocaleString("zh-TW")}</span>}
          {msg && <span className="text-sm text-green-700">{msg}</span>}
        </div>
      </Card>
    </>
  );
}
