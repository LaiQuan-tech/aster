"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { getMe, getPendingApprovals } from "@/lib/ess-api";
import { visibleTabs } from "@/lib/ess-tabs";

/**
 * ESS 分頁 key：穩定的公開字串（後台 tenants.features.essTabs 用它限縮工讀生可見分頁），
 * 不要改名。順序刻意與後台選單的模組分組一致(差勤 → 專案 → 薪資 → 其他)，
 * 讓員工端與管理端的心智模型相同。
 */
export type EssTabKey =
  | "home"
  | "schedule"
  | "punches"
  | "sheet"
  | "balances"
  | "requests"
  | "approvals"
  | "projects"
  | "bonus"
  | "payslips"
  | "expenses"
  | "kpi"
  | "jobs"
  | "ai"
  | "company"
  | "notifications"
  | "mydata";

export interface EssTab {
  key: EssTabKey;
  label: string;
  short: string;
  href: string;
}

export const ESS_TABS: readonly EssTab[] = [
  { key: "home", label: "今日打卡", short: "打卡", href: "/ess" },
  { key: "schedule", label: "個人班表", short: "班表", href: "/ess/schedule" },
  { key: "punches", label: "打卡紀錄", short: "紀錄", href: "/ess/punches" },
  { key: "sheet", label: "出勤月表", short: "月表", href: "/ess/attendance-sheet" },
  { key: "balances", label: "剩餘假別", short: "假別", href: "/ess/balances" },
  { key: "requests", label: "我的申請", short: "申請", href: "/ess/requests" },
  // 只給「輪到我簽」的人看（主管／被指定的簽核者）；顯示條件見 showApprovals。
  { key: "approvals", label: "待我簽核", short: "簽核", href: "/ess/approvals" },
  { key: "projects", label: "專案知識庫", short: "專案", href: "/ess/projects" },
  { key: "bonus", label: "我的分潤", short: "分潤", href: "/ess/my-bonus" },
  { key: "payslips", label: "我的薪資單", short: "薪資", href: "/ess/payslips" },
  { key: "expenses", label: "費用報銷", short: "報銷", href: "/ess/expenses" },
  { key: "kpi", label: "我的考核", short: "考核", href: "/ess/kpi" },
  { key: "jobs", label: "內部職缺", short: "職缺", href: "/ess/jobs" },
  { key: "ai", label: "AI 問答", short: "AI", href: "/ess/ai" },
  { key: "company", label: "公司資訊", short: "公司", href: "/ess/company-info" },
  { key: "notifications", label: "通知中心", short: "通知", href: "/ess/notifications" },
  { key: "mydata", label: "我的資料", short: "資料", href: "/ess/mydata" },
];

/* ── 各頁共用的 header 狀態（分頁限縮＋待簽筆數）──────────────────────────
 * 每個 ESS 頁面都掛一次 EssHeader；為了不在每次換頁都重打 /me 與
 * /requests/pending-approvals，這裡做 30 秒的模組層快取。簽核頁做完決定後呼叫
 * invalidateEssHeaderState()，下一頁的徽章就會立刻更新。
 * 兩支 API 都是 best-effort：失敗就當作「不限縮、沒有待簽」，不影響頁面本身。
 */
interface HeaderState {
  essTabs: string[] | null;
  isManager: boolean;
  pendingApprovals: number;
}

const CACHE_TTL_MS = 30_000;
let cached: { at: number; value: HeaderState } | null = null;
let inflight: Promise<HeaderState> | null = null;
/** 目前掛著的 EssHeader；invalidate 後要立刻重抓，徽章才會在同一頁跟著變。 */
const listeners = new Set<() => void>();

export function invalidateEssHeaderState() {
  cached = null;
  inflight = null;
  for (const notify of listeners) notify();
}

async function loadHeaderState(): Promise<HeaderState> {
  const [meRes, pendingRes] = await Promise.allSettled([getMe(), getPendingApprovals()]);
  const me = meRes.status === "fulfilled" ? meRes.value : null;
  return {
    essTabs: Array.isArray(me?.essTabs) ? me!.essTabs : null,
    isManager: me?.isManager === true,
    pendingApprovals: pendingRes.status === "fulfilled" ? pendingRes.value.requests.length : 0,
  };
}

function getHeaderState(): Promise<HeaderState> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);
  if (!inflight) {
    inflight = loadHeaderState()
      .then((value) => {
        cached = { at: Date.now(), value };
        inflight = null;
        return value;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

/**
 * Shared ESS top bar. The app name + brand colour come from the tenant branding
 * (passed in by the page that fetched it); a back-office default is used until
 * the fetch lands. Also injects the tenant primaryColor as --brand so buttons
 * across the page pick it up.
 *
 * 分頁可見性：依 GET /me 的 essTabs 限縮（lib/ess-tabs.ts，null＝全部）；
 * 「待我簽核」另外只在「後端說我是主管」或「目前有輪到我簽的單」或
 * 正在該頁時顯示，並帶待簽筆數徽章。
 */
export function EssHeader({
  appName,
  primaryColor,
  active,
  isAdmin = false,
}: {
  appName?: string;
  primaryColor?: string;
  active: EssTabKey;
  /** When the signed-in user is an HR/platform admin, show a link to /admin. */
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<HeaderState | null>(() => cached?.value ?? null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      getHeaderState()
        .then((value) => {
          if (alive) setState(value);
        })
        .catch(() => null);
    };
    refresh();
    listeners.add(refresh);
    return () => {
      alive = false;
      listeners.delete(refresh);
    };
  }, []);

  async function logout() {
    invalidateEssHeaderState();
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
  }

  const brandStyle = primaryColor
    ? ({ ["--brand" as string]: primaryColor } as React.CSSProperties)
    : undefined;

  const pending = state?.pendingApprovals ?? 0;
  const showApprovals = active === "approvals" || (state?.isManager ?? false) || pending > 0;
  const tabs = visibleTabs(ESS_TABS, state?.essTabs ?? null).filter(
    (item) => item.key !== "approvals" || showApprovals,
  );

  const badge = (key: EssTabKey) =>
    key === "approvals" && pending > 0 ? (
      <span
        className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-semibold leading-5 text-white"
        aria-label={`${pending} 張待簽核`}
      >
        {pending > 99 ? "99+" : pending}
      </span>
    ) : null;

  const tab = (key: EssTabKey, label: string, href: string) => (
    <button
      key={key}
      onClick={() => router.push(href)}
      className={`whitespace-nowrap text-sm font-medium px-3 py-1.5 rounded-md ${
        active === key ? "text-white" : "text-gray-600 hover:bg-gray-100"
      }`}
      style={active === key ? { backgroundColor: "var(--brand)" } : undefined}
    >
      {label}
      {badge(key)}
    </button>
  );

  return (
    <header
      style={brandStyle}
      className="no-print sticky top-0 z-50 border-b border-gray-100 bg-white/95 px-3 py-3 shadow-sm backdrop-blur sm:px-4"
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
            {badge(item.key)}
          </button>
        ))}
      </nav>
      <nav className="mt-3 hidden gap-1 overflow-x-auto pb-1 lg:flex lg:flex-wrap lg:overflow-visible lg:pb-0">
        {tabs.map((item) => tab(item.key, item.label, item.href))}
      </nav>
    </header>
  );
}
