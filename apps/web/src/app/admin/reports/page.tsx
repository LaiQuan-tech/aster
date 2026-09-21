"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDownload } from "@/lib/api-client";
import { fmtHm, localDateKey } from "@/lib/ess-format";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getAttendanceReport,
  getDepartments,
  getHeadcountReport,
  getLeaveReport,
  getPayrollReport,
  type AttendanceReport,
  type Department,
  type HeadcountReport,
  type LeaveReport,
  type PayrollReport,
} from "@/lib/admin-api";

const today = new Date().toISOString().slice(0, 10);
const month = new Date().toISOString().slice(0, 7);
const monthStart = `${month}-01`;
const numberFmt = new Intl.NumberFormat("zh-TW");

function minutesToHours(minutes: number) {
  return `${(minutes / 60).toFixed(1)}h`;
}

function money(value: number) {
  return `$${numberFmt.format(value)}`;
}

/** ISO → 當地「YYYY-MM-DD HH:mm」；原本直接切 ISO 字串會變成 UTC，比台北少 8 小時。 */
function fmtDateTime(value: string) {
  if (!value) return "—";
  const day = localDateKey(value);
  return day ? `${day} ${fmtHm(value)}` : value.slice(0, 16).replace("T", " ");
}

function kindLabel(kind: string) {
  const labels: Record<string, string> = {
    leave: "請假",
    ot: "加班",
    fix_punch: "忘打卡",
    trip: "公出/出差",
  };
  return labels[kind] ?? kind;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待簽核",
    approved: "已核准",
    rejected: "已駁回",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export default function ReportsPage() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState(month);
  const [deptId, setDeptId] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [attendance, setAttendance] = useState<AttendanceReport | null>(null);
  const [leave, setLeave] = useState<LeaveReport | null>(null);
  const [payroll, setPayroll] = useState<PayrollReport | null>(null);
  const [headcount, setHeadcount] = useState<HeadcountReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [attendanceReport, leaveReport, payrollReport, headcountReport, departmentRes] = await Promise.all([
        getAttendanceReport({ from, to, deptId: deptId || undefined }),
        getLeaveReport({ from, to }),
        getPayrollReport(period),
        getHeadcountReport(),
        getDepartments(),
      ]);
      setAttendance(attendanceReport);
      setLeave(leaveReport);
      setPayroll(payrollReport);
      setHeadcount(headcountReport);
      setDepartments(departmentRes.departments);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入報表中心失敗");
    } finally {
      setLoading(false);
    }
  }, [deptId, from, period, to]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  async function download(path: string, filename: string, key = filename) {
    setError(null);
    setDownloading(key);
    try {
      await apiDownload(path, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "下載失敗");
    } finally {
      setDownloading(null);
    }
  }

  async function downloadAll() {
    await download(attendanceCsvPath(), `出勤報表_${from}_${to}.csv`, "all-attendance");
    await download(`/reports/leave?from=${from}&to=${to}&format=csv`, `表單報表_${from}_${to}.csv`, "all-leave");
    await download(`/reports/payroll?period=${period}&format=csv`, `薪資報表_${period}.csv`, "all-payroll");
    await download("/reports/headcount?format=csv", "人力快照.csv", "all-headcount");
  }

  function attendanceCsvPath() {
    const params = new URLSearchParams({ from, to, format: "csv" });
    if (deptId) params.set("deptId", deptId);
    return `/reports/attendance?${params.toString()}`;
  }

  const attendanceTotals = useMemo(() => {
    const rows = attendance?.rows ?? [];
    return {
      employees: rows.length,
      presentDays: rows.reduce((sum, row) => sum + row.presentDays, 0),
      workedMinutes: rows.reduce((sum, row) => sum + row.workedMinutes, 0),
      lateMinutes: rows.reduce((sum, row) => sum + row.lateMinutes, 0),
      overtimeMinutes: rows.reduce((sum, row) => sum + row.overtimeMinutes, 0),
    };
  }, [attendance]);

  const leaveTotals = useMemo(() => {
    const rows = leave?.rows ?? [];
    return {
      forms: rows.reduce((sum, row) => sum + row.count, 0),
      hours: rows.reduce((sum, row) => sum + row.hours, 0),
      details: leave?.details.length ?? 0,
    };
  }, [leave]);

  const payrollTotals = useMemo(() => {
    const rows = payroll?.rows ?? [];
    return {
      employees: rows.length,
      gross: payroll?.total.gross ?? rows.reduce((sum, row) => sum + row.gross, 0),
    };
  }, [payroll]);

  const deptNameById = useMemo(
    () => new Map(departments.map((department) => [department.id, department.name])),
    [departments],
  );

  return (
    <>
      {error && <ErrorText>{error}</ErrorText>}

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">查詢條件</h2>
            <p className="mt-1 text-sm text-gray-500">出勤/表單使用日期區間，薪資使用薪資年月；出勤報表可依單位篩選。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton onClick={() => void loadReports()} disabled={loading}>
              {loading ? "查詢中…" : "重新查詢"}
            </PrimaryButton>
            <button
              type="button"
              onClick={() => void downloadAll()}
              disabled={downloading !== null}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
            >
              {downloading?.startsWith("all-") ? "批次下載中…" : "批次下載全部"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className={labelCls}>資料區間（起）</label>
            <input type="date" className={inputCls} value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>資料區間（迄）</label>
            <input type="date" className={inputCls} value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>薪資年月</label>
            <input type="month" className={inputCls} value={period} onChange={(event) => setPeriod(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>出勤報表單位</label>
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
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-medium text-gray-800">出勤報表</h2>
              <p className="mt-1 text-sm text-gray-500">工作、出勤、遲到、加班與夜間分鐘彙總。</p>
            </div>
            <button className="text-sm font-medium text-[var(--brand)]" onClick={() => void download(attendanceCsvPath(), `出勤報表_${from}_${to}.csv`, "attendance")} disabled={downloading === "attendance"}>
              {downloading === "attendance" ? "下載中…" : "CSV"}
            </button>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="人數" value={`${attendanceTotals.employees}`} />
            <StatCard label="出勤天" value={`${attendanceTotals.presentDays}`} />
            <StatCard label="工時" value={minutesToHours(attendanceTotals.workedMinutes)} />
            <StatCard label="加班" value={minutesToHours(attendanceTotals.overtimeMinutes)} hint={`遲到 ${attendanceTotals.lateMinutes} 分`} />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2">姓名</th>
                  <th className="px-3 py-2 text-right">出勤</th>
                  <th className="px-3 py-2 text-right">工時</th>
                  <th className="px-3 py-2 text-right">遲到</th>
                  <th className="px-3 py-2 text-right">加班</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(attendance?.rows ?? []).slice(0, 8).map((row) => (
                  <tr key={row.employeeId}>
                    <td className="px-3 py-2 text-gray-900">{row.employeeName || row.employeeId}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{row.presentDays}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{minutesToHours(row.workedMinutes)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{row.lateDays} 次 / {row.lateMinutes} 分</td>
                    <td className="px-3 py-2 text-right text-gray-600">{minutesToHours(row.overtimeMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {attendance?.rows.length === 0 && <Empty>此區間沒有出勤資料。</Empty>}
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-medium text-gray-800">請假 / 表單報表</h2>
              <p className="mt-1 text-sm text-gray-500">依維護類型與狀態彙總，並預覽明細。</p>
            </div>
            <button className="text-sm font-medium text-[var(--brand)]" onClick={() => void download(`/reports/leave?from=${from}&to=${to}&format=csv`, `表單報表_${from}_${to}.csv`, "leave")} disabled={downloading === "leave"}>
              {downloading === "leave" ? "下載中…" : "CSV"}
            </button>
          </div>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <StatCard label="表單件數" value={`${leaveTotals.forms}`} />
            <StatCard label="總時數" value={`${leaveTotals.hours}`} />
            <StatCard label="明細筆數" value={`${leaveTotals.details}`} />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2">類型</th>
                  <th className="px-3 py-2">狀態</th>
                  <th className="px-3 py-2 text-right">件數</th>
                  <th className="px-3 py-2 text-right">時數</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(leave?.rows ?? []).map((row) => (
                  <tr key={`${row.kind}-${row.status}`}>
                    <td className="px-3 py-2 text-gray-900">{kindLabel(row.kind)}</td>
                    <td className="px-3 py-2 text-gray-600">{statusLabel(row.status)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{row.count}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{row.hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {leave?.rows.length === 0 && <Empty>此區間沒有表單資料。</Empty>}
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-medium text-gray-800">薪資報表</h2>
              <p className="mt-1 text-sm text-gray-500">薪資年月的本俸、加給與應發合計。</p>
            </div>
            <button className="text-sm font-medium text-[var(--brand)]" onClick={() => void download(`/reports/payroll?period=${period}&format=csv`, `薪資報表_${period}.csv`, "payroll")} disabled={downloading === "payroll"}>
              {downloading === "payroll" ? "下載中…" : "CSV"}
            </button>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <StatCard label="薪資人數" value={`${payrollTotals.employees}`} />
            <StatCard label="應發總額" value={money(payrollTotals.gross)} />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2">姓名</th>
                  <th className="px-3 py-2 text-right">本俸</th>
                  <th className="px-3 py-2 text-right">加班/夜間</th>
                  <th className="px-3 py-2 text-right">應發</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(payroll?.rows ?? []).slice(0, 8).map((row) => (
                  <tr key={row.employeeId}>
                    <td className="px-3 py-2 text-gray-900">{row.employeeName || row.employeeId}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{money(row.base)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{money(row.overtimePay + row.nightPay)}</td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">{money(row.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {payroll?.rows.length === 0 && <Empty>此薪資年月沒有薪資資料。</Empty>}
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-medium text-gray-800">人力快照</h2>
              <p className="mt-1 text-sm text-gray-500">員工總數、狀態、角色與單位分布。</p>
            </div>
            <button className="text-sm font-medium text-[var(--brand)]" onClick={() => void download("/reports/headcount?format=csv", "人力快照.csv", "headcount")} disabled={downloading === "headcount"}>
              {downloading === "headcount" ? "下載中…" : "CSV"}
            </button>
          </div>
          {headcount ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="總人數" value={`${headcount.total}`} />
                <StatCard label="狀態數" value={`${Object.keys(headcount.byStatus).length}`} />
                <StatCard label="角色數" value={`${Object.keys(headcount.byRole).length}`} />
              </div>
              <div className="grid grid-cols-1 gap-3 text-sm text-gray-600 sm:grid-cols-3">
                <div><span className="font-medium text-gray-800">狀態</span><br />{Object.entries(headcount.byStatus).map(([key, value]) => `${key} ${value}`).join(" / ") || "無"}</div>
                <div><span className="font-medium text-gray-800">角色</span><br />{Object.entries(headcount.byRole).map(([key, value]) => `${key} ${value}`).join(" / ") || "無"}</div>
                <div><span className="font-medium text-gray-800">單位</span><br />{headcount.byDept.map((item) => `${item.deptId ? deptNameById.get(item.deptId) ?? item.deptId : "未分派"} ${item.count}`).join(" / ") || "無"}</div>
              </div>
            </div>
          ) : (
            <Empty>載入中…</Empty>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="font-medium text-gray-800">表單明細預覽</h2>
        <p className="mt-1 text-sm text-gray-500">顯示目前區間前 10 筆申請紀錄，完整資料請下載 CSV 或到表單紀錄管理查詢。</p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">姓名</th>
                <th className="px-3 py-2">類型</th>
                <th className="px-3 py-2">狀態</th>
                <th className="px-3 py-2">起訖</th>
                <th className="px-3 py-2 text-right">時數</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(leave?.details ?? []).slice(0, 10).map((row, index) => (
                <tr key={`${row.employeeId}-${row.startAt}-${index}`}>
                  <td className="px-3 py-2 text-gray-900">{row.employeeName || row.employeeId}</td>
                  <td className="px-3 py-2 text-gray-600">{kindLabel(row.kind)}</td>
                  <td className="px-3 py-2 text-gray-600">{statusLabel(row.status)}</td>
                  <td className="px-3 py-2 text-gray-600">{fmtDateTime(row.startAt)} → {fmtDateTime(row.endAt)}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{row.hours}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leave?.details.length === 0 && <Empty>此區間沒有表單明細。</Empty>}
        </div>
      </Card>
    </>
  );
}
