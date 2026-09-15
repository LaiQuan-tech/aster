"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, PageHeader, ErrorText, Empty, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import {
  batchDecideRequests,
  getDepartments,
  getEmployees,
  getRequestAttachments,
  getRequests,
  rejectRequest,
  approveRequest,
  type Department,
  type LeaveRequest,
  type RequestKind,
  type RequestStatus,
  type Employee,
} from "@/lib/admin-api";

type RequestAttachment = { id: string; fileName: string; sizeBytes: number; contentType: string; url: string };

const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
};

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "待審核",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
};

const STATUS_CLASS: Record<RequestStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-600",
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function contentLines(row: LeaveRequest): string[] {
  const period = `${fmt(row.start_at)} → ${fmt(row.end_at)}`;
  const lines = [row.hours != null ? `${period}（${row.hours} 小時）` : period];
  const main = row.reason || row.remark;
  if (main) lines.push(main);
  if (row.location) lines.push(`地點：${row.location}`);
  if (row.agent_name) lines.push(`代理人：${row.agent_name}`);
  if (row.trip_type) lines.push(`類型：${row.trip_type === "outing" ? "公出" : "出差"}`);
  if (row.payout) lines.push(`加班給付：${row.payout === "pay" ? "加班費" : "補休"}`);
  return lines;
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<LeaveRequest[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [status, setStatus] = useState<"" | RequestStatus>("pending");
  const [kind, setKind] = useState<"" | RequestKind>("");
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 附件清單：展開哪一張單 + 各單已抓到的附件（用 id 當 key 快取，避免重複打 API）
  const [expandedAttachmentsId, setExpandedAttachmentsId] = useState<string | null>(null);
  const [attachmentsById, setAttachmentsById] = useState<Record<string, RequestAttachment[]>>({});
  const [attachmentsLoadingId, setAttachmentsLoadingId] = useState<string | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<Record<string, string>>({});

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

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectableRows = useMemo(() => rows.filter((row) => row.status === "pending"), [rows]);
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedSet.has(row.id));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, empRes, deptRes] = await Promise.all([
        getRequests({
          status: status || undefined,
          kind: kind || undefined,
          employeeId: employeeId || undefined,
          from: from || undefined,
          to: to || undefined,
        }),
        getEmployees(),
        getDepartments(),
      ]);
      setRows(reqRes.requests);
      setEmployees(empRes.employees);
      setDepartments(deptRes.departments);
      setSelectedIds((ids) =>
        ids.filter((id) => reqRes.requests.some((request) => request.id === id && request.status === "pending")),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [employeeId, from, kind, status, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleOne(id: string) {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]));
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : selectableRows.map((row) => row.id));
  }

  function employeeLabel(employee: Employee | undefined, fallbackId: string) {
    if (!employee) return fallbackId.slice(0, 8);
    return employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name;
  }

  function departmentLabel(employee: Employee | undefined) {
    if (!employee?.dept_id) return "—";
    return deptName.get(employee.dept_id) ?? "未命名單位";
  }

  /** 展開/收合附件清單；展開時才現拉 signed URL，並用 attachmentsById 快取。 */
  async function toggleAttachments(requestId: string) {
    if (expandedAttachmentsId === requestId) {
      setExpandedAttachmentsId(null);
      return;
    }
    setExpandedAttachmentsId(requestId);
    if (attachmentsById[requestId]) return;
    setAttachmentsLoadingId(requestId);
    try {
      const res = await getRequestAttachments(requestId);
      setAttachmentsById((prev) => ({ ...prev, [requestId]: res.attachments }));
      setAttachmentsError((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    } catch (err) {
      setAttachmentsError((prev) => ({
        ...prev,
        [requestId]: err instanceof Error ? err.message : "載入附件失敗",
      }));
    } finally {
      setAttachmentsLoadingId((cur) => (cur === requestId ? null : cur));
    }
  }

  async function decide(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      if (action === "approve") await approveRequest(id, comment || undefined);
      else await rejectRequest(id, comment || undefined);
      setMessage(action === "approve" ? "已核准 1 張表單" : "已駁回 1 張表單");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "處理失敗");
    } finally {
      setBusyId(null);
    }
  }

  async function batch(action: "approve" | "reject") {
    if (selectedIds.length === 0) {
      setError("請先勾選要批次處理的表單");
      return;
    }
    setBusyId("batch");
    setError(null);
    setMessage(null);
    try {
      const result = await batchDecideRequests({
        ids: selectedIds,
        action,
        comment: comment || undefined,
      });
      setMessage(`批次完成：成功 ${result.ok} 張，失敗 ${result.failed} 張`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "批次處理失敗");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader title="簽核" desc="待處理表單、批次核准/駁回、依人員與表單類型快速篩選" />

      <Card>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-7">
          <div>
            <label className={labelCls}>狀態</label>
            <select
              className={inputCls}
              value={status}
              onChange={(event) => setStatus(event.target.value as "" | RequestStatus)}
            >
              <option value="">全部</option>
              <option value="pending">待審核</option>
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
            <label className={labelCls}>申請起日</label>
            <input type="date" className={inputCls} value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>申請迄日</label>
            <input type="date" className={inputCls} value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="flex items-end">
            <PrimaryButton onClick={() => void load()} disabled={loading}>
              搜尋
            </PrimaryButton>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_auto]">
          <div>
            <label className={labelCls}>簽核意見</label>
            <input
              className={inputCls}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="可輸入批次或單筆簽核意見"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void batch("reject")}
              disabled={busyId === "batch" || selectedIds.length === 0}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              批次駁回
            </button>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void batch("approve")}
              disabled={busyId === "batch" || selectedIds.length === 0}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              批次核准
            </button>
          </div>
        </div>

        {message && <p className="mb-3 text-sm text-green-600">{message}</p>}
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>目前沒有符合條件的申請</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="w-10 py-2 pr-4">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全選" />
                  </th>
                  <th className="py-2 pr-4">單位</th>
                  <th className="py-2 pr-4">工號 / 姓名</th>
                  <th className="py-2 pr-4">表單類型</th>
                  <th className="py-2 pr-4">申請日期</th>
                  <th className="py-2 pr-4">內容</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2 pr-4">目前關卡</th>
                  <th className="py-2 pr-4">附件</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const employee = employeeById.get(row.employee_id);
                  const canDecide = row.status === "pending";
                  return (
                    <tr key={row.id} className="border-b border-gray-50 align-top">
                      <td className="py-3 pr-4">
                        <input
                          type="checkbox"
                          checked={selectedSet.has(row.id)}
                          disabled={!canDecide}
                          onChange={() => toggleOne(row.id)}
                          aria-label={`選取 ${row.id}`}
                        />
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{departmentLabel(employee)}</td>
                      <td className="py-3 pr-4 font-medium text-gray-800">
                        {employeeLabel(employee, row.employee_id)}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
                          {KIND_LABEL[row.kind]}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{dateOnly(row.created_at)}</td>
                      <td className="max-w-sm py-3 pr-4 text-gray-600">
                        {contentLines(row).map((line, index) => (
                          <p key={`${row.id}-${index}`} className={index === 0 ? "" : "text-xs text-gray-400"}>
                            {line}
                          </p>
                        ))}
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`rounded-full px-2 py-1 text-xs ${STATUS_CLASS[row.status]}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-700">
                          第 {row.current_step} 關
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <button
                          type="button"
                          onClick={() => void toggleAttachments(row.id)}
                          className="text-xs font-medium underline underline-offset-2"
                          style={{ color: "var(--brand)" }}
                        >
                          {expandedAttachmentsId === row.id ? "收合附件" : "查看附件"}
                        </button>
                        {expandedAttachmentsId === row.id && (
                          <div className="mt-1 max-w-[12rem]">
                            {attachmentsLoadingId === row.id ? (
                              <p className="text-xs text-gray-400">載入中…</p>
                            ) : attachmentsError[row.id] ? (
                              <p className="text-xs text-red-600">{attachmentsError[row.id]}</p>
                            ) : (attachmentsById[row.id] ?? []).length === 0 ? (
                              <p className="text-xs text-gray-400">無附件</p>
                            ) : (
                              <ul className="space-y-0.5">
                                {(attachmentsById[row.id] ?? []).map((att) => (
                                  <li key={att.id} className="truncate">
                                    <a
                                      href={att.url ?? "#"}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-xs underline"
                                      style={{ color: "var(--brand)" }}
                                      title={att.fileName}
                                    >
                                      {att.fileName}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => void decide(row.id, "approve")}
                            disabled={!canDecide || busyId === row.id}
                            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                          >
                            核准
                          </button>
                          <button
                            onClick={() => void decide(row.id, "reject")}
                            disabled={!canDecide || busyId === row.id}
                            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                          >
                            駁回
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
