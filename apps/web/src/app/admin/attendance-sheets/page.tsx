"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
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

export default function AttendanceSheetsPage() {
  const [period, setPeriod] = useState(currentPeriod);
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [deptId, setDeptId] = useState("");
  const [onlyAnomaly, setOnlyAnomaly] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sheets, setSheets] = useState<SheetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAttendanceSheets({
        period,
        status: status || undefined,
        deptId: deptId || undefined,
        anomaly: onlyAnomaly || undefined,
      });
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
    void load();
  }, [load]);

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
      <PageHeader title="出勤月表 · 月結簽核" desc="依月份彙整全員出勤月表，追蹤送出／審核進度、產生本月與匯出" />

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
