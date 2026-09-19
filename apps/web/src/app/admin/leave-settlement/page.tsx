"use client";

/**
 * B8「假單月底核銷」第二階段：人資每月月底檢視當月已核准假單、核對憑證，
 * 逐筆（或整批）標記已核銷。核銷狀態存在 leave_requests 的 settled_at /
 * settled_by_emp_id / settled_period 三欄，不是新的簽核 status 值——這裡的
 * 「核銷狀態」篩選跟假單本身的簽核狀態無關，GET /leave-settlement 回來的資料
 * 一律是簽核已核准的假單。
 *
 * Pattern 來源（詳見 lib/leave-settlement-api.ts 檔頭與交付報告）：
 * - MonthPicker／部門下拉／狀態下拉／彙總卡／表格版型：app/admin/attendance-sheets/page.tsx
 * - 勾選批次操作（Record<string, boolean> + toggle）：app/admin/disbursements/page.tsx
 * - 附件數點開清單（expandable row + cache）：app/admin/expenses/page.tsx 的 AttachmentsList
 * - 「理由必填才能送出」的 destructive 動作：window.prompt，見
 *   app/admin/attendance-sheets/[id]/page.tsx 的 onReturn／onReopen
 * - 訊息提示：這個專案沒有 toast 元件庫，既有慣例是 message/error 這兩個
 *   inline state（綠字/ErrorText），這裡沿用同一套。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Card, PrimaryButton, ErrorText, Empty } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { getDepartments, type Department } from "@/lib/admin-api";
import {
  listLeaveSettlements,
  settleLeaveRequests,
  unsettleLeaveRequests,
  exportLeaveSettlementXlsx,
  listRequestAttachments,
  friendlySettlementError,
  summarizeSkipped,
  type SettlementItem,
  type SettlementSummary,
  type SettlementStatusFilter,
  type RequestAttachment,
} from "@/lib/leave-settlement-api";

const currentPeriod = new Date().toISOString().slice(0, 7);

const STATUS_FILTER_OPTIONS: { value: SettlementStatusFilter; label: string }[] = [
  { value: "unsettled", label: "未核銷" },
  { value: "settled", label: "已核銷" },
  { value: "all", label: "全部" },
];

const emptySummary: SettlementSummary = { totalCount: 0, settledCount: 0, unsettledCount: 0, hoursByLeaveType: [] };

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDateRange(start: string, end: string): string {
  return start === end ? start : `${start} ~ ${end}`;
}

function fmtDeductRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export default function LeaveSettlementPage() {
  const [period, setPeriod] = useState(currentPeriod);
  const [deptId, setDeptId] = useState("");
  const [statusFilter, setStatusFilter] = useState<SettlementStatusFilter>("unsettled");
  const [departments, setDepartments] = useState<Department[]>([]);

  const [summary, setSummary] = useState<SettlementSummary>(emptySummary);
  const [items, setItems] = useState<SettlementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [openAttachmentId, setOpenAttachmentId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Record<string, RequestAttachment[]>>({});
  const [attachmentsLoadingId, setAttachmentsLoadingId] = useState<string | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listLeaveSettlements({ period, deptId: deptId || undefined, status: statusFilter });
      setSummary(res.summary);
      setItems(res.items);
      setSelected({});
      setError(null);
    } catch (err) {
      setError(friendlySettlementError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [period, deptId, statusFilter]);

  useEffect(() => {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectableIds = useMemo(() => items.filter((item) => !item.settledAt).map((item) => item.id), [items]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected[id]);
  const hasSelection = Object.values(selected).some(Boolean);

  function toggleSelected(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const id of selectableIds) next[id] = true;
    setSelected(next);
  }

  async function runSettle(ids: string[]) {
    if (ids.length === 0) {
      setError("目前沒有可核銷的項目");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await settleLeaveRequests(period, ids);
      const skippedText = summarizeSkipped(res.skipped);
      setMessage(
        skippedText
          ? `已核銷 ${res.settled} 筆；略過 ${res.skipped.length} 筆（${skippedText}）`
          : `已核銷 ${res.settled} 筆`,
      );
      await load();
    } catch (err) {
      setError(friendlySettlementError(err, "核銷失敗"));
    } finally {
      setBusy(false);
    }
  }

  function onSettleSelected() {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    void runSettle(ids);
  }

  function onSettleAll() {
    void runSettle(selectableIds);
  }

  async function onUnsettle(item: SettlementItem) {
    const reason = window.prompt("請輸入取消核銷原因（必填，將記錄於稽核用途）：");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await unsettleLeaveRequests([item.id], reason.trim());
      setMessage(`已取消核銷 ${res.unsettled} 筆`);
      await load();
    } catch (err) {
      setError(friendlySettlementError(err, "取消核銷失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    setError(null);
    try {
      await exportLeaveSettlementXlsx(
        { period, deptId: deptId || undefined, status: statusFilter },
        `假單核銷_${period}.xlsx`,
      );
    } catch (err) {
      setError(friendlySettlementError(err, "匯出失敗"));
    }
  }

  async function toggleAttachments(item: SettlementItem) {
    if (openAttachmentId === item.id) {
      setOpenAttachmentId(null);
      return;
    }
    setOpenAttachmentId(item.id);
    if (attachments[item.id]) return;
    setAttachmentsLoadingId(item.id);
    setAttachmentsError(null);
    try {
      const res = await listRequestAttachments(item.id);
      setAttachments((prev) => ({ ...prev, [item.id]: res.attachments }));
    } catch (err) {
      setAttachmentsError(friendlySettlementError(err, "載入附件失敗"));
    } finally {
      setAttachmentsLoadingId(null);
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
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">核銷狀態</label>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as SettlementStatusFilter)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            >
              {STATUS_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <PrimaryButton type="button" onClick={() => void load()} disabled={loading}>
            搜尋
          </PrimaryButton>
          <button
            type="button"
            onClick={onSettleSelected}
            disabled={busy || !hasSelection}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            核銷勾選
          </button>
          <button
            type="button"
            onClick={onSettleAll}
            disabled={busy || selectableIds.length === 0}
            className="rounded-md border border-blue-300 px-4 py-2 text-sm font-medium text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            全部核銷
          </button>
          <button
            type="button"
            onClick={() => void onExport()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出 xlsx
          </button>
        </div>

        {message && <p className="mb-3 text-sm text-green-600">{message}</p>}
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">總筆數</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{summary.totalCount}</p>
          </div>
          <div className="rounded-xl bg-emerald-50 p-4">
            <p className="text-xs text-emerald-600">已核銷筆數</p>
            <p className="mt-1 text-xl font-semibold text-emerald-700">{summary.settledCount}</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-4">
            <p className="text-xs text-amber-600">未核銷筆數</p>
            <p className="mt-1 text-xl font-semibold text-amber-700">{summary.unsettledCount}</p>
          </div>
          <div className="rounded-xl bg-gray-50 p-4">
            <p className="text-xs text-gray-500">按假別時數合計</p>
            {summary.hoursByLeaveType.length === 0 ? (
              <p className="mt-1 text-sm text-gray-400">—</p>
            ) : (
              <p className="mt-1 text-sm leading-relaxed text-gray-800">
                {summary.hoursByLeaveType.map((h) => `${h.leaveTypeName} ${h.totalHours}h`).join("、")}
              </p>
            )}
          </div>
        </div>

        <h2 className="mb-4 text-sm font-medium text-gray-500">假單清單</h2>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : items.length === 0 ? (
          <Empty>查無符合條件的假單</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="全選" />
                  </th>
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">假別</th>
                  <th className="py-2 pr-3">期間</th>
                  <th className="py-2 pr-3 text-right">時數</th>
                  <th className="py-2 pr-3 text-right">扣假比率</th>
                  <th className="py-2 pr-3">附件</th>
                  <th className="py-2">核銷狀態</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <Fragment key={item.id}>
                    <tr className="border-b border-gray-50">
                      <td className="py-2 pr-3">
                        {!item.settledAt && (
                          <input
                            type="checkbox"
                            checked={!!selected[item.id]}
                            onChange={() => toggleSelected(item.id)}
                            aria-label={`勾選 ${item.employee.name}`}
                          />
                        )}
                      </td>
                      <td className="py-2 pr-3 font-medium text-gray-800">
                        {item.employee.employeeNo ? `${item.employee.employeeNo} · ${item.employee.name}` : item.employee.name}
                        <br />
                        <span className="text-xs font-normal text-gray-400">{item.employee.departmentName ?? "—"}</span>
                      </td>
                      <td className="py-2 pr-3 text-gray-700">{item.leaveType.name}</td>
                      <td className="py-2 pr-3 text-gray-600">
                        {fmtDateRange(item.startDate, item.endDate)}
                        {item.crossMonth && (
                          <span
                            className="ml-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700"
                            title="假單期間跨越月份：兩個月的清單都會列出，核銷一次即可（核銷月份以按下核銷時選的月份為準）"
                          >
                            跨月
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{item.hours}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtDeductRate(item.leaveType.deductRate)}</td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          onClick={() => void toggleAttachments(item)}
                          className={`text-xs underline ${
                            item.requiresAttachment && item.attachmentCount === 0 ? "text-red-600" : "text-blue-600"
                          }`}
                        >
                          {item.attachmentCount} 份{openAttachmentId === item.id ? "（收合）" : ""}
                        </button>
                      </td>
                      <td className="py-2">
                        {item.settledAt ? (
                          <div className="flex flex-col items-start gap-1">
                            <span className="text-xs text-gray-600">
                              {item.settledBy?.name ?? "—"} · {fmtDateTime(item.settledAt)}
                              {item.settledPeriod && item.settledPeriod !== period && (
                                <span className="ml-1 text-gray-400">（於 {item.settledPeriod} 核銷）</span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => void onUnsettle(item)}
                              disabled={busy}
                              className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              取消核銷
                            </button>
                          </div>
                        ) : (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">未核銷</span>
                        )}
                      </td>
                    </tr>
                    {openAttachmentId === item.id && (
                      <tr className="border-b border-gray-50 bg-gray-50">
                        <td colSpan={8} className="px-3 py-2">
                          {attachmentsLoadingId === item.id ? (
                            <span className="text-xs text-gray-500">載入中…</span>
                          ) : attachmentsError ? (
                            <ErrorText>{attachmentsError}</ErrorText>
                          ) : (attachments[item.id] ?? []).length === 0 ? (
                            <span className="text-xs text-gray-400">沒有附件。</span>
                          ) : (
                            <ul className="space-y-1">
                              {(attachments[item.id] ?? []).map((a) => (
                                <li key={a.id} className="text-xs">
                                  {a.fileName}
                                  <span className="ml-2 text-gray-500">{Math.round(a.sizeBytes / 1024)} KB</span>
                                  {a.url && (
                                    <a href={a.url} target="_blank" rel="noreferrer" className="ml-2 text-blue-600 underline">
                                      開啟
                                    </a>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
