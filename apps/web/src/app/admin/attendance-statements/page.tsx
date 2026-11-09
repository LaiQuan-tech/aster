"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, ErrorText } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import {
  currentSheetPeriod,
  exportAttendanceSheetsXlsx,
  friendlyError,
  generateAttendanceSheets,
  getAttendanceSheet,
  listAttendanceSheets,
  SHEET_STATUS_LABEL,
  type SheetListItem,
  type SheetStatus,
} from "@/lib/attendance-sheets-api";
import {
  buildRoster,
  buildStatementsSearch,
  filterRoster,
  readStatementsQuery,
  STATEMENT_STATUS_TILES,
  statusStats,
} from "@/lib/attendance-statements-page";
import { listPeriodCloses, type PeriodClose } from "@/lib/backup-api";
import { periodStatusDetail, periodStatusLabel } from "@/lib/payroll-periods-api";
import type { EmployeeStatements } from "@/lib/statements-api";
import { EmployeeStatementsPanel } from "../employees/_components/EmployeeStatementsPanel";
import { EmployeeRoster } from "./_components/EmployeeRoster";
import { SheetReviewBar } from "./_components/SheetReviewBar";

/**
 * 後台「出勤統計表」（2026-11-09 業主：原「出勤月表與月結」/admin/attendance-sheets 併入，一頁完成「看＋簽核＋結算進度」）。
 *
 *   - 頂部：月份、部門、只看異常、狀態磚（含張數，點磚＝依狀態篩選，再點取消）、月結鎖定進度（唯讀，連到月結發薪）、
 *     「產生月表」「匯出整批 Excel」（API 同原列表頁：generate／export.xlsx，requireFinance）。
 *   - 左側（桌機）／上方可收合（手機）：員工清單（components 見 _components/EmployeeRoster），可搜尋（EmployeeCombobox 同款篩選）。
 *   - 右側：月表狀態列（_components/SheetReviewBar：狀態、時間、異常清單、核准／退回／重開／重算／匯出單張、逐日月表與快照）
 *     ＋ 出勤統計表（EmployeeStatementsPanel live：出勤｜請假單｜支出表、列印、下載 Excel、假日列、凍結提示、重新整理）。
 *   - 網址：?employee=&period=&status=&dept=&anomaly=1（lib/attendance-statements-page.ts）；舊網址
 *     /admin/attendance-sheets（query 原樣）與 /admin/attendance-sheets/:id（→ ?sheet=:id）由 next.config 轉址過來。
 * 權限：HR／平台管理員／會計（同原兩頁；會計的金額在 API 端遮成「—」，簽核動作的守門在 API）。
 */

function prevPeriod(period: string, back: number): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 7);
}

/** 月結的唯一入口在月結發薪頁（HR 完成發薪並鎖定；老闆或老闆指定的人重新開放）。 */
function PayrollLink() {
  return (
    <Link href="/admin/payroll" className="text-xs font-medium hover:underline" style={{ color: "var(--brand)" }}>
      到月結發薪完成發薪／重新開放
    </Link>
  );
}

const PRINT_SHEET_CLASS = "print-attendance-sheet";

export default function AttendanceStatementsPage() {
  const [period, setPeriod] = useState(currentSheetPeriod());
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [dept, setDept] = useState("");
  const [onlyAnomaly, setOnlyAnomaly] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [search, setSearch] = useState("");
  const [rosterOpen, setRosterOpen] = useState(true);
  // 掛載後才讀網址（免得 SSR 與掛載內容不一致），讀完才開始載入與寫回網址。
  const [queryReady, setQueryReady] = useState(false);
  const periodFromUrl = useRef(false);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [sheets, setSheets] = useState<SheetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statementReload, setStatementReload] = useState(0);
  const [barReload, setBarReload] = useState(0);

  const [periodClose, setPeriodClose] = useState<PeriodClose | null>(null);
  const [periodCloseState, setPeriodCloseState] = useState<"loading" | "ready" | "error">("loading");
  const periodCloseSeq = useRef(0);
  const sheetsSeq = useRef(0);

  // 1) 讀網址；舊網址 /admin/attendance-sheets/:id 轉來帶 ?sheet=:id → 用月表換成員工＋月份。
  useEffect(() => {
    const q = readStatementsQuery(window.location.search);
    if (q.period) {
      setPeriod(q.period);
      periodFromUrl.current = true;
    }
    setStatus(q.status);
    setDept(q.dept);
    setOnlyAnomaly(q.anomaly);
    if (q.employee) {
      setEmployeeId(q.employee);
      if (window.matchMedia?.("(max-width: 1023px)").matches) setRosterOpen(false);
    }
    if (!q.sheet) {
      setQueryReady(true);
      return;
    }
    getAttendanceSheet(q.sheet)
      .then((res) => {
        setEmployeeId(res.sheet.employeeId);
        setPeriod(res.sheet.period);
        periodFromUrl.current = true;
        if (window.matchMedia?.("(max-width: 1023px)").matches) setRosterOpen(false);
      })
      .catch((err) => setError(friendlyError(err, "找不到這張出勤月表")))
      .finally(() => setQueryReady(true));
  }, []);

  // 2) 網址同步（可分享、重新整理保留）。
  useEffect(() => {
    if (!queryReady) return;
    const next = `${window.location.pathname}${buildStatementsSearch({ employee: employeeId || null, period, status, dept, anomaly: onlyAnomaly })}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [queryReady, employeeId, period, status, dept, onlyAnomaly]);

  useEffect(() => {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => null);
    getEmployees()
      .then((res) => setEmployees(res.employees))
      .catch((err) => setError(apiErrorMessage(err, "讀取員工失敗")));
  }, []);

  const loadPeriodClose = useCallback(async () => {
    periodCloseSeq.current += 1;
    const seq = periodCloseSeq.current;
    setPeriodClose(null);
    setPeriodCloseState("loading");
    try {
      const res = await listPeriodCloses(period);
      if (seq !== periodCloseSeq.current) return;
      setPeriodClose(res.closes[0] ?? null);
      setPeriodCloseState("ready");
    } catch {
      if (seq === periodCloseSeq.current) setPeriodCloseState("error");
    }
  }, [period]);

  useEffect(() => {
    if (queryReady) void loadPeriodClose();
  }, [loadPeriodClose, queryReady]);

  // 當月還沒有月表（月初、或 demo 資料在別的月份）且網址沒指定月份、沒套篩選、沒選員工：往前找最近有月表的月份（最多 12 個月）。
  const autoJumped = useRef(false);
  const loadSheets = useCallback(async () => {
    sheetsSeq.current += 1;
    const seq = sheetsSeq.current;
    setLoading(true);
    try {
      const res = await listAttendanceSheets({ period });
      if (seq !== sheetsSeq.current) return;
      if (res.sheets.length === 0 && !autoJumped.current && !periodFromUrl.current && !employeeId) {
        autoJumped.current = true;
        for (let back = 1; back <= 12; back += 1) {
          const candidate = prevPeriod(period, back);
          const prev = await listAttendanceSheets({ period: candidate });
          if (seq !== sheetsSeq.current) return;
          if (prev.sheets.length > 0) {
            setMessage(`${period} 尚無月表，已切到最近有資料的 ${candidate}`);
            setPeriod(candidate);
            return;
          }
        }
      }
      autoJumped.current = true;
      setSheets(res.sheets);
    } catch (err) {
      if (seq === sheetsSeq.current) setError(friendlyError(err, "載入失敗"));
    } finally {
      if (seq === sheetsSeq.current) setLoading(false);
    }
    // employeeId 只用來判斷要不要自動跳月份，不觸發重抓。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  useEffect(() => {
    if (queryReady) void loadSheets();
  }, [loadSheets, queryReady]);

  const roster = useMemo(() => buildRoster(employees, sheets), [employees, sheets]);
  const visibleRoster = useMemo(
    () => filterRoster(roster, { status, dept, anomaly: onlyAnomaly, query: search }),
    [roster, status, dept, onlyAnomaly, search],
  );
  const stats = useMemo(() => statusStats(sheets, dept), [sheets, dept]);
  const deptNameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const selectedRow = roster.find((r) => r.employeeId === employeeId) ?? null;
  const selectedSheet = sheets.find((s) => s.employeeId === employeeId) ?? null;

  function selectEmployee(id: string) {
    setEmployeeId(id);
    if (window.matchMedia?.("(max-width: 1023px)").matches) {
      setRosterOpen(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  /** 簽核／逐日修改後：重抓清單與統計表。 */
  const onSheetChanged = useCallback(() => {
    void loadSheets();
    setStatementReload((n) => n + 1);
  }, [loadSheets]);

  /** 統計表開畫面（或按重新整理）時重算了月表 → 清單與狀態列跟著刷新。 */
  const onStatementLoaded = useCallback(
    (data: EmployeeStatements) => {
      if (data.recompute?.ran) {
        void loadSheets();
        setBarReload((n) => n + 1);
      }
    },
    [loadSheets],
  );

  function printSheet() {
    const cleanup = () => {
      document.body.classList.remove(PRINT_SHEET_CLASS);
      window.removeEventListener("afterprint", cleanup);
    };
    document.body.classList.add(PRINT_SHEET_CLASS);
    window.addEventListener("afterprint", cleanup);
    window.print();
  }

  async function onGenerate() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await generateAttendanceSheets(period);
      setMessage(`已產生 ${res.generated} 張、重建 ${res.rebuilt} 張、略過 ${res.skipped.length} 張（非在職期間）`);
      await loadSheets();
      setStatementReload((n) => n + 1);
    } catch (err) {
      setError(friendlyError(err, "產生失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onExportAll() {
    setError(null);
    try {
      await exportAttendanceSheetsXlsx(period, `出勤月表_${period}.xlsx`);
    } catch (err) {
      setError(friendlyError(err, "匯出失敗"));
    }
  }

  const selectCls = "rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
  const tileCls = (active: boolean) =>
    `rounded-xl p-3 text-left transition ${active ? "bg-white" : "bg-gray-50 hover:bg-gray-100"}`;
  const activeTileStyle = { boxShadow: "0 0 0 2px var(--brand)" };

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">月份</label>
            <MonthPicker
              value={period}
              onChange={(p) => {
                periodFromUrl.current = true;
                setMessage(null);
                setPeriod(p);
              }}
              disabled={loading}
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="statement-dept">
              部門
            </label>
            <select id="statement-dept" value={dept} onChange={(e) => setDept(e.target.value)} className={`${selectCls} max-w-full`}>
              <option value="">全部部門</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-600">
            <input type="checkbox" checked={onlyAnomaly} onChange={(e) => setOnlyAnomaly(e.target.checked)} />
            只看異常
          </label>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={() => void onGenerate()}
              disabled={busy}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
            >
              產生月表
            </button>
            <button
              type="button"
              onClick={() => void onExportAll()}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
            >
              匯出整批 Excel
            </button>
          </div>
        </div>

        {/* 月結狀態（唯讀）。完成發薪並鎖定／重新開放統一在月結發薪頁。 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" data-testid="period-close-badge">
          {periodClose ? (
            <>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  periodClose.status === "closed" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                }`}
              >
                {periodStatusLabel(periodClose.status)}
              </span>
              <span className="text-gray-600">
                {periodStatusDetail(periodClose)}
                {periodClose.status === "closed" ? ` · ${periodClose.lockedCount}/${periodClose.sheetCount} 張已鎖定` : ""}
                {periodClose.note ? ` · ${periodClose.note}` : ""}
              </span>
            </>
          ) : periodCloseState === "ready" ? (
            <>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600">{periodStatusLabel("open")}</span>
              <span className="text-gray-500">
                {period} 尚未月結 · {stats.byStatus.locked}/{stats.total} 張已鎖定
              </span>
            </>
          ) : null}
          <PayrollLink />
        </div>

        {message && <p className="mt-2 text-sm text-green-600">{message}</p>}
        {error && (
          <div className="mt-2">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-9" role="group" aria-label="依狀態篩選">
          <button type="button" onClick={() => setStatus("")} aria-pressed={status === ""} className={tileCls(status === "")} style={status === "" ? activeTileStyle : undefined}>
            <p className="text-xs text-gray-500">總張數</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{stats.total}</p>
          </button>
          {STATEMENT_STATUS_TILES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(status === s ? "" : s)}
              aria-pressed={status === s}
              className={tileCls(status === s)}
              style={status === s ? activeTileStyle : undefined}
            >
              <p className="text-xs text-gray-500">{SHEET_STATUS_LABEL[s]}</p>
              <p className="mt-1 text-lg font-semibold text-gray-800">{stats.byStatus[s]}</p>
            </button>
          ))}
          <div className="rounded-xl bg-blue-50 p-3">
            <p className="text-xs text-blue-600">待核准</p>
            <p className="mt-1 text-lg font-semibold text-blue-700">{stats.pendingApproval}</p>
          </div>
          <div className="rounded-xl bg-red-50 p-3">
            <p className="text-xs text-red-600">有 error 異常</p>
            <p className="mt-1 text-lg font-semibold text-red-700">{stats.hasError}</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="min-w-0 print:hidden">
          <div className="rounded-2xl border border-gray-200 bg-white lg:sticky lg:top-4">
            <button
              type="button"
              onClick={() => setRosterOpen((v) => !v)}
              aria-expanded={rosterOpen}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-gray-800 lg:hidden"
            >
              <span className="min-w-0 truncate">
                員工清單（{visibleRoster.length}）
                {selectedRow ? `・${selectedRow.empNo ? `${selectedRow.empNo} ` : ""}${selectedRow.name}` : ""}
              </span>
              <span aria-hidden>{rosterOpen ? "▴" : "▾"}</span>
            </button>
            <div className={rosterOpen ? "block" : "hidden lg:block"}>
              <div className="border-t border-gray-100 p-2 lg:border-t-0">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="輸入工號、姓名搜尋"
                  aria-label="搜尋員工"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-400 focus:outline-none"
                />
                <p className="mt-1 hidden px-1 text-xs text-gray-400 lg:block">共 {visibleRoster.length} 人</p>
              </div>
              <div className="max-h-[60vh] overflow-y-auto border-t border-gray-100 lg:max-h-[calc(100vh-12rem)]">
                {loading && sheets.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-gray-500">載入中…</p>
                ) : (
                  <EmployeeRoster
                    rows={visibleRoster}
                    selectedId={employeeId}
                    onSelect={selectEmployee}
                    deptName={(id) => (id ? (deptNameById.get(id) ?? null) : null)}
                  />
                )}
              </div>
            </div>
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          {employeeId ? (
            <>
              <SheetReviewBar
                key={`${employeeId}-${period}`}
                sheetId={selectedSheet?.id ?? null}
                listLoading={loading && !selectedSheet}
                reloadKey={barReload}
                onChanged={onSheetChanged}
                onPrintSheet={printSheet}
              />
              <div className="statement-print-area">
                <EmployeeStatementsPanel
                  key={employeeId}
                  employeeId={employeeId}
                  kind="attendance"
                  live
                  period={period}
                  reloadKey={statementReload}
                  onLoaded={onStatementLoaded}
                />
              </div>
            </>
          ) : (
            <Card className="print:hidden">
              <p className="py-8 text-center text-sm text-gray-500">
                請從員工清單選擇員工：上方顯示月表狀態與簽核動作，下方是出勤統計表（出勤｜請假單｜支出表）。
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
