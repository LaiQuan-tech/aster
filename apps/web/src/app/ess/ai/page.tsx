"use client";

import { useEffect, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import { askAiQuestion, getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";

const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);
const monthStart = `${month}-01`;

function EssAiPageInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState(month);
  const [question, setQuestion] = useState("我這個月的出勤、請假或薪資有什麼需要注意？");
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((res) => setBranding(res.branding)).catch(() => null);
    getMe().then((me) => setIsAdmin(isAdminRole(me.role))).catch(() => null);
  }, []);

  async function ask() {
    setError(null);
    setLoading(true);
    try {
      const res = await askAiQuestion({ question, from, to, period });
      setAnswer(res.answer);
      setModel(res.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 問答失敗");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh bg-gray-50">
      <EssHeader
        appName={branding?.appName}
        primaryColor={branding?.primaryColor}
        active="ai"
        isAdmin={isAdmin}
      />
      <main className="mx-auto max-w-3xl space-y-4 px-3 pb-6 pt-4 sm:space-y-6 sm:px-4">
        <section className="rounded-2xl bg-white p-4 shadow-sm sm:p-6">
          <h1 className="text-xl font-bold text-gray-900">AI 問答</h1>
          <p className="mt-1 text-sm text-gray-500">
            員工問答只會使用你的個人差勤、表單、薪資單與通知資料；不會揭露其他員工資料。
          </p>
        </section>

        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        <section className="rounded-2xl bg-white p-4 shadow-sm sm:p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="text-sm font-medium text-gray-700">
              區間起
              <input className="mt-1 w-full rounded-md border px-3 py-2" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="text-sm font-medium text-gray-700">
              區間迄
              <input className="mt-1 w-full rounded-md border px-3 py-2" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <label className="text-sm font-medium text-gray-700">
              薪資年月
              <input className="mt-1 w-full rounded-md border px-3 py-2" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
            </label>
          </div>

          <label className="mt-4 block text-sm font-medium text-gray-700">
            想問什麼？
            <textarea
              className="mt-1 min-h-32 w-full rounded-md border px-3 py-2"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => void ask()}
            disabled={loading || !question.trim()}
            className="mt-3 w-full rounded-xl px-4 py-3 text-sm font-medium text-white disabled:opacity-60 sm:w-auto sm:rounded-md sm:py-2"
            style={{ backgroundColor: "var(--brand)" }}
          >
            {loading ? "回答中…" : "詢問 AI"}
          </button>
        </section>

        <section className="rounded-2xl bg-white p-4 shadow-sm sm:p-6">
          <h2 className="font-semibold text-gray-900">回答</h2>
          <pre className="mt-3 min-h-52 whitespace-pre-wrap rounded-xl bg-gray-50 p-4 text-sm leading-6 text-gray-700">
            {answer || "AI 回答會顯示在這裡。"}
          </pre>
          {model && <p className="mt-3 text-xs text-gray-400">Model：{model}</p>}
        </section>
      </main>
    </div>
  );
}

export default function EssAiPage() {
  return (
    <EssTabGate tab="ai">
      <EssAiPageInner />
    </EssTabGate>
  );
}
