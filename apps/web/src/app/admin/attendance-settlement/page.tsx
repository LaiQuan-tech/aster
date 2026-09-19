"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getEmployees,
  getAttendanceDays,
  settleAttendance,
  type AttendanceDay,
  type Employee,
} from "@/lib/admin-api";

const monthNow = new Date().toISOString().slice(0, 7);

type DataType = "all" | "worked" | "late" | "overtime" | "night" | "anomaly";
type SettlementStatus = "unsettled" | "settled" | "transferred";
type SettlementStatusFilter = "all" | SettlementStatus;

const dataTypeLabels: Record<DataType, string> = {
  all: "全部",
  worked: "有出勤",
  late: "遲到",
  overtime: "加班",
  night: "夜間",
  anomaly: "異常",
};

const settlementStatusLabels: Record<SettlementStatus, string> = {
  unsettled: "未結算",
  settled: "已結算",
  transferred: "已拋轉",
};

function minutes(value: number) {
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return `${hours}時${mins}分`;
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start, end };
}

const defaultRange = monthRange(monthNow);

function downloadCsv(
  rows: AttendanceDay[],
  employeeName: Map<string, string>,
  options: {
    payrollMonth: string;
    dataType: DataType;
    settlementStatus: SettlementStatus;
    cutoffDate: string;
    filenameSuffix: string;
  },
) {
  const header = [
    "薪資年月",
    "資料類型",
    "結算狀態",
    "截止日",
    "員工",
    "日期",
    "工作分鐘",
    "遲到分鐘",
    "加班分鐘",
    "夜間分鐘",
    "日別",
    "異常",
  ];
  const csvRows = rows.map((row) => [
    options.payrollMonth,
    dataTypeLabels[options.dataType],
    settlementStatusLabels[options.settlementStatus],
    options.cutoffDate,
    employeeName.get(row.employee_id) ?? row.employee_id,
    row.work_date,
    row.worked_minutes,
    row.late_minutes,
    row.overtime_minutes,
    row.night_minutes,
    row.day_type ?? "",
    row.anomaly ? JSON.stringify(row.anomaly) : "",
  ]);
  const csv = [header, ...csvRows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `attendance-payroll-transfer-${options.filenameSuffix}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function AttendanceSettlementPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [rows, setRows] = useState<AttendanceDay[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [payrollMonth, setPayrollMonth] = useState(monthNow);
  const [from, setFrom] = useState(defaultRange.start);
  const [to, setTo] = useState(defaultRange.end);
  const [cutoffDate, setCutoffDate] = useState(defaultRange.end);
  const [dataType, setDataType] = useState<DataType>("all");
  const [settlementStatus, setSettlementStatus] = useState<SettlementStatus>("unsettled");
  const [settlementStatusFilter, setSettlementStatusFilter] = useState<SettlementStatusFilter>("all");
  const [transferredAt, setTransferredAt] = useState<string | null>(null);
  const [dayType, setDayType] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const employeeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of employees) {
      map.set(employee.id, employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name);
    }
    return map;
  }, [employees]);

  const filteredRows = useMemo(() => {
    if (settlementStatusFilter !== "all" && settlementStatusFilter !== settlementStatus) return [];
    return rows.filter((row) => {
      if (dayType && row.day_type !== dayType) return false;
      if (dataType === "worked") return row.worked_minutes > 0;
      if (dataType === "late") return row.late_minutes > 0;
      if (dataType === "overtime") return row.overtime_minutes > 0;
      if (dataType === "night") return row.night_minutes > 0;
      if (dataType === "anomaly") return !!row.anomaly;
      return true;
    });
  }, [dataType, dayType, rows, settlementStatus, settlementStatusFilter]);

  const summary = useMemo(() => {
    return filteredRows.reduce(
      (total, row) => {
        total.worked += row.worked_minutes;
        total.late += row.late_minutes;
        total.overtime += row.overtime_minutes;
        total.night += row.night_minutes;
        if (row.anomaly) total.anomaly += 1;
        return total;
      },
      { worked: 0, late: 0, overtime: 0, night: 0, anomaly: 0 },
    );
  }, [filteredRows]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAttendanceDays({
        employeeId: employeeId || undefined,
        from,
        to,
      });
      setRows(res.attendanceDays);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入結算資料失敗");
    } finally {
      setLoading(false);
    }
  }, [employeeId, from, to]);

  useEffect(() => {
    getEmployees().then((response) => setEmployees(response.employees)).catch(() => null);
    void load();
  }, [load]);

  function applySettings() {
    const range = monthRange(payrollMonth);
    const nextTo = cutoffDate || range.end;
    setFrom(range.start);
    setTo(nextTo);
    setSettlementStatus("unsettled");
    setTransferredAt(null);
    setMessage(`已套用設定：${payrollMonth}，截止日 ${nextTo}`);
  }

  async function onSettle(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    try {
      const res = await settleAttendance({ employeeId: employeeId || undefined, from, to });
      setSettlementStatus("settled");
      setTransferredAt(null);
      setMessage(`已結算 ${res.settled} 筆出勤日`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "結算失敗");
    }
  }

  function downloadFilteredRows() {
    downloadCsv(filteredRows, employeeName, {
      payrollMonth,
      dataType,
      settlementStatus,
      cutoffDate: to,
      filenameSuffix: `${payrollMonth}-${dataType}`,
    });
  }

  function transferAllRows() {
    if (rows.length === 0) {
      setError("沒有可拋轉資料，請先搜尋或執行結算");
      return;
    }
    setError(null);
    const nextTransferredAt = new Date().toLocaleString("zh-TW", { hour12: false });
    setSettlementStatus("transferred");
    setSettlementStatusFilter("all");
    setTransferredAt(nextTransferredAt);
    downloadCsv(rows, employeeName, {
      payrollMonth,
      dataType: "all",
      settlementStatus: "transferred",
      cutoffDate: to,
      filenameSuffix: `${payrollMonth}-all-transfer`,
    });
    setMessage(`已全數拋轉 ${rows.length} 筆出勤日（${nextTransferredAt}）`);
  }

  return (
    <>
      <Card>
        <form onSubmit={onSettle} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-8">
            <div>
              <label className={labelCls}>薪資年月</label>
              <div className="flex gap-2">
                <input type="month" className={inputCls} value={payrollMonth} onChange={(event) => setPayrollMonth(event.target.value)} />
              </div>
            </div>
            <div className="lg:col-span-2">
              <label className={labelCls}>工號 / 姓名</label>
              <select className={inputCls} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
                <option value="">全部人員</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employeeName.get(employee.id)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>截止日</label>
              <input type="date" className={inputCls} value={cutoffDate} onChange={(event) => setCutoffDate(event.target.value)} />
            </div>
            <div>
              <label className={labelCls}>結算日期（起）</label>
              <input type="date" className={inputCls} value={from} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div>
              <label className={labelCls}>結算日期（迄）</label>
              <input type="date" className={inputCls} value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
            <div>
              <label className={labelCls}>資料類型</label>
              <select className={inputCls} value={dataType} onChange={(event) => setDataType(event.target.value as typeof dataType)}>
                <option value="all">全部</option>
                <option value="worked">有出勤</option>
                <option value="late">遲到</option>
                <option value="overtime">加班</option>
                <option value="night">夜間</option>
                <option value="anomaly">異常</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>結算狀態</label>
              <select
                className={inputCls}
                value={settlementStatusFilter}
                onChange={(event) => setSettlementStatusFilter(event.target.value as SettlementStatusFilter)}
              >
                <option value="all">全部</option>
                <option value="unsettled">未結算</option>
                <option value="settled">已結算</option>
                <option value="transferred">已拋轉</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>日別</label>
              <input className={inputCls} value={dayType} onChange={(event) => setDayType(event.target.value)} placeholder="例：workday" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={applySettings} className="rounded-md border px-4 py-2 text-sm">
              設定
            </button>
            <PrimaryButton type="submit">執行結算</PrimaryButton>
            <button type="button" onClick={() => void load()} className="rounded-md border px-4 py-2 text-sm">
              搜尋
            </button>
            <button
              type="button"
              onClick={transferAllRows}
              className="rounded-md border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700"
            >
              全數拋轉
            </button>
            <button
              type="button"
              onClick={downloadFilteredRows}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
            >
              下載
            </button>
          </div>
          <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
            設定摘要：薪資年月 {payrollMonth} / 資料類型 {dataTypeLabels[dataType]} / 結算狀態{" "}
            {settlementStatusLabels[settlementStatus]} / 截止日 {to}
            {transferredAt ? ` / 全數拋轉 ${transferredAt}` : ""}
          </div>
          {message && <p className="text-sm text-green-600">{message}</p>}
          {error && <ErrorText>{error}</ErrorText>}
        </form>
      </Card>

      <Card>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
          <div className="rounded-xl bg-emerald-50 p-4">
            <p className="text-xs text-emerald-600">結算狀態</p>
            <p className="mt-1 text-xl font-semibold text-emerald-700">{settlementStatusLabels[settlementStatus]}</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-4">
            <p className="text-xs text-amber-600">結算筆數</p>
            <p className="mt-1 text-xl font-semibold text-amber-700">{filteredRows.length}</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">工作時數</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{minutes(summary.worked)}</p>
          </div>
          <div className="rounded-xl bg-red-50 p-4">
            <p className="text-xs text-red-600">遲到</p>
            <p className="mt-1 text-xl font-semibold text-red-700">{minutes(summary.late)}</p>
          </div>
          <div className="rounded-xl bg-blue-50 p-4">
            <p className="text-xs text-blue-600">加班</p>
            <p className="mt-1 text-xl font-semibold text-blue-700">{minutes(summary.overtime)}</p>
          </div>
          <div className="rounded-xl bg-indigo-50 p-4">
            <p className="text-xs text-indigo-600">夜間</p>
            <p className="mt-1 text-xl font-semibold text-indigo-700">{minutes(summary.night)}</p>
          </div>
          <div className="rounded-xl bg-orange-50 p-4">
            <p className="text-xs text-orange-600">異常</p>
            <p className="mt-1 text-xl font-semibold text-orange-700">{summary.anomaly}</p>
          </div>
        </div>

        <h2 className="mb-4 text-sm font-medium text-gray-500">結算結果</h2>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : filteredRows.length === 0 ? (
          <Empty>查無結算資料</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">工號/姓名</th>
                  <th className="py-2 pr-4">日期</th>
                  <th className="py-2 pr-4">工作時數</th>
                  <th className="py-2 pr-4">遲到</th>
                  <th className="py-2 pr-4">加班</th>
                  <th className="py-2 pr-4">夜間</th>
                  <th className="py-2 pr-4">日別</th>
                  <th className="py-2">異常</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">
                      {employeeName.get(row.employee_id) ?? row.employee_id.slice(0, 8)}
                    </td>
                    <td className="py-2 pr-4">{row.work_date}</td>
                    <td className="py-2 pr-4">{minutes(row.worked_minutes)}</td>
                    <td className="py-2 pr-4">{minutes(row.late_minutes)}</td>
                    <td className="py-2 pr-4">{minutes(row.overtime_minutes)}</td>
                    <td className="py-2 pr-4">{minutes(row.night_minutes)}</td>
                    <td className="py-2 pr-4">{row.day_type ?? "—"}</td>
                    <td className="py-2">{row.anomaly ? "有" : "—"}</td>
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
