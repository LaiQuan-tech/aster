"use client";
import { useMemo, useState } from "react";
import { computeKpiTotal, type KpiReview, type KpiScore, type KpiTemplate } from "@/lib/kpi-api";

/**
 * 評分表單：admin（HR 代評）與 ess（考核者）共用。每個項目一列：分數 0–maxScore、評語。
 * 加權總分即時算（與後端同一條公式），送出前就看得到結果，避免「存了才發現算錯」。
 */
export function KpiScoreForm({
  review,
  template,
  readOnly,
  onSave,
  onSubmit,
}: {
  review: KpiReview;
  template: KpiTemplate | undefined;
  readOnly: boolean;
  onSave: (scores: KpiScore[]) => Promise<void>;
  onSubmit?: () => Promise<void>;
}) {
  const items = template?.items ?? [];
  const [scores, setScores] = useState<Record<string, { score: string; comment: string }>>(() => {
    const m: Record<string, { score: string; comment: string }> = {};
    for (const it of items) {
      const s = review.scores.find((x) => x.key === it.key);
      m[it.key] = { score: s ? String(s.score) : "", comment: s?.comment ?? "" };
    }
    return m;
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const asScores = (): KpiScore[] =>
    items
      .filter((it) => scores[it.key]?.score !== "")
      .map((it) => ({
        key: it.key,
        score: Number(scores[it.key].score),
        ...(scores[it.key].comment.trim() ? { comment: scores[it.key].comment.trim() } : {}),
      }));

  const total = useMemo(() => computeKpiTotal(items, asScores()), [scores, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const weightSum = items.reduce((s, it) => s + it.weight, 0);
  const invalid = items.some((it) => {
    const v = scores[it.key]?.score;
    if (v === "" || v === undefined) return false;
    const x = Number(v);
    return !Number.isFinite(x) || x < 0 || x > it.maxScore;
  });
  const incomplete = items.some((it) => (scores[it.key]?.score ?? "") === "");

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await onSave(asScores());
      setMsg("已儲存");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  if (!template) return <p className="text-sm text-red-600">找不到這份考核的範本（可能已被刪除）</p>;

  return (
    <div className="space-y-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-gray-500">
            <th className="py-1.5 pr-3">項目</th>
            <th className="py-1.5 pr-3 text-right">權重</th>
            <th className="py-1.5 pr-3 text-right">分數</th>
            <th className="py-1.5">評語</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.key} className="border-b last:border-0">
              <td className="py-1.5 pr-3 text-gray-800">{it.label}</td>
              <td className="py-1.5 pr-3 text-right text-gray-500">{it.weight}</td>
              <td className="py-1.5 pr-3 text-right">
                {readOnly ? (
                  <span>{scores[it.key]?.score || "—"} / {it.maxScore}</span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={it.maxScore}
                      step="0.5"
                      className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                      value={scores[it.key]?.score ?? ""}
                      onChange={(e) => setScores((m) => ({ ...m, [it.key]: { ...m[it.key], score: e.target.value } }))}
                    />
                    <span className="text-xs text-gray-400">/ {it.maxScore}</span>
                  </span>
                )}
              </td>
              <td className="py-1.5">
                {readOnly ? (
                  <span className="text-gray-600">{scores[it.key]?.comment || "—"}</span>
                ) : (
                  <input
                    className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
                    value={scores[it.key]?.comment ?? ""}
                    onChange={(e) => setScores((m) => ({ ...m, [it.key]: { ...m[it.key], comment: e.target.value } }))}
                    placeholder="選填"
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold text-gray-800">加權總分 {total}</span>
        {weightSum !== 100 && <span className="text-xs text-amber-700">（範本權重合計 {weightSum}，非 100，總分上限即 {weightSum}）</span>}
        {invalid && <span className="text-xs text-red-600">有分數超出範圍</span>}
        {!readOnly && (
          <>
            <button type="button" onClick={() => void save()} disabled={busy || invalid} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-50">
              儲存分數
            </button>
            {onSubmit && review.status === "draft" && (
              <button
                type="button"
                disabled={busy || invalid || incomplete}
                title={incomplete ? "每一項都要有分數才能送出" : undefined}
                onClick={async () => {
                  setBusy(true);
                  setMsg(null);
                  try {
                    await onSave(asScores());
                    await onSubmit();
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : "送出失敗");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: "var(--brand)" }}
              >
                儲存並送出
              </button>
            )}
          </>
        )}
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
      </div>
    </div>
  );
}
