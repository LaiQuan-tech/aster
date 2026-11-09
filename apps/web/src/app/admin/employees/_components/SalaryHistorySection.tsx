"use client";

/**
 * 員工內頁「薪資」分頁的「調薪歷程」＋「勞健保調整歷程」（2026-11-10）。只是紀錄：不改目前本薪／級距、不影響薪資計算。
 *   • 存「員工薪資保險資料」時本薪或投保有變 → API 自動寫一筆（生效日／原因由 EmployeePayrollPanel 的對話框帶）
 *   • 「＋ 補登調薪紀錄」「＋ 補登投保調整」補歷史（紙本上的 114.3.26 投保薪資調整 33000 這類）
 *   • 投保調整紀錄可刪除（軟刪）；調薪紀錄的修改／刪除在「費用與給付 → 稅務」的調薪紀錄
 * 只給 HR（員工內頁 canManage；API requireHrAdmin）。
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button, ConfirmDialog, ErrorText } from "@/components/admin-ui";
import {
  addInsuredChange,
  addSalaryAdjustment,
  buildInsuredBackfill,
  buildSalaryBackfill,
  deleteInsuredChange,
  diffText,
  fmtAmount,
  fmtDateTime,
  getSalaryHistory,
  pairText,
  todayDateKey,
  type SalaryHistory,
} from "@/lib/salary-history";

const inputCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";
const thCls = "whitespace-nowrap px-2 py-1.5 text-left text-xs font-medium text-gray-500";
const tdCls = "whitespace-nowrap px-2 py-1.5 text-sm text-gray-700";

const EMPTY_SALARY = { effectiveDate: "", prevSalary: "", newSalary: "", reason: "" };
const EMPTY_INSURED = { effectiveOn: "", labor: "", health: "", pension: "", prevLabor: "", prevHealth: "", prevPension: "", note: "" };

export function SalaryHistorySection({ employeeId, reloadKey }: { employeeId: string; reloadKey: number }) {
  const [history, setHistory] = useState<SalaryHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSalaryForm, setShowSalaryForm] = useState(false);
  const [showInsuredForm, setShowInsuredForm] = useState(false);
  const [salaryForm, setSalaryForm] = useState(EMPTY_SALARY);
  const [insuredForm, setInsuredForm] = useState(EMPTY_INSURED);
  const [salaryError, setSalaryError] = useState<string | null>(null);
  const [insuredError, setInsuredError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const salaryPanelId = useId();
  const insuredPanelId = useId();

  const load = useCallback(async () => {
    if (!employeeId) return;
    try {
      setHistory(await getSalaryHistory(employeeId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "讀取歷程失敗");
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function onAddSalary(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildSalaryBackfill(salaryForm);
    if (!built.ok) return setSalaryError(built.error);
    setBusy(true);
    try {
      await addSalaryAdjustment(employeeId, built.body);
      setSalaryForm({ ...EMPTY_SALARY, effectiveDate: todayDateKey() });
      setSalaryError(null);
      await load();
    } catch (err) {
      setSalaryError(err instanceof Error ? err.message : "補登失敗");
    } finally {
      setBusy(false);
    }
  }

  async function onAddInsured(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildInsuredBackfill(insuredForm);
    if (!built.ok) return setInsuredError(built.error);
    setBusy(true);
    try {
      await addInsuredChange(employeeId, built.body);
      setInsuredForm({ ...EMPTY_INSURED, effectiveOn: todayDateKey() });
      setInsuredError(null);
      await load();
    } catch (err) {
      setInsuredError(err instanceof Error ? err.message : "補登失敗");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmDelete() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await deleteInsuredChange(employeeId, pendingDelete);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  const salaryRows = history?.salaryAdjustments ?? [];
  const insuredRows = history?.insuredChanges ?? [];
  const insuredAvailable = history?.available.insured !== false;

  return (
    <div className="mt-6 space-y-6" data-testid="salary-history">
      {loadError && <ErrorText>{loadError}</ErrorText>}

      {/* 調薪歷程 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium text-gray-600">調薪歷程</h3>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              setShowSalaryForm((open) => !open);
              setSalaryForm((f) => (f.effectiveDate ? f : { ...f, effectiveDate: todayDateKey() }));
            }}
            aria-expanded={showSalaryForm}
            aria-controls={salaryPanelId}
          >
            {showSalaryForm ? "收合" : "＋ 補登調薪紀錄"}
          </Button>
        </div>
        <div id={salaryPanelId} hidden={!showSalaryForm}>
          <form
            onSubmit={onAddSalary}
            onChange={() => setSalaryError(null)}
            className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-4"
          >
            <p className="text-xs text-gray-500 sm:col-span-4">只寫一筆歷史紀錄，不會改目前的本薪。</p>
            <div>
              <label className={labelCls}>生效日</label>
              <input type="date" className={inputCls} value={salaryForm.effectiveDate} onChange={(e) => setSalaryForm({ ...salaryForm, effectiveDate: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>原本薪（選填）</label>
              <input type="number" min={0} className={inputCls} value={salaryForm.prevSalary} onChange={(e) => setSalaryForm({ ...salaryForm, prevSalary: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>新本薪</label>
              <input type="number" min={0} className={inputCls} value={salaryForm.newSalary} onChange={(e) => setSalaryForm({ ...salaryForm, newSalary: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>原因（選填）</label>
              <input className={inputCls} maxLength={500} value={salaryForm.reason} onChange={(e) => setSalaryForm({ ...salaryForm, reason: e.target.value })} />
            </div>
            <div className="sm:col-span-4">
              <button type="submit" disabled={busy} className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50" style={{ color: "var(--brand)" }}>
                {busy ? "儲存中…" : "補登調薪紀錄"}
              </button>
            </div>
            {salaryError && <ErrorText className="sm:col-span-4">{salaryError}</ErrorText>}
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead>
              <tr>
                <th className={thCls}>生效日</th>
                <th className={thCls}>原本薪 → 新本薪</th>
                <th className={thCls}>差額</th>
                <th className={thCls}>原因</th>
                <th className={thCls}>登錄人</th>
                <th className={thCls}>登錄時間</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {salaryRows.map((r) => (
                <tr key={r.id} data-testid="salary-adjustment-row">
                  <td className={tdCls}>{r.effectiveDate}</td>
                  <td className={tdCls}>
                    {fmtAmount(r.prevSalary)} → {fmtAmount(r.newSalary)}
                  </td>
                  <td className={`${tdCls} ${r.diff !== null && r.diff < 0 ? "text-rose-600" : ""}`}>{diffText(r.diff)}</td>
                  <td className={`${tdCls} whitespace-normal`}>{r.reason ?? "—"}</td>
                  <td className={tdCls}>{r.createdByName ?? "—"}</td>
                  <td className={tdCls}>{fmtDateTime(r.createdAt)}</td>
                </tr>
              ))}
              {salaryRows.length === 0 && (
                <tr>
                  <td className={`${tdCls} text-gray-400`} colSpan={6}>
                    無
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 勞健保調整歷程 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-medium text-gray-600">勞健保調整歷程</h3>
          {insuredAvailable && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => {
                setShowInsuredForm((open) => !open);
                setInsuredForm((f) => (f.effectiveOn ? f : { ...f, effectiveOn: todayDateKey() }));
              }}
              aria-expanded={showInsuredForm}
              aria-controls={insuredPanelId}
            >
              {showInsuredForm ? "收合" : "＋ 補登投保調整"}
            </Button>
          )}
        </div>
        {!insuredAvailable && (
          <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">投保調整歷程資料表尚未套用（migration 0088），暫時無法記錄。</p>
        )}
        <div id={insuredPanelId} hidden={!showInsuredForm || !insuredAvailable}>
          <form
            onSubmit={onAddInsured}
            onChange={() => setInsuredError(null)}
            className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-4"
          >
            <p className="text-xs text-gray-500 sm:col-span-4">只寫一筆歷史紀錄，不會改目前的投保級距。調整後金額至少填一項；調整前可留空。</p>
            <div className="sm:col-span-4 sm:max-w-[25%]">
              <label className={labelCls}>生效日</label>
              <input type="date" className={inputCls} value={insuredForm.effectiveOn} onChange={(e) => setInsuredForm({ ...insuredForm, effectiveOn: e.target.value })} />
            </div>
            {(
              [
                ["勞保投保薪資", "prevLabor", "labor"],
                ["健保投保薪資", "prevHealth", "health"],
                ["勞退月提繳工資", "prevPension", "pension"],
              ] as const
            ).map(([label, prevKey, nextKey]) => (
              <div key={nextKey} className="grid grid-cols-2 gap-2 sm:col-span-4 sm:grid-cols-4">
                <div>
                  <label className={labelCls}>{label}（調整前）</label>
                  <input type="number" min={0} step={1} className={inputCls} value={insuredForm[prevKey]} onChange={(e) => setInsuredForm({ ...insuredForm, [prevKey]: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>{label}（調整後）</label>
                  <input type="number" min={0} step={1} className={inputCls} value={insuredForm[nextKey]} onChange={(e) => setInsuredForm({ ...insuredForm, [nextKey]: e.target.value })} />
                </div>
              </div>
            ))}
            <div className="sm:col-span-4">
              <label className={labelCls}>原因／備註（選填）</label>
              <input className={inputCls} maxLength={500} value={insuredForm.note} onChange={(e) => setInsuredForm({ ...insuredForm, note: e.target.value })} />
            </div>
            <div className="sm:col-span-4">
              <button type="submit" disabled={busy} className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50" style={{ color: "var(--brand)" }}>
                {busy ? "儲存中…" : "補登投保調整"}
              </button>
            </div>
            {insuredError && <ErrorText className="sm:col-span-4">{insuredError}</ErrorText>}
          </form>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead>
              <tr>
                <th className={thCls}>生效日</th>
                <th className={thCls}>勞保投保薪資</th>
                <th className={thCls}>健保投保薪資</th>
                <th className={thCls}>勞退月提繳工資</th>
                <th className={thCls}>原因／備註</th>
                <th className={thCls}>登錄人</th>
                <th className={thCls}>登錄時間</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {insuredRows.map((r) => (
                <tr key={r.id} data-testid="insured-change-row">
                  <td className={tdCls}>{r.effectiveOn}</td>
                  <td className={tdCls}>{pairText(r.labor)}</td>
                  <td className={tdCls}>{pairText(r.health)}</td>
                  <td className={tdCls}>{pairText(r.pension, "自動")}</td>
                  <td className={`${tdCls} whitespace-normal`}>{r.note ?? "—"}</td>
                  <td className={tdCls}>{r.createdByName ?? "—"}</td>
                  <td className={tdCls}>{fmtDateTime(r.createdAt)}</td>
                  <td className={tdCls}>
                    <button type="button" onClick={() => setPendingDelete(r.id)} className="text-red-600 hover:underline">
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
              {insuredRows.length === 0 && (
                <tr>
                  <td className={`${tdCls} text-gray-400`} colSpan={8}>
                    無
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="刪除這筆投保調整紀錄？"
        message="只刪除歷程紀錄，不會改目前的投保級距。"
        confirmLabel="刪除"
        danger
        busy={busy}
        onConfirm={() => void onConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
