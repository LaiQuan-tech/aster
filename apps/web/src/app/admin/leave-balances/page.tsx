"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PrimaryButton, ErrorText, Empty, Segmented, inputCls, labelCls } from "@/components/admin-ui";
import {
  getEmployees,
  getLeaveBalancesAdmin,
  getLeaveTypes,
  getRequests,
  setLeaveBalance,
  type Employee,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
} from "@/lib/admin-api";

const yearNow = new Date().getFullYear();
const tabs = [
  { id: "special", label: "特殊假確認" },
  { id: "query", label: "剩餘假別時數" },
  { id: "grant", label: "年度給假" },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function LeaveBalancesPage() {
  const [activeTab, setActiveTab] = useState<TabId>("query");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [year, setYear] = useState(yearNow);
  const [editEmployeeId, setEditEmployeeId] = useState("");
  const [editLeaveTypeId, setEditLeaveTypeId] = useState("");
  const [entitled, setEntitled] = useState("");
  const [deferred, setDeferred] = useState("");
  const [batchAll, setBatchAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const names = useMemo(() => {
    const employeeMap = new Map(employees.map((employee) => [employee.id, employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name]));
    const leaveTypeMap = new Map(leaveTypes.map((leaveType) => [leaveType.id, leaveType.name]));
    return { employeeMap, leaveTypeMap };
  }, [employees, leaveTypes]);

  const specialLeaveTypeIds = useMemo(() => {
    return new Set(
      leaveTypes
        .filter((leaveType) => /特|補|婚|喪|病|公|產|陪產|家庭|生理/.test(leaveType.name))
        .map((leaveType) => leaveType.id),
    );
  }, [leaveTypes]);

  const specialRequests = useMemo(() => {
    return leaveRequests.filter((request) => {
      if (request.kind !== "leave") return false;
      if (employeeId && request.employee_id !== employeeId) return false;
      const requestYear = new Date(request.start_at).getFullYear();
      if (requestYear !== year) return false;
      if (specialLeaveTypeIds.size === 0) return true;
      return !!request.leave_type_id && specialLeaveTypeIds.has(request.leave_type_id);
    });
  }, [employeeId, leaveRequests, specialLeaveTypeIds, year]);

  const totals = useMemo(() => {
    return balances.reduce(
      (summary, balance) => {
        summary.entitled += Number(balance.entitled);
        summary.used += Number(balance.used);
        summary.deferred += Number(balance.deferred);
        return summary;
      },
      { entitled: 0, used: 0, deferred: 0 },
    );
  }, [balances]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [balanceRes, employeeRes, leaveTypeRes, requestRes] = await Promise.all([
        getLeaveBalancesAdmin({ employeeId: employeeId || undefined, year }),
        getEmployees(),
        getLeaveTypes(),
        getRequests({ kind: "leave", employeeId: employeeId || undefined, from: `${year}-01-01`, to: `${year}-12-31` }),
      ]);
      setBalances(balanceRes.balances);
      setEmployees(employeeRes.employees);
      setLeaveTypes(leaveTypeRes.leaveTypes);
      setLeaveRequests(requestRes.requests);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入假別時數失敗");
    } finally {
      setLoading(false);
    }
  }, [employeeId, year]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (!editLeaveTypeId || !entitled) {
      setError("請選擇假別並輸入可用時數");
      return;
    }
    if (!batchAll && !editEmployeeId) {
      setError("請選擇員工，或啟用全員批次給假");
      return;
    }
    try {
      const targetEmployeeIds = batchAll ? employees.map((employee) => employee.id) : [editEmployeeId];
      for (const targetEmployeeId of targetEmployeeIds) {
        await setLeaveBalance({
          employeeId: targetEmployeeId,
          leaveTypeId: editLeaveTypeId,
          year,
          entitled: Number(entitled),
          deferred: deferred ? Number(deferred) : undefined,
        });
      }
      setMessage(batchAll ? `已批次給假 ${targetEmployeeIds.length} 人` : "假別時數已儲存");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  return (
    <>
      <Segmented<TabId>
        aria-label="假別時數管理檢視"
        options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
        value={activeTab}
        onChange={setActiveTab}
        className="w-full md:w-auto"
      />

      <Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label className={labelCls}>年度</label>
            <input type="number" className={inputCls} value={year} onChange={(event) => setYear(Number(event.target.value))} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>工號 / 姓名</label>
            <select className={inputCls} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">全部人員</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>{names.employeeMap.get(employee.id)}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <PrimaryButton onClick={() => void load()}>搜尋</PrimaryButton>
          </div>
        </div>
      </Card>

      {activeTab === "special" && (
        <Card>
          <h2 className="mb-4 text-sm font-medium text-gray-500">特殊假確認</h2>
          {loading ? (
            <Empty>載入中…</Empty>
          ) : specialRequests.length === 0 ? (
            <Empty>查無特殊假申請</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="py-2 pr-4">申請人</th>
                    <th className="py-2 pr-4">假別</th>
                    <th className="py-2 pr-4">期間</th>
                    <th className="py-2 pr-4">時數</th>
                    <th className="py-2 pr-4">原因</th>
                    <th className="py-2">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {specialRequests.map((request) => (
                    <tr key={request.id} className="border-b border-gray-50">
                      <td className="py-2 pr-4 font-medium text-gray-800">
                        {names.employeeMap.get(request.employee_id) ?? request.employee_id.slice(0, 8)}
                      </td>
                      <td className="py-2 pr-4">{request.leave_type_id ? names.leaveTypeMap.get(request.leave_type_id) : "未指定"}</td>
                      <td className="py-2 pr-4">
                        {request.start_at.slice(0, 10)} → {request.end_at.slice(0, 10)}
                      </td>
                      <td className="py-2 pr-4">{request.hours ?? "—"}</td>
                      <td className="py-2 pr-4">{request.reason ?? "—"}</td>
                      <td className="py-2">{request.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {activeTab === "query" && (
        <Card>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">總給假</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{totals.entitled + totals.deferred}</p>
            </div>
            <div className="rounded-xl bg-red-50 p-4">
              <p className="text-xs text-red-600">已使用</p>
              <p className="mt-1 text-2xl font-semibold text-red-700">{totals.used}</p>
            </div>
            <div className="rounded-xl bg-green-50 p-4">
              <p className="text-xs text-green-600">剩餘</p>
              <p className="mt-1 text-2xl font-semibold text-green-700">{totals.entitled + totals.deferred - totals.used}</p>
            </div>
          </div>
          <h2 className="mb-4 text-sm font-medium text-gray-500">剩餘假別時數</h2>
          {loading ? (
            <Empty>載入中…</Empty>
          ) : balances.length === 0 ? (
            <Empty>查無資料</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="py-2 pr-4">姓名</th>
                    <th className="py-2 pr-4">年度</th>
                    <th className="py-2 pr-4">假別</th>
                    <th className="py-2 pr-4">本年給假</th>
                    <th className="py-2 pr-4">遞延</th>
                    <th className="py-2 pr-4">已用</th>
                    <th className="py-2">剩餘</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((balance) => {
                    const available = Number(balance.entitled) + Number(balance.deferred) - Number(balance.used);
                    return (
                      <tr key={balance.id} className="border-b border-gray-50">
                        <td className="py-2 pr-4 font-medium text-gray-800">
                          {names.employeeMap.get(balance.employee_id) ?? balance.employee_id.slice(0, 8)}
                        </td>
                        <td className="py-2 pr-4">{balance.year}</td>
                        <td className="py-2 pr-4">{names.leaveTypeMap.get(balance.leave_type_id) ?? balance.leave_type_id.slice(0, 8)}</td>
                        <td className="py-2 pr-4">{Number(balance.entitled)}</td>
                        <td className="py-2 pr-4">{Number(balance.deferred)}</td>
                        <td className="py-2 pr-4">{Number(balance.used)}</td>
                        <td className="py-2">{available}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {activeTab === "grant" && (
        <Card>
          <h2 className="mb-4 text-sm font-medium text-gray-500">年度給假 / 調整</h2>
          <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-5">
            <div>
              <label className={labelCls}>員工</label>
              <select className={inputCls} value={editEmployeeId} onChange={(event) => setEditEmployeeId(event.target.value)} disabled={batchAll}>
                <option value="">請選擇</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>{names.employeeMap.get(employee.id)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>假別</label>
              <select className={inputCls} value={editLeaveTypeId} onChange={(event) => setEditLeaveTypeId(event.target.value)}>
                <option value="">請選擇</option>
                {leaveTypes.map((leaveType) => (
                  <option key={leaveType.id} value={leaveType.id}>{leaveType.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>本年給假時數</label>
              <input type="number" step="0.5" className={inputCls} value={entitled} onChange={(event) => setEntitled(event.target.value)} />
            </div>
            <div>
              <label className={labelCls}>遞延時數</label>
              <input type="number" step="0.5" className={inputCls} value={deferred} onChange={(event) => setDeferred(event.target.value)} />
            </div>
            <div className="flex items-end">
              <PrimaryButton type="submit">儲存</PrimaryButton>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 sm:col-span-5">
              <input type="checkbox" checked={batchAll} onChange={(event) => setBatchAll(event.target.checked)} />
              套用給全部員工
            </label>
          </form>
          {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
          {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
        </Card>
      )}
    </>
  );
}
