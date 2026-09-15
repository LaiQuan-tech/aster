"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { EssHeader, type EssTabKey } from "@/components/EssHeader";
import { visibleTabs } from "@/lib/ess-tabs";
import {
  getBranding,
  getPunchToday,
  getAnnouncements,
  recordAnnouncementView,
  getPersonalNote,
  getRequests,
  postPunch,
  savePersonalNote,
  getMe,
  isAdminRole,
  type Branding,
  type PunchRecord,
  type Announcement,
} from "@/lib/ess-api";

interface InternalLink {
  name: string;
  url: string;
  enabled?: boolean;
  sort?: number;
}

/**
 * 「我的快捷」格子；依 essTabs 過濾用（見 EssHome 內的 visibleTabs 呼叫）。
 * `key` 對應該格子連去的分頁在 lib/ess-tabs.ts／EssHeader 的 tab key——
 * 同一個 tab（如「我的申請」底下的請假/加班/忘打卡/公出）可以有多個格子
 * 共用同一個 key，過濾時視為一體被藏起或放行。
 */
const QUICK_LINKS: ReadonlyArray<{ key: EssTabKey; label: string; href: string }> = [
  { key: "requests", label: "請假", href: "/ess/requests" },
  { key: "requests", label: "加班", href: "/ess/requests" },
  { key: "requests", label: "忘打卡申請", href: "/ess/requests" },
  { key: "requests", label: "公出/出差", href: "/ess/requests" },
  { key: "schedule", label: "個人班表", href: "/ess/schedule" },
  { key: "punches", label: "打卡紀錄", href: "/ess/punches" },
  { key: "balances", label: "剩餘假別", href: "/ess/balances" },
  { key: "payslips", label: "我的薪資單", href: "/ess/payslips" },
  { key: "jobs", label: "內部職缺", href: "/ess/jobs" },
  { key: "notifications", label: "通知中心", href: "/ess/notifications" },
  { key: "ai", label: "AI 問答", href: "/ess/ai" },
  { key: "mydata", label: "我的資料", href: "/ess/mydata" },
];

function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

/** Try to read a GPS fix; resolve to null if unavailable/denied/timed out. */
function tryGeolocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 5000, enableHighAccuracy: false },
    );
  });
}

function EssHome() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [records, setRecords] = useState<PunchRecord[]>([]);
  const [status, setStatus] = useState<"working" | "off">("off");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [internalLinks, setInternalLinks] = useState<InternalLink[]>([]);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "local">("idle");
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  // null＝不限縮（預設狀態，/me 回來前也是這個值，快捷格子先全部顯示，等
  // essTabs 若真的有限縮清單再收斂——跟 EssTabGate optimistic 同一種取捨）。
  const [essTabs, setEssTabs] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [punching, setPunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPunch = useCallback(async () => {
    const today = await getPunchToday();
    setRecords(today.records);
    setStatus(today.status);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      // Branding + announcements + me are best-effort; punch is the core.
      const [brandRes, annRes, meRes, noteRes] = await Promise.allSettled([
        getBranding(),
        getAnnouncements(),
        getMe(),
        getPersonalNote(),
      ]);
      if (!active) return;
      if (brandRes.status === "fulfilled") {
        setBranding(brandRes.value.branding);
        const links = ((brandRes.value.features?.internalLinks as InternalLink[] | undefined) ?? [])
          .filter((link) => link.enabled !== false)
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
        setInternalLinks(links);
      }
      if (annRes.status === "fulfilled") {
        const list = annRes.value.announcements;
        setAnnouncements(list);
        // 只對**需簽收的規章**記錄查閱：一般佈告不記，規章少、佈告多，
        // 對每則都寫一次既無意義也浪費。伺服器只保留第一次查閱時間。
        // 這是被動 log，不是「勾選同意」——後者客戶明確排斥。
        for (const a of list) {
          if (a.requires_signature && a.current_version_id) {
            void recordAnnouncementView(a.current_version_id).catch(() => null);
          }
        }
      }
      getRequests("pending").then((r) => setPendingCount(r.requests.length)).catch(() => null);
      if (noteRes.status === "fulfilled") {
        setNote(noteRes.value.note.body);
        setNoteStatus("saved");
        try {
          localStorage.setItem("ess-sticky-note", noteRes.value.note.body);
        } catch {
          /* private mode */
        }
      } else {
        try {
          setNote(localStorage.getItem("ess-sticky-note") ?? "");
          setNoteStatus("local");
        } catch {
          setNoteStatus("local");
        }
      }
      if (meRes.status === "fulfilled") {
        setIsAdmin(isAdminRole(meRes.value.role));
        setEssTabs(Array.isArray(meRes.value.essTabs) ? meRes.value.essTabs : null);
      }
      try {
        await loadPunch();
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "載入打卡狀態失敗");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    };
  }, [loadPunch]);

  function onNoteChange(value: string) {
    setNote(value);
    setNoteStatus("saving");
    try {
      localStorage.setItem("ess-sticky-note", value);
    } catch {
      /* ignore */
    }
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(async () => {
      try {
        await savePersonalNote(value);
        setNoteStatus("saved");
      } catch {
        setNoteStatus("local");
      }
    }, 600);
  }

  async function onPunch() {
    setPunching(true);
    setError(null);
    try {
      const fix = await tryGeolocation();
      await postPunch(
        fix
          ? { source: "gps", lat: fix.lat, lng: fix.lng }
          : { source: "web" },
      );
      await loadPunch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "打卡失敗");
    } finally {
      setPunching(false);
    }
  }

  const nextAction = status === "working" ? "下班打卡" : "上班打卡";

  return (
    <div className="min-h-screen bg-gray-50 safe-t">
      <EssHeader
        appName={branding?.appName}
        primaryColor={branding?.primaryColor}
        active="home"
        isAdmin={isAdmin}
      />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:space-y-6 sm:px-4">
        {/* Punch card */}
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-medium text-gray-400">Today</p>
              <h2 className="text-xl font-bold text-gray-900 sm:text-lg sm:font-semibold">今日打卡</h2>
            </div>
            <span
              className={`w-fit rounded-full px-3 py-1 text-sm font-medium ${
                status === "working"
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {status === "working" ? "上班中" : "未上班 / 已下班"}
            </span>
          </div>

          {/* Mobile: pinned to the bottom of the screen (thumb zone) so the
              primary punch action stays reachable while scrolling, clearing
              the iOS home-indicator via .safe-b. Desktop (sm:+) reverts to
              the original static, in-card button — unchanged. */}
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-100 bg-white px-3 pt-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] safe-b sm:static sm:inset-auto sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
            <button
              onClick={onPunch}
              disabled={punching || loading}
              className="w-full rounded-2xl py-6 text-2xl font-bold text-white shadow-lg shadow-gray-200 active:scale-[0.99] disabled:opacity-60 sm:rounded-lg sm:py-5 sm:text-xl"
              style={{ backgroundColor: "var(--brand)" }}
            >
              {punching ? "打卡中…" : nextAction}
            </button>

            {error && (
              <p className="text-sm text-red-600 mt-3" role="alert">
                {error}
              </p>
            )}
          </div>

          {/* Today's records */}
          <div className="mt-5">
            <h3 className="text-sm font-medium text-gray-500 mb-2">今日紀錄</h3>
            {loading ? (
              <p className="text-sm text-gray-400">載入中…</p>
            ) : records.length === 0 ? (
              <p className="text-sm text-gray-400">尚無打卡紀錄</p>
            ) : (
              <ul className="space-y-2">
                {records.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 text-sm"
                  >
                    <span
                      className={
                        r.type === "in" ? "text-green-700" : "text-gray-600"
                      }
                    >
                      {r.type === "in" ? "上班" : "下班"}
                    </span>
                    <span className="text-gray-500 tabular-nums">
                      {timeOf(r.punch_at)}
                      {r.source ? ` · ${r.source}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Announcements */}
        {/* LinkUp 我的快捷 */}
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">我的快捷</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {visibleTabs(QUICK_LINKS, essTabs).map((q) => (
              <button
                key={q.label}
                onClick={() => router.push(q.href)}
                className="rounded-2xl border border-gray-100 bg-gray-50 px-3 py-4 text-sm font-medium text-gray-700 hover:bg-gray-100 active:scale-[0.99] sm:rounded-lg sm:py-3"
              >
                {q.label}
              </button>
            ))}
          </div>
          {internalLinks.length > 0 && (
            <div className="mt-5 border-t border-gray-100 pt-4">
              <h3 className="mb-3 text-sm font-medium text-gray-500">內部連結</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {internalLinks.map((link) => (
                  <a
                    key={`${link.name}-${link.url}`}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    {link.name}
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* LinkUp 待辦 + 便利貼 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
            <h2 className="mb-2 text-lg font-semibold text-gray-800">待辦事項</h2>
            <button onClick={() => router.push("/ess/requests")} className="text-sm text-gray-600 hover:underline">
              進行中的申請/待我簽核：
              <span className="ml-1 font-bold" style={{ color: "var(--brand)" }}>
                {pendingCount ?? "—"}
              </span>{" "}
              筆
            </button>
          </section>
          <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-800">便利貼</h2>
              <span className="text-xs text-gray-400">
                {noteStatus === "saving"
                  ? "同步中…"
                  : noteStatus === "saved"
                    ? "已同步"
                    : noteStatus === "local"
                      ? "暫存本機"
                      : ""}
              </span>
            </div>
            <textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              maxLength={4000}
              placeholder="寫點什麼…會跟著你的帳號同步"
              className="h-20 w-full resize-none rounded-md border border-yellow-200 bg-yellow-50 p-2 text-sm focus:outline-none"
            />
          </section>
        </div>

        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">最新公告</h2>
          {loading ? (
            <p className="text-sm text-gray-400">載入中…</p>
          ) : announcements.length === 0 ? (
            <p className="text-sm text-gray-400">目前沒有公告</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {announcements.map((a) => (
                <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                    <h3 className="font-medium text-gray-800">{a.title}</h3>
                    <time className="shrink-0 text-xs text-gray-400">
                      {new Date(a.created_at).toLocaleDateString("zh-TW")}
                    </time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">
                    {a.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Reserve scroll room at the very bottom on mobile so the fixed
            punch bar above never covers the tail of this page's content.
            No-op on desktop (sm:+): no fixed bar there to clear. */}
        <div className="pb-safe-16 sm:hidden" aria-hidden="true" />
      </main>
    </div>
  );
}

export default function EssPage() {
  return (
    <AuthGate>
      <EssHome />
    </AuthGate>
  );
}
