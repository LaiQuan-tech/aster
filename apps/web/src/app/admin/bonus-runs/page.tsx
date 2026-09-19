"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { ItemsTable, SkippedList, Stat, StatusBadge } from "./_components";
import {
  createBonusRun,
  defaultBonusLabel,
  fmtMoney,
  getBonusSummary,
  humanizeBonusError,
  listBonusRuns,
  previewBonusRun,
  todayKey,
  type BonusRun,
  type BonusRunPreview,
  type BonusSummary,
} from "@/lib/bonus-api";

/**
 * 獎金季發放：歷年累計總表（只算已發放）＋批次列表＋「新增季批次」試算→建立草稿。
 * 規則：入帳幾成就發幾成、每季一批、草稿可改可刪、已發放凍結不可覆蓋（後端
 * services/bonus-run.ts 檔頭）。獎金池仍由專案頁人工填，這裡只做拆算與快照。
 */
export default function BonusRunsPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<BonusRun[]>([]);
  const [summary, setSummary] = useState<BonusSummary | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新增季批次
  const [showCreate, setShowCreate] = useState(false);
  const [fLabel, setFLabel] = useState("");
  const [fAsOf, setFAsOf] = useState("");
  const [fNote, setFNote] = useState("");
  const [preview, setPreview] = useState<BonusRunPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (y: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const [list, sum] = await Promise.all([listBonusRuns(), getBonusSummary({ year: y })]);
      setRuns(list.runs);
      setSummary(sum.summary);
    } catch (err) {
      setError(humanizeBonusError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(year);
  }, [load, year]);

  const yearOptions = useMemo(() => {
    const ys = new Set<number>(summary?.years ?? []);
    ys.add(Number(todayKey().slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [summary]);

  function openCreate() {
    const today = todayKey();
    setFLabel(defaultBonusLabel(today));
    setFAsOf(today);
    setFNote("");
    setPreview(null);
    setFormError(null);
    setShowCreate(true);
  }

  async function runPreview() {
    setPreviewing(true);
    setFormError(null);
    try {
      const p = await previewBonusRun({ asOf: fAsOf, label: fLabel.trim() || undefined });
      setPreview(p);
      if (!fLabel.trim()) setFLabel(p.label);
    } catch (err) {
      setFormError(humanizeBonusError(err, "試算失敗"));
    } finally {
      setPreviewing(false);
    }
  }

  async function submitCreate() {
    if (!fLabel.trim() || !fAsOf) {
      setFormError("期別與基準日必填");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const detail = await createBonusRun({ asOf: fAsOf, label: fLabel.trim(), note: fNote.trim() || null });
      router.push(`/admin/bonus-runs/${detail.run.id}`);
    } catch (err) {
      setFormError(humanizeBonusError(err, "建立失敗"));
      setCreating(false);
    }
  }

  const cmp = summary?.comparison ?? null;

  return (
    <div className="space-y-4">
      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      {/* ── 歷年累計總表 ─────────────────────────────────────────── */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-gray-800">歷年累計總表（只計已發放）</h2>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            年度
            <select className={`${inputCls} w-auto`} value={year ?? ""} onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}>
              <option value="">全部</option>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading && !summary ? (
          <Empty>載入中…</Empty>
        ) : !summary || summary.byQuarter.length === 0 ? (
          <Empty>{year ? `${year} 年` : "目前"}還沒有已發放的批次</Empty>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label={year ? `${year} 年發放合計` : "全部年度發放合計"} value={`${fmtMoney(summary.yearTotal)} 元`} />
              <Stat label="歷年累計" value={`${fmtMoney(summary.allTimeTotal)} 元`} />
              <Stat label={cmp?.latest ? `最近一期 ${cmp.latest.label}` : "最近一期"} value={cmp?.latest ? `${fmtMoney(cmp.latest.amount)} 元` : "—"} />
              <Stat
                label={cmp?.previous ? `較上季 ${cmp.previous.label}` : "較上季"}
                value={cmp?.delta == null ? "—" : `${cmp.delta >= 0 ? "+" : "−"}${fmtMoney(Math.abs(cmp.delta))} 元${cmp.deltaPct == null ? "" : `（${cmp.deltaPct >= 0 ? "+" : ""}${cmp.deltaPct}%）`}`}
                tone={cmp?.delta == null ? undefined : cmp.delta >= 0 ? "up" : "down"}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-x-auto">
                <p className="mb-1 text-xs font-medium text-gray-500">各季發放</p>
                <table className="w-full whitespace-nowrap text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-gray-500">
                      <th className="py-1.5 pr-2">期別</th>
                      <th className="py-1.5 pr-2">發放日</th>
                      <th className="py-1.5 pr-2 text-right">金額</th>
                      <th className="py-1.5 pr-2 text-right">人數</th>
                      <th className="py-1.5 pr-2 text-right">案數</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byQuarter.map((q) => (
                      <tr key={q.runId} className="border-b last:border-0">
                        <td className="py-1.5 pr-2">
                          <Link href={`/admin/bonus-runs/${q.runId}`} className="font-medium" style={{ color: "var(--brand)" }}>
                            {q.label}
                          </Link>
                        </td>
                        <td className="py-1.5 pr-2 text-gray-600">{q.paidOn ?? "—"}</td>
                        <td className="py-1.5 pr-2 text-right font-medium text-gray-900">{fmtMoney(q.amount)}</td>
                        <td className="py-1.5 pr-2 text-right text-gray-600">{q.employeeCount}</td>
                        <td className="py-1.5 pr-2 text-right text-gray-600">{q.projectCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto">
                <p className="mb-1 text-xs font-medium text-gray-500">各員工累計{cmp?.latest && cmp.previous ? `（含 ${cmp.latest.label} vs ${cmp.previous.label}）` : ""}</p>
                <table className="w-full whitespace-nowrap text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-gray-500">
                      <th className="py-1.5 pr-2">員工</th>
                      <th className="py-1.5 pr-2 text-right">{year ? `${year} 年` : "本期範圍"}</th>
                      <th className="py-1.5 pr-2 text-right">歷年累計</th>
                      <th className="py-1.5 pr-2 text-right">較上季</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byEmployee.map((e) => {
                      const c = cmp?.byEmployee.find((x) => x.employeeId === e.employeeId);
                      return (
                        <tr key={e.employeeId} className="border-b last:border-0">
                          <td className="py-1.5 pr-2 text-gray-800">
                            {e.employeeName ?? e.employeeId}
                            {e.empNo && <span className="ml-1 text-xs text-gray-400">{e.empNo}</span>}
                          </td>
                          <td className="py-1.5 pr-2 text-right font-medium text-gray-900">{fmtMoney(e.amountYear)}</td>
                          <td className="py-1.5 pr-2 text-right text-gray-600">{fmtMoney(e.amountAllTime)}</td>
                          <td className={`py-1.5 pr-2 text-right ${c ? (c.delta >= 0 ? "text-emerald-700" : "text-red-600") : "text-gray-400"}`}>
                            {c ? `${c.delta >= 0 ? "+" : "−"}${fmtMoney(Math.abs(c.delta))}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* ── 批次列表 ─────────────────────────────────────────────── */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-gray-800">發放批次</h2>
          <PrimaryButton onClick={openCreate}>＋ 新增季批次</PrimaryButton>
        </div>
        {loading && runs.length === 0 ? (
          <Empty>載入中…</Empty>
        ) : runs.length === 0 ? (
          <Empty>還沒有任何批次。按「＋ 新增季批次」試算本季應發。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-1.5 pr-2">期別</th>
                  <th className="py-1.5 pr-2">狀態</th>
                  <th className="py-1.5 pr-2">基準日</th>
                  <th className="py-1.5 pr-2">發放日</th>
                  <th className="py-1.5 pr-2 text-right">本季應發</th>
                  <th className="py-1.5 pr-2 text-right">人數</th>
                  <th className="py-1.5 pr-2 text-right">案數</th>
                  <th className="py-1.5 pr-2 text-right">超發</th>
                  <th className="py-1.5 pr-2">備註</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">
                      <Link href={`/admin/bonus-runs/${r.id}`} className="font-medium" style={{ color: "var(--brand)" }}>
                        {r.label}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-1.5 pr-2 text-gray-600">{r.asOf}</td>
                    <td className="py-1.5 pr-2 text-gray-600">{r.paidOn ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right font-medium text-gray-900">{fmtMoney(r.totals.amount)}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{r.totals.employeeCount}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{r.totals.projectCount}</td>
                    <td className={`py-1.5 pr-2 text-right ${r.totals.overpaidCount > 0 ? "font-medium text-red-600" : "text-gray-400"}`}>
                      {r.totals.overpaidCount > 0 ? `${r.totals.overpaidCount} 列` : "—"}
                    </td>
                    <td className="max-w-[16rem] truncate py-1.5 pr-2 text-gray-500">{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── 新增季批次（試算 → 建立草稿）─────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={() => !creating && setShowCreate(false)}>
          <div className="my-6 w-full max-w-5xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">新增季批次</h3>
              <button type="button" className="text-sm text-gray-500 hover:text-gray-700" onClick={() => setShowCreate(false)} disabled={creating}>
                關閉
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className={labelCls}>期別（同期別只能一筆）</label>
                <input className={inputCls} value={fLabel} onChange={(e) => setFLabel(e.target.value)} placeholder="2026-Q3" />
              </div>
              <div>
                <label className={labelCls}>試算基準日（入帳截至）</label>
                <input type="date" className={inputCls} value={fAsOf} onChange={(e) => setFAsOf(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>備註</label>
                <input className={inputCls} value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="例：中秋節前發" />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 md:rounded-md"
                onClick={runPreview}
                disabled={previewing || !fAsOf}
              >
                {previewing ? "試算中…" : "試算（不寫入）"}
              </button>
              <PrimaryButton onClick={submitCreate} disabled={creating || !preview}>
                {creating ? "建立中…" : "建立草稿"}
              </PrimaryButton>
              <span className="text-xs text-gray-500">先試算看數字，確認後建立草稿；草稿仍可改基準日重算、可刪。</span>
            </div>
            <div className="mt-2">
              <ErrorText>{formError}</ErrorText>
            </div>

            {preview && (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="本季應發合計" value={`${fmtMoney(preview.totals.amount)} 元`} />
                  <Stat label="人數／案數" value={`${preview.totals.employeeCount} 人／${preview.totals.projectCount} 案`} />
                  <Stat label="累計應發／已發" value={`${fmtMoney(preview.totals.entitledCumulative)}／${fmtMoney(preview.totals.paidBefore)}`} />
                  <Stat label="超發列" value={preview.totals.overpaidCount > 0 ? `${preview.totals.overpaidCount} 列` : "無"} tone={preview.totals.overpaidCount > 0 ? "down" : undefined} />
                </div>
                <ItemsTable items={preview.items} />
                <SkippedList skipped={preview.totals.skipped.map((s) => ({ ...s, ...(preview.snapshot.skipped ?? []).find((x) => x.projectId === s.projectId) }))} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
