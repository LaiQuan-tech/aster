"use client";

import { useEffect, useMemo, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  getNotifications,
  isAdminRole,
  markNotificationRead,
  type Branding,
  type NotificationItem,
  type NotificationStatus,
} from "@/lib/ess-api";

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function NotificationsInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<NotificationStatus | "all">("all");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(filter = statusFilter) {
    setLoading(true);
    try {
      const res = await getNotifications(filter === "all" ? undefined : filter);
      setItems(res.notifications);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入通知失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    void load("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () => items.filter((item) => !onlyUnread || !isRead(item)),
    [items, onlyUnread],
  );
  const unreadCount = items.filter((item) => !isRead(item)).length;

  async function onChangeStatus(next: NotificationStatus | "all") {
    setStatusFilter(next);
    await load(next);
  }

  async function onMarkRead(id: string) {
    setMarkingId(id);
    try {
      await markNotificationRead(id);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, payload: { ...(item.payload ?? {}), read: true } } : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "標記已讀失敗");
    } finally {
      setMarkingId(null);
    }
  }

  async function markAllVisibleRead() {
    const unread = filtered.filter((item) => !isRead(item));
    for (const item of unread) {
      await onMarkRead(item.id);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader
        appName={branding?.appName}
        primaryColor={branding?.primaryColor}
        active="notifications"
        isAdmin={isAdmin}
      />
      <main className="mx-auto max-w-3xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">通知中心</h2>
              <p className="mt-1 text-sm text-gray-500">
                Apollo LinkUp 提醒入口：忘打卡、異常出勤、簽核與公告集中查看。
              </p>
            </div>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700">
              未讀 {unreadCount} 筆
            </span>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-center">
            <select
              value={statusFilter}
              onChange={(event) => void onChangeStatus(event.target.value as NotificationStatus | "all")}
              className="rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-gray-400 focus:outline-none sm:rounded-md sm:py-2"
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
            <button
              type="button"
              onClick={() => void markAllVisibleRead()}
              disabled={filtered.every(isRead)}
              className="rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-700 disabled:opacity-40 sm:rounded-md sm:py-2"
            >
              可見項目全標已讀
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-xl bg-gray-50 px-3 py-2.5 text-center text-sm text-gray-600 hover:underline sm:bg-transparent sm:p-0 sm:text-left sm:text-gray-500"
            >
              重新整理
            </button>
          </div>

          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {loading ? (
            <p className="text-sm text-gray-400">載入中…</p>
          ) : filtered.length === 0 ? (
            <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-400">目前沒有符合條件的通知</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filtered.map((item) => (
                <li key={item.id} className="py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span
                          className={`h-2 w-2 rounded-full ${isRead(item) ? "bg-gray-300" : "bg-amber-500"}`}
                          aria-label={isRead(item) ? "已讀" : "未讀"}
                        />
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          {TYPE_LABEL[item.type] ?? item.type}
                        </span>
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                          {STATUS_LABEL[item.status]}
                        </span>
                        <time className="text-xs text-gray-400">{formatDate(item.created_at)}</time>
                      </div>
                      <h3 className="font-medium text-gray-900">{item.title}</h3>
                      {item.body && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{item.body}</p>}
                      {item.payload?.date !== undefined && item.payload.date !== null && (
                        <p className="mt-1 text-xs text-gray-400">關聯日期：{String(item.payload.date)}</p>
                      )}
                    </div>
                    {!isRead(item) && (
                      <button
                        type="button"
                        onClick={() => void onMarkRead(item.id)}
                        disabled={markingId === item.id}
                        className="w-full shrink-0 rounded-xl px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto sm:rounded-md sm:py-1.5"
                        style={{ backgroundColor: "var(--brand)" }}
                      >
                        {markingId === item.id ? "處理中…" : "標記已讀"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default function NotificationsPage() {
  return (
    <EssTabGate tab="notifications" optimistic>
      <NotificationsInner />
    </EssTabGate>
  );
}
