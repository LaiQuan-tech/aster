"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { ExcludedArchivedList, GrossProfitTable, ItemsTable, SkippedList, Stat, StatusBadge, WarningsList } from "../bonus-runs/_components";
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
 * 「獎金分潤」分頁上半部（原「獎金季發放」頁，2026-10-27 業主併入獎金分潤）：
 *   • 儀表板：歷年累計（只算已發放）——年度合計／歷年累計／最近一期／較上季，與各員工累計（年度篩選只影響儀表板）。
 *   • 發放批次：所有批次與狀態（草稿／待核准／已核准／已發放、沖銷），點期別進批次明細（送審、核准／退回、撤回、
 *     標記發放、匯出都在明細頁）；「＋ 新增季批次」試算→建立草稿。
 *     原儀表板的「各季發放」表（只列已發放）與這張清單重複，已拿掉——已發放的批次在這裡都看得到發放日、金額、人數、案數。
 *   • `onShowInSheet`（看得到總表的人才有）：每列「在總表看」把下方公司格式切到這一批；`shownRunId`＝目前總表顯示的批次，該列標示出來。
 * 規則：入帳幾成就發幾成、每季一批、草稿可改可刪、已發放凍結不可覆蓋（後端 services/bonus-run.ts 檔頭）。
 * 獎金池仍由專案頁人工填，這裡只做拆算與快照。API 是 requireHrAdmin；毛利類欄位依 canSeeProfit 遮罩（後端處理）。
 */
export function BonusRunsSection({
  shownRunId = null,
  onShowInSheet,
}: {
  shownRunId?: string | null;
  onShowInSheet?: (runId: string) => void;
}) {
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
    <div className="no-print space-y-4">
      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      {/* ── 歷年累計總表 ─────────────────────────────────────────── */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-gray-800">季發放儀表板（只計已發放）</h2>
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
            <div>
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
          <div>
            <h2 className="text-base font-semibold text-gray-800">發放批次</h2>
            <p className="text-xs text-gray-500">點期別或「批次明細」進去送審、核准／退回、撤回、標記發放與匯出 Excel{onShowInSheet ? "；「在總表看」把下方公司格式切到這一批" : ""}。</p>
          </div>
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
                  <th className="py-1.5 pr-2 text-right">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={`border-b last:border-0 ${r.id === shownRunId ? "bg-sky-50/70" : ""}`} aria-current={r.id === shownRunId ? "true" : undefined}>
                    <td className="py-1.5 pr-2">
                      <Link href={`/admin/bonus-runs/${r.id}`} className="font-medium" style={{ color: "var(--brand)" }}>
                        {r.label}
                      </Link>
                      {r.kind === "reversal" && <span className="ml-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-700">沖銷</span>}
                      {r.reversedByRunId && (
                        <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                          {r.reversedByStatus === "paid" ? "已沖銷" : "沖銷中"}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-1.5 pr-2 text-gray-600">{r.asOf}</td>
                    <td className="py-1.5 pr-2 text-gray-600">{r.paidOn ?? "—"}</td>
                    <td className={`py-1.5 pr-2 text-right font-medium ${r.totals.amount < 0 ? "text-rose-700" : "text-gray-900"}`}>{fmtMoney(r.totals.amount)}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{r.totals.employeeCount}</td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{r.totals.projectCount}</td>
                    <td className={`py-1.5 pr-2 text-right ${r.totals.overpaidCount > 0 ? "font-medium text-red-600" : "text-gray-400"}`}>
                      {r.totals.overpaidCount > 0 ? `${r.totals.overpaidCount} 列` : "—"}
                    </td>
                    <td className="max-w-[16rem] truncate py-1.5 pr-2 text-gray-500">{r.note ?? ""}</td>
                    <td className="py-1.5 pr-2 text-right">
                      <div className="flex justify-end gap-3 text-xs">
                        {onShowInSheet &&
                          (r.id === shownRunId ? (
                            <span className="text-sky-700">總表顯示中</span>
                          ) : (
                            <button type="button" className="underline-offset-2 hover:underline" style={{ color: "var(--brand)" }} onClick={() => onShowInSheet(r.id)}>
                              在總表看
                            </button>
                          ))}
                        <Link href={`/admin/bonus-runs/${r.id}`} className="underline-offset-2 hover:underline" style={{ color: "var(--brand)" }}>
                          批次明細
                        </Link>
                      </div>
                    </td>
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
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowCreate(false)} disabled={creating}>關閉</Button>
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
                <WarningsList warnings={preview.snapshot.warnings ?? preview.totals.warnings} />
                {/* 毛利表與獎金比例欄只給看得到集團財務的人（2026-10-26）；其他 HR 照常試算、建立、送審。 */}
                {preview.canSeeProfit !== false && <GrossProfitTable items={preview.items} />}
                <ItemsTable items={preview.items} label={fLabel} canSeeProfit={preview.canSeeProfit !== false} />
                <SkippedList skipped={preview.totals.skipped.map((s) => ({ ...s, ...(preview.snapshot.skipped ?? []).find((x) => x.projectId === s.projectId) }))} />
                <ExcludedArchivedList snapshot={preview.snapshot} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
