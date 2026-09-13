"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AdminGate } from "@/components/AdminGate";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { getBranding, type Branding, type Me } from "@/lib/admin-api";

type NavItem = { href: string; label: string; soon?: boolean; fresh?: boolean };

/**
 * `fresh: true` = 2026-09-14 這批上線的新功能，名稱前加「＊」讓 Jeff 驗收時一眼認得出來
 * （新頁面：印花稅備查、日常費用月結、員工預支；大改的既有頁：專案、公告、薪資資料）。
 * 驗收完把 fresh 拿掉即可，純顯示用。
 */
const labelOf = (item: NavItem) => (item.fresh ? `＊${item.label}` : item.label);

/**
 * 選單分組刻意對齊合約賣給客戶的模組（公司形象官網／系統基礎建置／員工帳號權限
 * 配發／AI 專案進度追蹤／AI 知識庫／獎金自動分配／人事差勤），客戶打開後台才找得
 * 到自己買的東西。`soon: true` = 該項尚未建置,選單上以「建置中」佔位而非隱藏,
 * 讓交付進度對客戶是透明的。做完該功能時把 soon 拿掉即可。
 */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "總覽",
    items: [
      { href: "/admin", label: "後台總覽" },
      { href: "/admin/notifications", label: "通知中心" },
      { href: "/admin/dashboard", label: "人力分析" },
      { href: "/admin/ai", label: "AI 助理" },
    ],
  },
  {
    title: "AI 專案進度追蹤",
    items: [
      { href: "/admin/projects/overview", label: "專案總覽 · 甘特圖／看板", soon: true },
      { href: "/admin/projects/alerts", label: "AI 進度示警", soon: true },
    ],
  },
  {
    title: "AI 知識庫",
    items: [
      { href: "/admin/knowledge", label: "文件庫 · 語意搜尋", soon: true },
      { href: "/admin/knowledge/ask", label: "AI 文件問答", soon: true },
      { href: "/admin/vendors", label: "廠商名冊 · 名片建檔", soon: true },
    ],
  },
  {
    title: "獎金自動分配",
    items: [
      { href: "/admin/projects", label: "專案與成員分潤", fresh: true },
      { href: "/admin/stamp-duty", label: "印花稅備查清單", fresh: true },
    ],
  },
  {
    title: "帳號與權限",
    items: [
      { href: "/admin/employees", label: "員工帳號與密碼配發" },
      { href: "/admin/employee-mail", label: "專屬 Email 配發", soon: true },
    ],
  },
  {
    title: "人事差勤 · 組織人事",
    items: [
      { href: "/admin/departments", label: "組織單位" },
      { href: "/admin/org-chart", label: "公司組織圖" },
      { href: "/admin/onboarding", label: "報到管理" },
    ],
  },
  {
    title: "人事差勤 · 差勤管理",
    items: [
      { href: "/admin/shifts", label: "班別" },
      { href: "/admin/schedules", label: "排班 / 班表審核" },
      { href: "/admin/punch-records", label: "打卡紀錄維護" },
      { href: "/admin/leave-types", label: "假別與簽核流程" },
      { href: "/admin/leave-balances", label: "假別時數管理" },
      { href: "/admin/attendance-settlement", label: "結算作業" },
    ],
  },
  {
    title: "人事差勤 · 表單簽核",
    items: [
      { href: "/admin/approvals", label: "待審核表單" },
      { href: "/admin/form-records", label: "表單紀錄管理" },
    ],
  },
  {
    title: "人事差勤 · 薪資",
    items: [
      { href: "/admin/payroll", label: "薪資 / 保險資料", fresh: true },
      { href: "/admin/payslips", label: "薪資明細表", soon: true },
      { href: "/admin/payroll-tax", label: "所得稅 / 補充保費" },
      { href: "/admin/expenses", label: "日常費用月結", fresh: true },
      { href: "/admin/advances", label: "員工預支", fresh: true },
    ],
  },
  {
    title: "人事差勤 · 招募與考核",
    items: [
      { href: "/admin/recruitment", label: "招募 ATS" },
      { href: "/admin/kpi", label: "績效考核", soon: true },
    ],
  },
  {
    title: "公司公告",
    items: [
      { href: "/admin/announcements", label: "最新消息 / 公告", fresh: true },
      { href: "/admin/company-space", label: "Company Space" },
      { href: "/admin/company-info", label: "公司福利 / 職安資訊", soon: true },
    ],
  },
  {
    title: "系統設定",
    items: [
      { href: "/admin/module-settings", label: "模組設定" },
      { href: "/admin/reports", label: "報表中心" },
    ],
  },
];

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [branding, setBranding] = useState<Branding | null>(null);

  useEffect(() => {
    let active = true;
    getBranding()
      .then((res) => {
        if (active) setBranding(res.branding);
      })
      .catch(() => {
        /* branding is best-effort */
      });
    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
  }

  const brandStyle = branding?.primaryColor
    ? ({ ["--brand" as string]: branding.primaryColor } as React.CSSProperties)
    : undefined;

  // Active when the path matches exactly, or (for sub-pages) starts with the
  // nav href — but "/admin" only lights up on an exact match so it isn't always on.
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  const flatNav = NAV_GROUPS.flatMap((group) => group.items);
  const activeItem = flatNav.find((item) => isActive(item.href));

  return (
    <div style={brandStyle} className="admin-shell min-h-screen bg-gray-50 md:flex">
      {/* Sidebar */}
      <aside className="hidden shrink-0 border-b border-gray-100 bg-white md:block md:min-h-screen md:w-60 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-5 py-4">
          <span className="text-base font-bold leading-snug" style={{ color: "var(--brand)" }}>
            {branding?.appName ?? "亞斯特設計顧問 數位化系統"}
          </span>
        </div>
        <nav className="flex flex-wrap gap-2 px-3 pb-3 md:flex-col md:flex-nowrap">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="w-full">
              <p className="px-3 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {group.title}
              </p>
              <div className="mt-1 flex flex-wrap gap-1 md:flex-col">
                {group.items.map((item) =>
                  item.soon ? (
                    <span
                      key={item.href}
                      aria-disabled="true"
                      title="此功能建置中"
                      className="flex cursor-not-allowed items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-gray-300"
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-400">
                        建置中
                      </span>
                    </span>
                  ) : (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`rounded-md px-3 py-2 text-sm font-medium ${
                        isActive(item.href) ? "text-white" : "text-gray-600 hover:bg-gray-100"
                      }`}
                      style={isActive(item.href) ? { backgroundColor: "var(--brand)" } : undefined}
                    >
                      {labelOf(item)}
                    </Link>
                  ),
                )}
              </div>
            </div>
          ))}
        </nav>
        <div className="hidden border-t border-gray-100 px-5 py-4 md:block">
          <p className="truncate text-sm font-medium text-gray-700">{me.name}</p>
          <p className="truncate text-xs text-gray-400">{me.email}</p>
          <button onClick={logout} className="mt-2 text-sm text-gray-500 hover:text-gray-800">
            登出
          </button>
        </div>
      </aside>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 border-b border-gray-100 bg-white/95 px-3 py-3 shadow-sm backdrop-blur md:hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => router.push("/admin")}
                className="block max-w-[52vw] truncate text-left text-xl font-bold leading-tight"
                style={{ color: "var(--brand)" }}
              >
                {branding?.appName ?? "亞斯特設計顧問 數位化系統"}
              </button>
              <p className="truncate text-sm font-medium text-gray-400">
                {activeItem?.label ?? "管理員後台"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => router.push("/ess")}
                className="rounded-full border px-3 py-1.5 text-sm font-medium"
                style={{ borderColor: "var(--brand)", color: "var(--brand)" }}
              >
                員工端
              </button>
              <button
                onClick={logout}
                className="rounded-full bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-600"
              >
                登出
              </button>
            </div>
          </div>
          <nav className="-mx-3 mt-3 flex gap-2 overflow-x-auto px-3 pb-1" aria-label="後台功能切換">
            {flatNav.map((item) =>
              item.soon ? (
                <span
                  key={item.href}
                  aria-disabled="true"
                  className="shrink-0 cursor-not-allowed rounded-full border border-dashed border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-300"
                >
                  {item.label}　建置中
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-semibold ${
                    isActive(item.href)
                      ? "text-white shadow-sm"
                      : "border border-gray-200 bg-gray-50 text-gray-700"
                  }`}
                  style={isActive(item.href) ? { backgroundColor: "var(--brand)" } : undefined}
                >
                  {labelOf(item)}
                </Link>
              ),
            )}
          </nav>
          <nav className="-mx-3 mt-2 flex gap-2 overflow-x-auto px-3 pb-1" aria-label="後台模組分類">
            {NAV_GROUPS.map((group) => {
              // 跳到該分類第一個「已建置」的頁面；整組都還沒做的分類不可點,
              // 否則會連到尚不存在的路由。
              const first = group.items.find((item) => !item.soon);
              const groupActive = group.items.some((item) => isActive(item.href));
              if (!first) {
                return (
                  <span
                    key={group.title}
                    aria-disabled="true"
                    className="shrink-0 cursor-not-allowed rounded-full border border-dashed border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-300"
                  >
                    {group.title}
                  </span>
                );
              }
              return (
                <Link
                  key={group.title}
                  href={first.href}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                    groupActive ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {group.title}
                </Link>
              );
            })}
          </nav>
        </header>
        <main className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 md:space-y-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminGate>{(me) => <Shell me={me}>{children}</Shell>}</AdminGate>;
}
