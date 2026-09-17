"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from "@/lib/ess-api";
import { invalidateEssState } from "@/lib/ess-state";
import { relativeTime } from "@/lib/ess-format";
import { isUnread, notificationLink, typeLabel } from "@/lib/ess-notifications";
import {
  Button,
  EmptyState,
  Icon,
  InlineError,
  Pill,
  SectionTitle,
  Segmented,
  Skeleton,
  useToast,
} from "@/components/ess-ui";

/**
 * /ess/notifications — 員工的通知列表（`GET /notifications?scope=mine`，HR 也只看自己的）。
 *
 * 投遞狀態（pending／sent／failed）對員工沒有意義，這頁不顯示也不能篩；只留
 * 「只看未讀」與「全部標為已讀」。整列可點：未讀就先標已讀，再依 `notificationLink()`
 * 導去對應頁（簽核／申請／補卡／出勤月表／打卡紀錄）；沒有對應頁的只展開內文。
 * 每次標記後 `invalidateEssState()`，底列的未讀徽章同頁就更新。
 */

/** 內文超過這個長度（或有換行）才顯示「展開全文」；短內文兩行放得下，不用多一顆按鈕。 */
const LONG_BODY_CHARS = 56;

function withRead(item: NotificationItem): NotificationItem {
  return { ...item, payload: { ...(item.payload ?? {}), read: true } };
}

function isLongBody(body: string | null): boolean {
  return !!body && (body.length > LONG_BODY_CHARS || body.includes("\n"));
}

export default function NotificationsPage() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  // 「只看未讀」切進來當下的未讀 id：這一輪點過（已讀）的列先留在畫面上，
  // 不然點一下要展開內文的列會立刻從清單消失。重抓或切回「全部」就重算。
  const [unreadSnapshot, setUnreadSnapshot] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getNotifications({ scope: "mine" });
      setItems(res.notifications);
      setUnreadSnapshot((prev) => (prev ? new Set(res.notifications.filter(isUnread).map((n) => n.id)) : null));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入通知失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unreadCount = useMemo(() => items.filter(isUnread).length, [items]);
  const visible = useMemo(
    () => (filter === "unread" ? items.filter((n) => isUnread(n) || unreadSnapshot?.has(n.id)) : items),
    [items, filter, unreadSnapshot],
  );

  function changeFilter(next: "all" | "unread") {
    setFilter(next);
    setUnreadSnapshot(next === "unread" ? new Set(items.filter(isUnread).map((n) => n.id)) : null);
  }

  /** 標單筆已讀：先樂觀更新，失敗再還原並提示。回傳是否成功。 */
  async function markRead(item: NotificationItem): Promise<boolean> {
    setItems((current) => current.map((n) => (n.id === item.id ? withRead(n) : n)));
    try {
      await markNotificationRead(item.id);
      invalidateEssState();
      return true;
    } catch (err) {
      setItems((current) => current.map((n) => (n.id === item.id ? item : n)));
      toast.show(err instanceof Error ? err.message : "標記已讀失敗", "error");
      return false;
    }
  }

  /** 整列點擊：未讀就先標已讀，有對應頁就導頁，沒有就切換展開。 */
  async function onRowClick(item: NotificationItem) {
    if (busyId) return;
    const link = notificationLink(item);
    setBusyId(item.id);
    try {
      if (isUnread(item)) await markRead(item);
      if (link) {
        router.push(link);
      } else {
        setExpandedId((cur) => (cur === item.id ? null : item.id));
      }
    } finally {
      setBusyId(null);
    }
  }

  /** 全部標為已讀：走 read-all；舊 API 沒有這支（404）就退化成逐筆。 */
  async function onMarkAllRead() {
    const unread = items.filter(isUnread);
    if (unread.length === 0) return;
    setMarkingAll(true);
    try {
      let done = 0;
      try {
        await markAllNotificationsRead();
        done = unread.length;
      } catch {
        for (const item of unread) {
          try {
            await markNotificationRead(item.id);
            done += 1;
            setItems((current) => current.map((n) => (n.id === item.id ? withRead(n) : n)));
          } catch {
            // 逐筆失敗的留著未讀，最後統一提示
          }
        }
        if (done < unread.length) {
          toast.show(`有 ${unread.length - done} 則沒標成功，請再試一次`, "error");
        }
      }
      if (done === unread.length) {
        setItems((current) => current.map(withRead));
        toast.show("已全部標為已讀", "success");
      }
    } finally {
      invalidateEssState();
      setMarkingAll(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <SectionTitle>通知</SectionTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onMarkAllRead()}
          disabled={loading || unreadCount === 0}
          loading={markingAll}
        >
          全部標為已讀
        </Button>
      </div>

      <Segmented
        aria-label="通知篩選"
        value={filter}
        onChange={changeFilter}
        options={[
          { value: "all", label: "全部" },
          { value: "unread", label: unreadCount > 0 ? `只看未讀（${unreadCount}）` : "只看未讀" },
        ]}
      />

      <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
        {error && (
          <div className="px-4 pt-4">
            <InlineError>{error}</InlineError>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => void load()} disabled={loading}>
              重新整理
            </Button>
          </div>
        )}
        {loading ? (
          <div className="p-4">
            <Skeleton lines={6} />
          </div>
        ) : visible.length === 0 ? (
          !error && (
            <EmptyState
              title={filter === "unread" ? "沒有未讀通知" : "沒有通知"}
              hint={filter === "unread" ? "所有通知都看過了。" : "忘打卡提醒、簽核結果、出勤月表會出現在這裡。"}
            />
          )
        ) : (
          <ul className="divide-y divide-gray-100">
            {visible.map((item) => {
              const unread = isUnread(item);
              const link = notificationLink(item);
              const expanded = expandedId === item.id;
              const body = item.body?.trim() || null;
              const showToggle = !!link && isLongBody(body);
              return (
                <li key={item.id} className={unread ? "bg-amber-50/40" : undefined}>
                  <button
                    type="button"
                    onClick={() => void onRowClick(item)}
                    disabled={busyId === item.id}
                    aria-expanded={link ? undefined : expanded}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition active:bg-gray-50 disabled:opacity-70"
                  >
                    <span
                      className={`mt-2 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-amber-500" : "bg-transparent"}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      {unread && <span className="sr-only">未讀：</span>}
                      <span className="flex items-center gap-2">
                        <Pill tone="gray">{typeLabel(item.type)}</Pill>
                        <time dateTime={item.created_at} className="ml-auto shrink-0 text-xs text-gray-400">
                          {relativeTime(item.created_at)}
                        </time>
                      </span>
                      <span
                        className={`mt-1 block text-base leading-snug sm:text-sm ${unread ? "font-semibold text-gray-900" : "font-medium text-gray-800"}`}
                      >
                        {item.title}
                      </span>
                      {body && (
                        <span
                          className={`mt-0.5 block whitespace-pre-line text-sm text-gray-600 ${expanded ? "" : "line-clamp-2"}`}
                        >
                          {body}
                        </span>
                      )}
                    </span>
                    {link && <Icon name="chevron" className="mt-1 h-5 w-5 shrink-0 text-gray-300" />}
                  </button>
                  {showToggle && (
                    <div className="px-4 pb-3 pl-9">
                      <button
                        type="button"
                        onClick={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                        aria-expanded={expanded}
                        className="text-xs text-gray-500 underline underline-offset-2"
                      >
                        {expanded ? "收合" : "展開全文"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
