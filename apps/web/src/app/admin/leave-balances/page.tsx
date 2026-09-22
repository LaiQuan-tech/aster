"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PrimaryButton, ErrorText, Empty, Segmented, inputCls, labelCls } from "@/components/admin-ui";
import {
  getEmployees,
  getLeaveBalancesAdmin,
  getLeaveTypes,
  getRequests,
  type Employee,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
} from "@/lib/admin-api";
import {
  balancePeriodLabel,
  balanceSourceClass,
  balanceSourceLabel,
  putLeaveBalance,
  runAnnualGrant,
  type AnnualGrantEntry,
  type AnnualGrantResult,
} from "@/lib/leave-balances-api";

const yearNow = new Date().getFullYear();
const tabs = [
  { id: "special", label: "特殊假確認" },
  { id: "query", label: "剩餘假別時數" },
  { id: "grant", label: "年度給假" },
] as const;

type TabId = (typeof tabs)[number]["id"];

/** 今天（本機時區）'YYYY-MM-DD'，給「基準日」欄位當預設值。 */
function todayKey(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const SKIP_REASONS: Record<string, string> = {
  calendar_basis: "規則設為曆年制，不自動給假",
  not_hired_yet: "到職日晚於基準日",
  under_six_months: "年資未滿 6 個月",
  already_granted: "本期已有餘額桶",
};

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
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [batchAll, setBatchAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 週年制年度給假（W1）：先 dryRun 預覽、核對清單後才正式執行。
  const [grantAsOf, setGrantAsOf] = useState(todayKey());
  const [grantMigrate, setGrantMigrate] = useState(false);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantPreview, setGrantPreview] = useState<AnnualGrantResult | null>(null);
  const [grantDone, setGrantDone] = useState<AnnualGrantResult | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

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
        await putLeaveBalance({
          employeeId: targetEmployeeId,
          leaveTypeId: editLeaveTypeId,
          year,
          entitled: Number(entitled),
          deferred: deferred ? Number(deferred) : undefined,
          // 期間留白＝沿用曆年（該年 1/1～12/31）；填了就是手調某一段週年期。
          periodStart: periodStart || undefined,
          periodEnd: periodEnd || undefined,
        });
      }
      setMessage(batchAll ? `已批次給假 ${targetEmployeeIds.length} 人` : "假別時數已儲存");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  /** dryRun=true 只算不寫；dryRun=false 才真的發放／搬遷。 */
  async function runGrant(dryRun: boolean) {
    setGrantBusy(true);
    setGrantError(null);
    if (dryRun) setGrantDone(null);
    try {
      const result = await runAnnualGrant({
        asOf: grantAsOf || undefined,
        dryRun,
        migrate: grantMigrate,
      });
      if (dryRun) {
        setGrantPreview(result);
      } else {
        setGrantDone(result);
        setGrantPreview(null);
        await load();
      }
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : "年度給假失敗");
    } finally {
      setGrantBusy(false);
    }
  }

  const grantShown = grantDone ?? grantPreview;
  const grantRows: AnnualGrantEntry[] = grantShown
    ? [...grantShown.granted, ...grantShown.migrated, ...grantShown.skipped]
    : [];

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
            <p className="mt-1 text-xs text-gray-400">週年制下＝「期間與這一年重疊」的餘額桶</p>
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
                    <th className="py-2 pr-4">期間</th>
                    <th className="py-2 pr-4">來源</th>
                    <th className="py-2 pr-4">假別</th>
                    <th className="py-2 pr-4">本期給假</th>
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
                        <td className="py-2 pr-4 whitespace-nowrap">{balancePeriodLabel(balance)}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${balanceSourceClass(balance.source)}`}
                            title={balance.note ?? undefined}
                          >
                            {balanceSourceLabel(balance.source)}
                          </span>
                        </td>
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
        <>
          <Card>
            <h2 className="mb-1 text-sm font-medium text-gray-500">特休週年制 · 年度給假</h2>
            <p className="mb-4 text-xs text-gray-400">
              依每個人的到職日週年期間與年資表（規則參數 → 特休）自動發放；已有本期餘額桶的人會自動跳過。
              先「預覽」核對清單，確認無誤再「正式執行」。
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <label className={labelCls}>基準日</label>
                <input type="date" className={inputCls} value={grantAsOf} onChange={(event) => setGrantAsOf(event.target.value)} />
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm text-gray-600 sm:col-span-2">
                <input type="checkbox" checked={grantMigrate} onChange={(event) => setGrantMigrate(event.target.checked)} />
                同時把舊的曆年列搬成週年期（上線一次性）
              </label>
              <div className="flex items-end gap-2">
                <PrimaryButton onClick={() => void runGrant(true)} disabled={grantBusy}>
                  {grantBusy ? "處理中…" : "預覽"}
                </PrimaryButton>
                <button
                  type="button"
                  className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 disabled:opacity-40"
                  disabled={grantBusy || !grantPreview}
                  onClick={() => void runGrant(false)}
                >
                  正式執行
                </button>
              </div>
            </div>
            {grantError && <div className="mt-3"><ErrorText>{grantError}</ErrorText></div>}
            {grantShown && (
              <div className="mt-4">
                <p className={`text-sm ${grantShown.dryRun ? "text-amber-600" : "text-green-600"}`}>
                  {grantShown.dryRun ? "預覽（尚未寫入）" : "已執行"}：基準日 {grantShown.asOf}、
                  假別 {grantShown.leaveTypeCode}、每日工時 {grantShown.dailyRegularHours} 小時、
                  新增 {grantShown.granted.length}、搬遷 {grantShown.migrated.length}、跳過 {grantShown.skipped.length}
                  {grantShown.basis === "calendar" && "（規則目前是曆年制，不會自動發放）"}
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="py-2 pr-4">姓名</th>
                        <th className="py-2 pr-4">到職日</th>
                        <th className="py-2 pr-4">週年期間</th>
                        <th className="py-2 pr-4">年資（月）</th>
                        <th className="py-2 pr-4">天數</th>
                        <th className="py-2 pr-4">時數</th>
                        <th className="py-2">結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grantRows.map((row) => (
                        <tr key={`${row.employeeId}-${row.action}`} className="border-b border-gray-50">
                          <td className="py-2 pr-4 font-medium text-gray-800">
                            {row.empNo ? `${row.empNo} · ${row.name}` : row.name}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">{row.hireDate || "—"}</td>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {row.periodStart && row.periodEnd ? `${row.periodStart} ～ ${row.periodEnd}` : "—"}
                          </td>
                          <td className="py-2 pr-4">{row.seniorityMonths}</td>
                          <td className="py-2 pr-4">{row.days}</td>
                          <td className="py-2 pr-4">{row.entitledHours}</td>
                          <td className="py-2">
                            {row.action === "granted" && <span className="text-green-700">新增</span>}
                            {row.action === "migrated" && (
                              <span className="text-amber-700">
                                由曆年 {row.fromYear} 搬遷（已用 {row.usedHours} 小時）
                              </span>
                            )}
                            {row.action === "skipped" && (
                              <span className="text-gray-500">跳過 · {SKIP_REASONS[row.reason ?? ""] ?? row.reason}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {grantRows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="py-3 text-gray-400">沒有符合條件的員工（需在職且有到職日）</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-1 text-sm font-medium text-gray-500">手動給假 / 調整</h2>
            <p className="mb-4 text-xs text-gray-400">
              期間留白＝沿用曆年（上方「年度」的 1/1～12/31）；要調某一段週年期就填期間起日（迄日留白＝起日 + 1 年 − 1 天）。
            </p>
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
                <label className={labelCls}>本期給假時數</label>
                <input type="number" step="0.5" className={inputCls} value={entitled} onChange={(event) => setEntitled(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>遞延時數</label>
                <input type="number" step="0.5" className={inputCls} value={deferred} onChange={(event) => setDeferred(event.target.value)} />
              </div>
              <div className="flex items-end">
                <PrimaryButton type="submit">儲存</PrimaryButton>
              </div>
              <div>
                <label className={labelCls}>期間起日（選填）</label>
                <input type="date" className={inputCls} value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>期間迄日（選填）</label>
                <input type="date" className={inputCls} value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-600 sm:col-span-5">
                <input type="checkbox" checked={batchAll} onChange={(event) => setBatchAll(event.target.checked)} />
                套用給全部員工
              </label>
            </form>
            {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
            {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
          </Card>
        </>
      )}
    </>
  );
}
