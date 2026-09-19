"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText } from "@/components/admin-ui";
import {
  deliverPendingNotifications,
  getNotifications,
  markNotificationRead,
  type NotificationItem,
  type NotificationStatus,
} from "@/lib/admin-api";

const STATUS_LABEL: Record<NotificationStatus, string> = {
  pending: "待處理",
  sent: "已送出",
  failed: "投遞失敗",
};

const TYPE_LABEL: Record<string, string> = {
  missing_punch: "忘打卡",
  anomaly: "異常出勤",
  approval: "簽核提醒",
  report: "報表通知",
  announcement: "公告",
};

function isRead(item: NotificationItem): boolean {
  return item.payload?.read === true;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminNotificationsPage() {
  const [rows, setRows] = useState<NotificationItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<NotificationStatus | "all">("all");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (status = statusFilter) => {
    setLoading(true);
    try {
      const res = await getNotifications(status === "all" ? undefined : status);
      setRows(res.notifications);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入通知失敗");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load("all");
  }, [load]);

  const visibleRows = useMemo(
    () => rows.filter((row) => !onlyUnread || !isRead(row)),
    [rows, onlyUnread],
  );
  const unreadCount = rows.filter((row) => !isRead(row)).length;

  async function changeStatus(next: NotificationStatus | "all") {
    setStatusFilter(next);
    await load(next);
  }

  async function markRead(id: string) {
    setMarkingId(id);
    try {
      await markNotificationRead(id);
      setRows((current) =>
        current.map((row) =>
          row.id === id ? { ...row, payload: { ...(row.payload ?? {}), read: true } } : row,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "標記已讀失敗");
    } finally {
      setMarkingId(null);
    }
  }

  async function deliverPending() {
    setDelivering(true);
    setMessage(null);
    setError(null);
    try {
      const result = await deliverPendingNotifications(50);
      setMessage(
        `投遞完成：掃描 ${result.scanned}、送出 ${result.delivered}、失敗 ${result.failed}、略過 ${result.skipped}`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "投遞失敗");
    } finally {
      setDelivering(false);
    }
  }

  return (
    <>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">通知佇列</h2>
            <p className="mt-1 text-sm text-gray-500">
              HR 可查看全租戶通知；員工端只會看到自己的通知。
            </p>
          </div>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700">
            未讀 {unreadCount} 筆
          </span>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <select
            value={statusFilter}
            onChange={(event) => void changeStatus(event.target.value as NotificationStatus | "all")}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
          >
            <option value="all">全部狀態</option>
            <option value="pending">待處理</option>
            <option value="sent">已送出</option>
            <option value="failed">投遞失敗</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={onlyUnread}
              onChange={(event) => setOnlyUnread(event.target.checked)}
            />
            只看未讀
          </label>
          <button type="button" onClick={() => void load()} className="text-sm text-gray-500 hover:underline">
            重新整理
          </button>
          <button
            type="button"
            onClick={() => void deliverPending()}
            disabled={delivering}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            {delivering ? "投遞中…" : "投遞待處理通知"}
          </button>
        </div>

        {message && <p className="mb-3 text-sm text-green-700">{message}</p>}
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : visibleRows.length === 0 ? (
          <Empty>目前沒有符合條件的通知</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">時間</th>
                  <th className="py-2 pr-4">類型</th>
                  <th className="py-2 pr-4">收件員工</th>
                  <th className="py-2 pr-4">標題 / 內容</th>
                  <th className="py-2 pr-4">Channel</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2">已讀</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50 align-top">
                    <td className="py-3 pr-4 whitespace-nowrap text-gray-500">{fmt(row.created_at)}</td>
                    <td className="py-3 pr-4">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {TYPE_LABEL[row.type] ?? row.type}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-gray-500">{row.employee_id.slice(0, 8)}</td>
                    <td className="py-3 pr-4">
                      <p className="font-medium text-gray-900">{row.title}</p>
                      {row.body && <p className="mt-1 whitespace-pre-wrap text-gray-600">{row.body}</p>}
                      {row.payload?.date !== undefined && row.payload.date !== null && (
                        <p className="mt-1 text-xs text-gray-400">關聯日期：{String(row.payload.date)}</p>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-gray-600">{row.channel}</td>
                    <td className="py-3 pr-4">{STATUS_LABEL[row.status]}</td>
                    <td className="py-3">
                      {isRead(row) ? (
                        <span className="text-gray-400">已讀</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void markRead(row.id)}
                          disabled={markingId === row.id}
                          className="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                          style={{ backgroundColor: "var(--brand)" }}
                        >
                          {markingId === row.id ? "處理中…" : "標記已讀"}
                        </button>
                      )}
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
