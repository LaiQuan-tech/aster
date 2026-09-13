"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, ErrorText, PrimaryButton, inputCls } from "@/components/admin-ui";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { askKnowledge, listKnowledgeDocuments, type SearchHit } from "@/lib/knowledge-api";

/**
 * AI 文件問答：問題 → 取回最相關的段落 → 模型只依這些段落作答並標 [n] 引用。
 * 答案下方列出引用來源，每一句都能對回原文——模型說了文件裡沒有的東西一眼看得出。
 */
interface Turn {
  q: string;
  a?: string;
  sources?: SearchHit[];
  mode?: "vector" | "keyword";
  error?: string;
}

export default function KnowledgeAskPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [docCount, setDocCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSources, setOpenSources] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listKnowledgeDocuments()
      .then((r) => { setAiAvailable(r.aiAvailable); setDocCount(r.documents.filter((d) => d.status === "indexed").length); })
      .catch(() => null);
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  async function ask() {
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    setError(null);
    const idx = turns.length;
    setTurns((t) => [...t, { q: question }]);
    try {
      const r = await askKnowledge(question);
      setTurns((t) => t.map((x, i) => (i === idx ? { ...x, a: r.answer, sources: r.sources, mode: r.mode } : x)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "問答失敗";
      setTurns((t) => t.map((x, i) => (i === idx ? { ...x, error: msg } : x)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="AI 文件問答" desc="只依知識庫裡的文件回答，每句附引用；文件裡沒有的會直說" />
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {!aiAvailable && <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">未設定 GEMINI_API_KEY，問答不可用；<Link href="/admin/knowledge" className="underline">文件庫</Link>的關鍵字搜尋仍可用。</p>}
      {docCount === 0 && <p className="mb-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">知識庫還是空的——先到 <Link href="/admin/knowledge" className="underline">文件庫</Link> 放文件。</p>}

      <Card>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <p className="text-sm text-gray-400">例：「出差住宿一晚上限多少？」「合約印花稅由誰貼？」「特休怎麼算？」</p>
          )}
          {turns.map((t, i) => (
            <div key={i}>
              <div className="mb-2 flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 text-sm text-white" style={{ backgroundColor: "var(--brand)" }}>{t.q}</div>
              </div>
              <div className="flex justify-start">
                <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-gray-100 bg-gray-50 px-4 py-3">
                  {t.error ? (
                    <p className="text-sm text-red-600">{t.error}</p>
                  ) : t.a === undefined ? (
                    <p className="text-sm text-gray-400">思考中…</p>
                  ) : (
                    <>
                      <SimpleMarkdown text={t.a} />
                      {t.sources && t.sources.length > 0 && (
                        <div className="mt-2 border-t border-gray-200 pt-2">
                          <button type="button" onClick={() => setOpenSources(openSources === i ? null : i)} className="text-xs text-gray-500 hover:underline">
                            {openSources === i ? "收起來源" : `引用來源 ${t.sources.length} 段`}{t.mode === "keyword" ? "（關鍵字檢索）" : ""}
                          </button>
                          {openSources === i && (
                            <ol className="mt-2 space-y-2">
                              {t.sources.map((s, n) => (
                                <li key={s.chunkId} className="rounded-md bg-white p-2 text-xs text-gray-700">
                                  <p className="mb-1 font-medium text-gray-800">[{n + 1}] {s.title}<span className="ml-1 font-normal text-gray-400">第 {s.chunkIndex + 1} 段{s.similarity != null ? `・${(s.similarity * 100).toFixed(0)}%` : ""}</span></p>
                                  <p className="whitespace-pre-wrap">{s.content.length > 500 ? `${s.content.slice(0, 500)}…` : s.content}</p>
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); void ask(); }} className="mt-4 flex gap-2">
          <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="問一個文件裡可能有答案的問題" disabled={busy || !aiAvailable} />
          <PrimaryButton type="submit" disabled={busy || !q.trim() || !aiAvailable}>{busy ? "…" : "問"}</PrimaryButton>
        </form>
      </Card>
    </>
  );
}
