"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

interface AiAskResponse {
  answer: string;
  model: string;
  scope: "tenant" | "self";
}

interface Message {
  role: "assistant" | "user";
  text: string;
}

const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);
const monthStart = `${month}-01`;

const EXAMPLES = [
  "這個月誰遲到最多？",
  "幫我看目前加班風險",
  "薪資總額跟表單件數摘要",
  "有哪些資料適合客戶 demo？",
];

export function FloatingAiChat() {
  const pathname = usePathname();
  // ESS（員工前台）手機版有固定底部分頁列，浮球會疊在打卡列上：/ess* 只在桌機（lg+）顯示。
  const inEss = pathname === "/ess" || pathname?.startsWith("/ess/") === true;
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: "嗨，我是 HR AI 助理。你可以直接問我出勤、請假、薪資、人力或異常資料；我會依照你的登入權限讀資料。",
    },
  ]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    supabase.auth.getSession().then(({ data }) => setReady(!!data.session)).catch(() => setReady(false));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => setReady(!!session));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  const period = useMemo(() => month, []);

  async function ask(question = input.trim()) {
    if (!question || loading) return;
    setInput("");
    setLoading(true);
    setMessages((items) => [...items, { role: "user", text: question }]);
    try {
      const res = await apiFetch<AiAskResponse>("/ai/ask", {
        method: "POST",
        body: JSON.stringify({ question, from: monthStart, to: today, period }),
      });
      setMessages((items) => [
        ...items,
        { role: "assistant", text: `${res.answer}\n\n（scope: ${res.scope} / model: ${res.model}）` },
      ]);
    } catch (err) {
      setMessages((items) => [
        ...items,
        {
          role: "assistant",
          text:
            err instanceof Error
              ? `我現在暫時讀不到資料：${err.message}`
              : "我現在暫時讀不到資料，請稍後再試。",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  if (!ready) return null;

  return (
    <div className={`fixed bottom-24 right-3 z-50 print:hidden lg:bottom-5 lg:right-5${inEss ? " hidden lg:block" : ""}`}>
      {open && (
        <section className="mb-3 flex h-[min(70vh,560px)] w-[min(94vw,420px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl lg:h-[560px]">
          <header className="flex items-start justify-between gap-3 bg-slate-950 px-4 py-3 text-white">
            <div>
              <h2 className="text-sm font-semibold">HR AI 聊天助理</h2>
              <p className="text-xs text-slate-300">右下角直接調資料、看摘要、找風險</p>
            </div>
            <button className="rounded-md px-2 text-xl leading-none text-slate-300 hover:bg-white/10" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
            {messages.map((message, index) => (
              <div key={index} className={message.role === "user" ? "text-right" : "text-left"}>
                <div
                  className={`inline-block max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-6 ${
                    message.role === "user"
                      ? "bg-[var(--brand)] text-white"
                      : "border border-slate-100 bg-white text-slate-700 shadow-sm"
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))}
            {loading && <p className="text-sm text-slate-400">AI 正在查資料…</p>}
          </div>

          <div className="border-t border-slate-100 bg-white p-3">
            <div className="mb-2 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-200"
                  disabled={loading}
                  onClick={() => void ask(example)}
                >
                  {example}
                </button>
              ))}
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
            >
              <input
                className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
                placeholder="問我：這月誰加班最高？"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
              <button
                className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                style={{ backgroundColor: "var(--brand)" }}
                disabled={loading || !input.trim()}
              >
                送出
              </button>
            </form>
          </div>
        </section>
      )}

      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-2xl transition hover:-translate-y-0.5"
      >
        <span className="text-lg">✦</span>
        AI 助理
      </button>
    </div>
  );
}
