"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, PageHeader, ErrorText, Empty, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import {
  batchDecideRequests,
  changeRequestApprover,
  deleteRequest,
  getApprovalFlows,
  getDepartments,
  getEmployees,
  getRequests,
  remindRequest,
  type ApprovalFlow,
  type Department,
  type Employee,
  type LeaveRequest,
  type RequestKind,
  type RequestStatus,
} from "@/lib/admin-api";

const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
};

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "簽核中",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
};

function downloadCsv(
  records: LeaveRequest[],
  employeeName: Map<string, string>,
  employeeDept: Map<string, string>,
  currentApprover: (record: LeaveRequest) => string,
) {
  const header = [
    "申請日期",
    "單位",
    "申請人",
    "表單類型",
    "起日",
    "迄日",
    "時數",
    "地點/代理/給付",
    "原因",
    "目前簽核人",
    "關卡",
    "狀態",
  ];
  const rows = records.map((record) => [
    record.created_at.slice(0, 10),
    employeeDept.get(record.employee_id) ?? "—",
    employeeName.get(record.employee_id) ?? record.employee_id,
    KIND_LABEL[record.kind],
    record.start_at.slice(0, 16).replace("T", " "),
    record.end_at.slice(0, 16).replace("T", " "),
    record.hours ?? "",
    [record.location, record.agent_name, record.payout].filter(Boolean).join(" / "),
    record.reason ?? record.remark ?? "",
    currentApprover(record),
    `第 ${record.current_step} 關`,
    STATUS_LABEL[record.status],
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll("\"", "\"\"")}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `form-records-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function FormRecordsPage() {
  const [records, setRecords] = useState<LeaveRequest[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [approvalFlows, setApprovalFlows] = useState<ApprovalFlow[]>([]);
  const [status, setStatus] = useState<"" | RequestStatus>("");
  const [kind, setKind] = useState<"" | RequestKind>("");
  const [deptId, setDeptId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [keyword, setKeyword] = useState("");
  const [adminComment, setAdminComment] = useState("");
  const [approverDrafts, setApproverDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const employeeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of employees) {
      map.set(employee.id, employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name);
    }
    return map;
  }, [employees]);

  const employeeById = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const employee of employees) {
      map.set(employee.id, employee);
    }
    return map;
  }, [employees]);

  const deptName = useMemo(() => {
    const map = new Map<string, string>();
    for (const department of departments) {
      map.set(department.id, department.name);
    }
    return map;
  }, [departments]);

  const employeeDept = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of employees) {
      map.set(employee.id, employee.dept_id ? (deptName.get(employee.dept_id) ?? "未命名單位") : "—");
    }
    return map;
  }, [deptName, employees]);

  const approvalFlowByKind = useMemo(() => {
    const map = new Map<RequestKind, string[]>();
    for (const flow of approvalFlows) {
      map.set(flow.applies_to, flow.approver_emp_ids ?? []);
    }
    return map;
  }, [approvalFlows]);

  const fallbackHrApprover = useMemo(
    () => employees.find((employee) => employee.role === "hr_admin" || employee.role === "platform_admin"),
    [employees],
  );

  const approverCandidates = useMemo(
    () => employees.filter((employee) => employee.status === "active"),
    [employees],
  );

  const currentApproverLabel = useCallback(
    (record: LeaveRequest) => {
      if (record.status !== "pending") return "—";
      const approverId =
        record.current_approver_emp_id ??
        approvalFlowByKind.get(record.kind)?.[record.current_step - 1] ??
        fallbackHrApprover?.id;
      const label = approverId ? employeeName.get(approverId) : undefined;
      return label ? `第 ${record.current_step} 關 · ${label}` : `第 ${record.current_step} 關 · 依後端簽核鏈`;
    },
    [approvalFlowByKind, employeeName, fallbackHrApprover],
  );

  const filtered = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    return records.filter((record) => {
      const employee = employeeById.get(record.employee_id);
      if (deptId && employee?.dept_id !== deptId) return false;
      if (!term) return true;
      const name = employeeName.get(record.employee_id) ?? "";
      const department = employeeDept.get(record.employee_id) ?? "";
      const content = [record.reason, record.remark, record.location, record.agent_name, currentApproverLabel(record)]
        .filter(Boolean)
        .join(" ");
      return (
        name.toLowerCase().includes(term) ||
        record.employee_id.toLowerCase().includes(term) ||
        department.toLowerCase().includes(term) ||
        content.toLowerCase().includes(term)
      );
    });
  }, [currentApproverLabel, deptId, employeeById, employeeDept, employeeName, keyword, records]);

  const stats = useMemo(() => {
    return {
      total: filtered.length,
      pending: filtered.filter((record) => record.status === "pending").length,
      approved: filtered.filter((record) => record.status === "approved").length,
      rejected: filtered.filter((record) => record.status === "rejected").length,
    };
  }, [filtered]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, empRes, deptRes, flowRes] = await Promise.all([
        getRequests({
          status: status || undefined,
          kind: kind || undefined,
          employeeId: employeeId || undefined,
          from: from || undefined,
          to: to || undefined,
        }),
        getEmployees(),
        getDepartments(),
        getApprovalFlows(),
      ]);
      setRecords(reqRes.requests);
      setEmployees(empRes.employees);
      setDepartments(deptRes.departments);
      setApprovalFlows(flowRes.flows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入表單紀錄失敗");
    } finally {
      setLoading(false);
    }
  }, [employeeId, from, kind, status, to]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remind(id: string) {
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      await remindRequest(id);
      setMessage("已送出催簽提醒");
    } catch (err) {
      setError(err instanceof Error ? err.message : "催簽失敗");
    } finally {
      setBusyId(null);
    }
  }

  async function proxyApprove(id: string) {
    if (!window.confirm("確定要以 HR 代理簽核核准此表單？")) return;
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      const result = await batchDecideRequests({
        ids: [id],
        action: "approve",
        comment: adminComment || "HR 代理簽核",
      });
      if (result.failed > 0) {
        const failed = result.results.find((item) => !item.ok);
        throw new Error(failed && !failed.ok ? failed.error : "代理簽核失敗");
      }
      setMessage("已完成 HR 代理簽核");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "代理簽核失敗");
    } finally {
      setBusyId(null);
    }
  }

  async function changeApprover(record: LeaveRequest) {
    const approverEmpId = approverDrafts[record.id] ?? record.current_approver_emp_id ?? "";
    if (!approverEmpId) {
      setError("請先選擇新的簽核人");
      return;
    }
    if (approverEmpId === record.current_approver_emp_id) {
      setMessage("目前簽核人未變更");
      return;
    }
    setBusyId(record.id);
    setError(null);
    setMessage(null);
    try {
      await changeRequestApprover(record.id, approverEmpId, adminComment || undefined);
      setMessage("已變更目前簽核人並送出通知");
      setApproverDrafts((drafts) => {
        const next = { ...drafts };
        delete next[record.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "變更簽核人失敗");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    // 註銷理由必填：伺服器端為軟刪除，紀錄與附件、簽核軌跡都會保留，
    // 理由會一併存進 delete_reason 供日後追溯。
    const reason = window.prompt(
      "註銷此表單紀錄。紀錄不會被刪除，僅標記為已註銷並保留追溯。\n請輸入註銷理由（必填）：",
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError("註銷理由為必填");
      return;
    }
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      await deleteRequest(id, reason.trim());
      setMessage("表單紀錄已註銷（紀錄保留）");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "註銷失敗");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader title="表單紀錄管理" desc="查詢、催簽、註銷與匯出請假、加班、補卡、公出/出差表單" />

      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">表單總數</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.total}</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-4">
            <p className="text-xs text-amber-700">簽核中</p>
            <p className="mt-1 text-2xl font-semibold text-amber-800">{stats.pending}</p>
          </div>
          <div className="rounded-xl bg-green-50 p-4">
            <p className="text-xs text-green-700">已核准</p>
            <p className="mt-1 text-2xl font-semibold text-green-800">{stats.approved}</p>
          </div>
          <div className="rounded-xl bg-red-50 p-4">
            <p className="text-xs text-red-700">已駁回</p>
            <p className="mt-1 text-2xl font-semibold text-red-800">{stats.rejected}</p>
          </div>
        </div>
      </Card>

      <Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-8">
          <div>
            <label className={labelCls}>表單狀態</label>
            <select className={inputCls} value={status} onChange={(event) => setStatus(event.target.value as "" | RequestStatus)}>
              <option value="">全部</option>
              <option value="pending">簽核中</option>
              <option value="approved">已核准</option>
              <option value="rejected">已駁回</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>表單類型</label>
            <select className={inputCls} value={kind} onChange={(event) => setKind(event.target.value as "" | RequestKind)}>
              <option value="">全部</option>
              <option value="leave">請假</option>
              <option value="ot">加班</option>
              <option value="fix_punch">補卡</option>
              <option value="business_trip">公出/出差</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>單位</label>
            <select className={inputCls} value={deptId} onChange={(event) => setDeptId(event.target.value)}>
              <option value="">全部單位</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </div>
          <div className="lg:col-span-2">
            <label className={labelCls}>工號 / 姓名</label>
            <select className={inputCls} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">全部人員</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>查詢起日</label>
            <input type="date" className={inputCls} value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>查詢迄日</label>
            <input type="date" className={inputCls} value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="flex items-end">
            <PrimaryButton onClick={() => void load()} disabled={loading}>搜尋</PrimaryButton>
          </div>
          <div className="lg:col-span-5">
            <label className={labelCls}>關鍵字</label>
            <input
              className={inputCls}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜尋姓名、工號、單位、原因、地點、代理人或目前簽核人"
            />
          </div>
          <div className="lg:col-span-2">
            <label className={labelCls}>管理備註</label>
            <input
              className={inputCls}
              value={adminComment}
              onChange={(event) => setAdminComment(event.target.value)}
              placeholder="代理簽核時寫入意見"
            />
          </div>
          <div className="flex items-end lg:col-span-2">
            <button
              type="button"
              onClick={() => downloadCsv(filtered, employeeName, employeeDept, currentApproverLabel)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
            >
              匯出 CSV
            </button>
          </div>
        </div>
      </Card>

      <Card>
        {message && <p className="mb-3 text-sm text-green-600">{message}</p>}
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : filtered.length === 0 ? (
          <Empty>查無表單紀錄</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">申請日期</th>
                  <th className="py-2 pr-4">單位</th>
                  <th className="py-2 pr-4">工號 / 姓名</th>
                  <th className="py-2 pr-4">表單類型</th>
                  <th className="py-2 pr-4">內容</th>
                  <th className="py-2 pr-4">目前簽核人</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2">管理</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr key={record.id} className="border-b border-gray-50 align-top">
                    <td className="py-3 pr-4">{record.created_at.slice(0, 10)}</td>
                    <td className="py-3 pr-4 text-gray-600">{employeeDept.get(record.employee_id) ?? "—"}</td>
                    <td className="py-3 pr-4 font-medium text-gray-800">
                      {employeeName.get(record.employee_id) ?? record.employee_id.slice(0, 8)}
                    </td>
                    <td className="py-3 pr-4">{KIND_LABEL[record.kind]}</td>
                    <td className="max-w-sm py-3 pr-4 text-gray-600">
                      <p>
                        {record.start_at.slice(0, 16).replace("T", " ")} → {record.end_at.slice(0, 16).replace("T", " ")}
                        {record.hours != null ? `，${record.hours} 小時` : ""}
                      </p>
                      {record.reason && <p className="text-xs text-gray-400">原因：{record.reason}</p>}
                      {record.location && <p className="text-xs text-gray-400">地點：{record.location}</p>}
                      {record.agent_name && <p className="text-xs text-gray-400">代理人：{record.agent_name}</p>}
                      {record.payout && <p className="text-xs text-gray-400">給付：{record.payout === "pay" ? "加班費" : "補休"}</p>}
                    </td>
                    <td className="py-3 pr-4 text-gray-600">{currentApproverLabel(record)}</td>
                    <td className="py-3 pr-4">
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
                        {STATUS_LABEL[record.status]}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void remind(record.id)}
                          disabled={busyId === record.id || record.status !== "pending"}
                          className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 disabled:opacity-50"
                        >
                          催簽
                        </button>
                        <button
                          type="button"
                          onClick={() => void proxyApprove(record.id)}
                          disabled={busyId === record.id || record.status !== "pending"}
                          className="rounded-md border border-green-300 px-3 py-1.5 text-xs font-medium text-green-700 disabled:opacity-50"
                        >
                          代理簽核
                        </button>
                        <button
                          type="button"
                          onClick={() => void changeApprover(record)}
                          disabled={busyId === record.id || record.status !== "pending"}
                          className="rounded-md border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 disabled:opacity-50"
                        >
                          變更簽核人
                        </button>
                        {record.status === "pending" && (
                          <select
                            className="rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                            value={approverDrafts[record.id] ?? record.current_approver_emp_id ?? ""}
                            onChange={(event) =>
                              setApproverDrafts((drafts) => ({ ...drafts, [record.id]: event.target.value }))
                            }
                          >
                            <option value="">選擇簽核人</option>
                            {approverCandidates.map((employee) => (
                              <option key={employee.id} value={employee.id}>
                                {employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          onClick={() => void remove(record.id)}
                          disabled={busyId === record.id || record.status === "approved"}
                          className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50"
                        >
                          註銷
                        </button>
                      </div>
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
