"use client";

import { useEffect, useState } from "react";
import { Card, PrimaryButton, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import {
  askAiQuestion,
  generateAiReportSummary,
  getDepartments,
  type Department,
} from "@/lib/admin-api";

const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);
const monthStart = `${month}-01`;

export default function AdminAiPage() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState(month);
  const [deptId, setDeptId] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [question, setQuestion] = useState("這個月有哪些出勤風險需要 HR 優先處理？");
  const [summary, setSummary] = useState("");
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState<"summary" | "ask" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => null);
  }, []);

  async function runSummary() {
    setError(null);
    setLoading("summary");
    try {
      const res = await generateAiReportSummary({ from, to, period, deptId: deptId || undefined });
      setSummary(res.summary);
      setModel(res.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : "產生 AI 月報失敗");
    } finally {
      setLoading(null);
    }
  }

  async function runAsk() {
    setError(null);
    setLoading("ask");
    try {
      const res = await askAiQuestion({ question, from, to, period });
      setAnswer(res.answer);
      setModel(res.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 問答失敗");
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      {error && <ErrorText>{error}</ErrorText>}

      <Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className={labelCls}>資料區間（起）</label>
            <input className={inputCls} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>資料區間（迄）</label>
            <input className={inputCls} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>薪資年月</label>
            <input className={inputCls} type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>月報單位</label>
            <select className={inputCls} value={deptId} onChange={(event) => setDeptId(event.target.value)}>
              <option value="">全部單位</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>{department.name}</option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">AI 自動月報</h2>
              <p className="mt-1 text-sm text-gray-500">彙整出勤、請假/表單、薪資、人力、異常與通知。</p>
            </div>
            <PrimaryButton onClick={() => void runSummary()} disabled={loading !== null}>
              {loading === "summary" ? "產生中…" : "產生月報"}
            </PrimaryButton>
          </div>
          <pre className="mt-4 min-h-64 whitespace-pre-wrap rounded-xl bg-slate-950 p-4 text-sm leading-6 text-slate-100">
            {summary || "尚未產生。"}
          </pre>
        </Card>

        <Card>
          <div>
            <h2 className="text-base font-semibold text-gray-900">AI 資料問答</h2>
            <p className="mt-1 text-sm text-gray-500">可詢問：遲到風險、加班偏高、請假趨勢、薪資總額、人力分布。</p>
          </div>
          <textarea
            className={`${inputCls} mt-4 min-h-28`}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="mt-3">
            <PrimaryButton onClick={() => void runAsk()} disabled={loading !== null || !question.trim()}>
              {loading === "ask" ? "回答中…" : "詢問 AI"}
            </PrimaryButton>
          </div>
          <pre className="mt-4 min-h-52 whitespace-pre-wrap rounded-xl bg-gray-50 p-4 text-sm leading-6 text-gray-700">
            {answer || "AI 回答會顯示在這裡。"}
          </pre>
        </Card>
      </div>

      {model && <p className="text-xs text-gray-400">Model：{model}</p>}
    </>
  );
}
