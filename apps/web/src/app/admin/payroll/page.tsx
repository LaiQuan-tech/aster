"use client";

/**
 * 後台「月結發薪」（2026-11-09 業主核准：原「薪資資料與執行」/admin/payroll 與「薪資單」/admin/payslips 合併成一頁）。
 * 一頁看到當月每位員工還有什麼沒就緒，在列表逐一處理，全部就緒才「完成 YYYY-MM 發薪並鎖定」。
 *
 *   - 頂部：月份；步驟條 ①檢查待辦 ②執行薪資 ③核對並定案 ④寄送薪資條 ⑤鎖定（lib/payroll-month-api.ts stepViews）；
 *     合計卡（原薪資單頁）；「執行薪資（全部）」「全部定案」「批次寄送 Email」「匯出工資清冊 CSV」（原邏輯與錯誤處理，
 *     含 anomalies_unacknowledged／period_closed 等閘門訊息）。
 *   - 員工清單（GET /payroll-periods/:period/employees；可搜尋、篩選 全部／未就緒／已就緒／有提醒）：
 *     待簽申請、出勤月表、遲到說明、核銷／報銷、薪資單（狀態＋實發）。點選 → 明細面板（_components/EmployeeMonthPanel）。
 *   - 底部：鎖定區（_components/PeriodLockCard：未全過時按鈕停用並列出卡在誰、哪一項；重新開放與權限照舊；最近 12 個月收合）、
 *     薪資加減項（前期更正，#payroll-adjustments）、工資清冊明細（原薪資單頁的全表，收合）。
 *   - 員工薪資保險資料（基本薪資、投保、勞退、固定津貼、健保眷屬、扶養親屬）搬到員工內頁的「薪資」分頁
 *     （/admin/employees/[id]?tab=salary）。
 *   - 網址：?period=YYYY-MM&employee=<id>；舊網址 /admin/payslips（帶 period）由 next.config 轉址過來。
 * 權限：HR／平台管理員（逐人列表與檢查清單 API 為 requireHrAdmin；會計的導覽看不到這頁）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, ErrorText, Input, Segmented } from "@/components/admin-ui";
import { apiDownload, apiErrorMessage } from "@/lib/api-client";
import { finalizePayslip, getEmployees, getPayslips, runPayroll, type Employee } from "@/lib/admin-api";
import { sendPayslip, sendPayslipsBatch } from "@/lib/cash-payouts-api";
import { getMeCached } from "@/lib/ess-state";
import { payrollGateText } from "@/lib/payroll-gate";
import {
  ROSTER_FILTER_LABEL,
  filterRoster,
  getPeriodEmployees,
  lateCell,
  lockBlockersOf,
  payslipCell,
  requestsCell,
  rosterCounts,
  rosterLabel,
  settlementCell,
  sheetCell,
  stepViews,
  type Cell,
  type PeriodEmployeesResponse,
  type RosterFilter,
} from "@/lib/payroll-month-api";
import { payrollPeriodErrorMessage } from "@/lib/payroll-periods-api";
import { errorMessageOf } from "@/lib/period-closed";
import { EmployeeMonthPanel } from "./_components/EmployeeMonthPanel";
import { PayrollAdjustmentsCard } from "./_components/PayrollAdjustmentsCard";
import { PeriodLockCard } from "./_components/PeriodLockCard";
import { SEND_SKIP_LABEL, money, payslipTotalsOf, PayslipLedgerTable, type PayslipRow } from "./_components/payslip-bits";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function readUrl(): { period: string | null; employee: string | null } {
  if (typeof window === "undefined") return { period: null, employee: null };
  const q = new URLSearchParams(window.location.search);
  const period = q.get("period");
  return { period: period && PERIOD_RE.test(period) ? period : null, employee: q.get("employee") };
}

function writeUrl(period: string, employee: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set("period", period);
  if (employee) url.searchParams.set("employee", employee);
  else url.searchParams.delete("employee");
  window.history.replaceState(window.history.state, "", url.toString());
}

const TONE_CLASS: Record<Cell["tone"], string> = {
  ok: "text-gray-500",
  warn: "text-amber-700",
  bad: "text-red-700 font-medium",
  none: "text-gray-300",
};
const DOT_CLASS: Record<Cell["tone"], string> = {
  ok: "bg-green-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  none: "bg-gray-200",
};

function CellView({ cell }: { cell: Cell }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${TONE_CLASS[cell.tone]}`}>
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[cell.tone]}`} aria-hidden />
      {cell.text}
    </span>
  );
}

export default function PayrollMonthPage() {
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [data, setData] = useState<PeriodEmployeesResponse | null>(null);
  const [payslips, setPayslips] = useState<PayslipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [lockKey, setLockKey] = useState(0);
  const [adjFocus, setAdjFocus] = useState<{ employeeId: string; period: string; nonce: number } | null>(null);

  // 網址 → 初始月份與員工（舊網址 /admin/payslips?period= 轉過來也吃得到）。
  useEffect(() => {
    const u = readUrl();
    if (u.period) setPeriod(u.period);
    if (u.employee) setSelectedId(u.employee);
    setUrlReady(true);
  }, []);
  useEffect(() => {
    if (urlReady) writeUrl(period, selectedId);
  }, [period, selectedId, urlReady]);

  useEffect(() => {
    getEmployees()
      .then((r) => setEmployees(r.employees))
      .catch((err) => setError(err instanceof Error ? err.message : "載入員工失敗"));
    getMeCached()
      .then((me) => setMeId(me.id))
      .catch(() => setMeId(null));
  }, []);

  const load = useCallback(async () => {
    if (!urlReady) return;
    setLoading(true);
    try {
      const [list, slips] = await Promise.all([getPeriodEmployees(period), getPayslips(period)]);
      setData(list);
      setPayslips(slips.payslips as PayslipRow[]);
      setError(null);
    } catch (err) {
      setError(payrollPeriodErrorMessage(err, "載入月結資料失敗"));
    } finally {
      setLoading(false);
    }
  }, [period, urlReady]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 任何動作之後：重抓逐人列表、薪資單、鎖定卡、加減項卡。 */
  const afterChange = useCallback(() => {
    void load();
    setLockKey((k) => k + 1);
    setRefreshKey((k) => k + 1);
  }, [load]);

  const empName = useCallback(
    (id: string) => {
      const e = employees.find((x) => x.id === id);
      if (e) return e.emp_no ? `${e.emp_no} · ${e.name}` : e.name;
      const r = data?.employees.find((x) => x.employeeId === id);
      return r ? rosterLabel(r) : id.slice(0, 8);
    },
    [employees, data],
  );

  const rows = useMemo(() => data?.employees ?? [], [data]);
  const visible = useMemo(() => filterRoster(rows, filter, keyword), [rows, filter, keyword]);
  const counts = useMemo(() => rosterCounts(rows), [rows]);
  const steps = useMemo(() => stepViews(rows, data?.status ?? null), [rows, data]);
  const blockers = useMemo(() => (data ? lockBlockersOf(rows) : null), [data, rows]);
  const totals = useMemo(() => payslipTotalsOf(payslips), [payslips]);
  const ledgerRows = useMemo(
    () => [...payslips].sort((a, b) => empName(a.employee_id).localeCompare(empName(b.employee_id))),
    [payslips, empName],
  );
  const selected = rows.find((r) => r.employeeId === selectedId) ?? null;
  const selectedSlip = selected ? (payslips.find((p) => p.employee_id === selected.employeeId) ?? null) : null;
  const locked = data?.status === "closed";

  function pick(id: string) {
    setSelectedId(id);
    // 手機：面板在清單下方，捲過去。
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1023px)").matches) {
        document.getElementById("payroll-employee-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  /* -------------------------------------------------------- 全體動作 --- */

  async function runAll() {
    if (busy) return;
    setRunMsg(null);
    setBusy(true);
    try {
      const result = await runPayroll(period);
      // 遲到說明老闆還沒決定的人（視為影響全勤）一併提醒（2026-10-11）。
      const lateWarnings = (result.warnings ?? []).map((w) => `${empName(w.employeeId)} ${w.message}`);
      // 併進薪資單的一次性加減項（前期更正）筆數（API 回 adjustmentCount；舊版 API 沒有就不顯示）。
      const adjustmentCount = (result as { adjustmentCount?: number }).adjustmentCount ?? 0;
      // 適用勞退新制卻算不出提繳工資的人；底薪＋計入投保的固定津貼高於勞保級距的人（系統不自動改級距，只提醒）。
      const missingPension = (result as { missingPensionWage?: string[] }).missingPensionWage ?? [];
      const insuredReview =
        (result as { insuredSalaryReview?: Array<{ employeeId: string; total: number; laborInsuredSalary: number | null }> })
          .insuredSalaryReview ?? [];
      setRunMsg({
        ok: true,
        text:
          `已執行 ${period} 薪資作業：產生 ${result.generated} 筆，略過已定案 ${result.skipped.length} 筆` +
          (adjustmentCount > 0 ? `；含加減項（前期更正）${adjustmentCount} 筆` : "") +
          (missingPension.length > 0
            ? `；算不出勞退提繳工資（雇主提撥與自提為 0，請到員工內頁的「薪資」分頁手填）：${missingPension.map((id) => empName(id)).join("、")}`
            : "") +
          (insuredReview.length > 0
            ? `；請確認投保級距（底薪＋計入投保的固定津貼高於勞保級距）：${insuredReview
                .map((r) => `${empName(r.employeeId)} ${r.total.toLocaleString("zh-TW")}／級距 ${r.laborInsuredSalary == null ? "未設定" : r.laborInsuredSalary.toLocaleString("zh-TW")}`)
                .join("、")}`
            : "") +
          (lateWarnings.length > 0 ? `；提醒：${lateWarnings.join("；")}` : ""),
      });
      afterChange();
    } catch (err) {
      // 已發薪鎖定 → 409 period_closed；月表還有 error 級、沒填說明的日異常 → 409 anomalies_unacknowledged（列出待處理項目）。
      setRunMsg({ ok: false, text: payrollGateText(err, empName) ?? errorMessageOf(err, "執行失敗") });
    } finally {
      setBusy(false);
    }
  }

  async function finalizeAll() {
    const drafts = payslips.filter((p) => p.status !== "finalized");
    if (drafts.length === 0) return;
    if (!confirm(`確定將 ${period} 的 ${drafts.length} 張草稿全部定案？定案後不可再重算。`)) return;
    setBusy(true);
    let current: PayslipRow | null = null;
    try {
      for (const p of drafts) {
        current = p;
        await finalizePayslip(p.id);
      }
      afterChange();
    } catch (err) {
      // 已定案成功的那幾張要看得到：先重新載入，再顯示失敗訊息（帶上是哪一位；例如 409 adjustments_stale＝加減項有異動，
      // 要先重新執行薪資）。顯示 API 的中文說明，不是代碼。
      afterChange();
      setError(`${current ? `${empName(current.employee_id)}：` : ""}${apiErrorMessage(err, "定案失敗")}`);
    } finally {
      setBusy(false);
    }
  }

  /** 寄送失敗：優先顯示 API 附的中文說明（例如 409 mail_not_configured），沒有才退回代碼。 */
  function describeSendError(err: unknown, fallback: string): string {
    const msg = apiErrorMessage(err, fallback);
    return msg === fallback ? msg : `${fallback}：${msg}`;
  }

  /** 批次寄送：只寄已定案的，未寄成功的逐筆列出原因。 */
  async function sendBatch() {
    const finalized = payslips.filter((p) => p.status === "finalized");
    if (finalized.length === 0) return;
    if (!confirm(`確定把 ${period} 的 ${finalized.length} 張已定案薪資單寄給本人？`)) return;
    setBusy(true);
    setSendMsg(null);
    try {
      const res = await sendPayslipsBatch(period);
      const skipped = res.skipped.filter((s) => s.reason !== "not_finalized");
      setSendMsg(
        `已寄出 ${res.sent} 張` +
          (skipped.length > 0
            ? `；未寄出 ${skipped.length} 張（${skipped.map((s) => `${empName(s.employeeId)}：${SEND_SKIP_LABEL[s.reason] ?? s.reason}`).join("、")}）`
            : ""),
      );
      afterChange();
      setError(null);
    } catch (err) {
      setError(describeSendError(err, "批次寄送失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function finalizeOne(id: string) {
    setBusy(true);
    try {
      await finalizePayslip(id);
      afterChange();
    } catch (err) {
      setError(apiErrorMessage(err, "定案失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function sendOne(p: PayslipRow) {
    setBusy(true);
    try {
      await sendPayslip(p.id);
      afterChange();
      setError(null);
    } catch (err) {
      setError(describeSendError(err, "寄送失敗"));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------- 畫面 --- */

  return (
    <div className="min-w-0 space-y-4">
      {error && <ErrorText>{error}</ErrorText>}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs font-medium text-gray-500">
            發薪月份
            <Input
              type="month"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              className="mt-1 w-40"
              data-testid="payroll-period"
            />
          </label>
          <Button onClick={() => void runAll()} disabled={busy || locked} data-testid="payroll-run-all">
            執行薪資（全部）
          </Button>
          <Button variant="secondary" onClick={() => void finalizeAll()} disabled={busy || totals.draft === 0}>
            全部定案（{totals.draft}）
          </Button>
          <Button
            variant="secondary"
            onClick={() => void sendBatch()}
            disabled={busy || totals.finalized === 0}
            title="把本期已定案的薪資單寄到每位同仁的公司信箱（無則個人信箱／登入信箱）"
          >
            批次寄送 Email（{totals.finalized}）
          </Button>
          <Button
            variant="secondary"
            onClick={() => apiDownload(`/reports/payroll?period=${period}&format=csv`, `工資清冊_${period}.csv`).catch((e) => setError(e.message))}
          >
            匯出工資清冊 CSV
          </Button>
        </div>
        {runMsg && (
          <p role={runMsg.ok ? "status" : "alert"} className={`mt-3 break-words text-sm ${runMsg.ok ? "text-green-700" : "text-red-600"}`}>
            {runMsg.text}
          </p>
        )}
        {sendMsg && <p className="mt-2 break-words text-sm text-gray-600">{sendMsg}</p>}
        {locked && <p className="mt-2 text-sm text-green-700">{period} 已完成發薪並鎖定；要改請由老闆或老闆指定的人在下方重新開放。</p>}

        <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="payroll-steps">
          {steps.map((s) => (
            <li
              key={s.key}
              className={`min-w-0 rounded-xl border px-3 py-2 ${s.done ? "border-green-200 bg-green-50/60" : "border-gray-200 bg-white"}`}
            >
              <p className={`text-xs font-medium ${s.done ? "text-green-700" : "text-gray-500"}`}>
                {"①②③④⑤"[s.no - 1]} {s.label}
              </p>
              <p className={`mt-0.5 text-sm font-semibold tabular-nums ${s.done ? "text-green-800" : "text-gray-900"}`}>{loading && !data ? "…" : s.progress}</p>
            </li>
          ))}
        </ol>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">應發合計</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{money(totals.gross)}</p>
          </div>
          <div className="rounded-xl bg-rose-50 p-3">
            <p className="text-xs text-rose-600">應扣合計</p>
            <p className="mt-1 text-lg font-semibold text-rose-700">{money(totals.deductions)}</p>
          </div>
          <div className="rounded-xl bg-emerald-50 p-3">
            <p className="text-xs text-emerald-600">實發合計</p>
            <p className="mt-1 text-lg font-semibold text-emerald-700">{money(totals.net)}</p>
          </div>
          <div className="rounded-xl bg-violet-50 p-3" title="公司負擔，不從員工實發扣除">
            <p className="text-xs text-violet-700">雇主勞退提撥合計</p>
            <p className="mt-1 text-lg font-semibold text-violet-800">{money(totals.employerPension)}</p>
          </div>
          <div className="rounded-xl bg-slate-100 p-3" title="應發合計 ＋ 固定津貼免稅部分 ＋ 雇主勞退提撥（雇主勞健保負擔未計）">
            <p className="text-xs text-slate-600">人事成本合計</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{money(Math.round(totals.laborCost * 100) / 100)}</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xs text-amber-700">草稿 / 全部</p>
            <p className="mt-1 text-lg font-semibold text-amber-800">
              {totals.draft} / {payslips.length}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <Card>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜尋工號或姓名" className="sm:w-56" aria-label="搜尋員工" />
            <Segmented
              size="sm"
              compact
              aria-label="篩選員工"
              value={filter}
              onChange={setFilter}
              options={(Object.keys(ROSTER_FILTER_LABEL) as RosterFilter[]).map((k) => ({ value: k, label: `${ROSTER_FILTER_LABEL[k]} ${counts[k]}` }))}
            />
          </div>

          {loading && !data ? (
            <p className="text-sm text-gray-400">載入中…</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">{rows.length === 0 ? `${period} 沒有在職員工` : "沒有符合條件的員工"}</p>
          ) : (
            <>
              {/* 手機：每人一張小卡 */}
              <ul className="divide-y divide-gray-100 sm:hidden" data-testid="payroll-roster-mobile">
                {visible.map((r) => (
                  <li key={r.employeeId}>
                    <button
                      type="button"
                      onClick={() => pick(r.employeeId)}
                      className={`w-full px-1 py-2.5 text-left ${selectedId === r.employeeId ? "bg-gray-50" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium text-gray-900">{rosterLabel(r)}</span>
                        <span className={`shrink-0 text-xs font-medium ${r.ready ? "text-green-700" : "text-red-700"}`}>{r.ready ? "✓ 已就緒" : "● 未就緒"}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span>月表 <CellView cell={sheetCell(r)} /></span>
                        <span>薪資單 <CellView cell={payslipCell(r)} /></span>
                        {r.pendingRequests.total > 0 && <span>待簽 <CellView cell={requestsCell(r)} /></span>}
                        {r.undecidedLateReports > 0 && <span>遲到 <CellView cell={lateCell(r)} /></span>}
                        {(r.unsettledLeaves > 0 || r.submittedExpenses.count > 0) && <CellView cell={settlementCell(r)} />}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {/* 桌機：表格 */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm" data-testid="payroll-roster">
                  <thead>
                    <tr className="border-b border-gray-200 text-xs text-gray-500">
                      <th className="py-2 pr-3">員工</th>
                      <th className="py-2 pr-3">待簽申請</th>
                      <th className="py-2 pr-3">出勤月表</th>
                      <th className="py-2 pr-3">遲到說明</th>
                      <th className="py-2 pr-3">核銷／報銷</th>
                      <th className="py-2">薪資單（實發）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr
                        key={r.employeeId}
                        onClick={() => pick(r.employeeId)}
                        className={`cursor-pointer border-b border-gray-50 hover:bg-gray-50 ${selectedId === r.employeeId ? "bg-gray-50" : ""}`}
                        data-testid={`payroll-roster-row-${r.employeeId}`}
                      >
                        <td className="py-2 pr-3">
                          <button type="button" className="flex items-center gap-2 text-left font-medium text-gray-900 hover:underline">
                            <span className={r.ready ? "text-green-600" : "text-red-600"} aria-label={r.ready ? "已就緒" : "未就緒"}>
                              {r.ready ? "✓" : "●"}
                            </span>
                            <span className="whitespace-nowrap">{rosterLabel(r)}</span>
                          </button>
                        </td>
                        <td className="py-2 pr-3"><CellView cell={requestsCell(r)} /></td>
                        <td className="py-2 pr-3"><CellView cell={sheetCell(r)} /></td>
                        <td className="py-2 pr-3"><CellView cell={lateCell(r)} /></td>
                        <td className="py-2 pr-3"><CellView cell={settlementCell(r)} /></td>
                        <td className="py-2"><CellView cell={payslipCell(r)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>

        <div id="payroll-employee-panel" className="min-w-0 scroll-mt-4 lg:sticky lg:top-4 lg:self-start">
          <Card>
            {selected ? (
              <EmployeeMonthPanel
                key={`${selected.employeeId}-${period}`}
                row={selected}
                period={period}
                payslip={selectedSlip}
                meId={meId}
                locked={locked}
                empName={empName}
                onChanged={afterChange}
                onEditAdjustments={() => setAdjFocus((f) => ({ employeeId: selected.employeeId, period, nonce: (f?.nonce ?? 0) + 1 }))}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <p className="py-6 text-center text-sm text-gray-400">點選左側員工，查看並處理這個月還沒就緒的項目</p>
            )}
          </Card>
        </div>
      </div>

      {/* 月結與發薪鎖定：全部就緒才能鎖；卡住的人點名字跳過去。重新開放與權限照舊；最近 12 個月收合。 */}
      <PeriodLockCard key={lockKey} period={period} blockers={blockers} onPickEmployee={pick} onChanged={afterChange} />

      {/* 前期更正：#payroll-adjustments 是重新開放對話框裡「前往前期更正」的錨點。 */}
      <PayrollAdjustmentsCard employees={employees} refreshKey={refreshKey} focus={adjFocus} />

      <details className="rounded-xl border border-gray-200 bg-white p-4 md:p-5" data-testid="payroll-ledger">
        <summary className="cursor-pointer select-none text-sm font-medium text-gray-600">工資清冊明細（{payslips.length} 張，逐列應發／應扣／實發）</summary>
        <div className="mt-3 min-w-0">
          {payslips.length === 0 ? (
            <p className="text-sm text-gray-400">{period} 沒有薪資單</p>
          ) : (
            <PayslipLedgerTable rows={ledgerRows} totals={totals} empName={empName} busy={busy} onFinalize={(id) => void finalizeOne(id)} onSend={(p) => void sendOne(p)} />
          )}
        </div>
      </details>
    </div>
  );
}
