"use client";

/**
 * ESS 共用頁框（由 app/ess/layout.tsx 掛，包住所有 /ess/** 頁面）。
 *
 * - 手機（<lg）：頂部列（返回鍵／頁標題／後台 pill）＋固定底部分頁列
 *   「打卡・請假・（簽核）・通知・更多」，內容區 `.pb-tabbar` 預留底列高度。
 * - 桌機（lg+）：頂部列左 appName、中同一組項目水平導覽、右「後台」＋「登出」；無底列。
 * - 頁面 gate：依 routeForPath(pathname).key 對 /me 的 essTabs 判斷，一律 optimistic
 *   （/me 未回先渲染），確定不允許才換成「此帳號未開放此功能」。home／更多／公告不 gate。
 * - 徽章：簽核＝待簽筆數（紅色，99+）、通知＝未讀數（API 沒回就不顯示）。
 * - ToastProvider 放在這裡，頁面用 useToast()。
 * - 所有共用資料走 useEssState()（模組層快取），換頁不重打 /me／branding。
 */
import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { resetEssState, useEssState } from "@/lib/ess-state";
import {
  ALWAYS_VISIBLE_TAB_KEYS,
  bottomTabs,
  isBottomRootPath,
  parentPathFor,
  routeForPath,
  type BottomTab,
  type BottomTabKey,
} from "@/lib/ess-tabs";
import { Button, Icon, ToastProvider, type IconName } from "@/components/ess-ui";

const DEFAULT_APP_NAME = "亞斯特設計顧問 數位化系統";

const TAB_ICON: Partial<Record<BottomTabKey, IconName>> = {
  home: "stamp",
  requests: "leave",
  approvals: "check",
  notifications: "bell",
  more: "more",
};

function fmtBadge(n: number): string {
  return n > 99 ? "99+" : String(n);
}

function Badge({ count, label, inline }: { count: number; label: string; inline?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={
        inline
          ? "ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-semibold leading-5 text-white"
          : "absolute -right-2 -top-1 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-[1.125rem] text-white"
      }
      aria-label={`${count} ${label}`}
    >
      {fmtBadge(count)}
    </span>
  );
}

/** 登出：清共用快取 → Supabase signOut → /login。給 shell（桌機）與「更多」頁共用。 */
export async function essLogout(router: { replace: (href: string) => void }) {
  resetEssState();
  try {
    await getSupabaseBrowser().auth.signOut();
  } finally {
    router.replace("/login");
  }
}

function GatePanel() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-bold text-gray-800">此帳號未開放此功能</h1>
      <p className="text-gray-500">請聯絡人資調整可用功能，或返回打卡首頁。</p>
      <Link
        href="/ess"
        className="rounded-xl px-5 py-2.5 text-sm font-medium text-white"
        style={{ backgroundColor: "var(--brand)" }}
      >
        回首頁
      </Link>
    </div>
  );
}

export function EssShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/ess";
  const router = useRouter();
  const state = useEssState();
  const [loggingOut, setLoggingOut] = useState(false);

  const route = routeForPath(pathname);
  const tabs = bottomTabs({
    essTabs: state.essTabs,
    isManager: state.isManager,
    pendingApprovals: state.pendingApprovals,
  });

  // active：home 精準 /ess，其餘 prefix；不在底列上的路徑（含 /ess/more 與未知）全算「更多」。
  const routeKey: BottomTabKey = route.key ?? "more";
  const activeKey: BottomTabKey = tabs.some((t) => t.key === routeKey) ? routeKey : "more";

  // gate：optimistic——只有 /me 已回（essTabs 是陣列）且明確不含這個 key 才擋。
  const gated =
    route.key !== null &&
    !ALWAYS_VISIBLE_TAB_KEYS.has(route.key) &&
    state.essTabs !== null &&
    !state.essTabs.includes(route.key);

  const appName = state.branding?.appName ?? DEFAULT_APP_NAME;
  const title = route.title || appName;
  const isHomeTitle = !route.title;
  const showBack = !isBottomRootPath(pathname);
  const brandStyle = state.branding?.primaryColor
    ? ({ ["--brand" as string]: state.branding.primaryColor } as CSSProperties)
    : undefined;

  const onLogout = useCallback(async () => {
    setLoggingOut(true);
    await essLogout(router);
  }, [router]);

  const badgeFor = (key: BottomTabKey, inline = false) => {
    if (key === "approvals") return <Badge count={state.pendingApprovals} label="張待簽核" inline={inline} />;
    if (key === "notifications") return <Badge count={state.unreadNotifications} label="則未讀通知" inline={inline} />;
    return null;
  };

  const desktopTab = (tab: BottomTab) => {
    const active = tab.key === activeKey;
    return (
      <Link
        key={tab.key}
        href={tab.href}
        aria-current={active ? "page" : undefined}
        className={`inline-flex items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
          active ? "text-white" : "text-gray-600 hover:bg-gray-100"
        }`}
        style={active ? { backgroundColor: "var(--brand)" } : undefined}
      >
        {tab.label}
        {badgeFor(tab.key, true)}
      </Link>
    );
  };

  return (
    <div style={brandStyle} className="min-h-dvh bg-gray-50">
      <ToastProvider>
        <header className="no-print safe-t sticky top-0 z-40 border-b border-gray-100 bg-white/95 backdrop-blur">
          {/* 手機頂部列 */}
          <div className="flex h-12 items-center gap-2 px-2 lg:hidden">
            <div className="flex min-w-12 shrink-0 items-center">
              {showBack && (
                <button
                  type="button"
                  onClick={() => router.push(parentPathFor(pathname))}
                  aria-label="返回"
                  className="-ml-1 flex h-11 w-11 items-center justify-center rounded-full text-gray-600 active:bg-gray-100"
                >
                  <Icon name="back" className="h-6 w-6" />
                </button>
              )}
            </div>
            <h1
              className={`min-w-0 flex-1 truncate text-center text-base font-semibold ${
                isHomeTitle ? "" : "text-gray-800"
              }`}
              style={isHomeTitle ? { color: "var(--brand)" } : undefined}
            >
              {title}
            </h1>
            <div className="flex min-w-12 shrink-0 items-center justify-end">
              {state.isAdmin && (
                <Link
                  href="/admin"
                  className="rounded-full border px-2.5 py-1 text-xs font-medium"
                  style={{ borderColor: "var(--brand)", color: "var(--brand)" }}
                >
                  後台
                </Link>
              )}
            </div>
          </div>

          {/* 桌機頂部導覽 */}
          <div className="mx-auto hidden h-14 max-w-6xl items-center gap-4 px-4 lg:flex">
            <Link href="/ess" className="min-w-0 shrink-0 truncate text-lg font-bold" style={{ color: "var(--brand)" }}>
              {appName}
            </Link>
            <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="員工功能切換">
              {tabs.map(desktopTab)}
            </nav>
            <div className="flex shrink-0 items-center gap-2">
              {state.isAdmin && (
                <Link
                  href="/admin"
                  className="rounded-full border px-3 py-1.5 text-sm font-medium"
                  style={{ borderColor: "var(--brand)", color: "var(--brand)" }}
                >
                  後台
                </Link>
              )}
              <Button variant="ghost" size="sm" onClick={onLogout} loading={loggingOut}>
                登出
              </Button>
            </div>
          </div>
        </header>

        <main
          className={`pb-tabbar mx-auto w-full px-3 pt-4 sm:px-4 ${route.wide ? "max-w-6xl" : "max-w-3xl"}`}
        >
          {gated ? <GatePanel /> : children}
        </main>

        {/* 手機底部分頁列 */}
        <nav
          className="no-print safe-b fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur lg:hidden"
          aria-label="員工功能切換"
        >
          <ul className="flex items-stretch">
            {tabs.map((tab) => {
              const active = tab.key === activeKey;
              return (
                <li key={tab.key} className="min-w-0 flex-1">
                  <Link
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 pb-1 pt-1.5 text-[11px] font-medium ${
                      active ? "" : "text-gray-500"
                    }`}
                    style={active ? { color: "var(--brand)" } : undefined}
                  >
                    <span className="relative">
                      <Icon name={TAB_ICON[tab.key] ?? "more"} className="h-6 w-6" />
                      {badgeFor(tab.key)}
                    </span>
                    <span className="truncate">{tab.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </ToastProvider>
    </div>
  );
}
