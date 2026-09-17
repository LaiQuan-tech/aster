"use client";

import { useState } from "react";
import { Button, Card, Field, InlineError, Input, Textarea } from "@/components/ess-ui";
import { askAiQuestion } from "@/lib/ess-api";

const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);
const monthStart = `${month}-01`;

export default function EssAiPage() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState(month);
  const [question, setQuestion] = useState("我這個月的出勤、請假或薪資有什麼需要注意？");
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        員工問答只會使用你的個人差勤、表單、薪資單與通知資料；不會揭露其他員工資料。
      </p>

      {error && <InlineError>{error}</InlineError>}

      <Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="區間起" htmlFor="ai-from">
            <Input id="ai-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="區間迄" htmlFor="ai-to">
            <Input id="ai-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field label="薪資年月" htmlFor="ai-period">
            <Input id="ai-period" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="想問什麼？" htmlFor="ai-question">
            <Textarea
              id="ai-question"
              className="min-h-32"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </Field>
        </div>
        <Button
          onClick={() => void ask()}
          disabled={!question.trim()}
          loading={loading}
          className="mt-3 w-full sm:w-auto"
        >
          {loading ? "回答中…" : "詢問 AI"}
        </Button>
      </Card>

      <Card title="回答">
        <pre className="min-h-52 whitespace-pre-wrap rounded-xl bg-gray-50 p-4 text-sm leading-6 text-gray-700">
          {answer || "AI 回答會顯示在這裡。"}
        </pre>
        {model && <p className="mt-3 text-xs text-gray-400">Model：{model}</p>}
      </Card>
    </div>
  );
}
