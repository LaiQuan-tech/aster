"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { getProjectAlerts, getProjectAlertDigest, type ProjectAlert, type AlertSeverity } from "@/lib/projects-api";

/**
 * AI 進度示警。規則引擎（後端 services/project-alerts.ts）決定哪些案子要警告——
 * 可測、可解釋；AI 只負責把清單整理成一段話。每天 04:30 也會把急／注意等級的
 * 示警推進通知中心（lead 與 HR）。
 */
const SEV_LABEL: Record<AlertSeverity, string> = { high: "急", medium: "注意", low: "提醒" };
const SEV_CLS: Record<AlertSeverity, string> = {
  high: "border-red-200 bg-red-50",
  medium: "border-amber-200 bg-amber-50",
  low: "border-gray-200 bg-gray-50",
};
const SEV_BADGE: Record<AlertSeverity, string> = {
  high: "bg-red-600 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-gray-400 text-white",
};

export default function ProjectAlertsPage() {
  const [alerts, setAlerts] = useState<ProjectAlert[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [today, setToday] = useState("");
  const [aiAvailable, setAiAvailable] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AlertSeverity | "all">("all");

  useEffect(() => {
    getProjectAlerts()
      .then((r) => { setAlerts(r.alerts); setLabels(r.ruleLabels); setToday(r.today); setAiAvailable(r.aiAvailable); })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const counts = useMemo(() => ({
    high: alerts.filter((a) => a.severity === "high").length,
    medium: alerts.filter((a) => a.severity === "medium").length,
    low: alerts.filter((a) => a.severity === "low").length,
  }), [alerts]);
  const shown = filter === "all" ? alerts : alerts.filter((a) => a.severity === filter);
  const byProject = useMemo(() => {
    const m = new Map<string, ProjectAlert[]>();
    for (const a of shown) m.set(a.projectId, [...(m.get(a.projectId) ?? []), a]);
    return [...m.entries()];
  }, [shown]);

  async function runDigest() {
    setDigestBusy(true);
    setError(null);
    try {
      const r = await getProjectAlertDigest();
      setDigest(r.digest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 摘要失敗");
    } finally {
      setDigestBusy(false);
    }
  }

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "high", "medium", "low"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-sm ${filter === f ? "text-white" : "border border-gray-200 bg-white text-gray-600"}`}
              style={filter === f ? { backgroundColor: "var(--brand)" } : undefined}>
              {f === "all" ? `全部 ${alerts.length}` : `${SEV_LABEL[f]} ${counts[f]}`}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Link href="/admin/projects/overview" className="text-sm text-gray-500 hover:underline">專案總覽</Link>
            <PrimaryButton type="button" onClick={() => void runDigest()} disabled={digestBusy || !aiAvailable || alerts.length === 0}>
              {digestBusy ? "整理中…" : "AI 摘要今天該做的事"}
            </PrimaryButton>
          </div>
        </div>
        {!aiAvailable && <p className="mt-2 text-xs text-gray-400">未設定 GEMINI_API_KEY：規則示警照常，只是沒有 AI 摘要。</p>}
        {digest && (
          <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-4">
            <SimpleMarkdown text={digest} />
          </div>
        )}
      </Card>

      {alerts.length === 0 ? (
        <Card><Empty>沒有示警。所有進行中的專案都在軌道上。</Empty></Card>
      ) : shown.length === 0 ? (
        <Card><Empty>這個等級沒有示警</Empty></Card>
      ) : (
        byProject.map(([projectId, list]) => (
          <Card key={projectId}>
            <div className="mb-2 flex items-center justify-between">
              <Link href={`/admin/projects/${projectId}`} className="text-sm font-semibold text-gray-900 hover:underline">
                {list[0].projectCode ? `${list[0].projectCode} ` : ""}{list[0].projectName}
              </Link>
              <span className="text-xs text-gray-400">{list.length} 項</span>
            </div>
            <ul className="space-y-2">
              {list.map((a) => (
                <li key={a.key} className={`flex items-start gap-3 rounded-lg border p-3 ${SEV_CLS[a.severity]}`}>
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${SEV_BADGE[a.severity]}`}>{SEV_LABEL[a.severity]}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500">{labels[a.rule] ?? a.rule}</p>
                    <p className="text-sm text-gray-800">{a.message}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">規則</h2>
        <ul className="grid grid-cols-1 gap-1 text-xs text-gray-600 sm:grid-cols-2">
          <li><b>急</b>：逾期未請款、逾預定完工日未結案、已到期／結案仍有未請款金額</li>
          <li><b>注意</b>：7 天內到期的請款、開案 30 天無合約、有合約無請款期程、應貼印花稅 30 天未貼、60 天無動靜、停工 90 天</li>
          <li><b>提醒</b>：14 天內到預定完工日、未填起訖日</li>
          <li>封存的專案不掃描；門檻在 <code>services/project-alerts.ts</code> 的 ALERT_THRESHOLDS</li>
        </ul>
      </Card>
    </>
  );
}
