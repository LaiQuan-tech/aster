"use client";

/**
 * 後台共用頁框（由 app/admin/layout.tsx 掛，包住所有 /admin 底下的頁面）。
 *
 * - 桌機（md+）：左側固定側欄只列該角色可見的分區（lib/admin-nav.ts 的 sectionsForRole，HR 是全部 9 個）；分區內的分頁
 *   在內容區頂部以 tab 列切換，有 children 的分頁再多一列子分頁膠囊——全部依路由表渲染。
 * - 手機（<md）：頂列「漢堡／頁標題／員工端」＋橫捲 tab 列（＋子分頁列）；漢堡開 BottomSheet
 *   抽屜列 9 個分區，pathname 一變就自動關。
 * - 頁首（h1／desc／返回鍵）由這裡依路由表畫，頁面本身不再放 PageHeader；detail 頁
 *   （/admin/projects/[id] 等）的 h1 用 detail.title，動態標題由頁面的 DetailHeading 補。
 *   首頁（title ""）不畫頁首。
 * - 隱藏模組（features.adminModules）未啟用的分頁不列在 tab 列；直開網址仍可用，該 tab 會被
 *   塞回列上並標「未啟用」。
 * - 角色範圍（W4，2026-09-23）：會計（employees.role='accountant'）的側欄只列開放的分區、
 *   分頁列只列開放的分頁（lib/admin-nav.ts 的 roleNavOf／sectionsForRole／tabsForSection；
 *   範圍可在「設定 → 進階功能 → 會計可用範圍」調整）。直開未開放的網址（2026-09-23 驗收修正）：
 *   isAdminPathAllowed 回 false 就不渲染 children，改畫整頁「此頁未開放給會計」＋回首頁——以前照常
 *   渲染該頁，結果是 403 toast＋空殼頁（bonus-runs）或整頁正常（payroll）。HR／平台管理員不受影響
 *   （隱藏模組直開網址仍可用）。真正的防線仍在 API（requireFinance／requireHrAdmin），這裡只是
 *   導覽層守門，別把它當安全邊界。
 * - 共用資料（appName／features／待簽筆數）走 useEssState()（模組層快取，換頁不重打）；
 *   ToastProvider 在最外層，頁面用 useToast()。
 * - 保留 `admin-shell` class：globals.css 的手機表格 min-width 與列印隱藏 aside/header 都靠它。
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/lib/admin-api";
import { useEssState } from "@/lib/ess-state";
import {
  ADMIN_TABS,
  adminModulesOf,
  isAdminPathAllowed,
  isModuleEnabled,
  resolveAdminPath,
  roleNavOf,
  sectionsForRole,
  subTabsFor,
  tabsForSection,
  type AdminIconName,
  type AdminModulesConfig,
  type AdminSection,
  type AdminSubTab,
  type AdminTab,
  type RoleNavConfig,
} from "@/lib/admin-nav";
import { BottomSheet, Button, Icon, Pill, ToastProvider } from "@/components/ess-ui";
import { essLogout } from "@/components/EssShell";

const DEFAULT_APP_NAME = "亞斯特設計顧問 數位化系統";

/* ------------------------------------------------------------- icons --- */

/** 9 個分區的 inline SVG 路徑（24×24、stroke＝currentColor）；首頁的分區入口也用這組。 */
export const ADMIN_ICONS: Record<AdminIconName, ReactNode> = {
  home: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  finance: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </>
  ),
  approvals: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1" />
      <path d="M9 13l2 2 4-4" />
    </>
  ),
  attendance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  payroll: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7 12h.01M17 12h.01" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M21.5 20a6.5 6.5 0 0 0-4.5-6.2" />
    </>
  ),
  announce: (
    <>
      <path d="M3 10v4a1 1 0 0 0 1 1h3l6 4V5L7 9H4a1 1 0 0 0-1 1z" />
      <path d="M17 9a4 4 0 0 1 0 6" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </>
  ),
  system: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
};

/** 分區圖示（傳 className 時請自帶尺寸，預設 h-5 w-5）。 */
export function SectionIcon({ name, className = "h-5 w-5" }: { name: AdminIconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {ADMIN_ICONS[name]}
    </svg>
  );
}

function MenuIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/* ------------------------------------------------------------- parts --- */

function Badge({ count, label, className = "" }: { count: number; label: string; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-semibold leading-5 text-white ${className}`}
      aria-label={`${count} ${label}`}
    >
      {count > 99 ? "99+" : String(count)}
    </span>
  );
}

const BRAND_OUTLINE: CSSProperties = { borderColor: "var(--brand)", color: "var(--brand)" };

/** 分區分頁列（桌機在內容區頁首、手機在頂列）；detail 頁父分頁算 active；未啟用模組標「未啟用」。 */
/**
 * `allowedTabKeys` null＝不限縮（HR／平台管理員）；有值時不在集合裡的分頁只會因為
 * 「直開網址」才被 tabsForSection 的 includeTab 塞回列上，標「未開放給會計」。
 */
function TabBar({
  tabs,
  activeKey,
  modules,
  allowedTabKeys,
}: {
  tabs: AdminTab[];
  activeKey: string | null;
  modules: AdminModulesConfig;
  allowedTabKeys: ReadonlySet<string> | null;
}) {
  return (
    <nav
      aria-label="分區分頁"
      className="-mx-3 flex gap-1 overflow-x-auto px-3 md:mx-0 md:border-b md:border-gray-200 md:px-0"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const disabled = !isModuleEnabled(modules, tab.module);
        const offLimits = !disabled && !!allowedTabKeys && !allowedTabKeys.has(tab.key);
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              active ? "" : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
            style={active ? BRAND_OUTLINE : undefined}
          >
            {tab.label}
            {disabled && (
              <Pill tone="gray" className="ml-1.5">
                未啟用
              </Pill>
            )}
            {offLimits && (
              <Pill tone="gray" className="ml-1.5">
                未開放給會計
              </Pill>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function SubTabBar({ subTabs, activeKey }: { subTabs: AdminSubTab[]; activeKey: string | null }) {
  return (
    <nav aria-label="子分頁" className="mt-2 flex gap-2 overflow-x-auto">
      {subTabs.map((sub) => {
        const active = sub.key === activeKey;
        return (
          <Link
            key={sub.key}
            href={sub.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${
              active ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
            style={active ? { backgroundColor: "var(--brand)" } : undefined}
          >
            {sub.label}
          </Link>
        );
      })}
    </nav>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-9 items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
      <Icon name="back" className="h-4 w-4" />
      返回{label}
    </Link>
  );
}

/** 返回鍵文字：回父分頁（「返回專案」「返回放款作業」）；父路徑本身是 detail 時回它的標題（「返回專案明細」）。 */
function backLabelFor(parentPath: string): string {
  const parent = resolveAdminPath(parentPath);
  if (parent.isDetail) return parent.title;
  const tab = parent.tab ? ADMIN_TABS[parent.section].find((t) => t.key === parent.tab) : undefined;
  const sub = parent.sub ? tab?.children?.find((c) => c.key === parent.sub) : undefined;
  return sub?.label ?? tab?.label ?? parent.title;
}

/* ------------------------------------------------------------- shell --- */

export function AdminShell({ me, children }: { me: Me; children: ReactNode }) {
  const pathname = usePathname() ?? "/admin";
  const router = useRouter();
  const state = useEssState();
  // 抽屜記「在哪個 pathname 打開」：導頁後 pathname 不同即視為關閉，不需要 effect。
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const resolved = resolveAdminPath(pathname);
  const modules = adminModulesOf(state.features);
  // W4：角色範圍。roleNav 為 null＝不限縮（HR／平台管理員與其他角色）。
  const roleNav = roleNavOf(me.role, state.features);
  const sections: AdminSection[] = sectionsForRole(roleNav, modules);
  const tabs = tabsForSection(resolved.section, modules, { includeTab: resolved.tab, roleNav });
  const allowedTabKeys = roleNav?.tabs[resolved.section]
    ? new Set<string>(roleNav.tabs[resolved.section] as string[])
    : null;
  const subTabs = subTabsFor(resolved.section, resolved.tab);
  // 直開未開放給這個角色的網址：不渲染頁面本體（見檔頭說明）。HR／平台管理員永遠 true。
  const pathAllowed = isAdminPathAllowed({ pathname, roleNav, modules });
  const roleLabel = me.role === "accountant" ? "會計" : "此角色";
  const isHome = resolved.title === "";
  const appName = state.branding?.appName ?? DEFAULT_APP_NAME;
  const brandStyle = state.branding?.primaryColor
    ? ({ ["--brand" as string]: state.branding.primaryColor } as CSSProperties)
    : undefined;
  const drawerOpen = drawerPath === pathname;
  const backLabel = resolved.parentPath ? backLabelFor(resolved.parentPath) : null;
  const closeDrawer = () => setDrawerPath(null);

  async function onLogout() {
    setLoggingOut(true);
    await essLogout(router);
  }

  const userCard = (
    <>
      <p className="truncate text-sm font-medium text-gray-800">{me.name}</p>
      <p className="truncate text-xs text-gray-400">{[me.empNo, me.email].filter(Boolean).join(" · ") || "—"}</p>
    </>
  );

  return (
    <ToastProvider>
      <div className="admin-shell min-h-dvh bg-gray-50 md:flex" style={brandStyle}>
        {/* 桌機側欄：9 個分區 */}
        <aside className="hidden md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:shrink-0 md:flex-col md:border-r md:border-gray-100 md:bg-white">
          <div className="px-5 py-4">
            <Link href="/admin" className="block truncate text-base font-bold leading-snug" style={{ color: "var(--brand)" }}>
              {appName}
            </Link>
          </div>
          <nav aria-label="後台分區" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
            {sections.map((section) => {
              const active = section.key === resolved.section;
              return (
                <Link
                  key={section.key}
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium ${
                    active ? "text-white" : "text-gray-600 hover:bg-gray-100"
                  }`}
                  style={active ? { backgroundColor: "var(--brand)" } : undefined}
                >
                  <SectionIcon name={section.icon} className="h-5 w-5 shrink-0" />
                  <span className="truncate">{section.label}</span>
                  {section.key === "approvals" && (
                    <Badge count={state.pendingApprovals} label="張待簽核" className="ml-auto" />
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-gray-100 px-4 py-4">
            {userCard}
            <Link
              href="/ess"
              className="mt-3 flex min-h-10 items-center justify-center rounded-xl border text-sm font-medium"
              style={BRAND_OUTLINE}
            >
              員工端
            </Link>
            <Button variant="ghost" size="sm" block className="mt-2 text-gray-600" onClick={onLogout} loading={loggingOut}>
              <Icon name="logout" className="h-4 w-4" />
              登出
            </Button>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* 手機頂列：漢堡／標題／員工端 ＋ 分頁列 ＋ 子分頁列 */}
          <header className="no-print sticky top-0 z-40 border-b border-gray-100 bg-white/95 backdrop-blur md:hidden">
            <div className="flex h-12 items-center gap-2 px-2">
              <button
                type="button"
                onClick={() => setDrawerPath(pathname)}
                aria-label="功能選單"
                aria-expanded={drawerOpen}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-700 active:bg-gray-100"
              >
                <MenuIcon />
              </button>
              <h1
                className={`min-w-0 flex-1 truncate text-center text-base font-semibold ${isHome ? "" : "text-gray-800"}`}
                style={isHome ? { color: "var(--brand)" } : undefined}
              >
                {isHome ? appName : resolved.title}
              </h1>
              <Link href="/ess" className="shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium" style={BRAND_OUTLINE}>
                員工端
              </Link>
            </div>
            {tabs.length >= 2 && (
              <div className="px-3 pb-2">
                <TabBar tabs={tabs} activeKey={resolved.tab} modules={modules} allowedTabKeys={allowedTabKeys} />
              </div>
            )}
            {subTabs.length > 0 && (
              <div className="px-3 pb-2">
                <SubTabBar subTabs={subTabs} activeKey={resolved.sub} />
              </div>
            )}
          </header>

          <div className={`mx-auto w-full px-3 py-4 sm:px-4 md:px-8 md:py-6 ${resolved.narrow ? "max-w-4xl" : "max-w-7xl"}`}>
            {!pathAllowed ? (
              <main className="py-12 text-center" aria-labelledby="admin-off-limits-title">
                <h1 id="admin-off-limits-title" className="text-xl font-bold text-gray-900">
                  此頁未開放給{roleLabel}
                </h1>
                <p className="mt-2 text-sm text-gray-500">
                  這個功能不在{roleLabel}的後台範圍內；需要的話請 HR 到「設定 → 進階功能」調整可用範圍。
                </p>
                <Link
                  href="/admin"
                  className="mt-6 inline-flex min-h-10 items-center justify-center rounded-xl px-5 text-sm font-medium text-white"
                  style={{ backgroundColor: "var(--brand)" }}
                >
                  回首頁
                </Link>
              </main>
            ) : (
              <>
                {/* 桌機頁首：返回鍵／h1／desc／分頁列；首頁整塊不畫 */}
                {!isHome && (
                  <header className="no-print mb-4 hidden md:block">
                    {resolved.parentPath && backLabel !== null && (
                      <div className="mb-2">
                        <BackLink href={resolved.parentPath} label={backLabel} />
                      </div>
                    )}
                    <h1 className="text-xl font-bold text-gray-900">{resolved.title}</h1>
                    {resolved.desc && <p className="mt-1 text-sm text-gray-500">{resolved.desc}</p>}
                    {tabs.length >= 2 && (
                      <div className="mt-4">
                        <TabBar tabs={tabs} activeKey={resolved.tab} modules={modules} allowedTabKeys={allowedTabKeys} />
                      </div>
                    )}
                    {subTabs.length > 0 && <SubTabBar subTabs={subTabs} activeKey={resolved.sub} />}
                  </header>
                )}
                {resolved.parentPath && backLabel !== null && (
                  <div className="no-print mb-3 md:hidden">
                    <BackLink href={resolved.parentPath} label={backLabel} />
                  </div>
                )}
                <main className="space-y-4 md:space-y-6">{children}</main>
              </>
            )}
          </div>
        </div>

        {/* 手機抽屜：9 個分區＋使用者卡＋員工端＋登出 */}
        <BottomSheet open={drawerOpen} onClose={closeDrawer} title="功能選單">
          <nav aria-label="後台分區">
            <ul className="-my-1 divide-y divide-gray-100">
              {sections.map((section) => {
                const active = section.key === resolved.section;
                return (
                  <li key={section.key}>
                    <Link
                      href={section.href}
                      onClick={closeDrawer}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 ${active ? "bg-gray-100" : "active:bg-gray-50"}`}
                      style={active ? { color: "var(--brand)" } : undefined}
                    >
                      <SectionIcon name={section.icon} className={`h-6 w-6 shrink-0 ${active ? "" : "text-gray-500"}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center text-base font-medium ${active ? "" : "text-gray-800"}`}>
                          {section.label}
                          {section.key === "approvals" && (
                            <Badge count={state.pendingApprovals} label="張待簽核" className="ml-1.5" />
                          )}
                        </span>
                        <span className="block truncate text-xs text-gray-400">{section.desc}</span>
                      </span>
                      <Icon name="chevron" className="h-5 w-5 shrink-0 text-gray-300" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="mt-4 border-t border-gray-100 pt-4">
            <div className="min-w-0">{userCard}</div>
            <Link
              href="/ess"
              onClick={closeDrawer}
              className="mt-4 flex min-h-11 items-center justify-center rounded-xl border text-sm font-medium"
              style={BRAND_OUTLINE}
            >
              員工端
            </Link>
            <Button variant="ghost" size="md" block className="mt-3 text-gray-600" onClick={onLogout} loading={loggingOut}>
              <Icon name="logout" className="h-5 w-5" />
              登出
            </Button>
          </div>
        </BottomSheet>
      </div>
    </ToastProvider>
  );
}
