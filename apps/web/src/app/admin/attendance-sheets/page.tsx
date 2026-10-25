"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { readFlagParam, readPeriodParam } from "@/lib/boss-dashboard";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { getDepartments, type Department } from "@/lib/admin-api";
import {
  listAttendanceSheets,
  generateAttendanceSheets,
  exportAttendanceSheetsXlsx,
  friendlyError,
  SHEET_STATUS_LABEL,
  type SheetListItem,
  type SheetStatus,
} from "@/lib/attendance-sheets-api";
import { listPeriodCloses, type PeriodClose } from "@/lib/backup-api";
import { periodStatusDetail, periodStatusLabel } from "@/lib/payroll-periods-api";

const currentPeriod = new Date().toISOString().slice(0, 7);

const STATUS_OPTIONS: (SheetStatus | "")[] = [
  "",
  "draft",
  "submitted",
  "manager_reviewed",
  "approved",
  "locked",
  "returned",
];

const STATUS_TILES: SheetStatus[] = ["draft", "submitted", "manager_reviewed", "approved", "locked", "returned"];

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function otAlertClass(alert: SheetListItem["overtimeMonthlyAlert"]): string {
  if (alert === "46") return "text-red-700 font-semibold";
  if (alert === "40") return "text-orange-600 font-semibold";
  if (alert === "36") return "text-amber-600 font-semibold";
  return "text-gray-700";
}

/** 月結的唯一入口在薪資作業頁（HR 完成發薪並鎖定；老闆或老闆指定的人重新開放）。 */
function PayrollLink() {
  return (
    <Link href="/admin/payroll" className="text-xs font-medium hover:underline" style={{ color: "var(--brand)" }}>
      到薪資作業完成發薪／重新開放
    </Link>
  );
}

export default function AttendanceSheetsPage() {
  const [period, setPeriod] = useState(currentPeriod);
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [deptId, setDeptId] = useState("");
  const [onlyAnomaly, setOnlyAnomaly] = useState(false);
  // 首頁「出勤異常／合規警示」帶 ?period=YYYY-MM&anomaly=1 過來（lib/boss-dashboard.ts bossLinks）：
  // 掛載時先套網址篩選再開始載入（queryReady），免得先用預設值載一次、又觸發「自動往前找有月表的月份」蓋掉帶來的月份。
  const [queryReady, setQueryReady] = useState(false);
  useEffect(() => {
    const search = window.location.search;
    const p = readPeriodParam(search);
    if (p) setPeriod(p);
    if (readFlagParam(search, "anomaly")) setOnlyAnomaly(true);
    setQueryReady(true);
  }, []);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sheets, setSheets] = useState<SheetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 這個月的月結紀錄（period_closes；沒有＝開放中）。唯讀：完成發薪並鎖定／重新開放都在薪資作業頁（/admin/payroll）。
  // loading＝還沒回來（先不顯示狀態，免得已結算的月份先閃一下「開放中」）；error＝讀取失敗（只放連結，不假裝是開放中）。
  const [periodClose, setPeriodClose] = useState<PeriodClose | null>(null);
  const [periodCloseState, setPeriodCloseState] = useState<"loading" | "ready" | "error">("loading");
  const periodCloseSeq = useRef(0);

  const loadPeriodClose = useCallback(async () => {
    periodCloseSeq.current += 1;
    const seq = periodCloseSeq.current;
    setPeriodClose(null);
    setPeriodCloseState("loading");
    try {
      const res = await listPeriodCloses(period);
      if (seq !== periodCloseSeq.current) return; // 月份又換了：丟掉舊回應
      setPeriodClose(res.closes[0] ?? null);
      setPeriodCloseState("ready");
    } catch {
      if (seq === periodCloseSeq.current) setPeriodCloseState("error");
    }
  }, [period]);

  useEffect(() => {
    void loadPeriodClose();
  }, [loadPeriodClose]);

  // 當月還沒有月表時（例如月初、或 demo 資料在別的月份），自動往前找最近一個有月表的月份，
  // 免得老闆打開看到一片空白。只在「沒套任何篩選」且是第一次載入時做，最多往回找 12 個月。
  const autoJumped = useRef(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAttendanceSheets({
        period,
        status: status || undefined,
        deptId: deptId || undefined,
        anomaly: onlyAnomaly || undefined,
      });
      if (res.sheets.length === 0 && !autoJumped.current && !status && !deptId && !onlyAnomaly) {
        autoJumped.current = true;
        for (let back = 1; back <= 12; back += 1) {
          const [y, m] = period.split("-").map(Number);
          const d = new Date(Date.UTC(y, m - 1 - back, 1));
          const candidate = d.toISOString().slice(0, 7);
          const prev = await listAttendanceSheets({ period: candidate });
          if (prev.sheets.length > 0) {
            setPeriod(candidate);
            setMessage(`${period} 尚無月表，已切到最近有資料的 ${candidate}`);
            return;
          }
        }
      }
      setSheets(res.sheets);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [deptId, onlyAnomaly, period, status]);

  useEffect(() => {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!queryReady) return;
    void load();
  }, [load, queryReady]);

  const stats = useMemo(() => {
    const byStatus: Partial<Record<SheetStatus, number>> = {};
    let pendingApproval = 0;
    let hasError = 0;
    for (const row of sheets) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.status === "manager_reviewed") pendingApproval += 1;
      if (row.anomalyCount.error > 0) hasError += 1;
    }
    return { byStatus, pendingApproval, hasError };
  }, [sheets]);

  async function onGenerate() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await generateAttendanceSheets(period);
      setMessage(`已產生 ${res.generated} 張、重建 ${res.rebuilt} 張、略過 ${res.skipped.length} 張（非在職期間）`);
      await load();
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

  return (
    <>
      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">月份</label>
            <MonthPicker value={period} onChange={setPeriod} disabled={loading} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">狀態</label>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as SheetStatus | "")}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt || "all"} value={opt}>
                  {opt ? SHEET_STATUS_LABEL[opt] : "全部"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">部門</label>
            <select
              value={deptId}
              onChange={(event) => setDeptId(event.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            >
              <option value="">全部部門</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-600">
            <input type="checkbox" checked={onlyAnomaly} onChange={(event) => setOnlyAnomaly(event.target.checked)} />
            只看異常
          </label>
          <PrimaryButton type="button" onClick={() => void load()}>
            搜尋
          </PrimaryButton>
          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            產生本月
          </button>
          <button
            type="button"
            onClick={() => void onExportAll()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出全員 xlsx
          </button>
        </div>

        {/* 月結狀態（唯讀）。完成發薪並鎖定／重新開放統一在薪資作業頁，這裡只放狀態與連結。 */}
        {periodClose ? (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="period-close-badge">
            {periodClose.status === "closed" ? (
              <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">
                {periodStatusLabel(periodClose.status)}
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                {periodStatusLabel(periodClose.status)}
              </span>
            )}
            <span className="text-gray-600">
              {periodStatusDetail(periodClose)}
              {periodClose.status === "closed" ? ` · ${periodClose.lockedCount}/${periodClose.sheetCount} 張已鎖定` : ""}
              {periodClose.note ? ` · ${periodClose.note}` : ""}
            </span>
            <PayrollLink />
          </div>
        ) : periodCloseState === "ready" ? (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600">
              {periodStatusLabel("open")}
            </span>
            <span className="text-gray-500">{period} 尚未月結</span>
            <PayrollLink />
          </div>
        ) : (
          <div className="mb-3 text-sm">
            <PayrollLink />
          </div>
        )}

        {message && <p className="mb-3 text-sm text-green-600">{message}</p>}
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">總張數</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{sheets.length}</p>
          </div>
          {STATUS_TILES.map((s) => (
            <div key={s} className="rounded-xl bg-gray-50 p-4">
              <p className="text-xs text-gray-500">{SHEET_STATUS_LABEL[s]}</p>
              <p className="mt-1 text-xl font-semibold text-gray-800">{stats.byStatus[s] ?? 0}</p>
            </div>
          ))}
          <div className="rounded-xl bg-blue-50 p-4">
            <p className="text-xs text-blue-600">待核准</p>
            <p className="mt-1 text-xl font-semibold text-blue-700">{stats.pendingApproval}</p>
          </div>
          <div className="rounded-xl bg-red-50 p-4">
            <p className="text-xs text-red-600">有 error 異常</p>
            <p className="mt-1 text-xl font-semibold text-red-700">{stats.hasError}</p>
          </div>
        </div>

        {loading ? (
          <Empty>載入中…</Empty>
        ) : sheets.length === 0 ? (
          <Empty>{period} 查無出勤月表，可先點「產生本月」</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">部門</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2 pr-3 text-right">加班累計</th>
                  <th className="py-2 pr-3">異常 error/warn</th>
                  <th className="py-2 pr-3">送出／核准時間</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50">
                    <td className="py-2 pr-3 font-medium text-gray-800">
                      {row.employeeNo ? `${row.employeeNo} · ${row.employeeName}` : row.employeeName}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{row.department ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        {SHEET_STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${otAlertClass(row.overtimeMonthlyAlert)}`}>
                      {(row.otTotalMinutes / 60).toFixed(1)}h
                      {row.overtimeMonthlyAlert !== "none" && ` (${row.overtimeMonthlyAlert})`}
                    </td>
                    <td className="py-2 pr-3">
                      {row.anomalyCount.error > 0 && (
                        <span className="mr-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                          error×{row.anomalyCount.error}
                        </span>
                      )}
                      {row.anomalyCount.warn > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                          warn×{row.anomalyCount.warn}
                        </span>
                      )}
                      {row.anomalyCount.error === 0 && row.anomalyCount.warn === 0 && <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      送出 {fmtDateTime(row.submittedAt)}
                      <br />
                      核准 {fmtDateTime(row.approvedAt)}
                    </td>
                    <td className="py-2">
                      <Link
                        href={`/admin/attendance-sheets/${row.id}`}
                        className="text-sm hover:underline"
                        style={{ color: "var(--brand)" }}
                      >
                        檢視
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
