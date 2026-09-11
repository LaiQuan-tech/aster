"use client";

import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

/**
 * Shared ESS top bar. The app name + brand colour come from the tenant branding
 * (passed in by the page that fetched it); a back-office default is used until
 * the fetch lands. Also injects the tenant primaryColor as --brand so buttons
 * across the page pick it up.
 */
export function EssHeader({
  appName,
  primaryColor,
  active,
  isAdmin = false,
}: {
  appName?: string;
  primaryColor?: string;
  active:
    | "home"
    | "requests"
    | "notifications"
    | "mydata"
    | "punches"
    | "balances"
    | "schedule"
    | "payslips"
    | "jobs"
    | "projects"
    | "bonus"
    | "expenses"
    | "ai";
  /** When the signed-in user is an HR/platform admin, show a link to /admin. */
  isAdmin?: boolean;
}) {
  const router = useRouter();

  async function logout() {
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
  }

  const brandStyle = primaryColor
    ? ({ ["--brand" as string]: primaryColor } as React.CSSProperties)
    : undefined;

  const tabs: Array<{
    key:
      | "home"
      | "requests"
      | "notifications"
      | "mydata"
      | "punches"
      | "balances"
      | "schedule"
      | "payslips"
      | "jobs"
      | "projects"
      | "bonus"
      | "expenses"
      | "ai";
    label: string;
    short: string;
    href: string;
  }> = [
    // 順序刻意與後台選單的模組分組一致(差勤 → 專案 → 薪資 → 其他),
    // 讓員工端與管理端的心智模型相同。
    { key: "home", label: "今日打卡", short: "打卡", href: "/ess" },
    { key: "schedule", label: "個人班表", short: "班表", href: "/ess/schedule" },
    { key: "punches", label: "打卡紀錄", short: "紀錄", href: "/ess/punches" },
    { key: "balances", label: "剩餘假別", short: "假別", href: "/ess/balances" },
    { key: "requests", label: "我的申請", short: "申請", href: "/ess/requests" },
    { key: "projects", label: "專案知識庫", short: "專案", href: "/ess/projects" },
    { key: "bonus", label: "我的分潤", short: "分潤", href: "/ess/my-bonus" },
    { key: "payslips", label: "我的薪資單", short: "薪資", href: "/ess/payslips" },
    { key: "expenses", label: "費用報銷", short: "報銷", href: "/ess/expenses" },
    { key: "jobs", label: "內部職缺", short: "職缺", href: "/ess/jobs" },
    { key: "ai", label: "AI 問答", short: "AI", href: "/ess/ai" },
    { key: "notifications", label: "通知中心", short: "通知", href: "/ess/notifications" },
    { key: "mydata", label: "我的資料", short: "資料", href: "/ess/mydata" },
  ];

  const tab = (
    key: (typeof tabs)[number]["key"],
    label: string,
    href: string,
  ) => (
    <button
      onClick={() => router.push(href)}
      className={`whitespace-nowrap text-sm font-medium px-3 py-1.5 rounded-md ${
        active === key ? "text-white" : "text-gray-600 hover:bg-gray-100"
      }`}
      style={active === key ? { backgroundColor: "var(--brand)" } : undefined}
    >
      {label}
    </button>
  );

  return (
    <header
      style={brandStyle}
      className="sticky top-0 z-50 border-b border-gray-100 bg-white/95 px-3 py-3 shadow-sm backdrop-blur sm:px-4"
    >
      <div className="relative z-20 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => router.push("/ess")}
          className="min-w-0 text-left text-xl font-bold leading-tight sm:text-lg lg:text-xl"
          style={{ color: "var(--brand)" }}
        >
          <span className="block truncate">{appName ?? "亞斯特設計顧問 數位化系統"}</span>
          <span className="block text-sm font-medium text-gray-400 lg:hidden">員工自助</span>
        </button>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {isAdmin && (
            <button
              onClick={() => router.push("/admin")}
              className="rounded-full border px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: "var(--brand)", color: "var(--brand)" }}
            >
              後台
            </button>
          )}
          <button
            onClick={logout}
            className="rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            登出
          </button>
        </div>
      </div>
      <nav className="relative z-20 -mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1 lg:hidden" aria-label="員工功能切換">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => router.push(item.href)}
            className={`shrink-0 rounded-full px-5 py-3 text-base font-semibold transition active:scale-[0.98] ${
              active === item.key
                ? "text-white shadow-sm"
                : "border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
            }`}
            style={active === item.key ? { backgroundColor: "var(--brand)" } : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <nav className="mt-3 hidden gap-1 overflow-x-auto pb-1 lg:flex lg:flex-wrap lg:overflow-visible lg:pb-0">
        {tabs.map((item) => tab(item.key, item.label, item.href))}
      </nav>
    </header>
  );
}
