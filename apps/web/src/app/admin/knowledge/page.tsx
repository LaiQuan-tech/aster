"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import {
  listKnowledgeDocuments, createKnowledgeText, uploadKnowledgeFile, linkProjectDocument, reindexKnowledgeDocument,
  deleteKnowledgeDocument, knowledgeDownloadUrl, searchKnowledge, type KnowledgeDocument, type SearchHit,
} from "@/lib/knowledge-api";
import { listProjects, getProjectDocuments, type Project, type ProjectDocument } from "@/lib/projects-api";

/**
 * 文件庫 · 語意搜尋。三種進件：貼文字、上傳檔案（txt/md/csv/json/pdf/docx）、掛專案文件庫既有檔。
 * 建檔即索引（抽字 → 切塊 → 向量）。搜尋有金鑰走語意、沒金鑰退回關鍵字，結果標示用了哪種。
 */
const STATUS_CLS: Record<KnowledgeDocument["status"], string> = {
  indexed: "bg-green-50 text-green-700",
  pending: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
};
const STATUS_LABEL: Record<KnowledgeDocument["status"], string> = { indexed: "已索引", pending: "處理中", failed: "失敗" };
const KIND_LABEL: Record<KnowledgeDocument["kind"], string> = { text: "文字", file: "檔案", project_document: "專案文件" };

export default function KnowledgePage() {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 搜尋
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [mode, setMode] = useState<"vector" | "keyword" | null>(null);
  // 進件
  const [add, setAdd] = useState<"text" | "file" | "project" | null>(null);
  const [tTitle, setTTitle] = useState("");
  const [tBody, setTBody] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectDocs, setProjectDocs] = useState<ProjectDocument[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await listKnowledgeDocuments();
      setDocs(r.documents);
      setAiAvailable(r.aiAvailable);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (add === "project" && projects.length === 0) listProjects().then((r) => setProjects(r.projects)).catch(() => null);
  }, [add, projects.length]);
  useEffect(() => {
    if (projectId) getProjectDocuments(projectId).then((r) => setProjectDocs(r.documents)).catch(() => setProjectDocs([]));
    else setProjectDocs([]);
  }, [projectId]);

  function report(index: { status: string; chunks: number; error?: string }, title: string) {
    if (index.status === "indexed") setError(null);
    else setError(`「${title}」索引失敗：${index.error ?? "未知原因"}`);
  }

  async function doSearch() {
    if (!q.trim()) { setHits(null); return; }
    setBusy("search");
    try {
      const r = await searchKnowledge(q.trim(), 10);
      setHits(r.hits);
      setMode(r.mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "搜尋失敗");
    } finally {
      setBusy(null);
    }
  }
  async function addText() {
    if (!tTitle.trim() || !tBody.trim()) return;
    setBusy("add");
    try {
      const r = await createKnowledgeText({ title: tTitle.trim(), body: tBody });
      report(r.index, r.document.title);
      setTTitle(""); setTBody(""); setAdd(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "建檔失敗");
    } finally {
      setBusy(null);
    }
  }
  async function addFile(file: File | undefined) {
    if (!file) return;
    setBusy("add");
    try {
      const r = await uploadKnowledgeFile(file);
      report(r.index, r.document.title);
      setAdd(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function link(pd: ProjectDocument) {
    setBusy(pd.id);
    try {
      const r = await linkProjectDocument(pd.id);
      report(r.index, r.document.title);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "掛入失敗");
    } finally {
      setBusy(null);
    }
  }
  async function reindex(d: KnowledgeDocument) {
    setBusy(d.id);
    try {
      const r = await reindexKnowledgeDocument(d.id);
      report(r.index, d.title);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重建失敗");
    } finally {
      setBusy(null);
    }
  }
  async function remove(d: KnowledgeDocument) {
    if (!confirm(`從知識庫移除「${d.title}」？${d.kind === "project_document" ? "（專案文件本身不會被刪）" : ""}`)) return;
    try { await deleteKnowledgeDocument(d.id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "刪除失敗"); }
  }
  async function open(d: KnowledgeDocument) {
    try { const { url } = await knowledgeDownloadUrl(d.id); window.open(url, "_blank", "noreferrer"); } catch (err) { setError(err instanceof Error ? err.message : "開啟失敗"); }
  }

  const linkedIds = new Set(docs.map((d) => d.projectDocumentId).filter(Boolean));

  return (
    <>
      <PageHeader title="文件庫 · 語意搜尋" desc="把 SOP、規章、合約範本、專案文件放進來，用意思找、不用記關鍵字" />
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {!aiAvailable && <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">未設定 GEMINI_API_KEY：文件仍可建檔與關鍵字搜尋，但沒有語意搜尋與問答。設定後對每份文件按「重建索引」。</p>}

      <Card>
        <form onSubmit={(e) => { e.preventDefault(); void doSearch(); }} className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} max-w-xl`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="例：加班費怎麼算？出差住宿上限？合約印花稅誰貼？" />
          <PrimaryButton type="submit" disabled={busy === "search"}>{busy === "search" ? "搜尋中…" : "搜尋"}</PrimaryButton>
          <Link href="/admin/knowledge/ask" className="text-sm hover:underline" style={{ color: "var(--brand)" }}>改用 AI 問答 →</Link>
        </form>
        {hits !== null && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-gray-400">{mode === "vector" ? "語意搜尋" : "關鍵字搜尋"}・{hits.length} 筆</p>
            {hits.length === 0 ? (
              <Empty>沒有相關內容</Empty>
            ) : (
              <ul className="space-y-2">
                {hits.map((h) => (
                  <li key={h.chunkId} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                    <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
                      <span className="font-medium text-gray-700">{h.title}</span>
                      <span>第 {h.chunkIndex + 1} 段{h.similarity != null ? `・相似度 ${(h.similarity * 100).toFixed(0)}%` : ""}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-gray-800">{h.content.length > 600 ? `${h.content.slice(0, 600)}…` : h.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-700">文件（{docs.length}）</h2>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={() => setAdd(add === "text" ? null : "text")} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700">貼文字</button>
            <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json,.pdf,.docx" className="hidden" onChange={(e) => void addFile(e.target.files?.[0])} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy === "add"} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-50">{busy === "add" ? "處理中…" : "上傳檔案"}</button>
            <button type="button" onClick={() => setAdd(add === "project" ? null : "project")} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700">掛入專案文件</button>
          </div>
        </div>

        {add === "text" && (
          <div className="mb-4 rounded-lg border border-gray-200 p-3">
            <div className="mb-2"><label className={labelCls}>標題</label><input className={inputCls} value={tTitle} onChange={(e) => setTTitle(e.target.value)} placeholder="例：出差報銷 SOP" /></div>
            <div className="mb-2"><label className={labelCls}>內容</label><textarea className={`${inputCls} min-h-[160px]`} value={tBody} onChange={(e) => setTBody(e.target.value)} /></div>
            <PrimaryButton type="button" onClick={() => void addText()} disabled={busy === "add" || !tTitle.trim() || !tBody.trim()}>{busy === "add" ? "索引中…" : "建檔並索引"}</PrimaryButton>
          </div>
        )}
        {add === "project" && (
          <div className="mb-4 rounded-lg border border-gray-200 p-3">
            <label className={labelCls}>專案</label>
            <select className={`${inputCls} max-w-sm`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">選擇專案</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} ` : ""}{p.name}</option>)}
            </select>
            {projectId && (projectDocs.length === 0 ? <p className="mt-2 text-sm text-gray-400">這個專案沒有文件</p> : (
              <ul className="mt-2 divide-y">
                {projectDocs.map((pd) => (
                  <li key={pd.id} className="flex items-center justify-between py-1.5 text-sm">
                    <span>{pd.fileName}<span className="ml-2 text-xs text-gray-400">{Math.round(pd.sizeBytes / 1024)} KB</span></span>
                    {linkedIds.has(pd.id) ? <span className="text-xs text-gray-400">已在知識庫</span> : (
                      <button type="button" onClick={() => void link(pd)} disabled={busy === pd.id} className="text-sm font-medium disabled:opacity-50" style={{ color: "var(--brand)" }}>{busy === pd.id ? "索引中…" : "掛入"}</button>
                    )}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}

        {docs.length === 0 ? (
          <Empty>知識庫是空的。貼一段文字、上傳檔案，或從專案文件掛入。</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-2 pr-3">標題</th>
                <th className="py-2 pr-3">來源</th>
                <th className="py-2 pr-3 text-right">段數</th>
                <th className="py-2 pr-3">狀態</th>
                <th className="py-2 pr-3">更新</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b last:border-0 align-top">
                  <td className="py-2 pr-3">
                    <p className="font-medium text-gray-900">{d.title}</p>
                    {d.error && <p className="text-xs text-red-600">{d.error}</p>}
                  </td>
                  <td className="py-2 pr-3 text-gray-600">{KIND_LABEL[d.kind]}{d.fileName ? <span className="block text-xs text-gray-400">{d.fileName}</span> : null}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{d.chunkCount}</td>
                  <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[d.status]}`}>{STATUS_LABEL[d.status]}</span></td>
                  <td className="py-2 pr-3 text-xs text-gray-500">{new Date(d.updatedAt).toLocaleDateString("zh-TW")}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {d.kind !== "text" && <button type="button" onClick={() => void open(d)} className="mr-3 text-xs text-gray-600 hover:underline">開啟</button>}
                    <button type="button" onClick={() => void reindex(d)} disabled={busy === d.id} className="mr-3 text-xs text-gray-600 hover:underline disabled:opacity-50">{busy === d.id ? "重建中…" : "重建索引"}</button>
                    <button type="button" onClick={() => void remove(d)} className="text-xs text-gray-400 hover:text-red-600">移除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
