"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty } from "@/components/admin-ui";
import { getBranding, getRequests, seedDemoData, getAnnouncements, type Announcement } from "@/lib/admin-api";
import { getDisbursementSummary, type DisbursementSummary } from "@/lib/disbursements-api";
import {
  getReceivables,
  getAnnualProjects,
  currentRocYear,
  listProjectsExt,
  PROJECT_KIND_LABELS,
  type ProjectListItem,
} from "@/lib/projects-ext-api";
import { getProjectAlerts } from "@/lib/projects-api";
import { getBonusSummary } from "@/lib/bonus-api";
import { listBackups, type SnapshotPeriodSummary } from "@/lib/backup-api";

// module 名稱與側邊選單的分組一致(見 admin/layout.tsx 的 NAV_GROUPS),
// 兩處都對齊合約賣給客戶的模組,客戶才找得到自己買的東西。
const LINKS: { href: string; label: string; desc: string; module: string }[] = [
  { href: "/admin/dashboard", label: "人力分析", desc: "在職人數分析", module: "總覽" },
  { href: "/admin/ai", label: "AI 助理", desc: "AI 月報摘要與 HR 資料問答", module: "總覽" },
  { href: "/admin/notifications", label: "通知中心", desc: "全租戶通知、未讀與投遞狀態", module: "總覽" },
  { href: "/admin/projects", label: "專案與成員分潤", desc: "專案、成員分潤比例與異動留痕", module: "獎金自動分配" },
  { href: "/admin/employees", label: "員工帳號與密碼配發", desc: "建立帳號、配發／重設密碼、角色權限", module: "帳號與權限" },
  { href: "/admin/departments", label: "組織單位", desc: "組織架構維護", module: "人事差勤 · 組織人事" },
  { href: "/admin/org-chart", label: "公司組織圖", desc: "部門階層樹狀圖", module: "人事差勤 · 組織人事" },
  { href: "/admin/onboarding", label: "報到管理", desc: "新進人員報到與建檔", module: "人事差勤 · 組織人事" },
  { href: "/admin/shifts", label: "班別", desc: "上下班時間與夜班", module: "人事差勤 · 差勤管理" },
  { href: "/admin/schedules", label: "排班 / 班表審核", desc: "指派員工班別與班表確認", module: "人事差勤 · 差勤管理" },
  { href: "/admin/punch-records", label: "打卡紀錄維護", desc: "查詢打卡與補登", module: "人事差勤 · 差勤管理" },
  { href: "/admin/leave-types", label: "假別與簽核流程", desc: "假別與各類別簽核者", module: "人事差勤 · 差勤管理" },
  { href: "/admin/leave-balances", label: "假別時數管理", desc: "查詢與設定員工年度可用時數", module: "人事差勤 · 差勤管理" },
  { href: "/admin/attendance-settlement", label: "結算作業", desc: "差勤結算與出勤日彙整", module: "人事差勤 · 差勤管理" },
  { href: "/admin/approvals", label: "待審核表單", desc: "待處理的請假／加班／補卡", module: "人事差勤 · 表單簽核" },
  { href: "/admin/form-records", label: "表單紀錄管理", desc: "請假、加班、補卡、公出/出差全紀錄", module: "人事差勤 · 表單簽核" },
  { href: "/admin/payroll", label: "薪資 / 保險資料", desc: "薪資保險資料、執行薪資、薪資單", module: "人事差勤 · 薪資" },
  { href: "/admin/payroll-tax", label: "所得稅 / 補充保費", desc: "批次調薪、非員工所得、補充保費", module: "人事差勤 · 薪資" },
  { href: "/admin/recruitment", label: "招募 ATS", desc: "職缺需求單、人才庫、面試、錄用", module: "人事差勤 · 招募與考核" },
  { href: "/admin/announcements", label: "最新消息 / 公告", desc: "公司規章、部門公告、最新消息", module: "公司公告" },
  { href: "/admin/company-space", label: "Company Space", desc: "權限項目、人員權限、站台設定", module: "公司公告" },
  { href: "/admin/module-settings", label: "模組設定", desc: "行事曆、差勤薪資規則、功能參數", module: "系統設定" },
  { href: "/admin/reports", label: "報表中心", desc: "出勤、請假、薪資、人力報表", module: "系統設定" },
];

/* -------------------------------------------------------------- 老闆看板 -- */
// B9：每張卡各自獨立讀取、獨立失敗——用 Promise.allSettled 平行打 9 支既有端點
// (不新增 API),任一支掛掉只讓那張卡顯示「載入失敗」,其餘照常顯示數字。

type Loadable<T> = { loading: boolean; error: string | null; data: T | null };

function initLoadable<T>(): Loadable<T> {
  return { loading: true, error: null, data: null };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "載入失敗";
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString("zh-TW");
}

interface ReceivablesCardData {
  unreceivedTotal: number;
  overdueCount: number;
}

interface AnnualCardData {
  amountTotal: number;
  pct: number | null;
}

interface BonusCardData {
  yearTotal: number;
  latestLabel: string | null;
}

interface AlertsCardData {
  total: number;
  high: number;
}

/**
 * 變更／追加案的專案編號慣例是 `{原案 code}-{n}`（見 projects-ext-api.ts C2 段落
 * 的 duplicateProject 註解，如 `AT-115-013` → `AT-115-013-1`）。GET /projects
 * 清單（ProjectListItem）沒有回 parentProjectId，這裡直接從 code 反推「原案」，
 * 不用額外多打一支 lineage 端點（維持「不新增任何 API」的邊界）。
 */
function rootCodeOf(code: string | null | undefined): string | null {
  if (!code) return null;
  const m = code.match(/^(.*)-\d+$/);
  return m ? m[1] : null;
}

function BossCard({
  href,
  label,
  state,
  children,
}: {
  href: string;
  label: string;
  state: { loading: boolean; error: string | null };
  children: ReactNode;
}) {
  return (
    <Link href={href} className="block rounded-xl bg-slate-50 p-4 transition hover:bg-slate-100">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="mt-1.5">
        {state.loading ? (
          <p className="text-sm text-gray-400">載入中…</p>
        ) : state.error ? (
          <p className="text-sm text-red-600" title={state.error}>
            載入失敗
          </p>
        ) : (
          children
        )}
      </div>
    </Link>
  );
}

export default function AdminOverview() {
  const [widgets, setWidgets] = useState<string[]>([]);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [demoStatus, setDemoStatus] = useState<string | null>(null);
  const [seedingDemo, setSeedingDemo] = useState(false);

  const [disb, setDisb] = useState<Loadable<DisbursementSummary>>(initLoadable<DisbursementSummary>());
  const [recv, setRecv] = useState<Loadable<ReceivablesCardData>>(initLoadable<ReceivablesCardData>());
  const [annual, setAnnual] = useState<Loadable<AnnualCardData>>(initLoadable<AnnualCardData>());
  const [bonus, setBonus] = useState<Loadable<BonusCardData>>(initLoadable<BonusCardData>());
  const [pendingReq, setPendingReq] = useState<Loadable<number>>(initLoadable<number>());
  const [alerts, setAlerts] = useState<Loadable<AlertsCardData>>(initLoadable<AlertsCardData>());
  const [announcements, setAnnouncements] = useState<Loadable<Announcement[]>>(initLoadable<Announcement[]>());
  const [changes, setChanges] = useState<Loadable<ProjectListItem[]>>(initLoadable<ProjectListItem[]>());
  const [snapshot, setSnapshot] = useState<Loadable<SnapshotPeriodSummary | null>>(initLoadable<SnapshotPeriodSummary | null>());

  useEffect(() => {
    let active = true;

    getBranding()
      .then((res) => {
        if (active) setWidgets(res.features?.dashboardWidgets ?? []);
      })
      .catch(() => null);

    async function loadDisbursement() {
      try {
        const s = await getDisbursementSummary();
        if (active) setDisb({ loading: false, error: null, data: s });
      } catch (err) {
        if (active) setDisb({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadReceivables() {
      try {
        // 未收款總額：不帶 state（預設 status=open）；逾期筆數：state=overdue。
        const [all, overdue] = await Promise.all([getReceivables(), getReceivables("open", "overdue")]);
        if (active) {
          setRecv({
            loading: false,
            error: null,
            data: { unreceivedTotal: all.summary.unreceivedTotal, overdueCount: overdue.summary.overdueCount },
          });
        }
      } catch (err) {
        if (active) setRecv({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadAnnual() {
      try {
        const r = await getAnnualProjects({ year: currentRocYear() });
        const total = r.totals.amountTotal;
        const received = r.totals.receivedTotal;
        const pct = total > 0 ? Math.round((received / total) * 100) : null;
        if (active) setAnnual({ loading: false, error: null, data: { amountTotal: total, pct } });
      } catch (err) {
        if (active) setAnnual({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadBonus() {
      try {
        const { summary } = await getBonusSummary();
        const latest = summary.comparison.latest;
        if (active) {
          setBonus({
            loading: false,
            error: null,
            data: {
              yearTotal: summary.yearTotal,
              latestLabel: latest ? `${latest.label}（${fmtMoney(latest.amount)}）` : null,
            },
          });
        }
      } catch (err) {
        if (active) setBonus({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadPending() {
      try {
        const r = await getRequests("pending");
        if (active) setPendingReq({ loading: false, error: null, data: r.requests.length });
      } catch (err) {
        if (active) setPendingReq({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadAlerts() {
      try {
        const r = await getProjectAlerts();
        const high = r.alerts.filter((a) => a.severity === "high").length;
        if (active) setAlerts({ loading: false, error: null, data: { total: r.alerts.length, high } });
      } catch (err) {
        if (active) setAlerts({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadAnnouncements() {
      try {
        const r = await getAnnouncements();
        if (active) setAnnouncements({ loading: false, error: null, data: r.announcements.slice(0, 3) });
      } catch (err) {
        if (active) setAnnouncements({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadChanges() {
      try {
        const r = await listProjectsExt({ includeArchived: true, sort: "opened", dir: "desc" });
        const filtered = r.projects.filter((p) => p.kind === "change" || p.kind === "addition").slice(0, 5);
        if (active) setChanges({ loading: false, error: null, data: filtered });
      } catch (err) {
        if (active) setChanges({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadSnapshot() {
      try {
        const r = await listBackups();
        if (active) setSnapshot({ loading: false, error: null, data: r.periods[0] ?? null });
      } catch (err) {
        if (active) setSnapshot({ loading: false, error: errMsg(err), data: null });
      }
    }

    void Promise.allSettled([
      loadDisbursement(),
      loadReceivables(),
      loadAnnual(),
      loadBonus(),
      loadPending(),
      loadAlerts(),
      loadAnnouncements(),
      loadChanges(),
      loadSnapshot(),
    ]);

    return () => {
      active = false;
    };
  }, []);

  const visibleLinks =
    widgets.length === 0
      ? LINKS
      : LINKS.filter((link) => {
          if (widgets.includes("待簽核申請") && link.href === "/admin/approvals") return true;
          if (widgets.includes("期末在職") && link.href === "/admin/dashboard") return true;
          if (widgets.includes("新進/離職") && link.href === "/admin/onboarding") return true;
          if (widgets.includes("公告") && link.href === "/admin/announcements") return true;
          if (widgets.includes("薪資作業") && link.href === "/admin/payroll") return true;
          return !["/admin/approvals", "/admin/dashboard", "/admin/onboarding", "/admin/announcements", "/admin/payroll"].includes(link.href);
        });

  async function onSeedDemo() {
    setSeedError(null);
    setDemoStatus(null);
    setSeedingDemo(true);
    try {
      const res = await seedDemoData();
      setDemoStatus(`已建立 Demo 資料：${res.employees} 位員工、${res.attendanceDays} 筆出勤、${res.payslips} 份薪資單、${res.notifications} 筆通知。`);
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : "建立 Demo 資料失敗");
    } finally {
      setSeedingDemo(false);
    }
  }

  return (
    <>
      <PageHeader title="總覽" desc="後台管理首頁" />

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">老闆看板</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <BossCard href="/admin/disbursements" label="放款" state={disb}>
            <p className="text-xl font-semibold text-gray-900">{fmtMoney(disb.data?.monthTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              本年 {fmtMoney(disb.data?.yearTotal)}・應付未付 {fmtMoney(disb.data?.unpaidPayableTotal)}
            </p>
          </BossCard>

          <BossCard href="/admin/projects/receivables" label="未收款總額" state={recv}>
            <p className="text-xl font-semibold text-amber-600">{fmtMoney(recv.data?.unreceivedTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">逾期 {recv.data?.overdueCount ?? "—"} 筆</p>
          </BossCard>

          <BossCard href="/admin/projects/annual" label={`本年合約總額（民國${currentRocYear()}）`} state={annual}>
            <p className="text-xl font-semibold text-gray-900">{fmtMoney(annual.data?.amountTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">已收 {annual.data?.pct == null ? "—" : `${annual.data.pct}%`}</p>
          </BossCard>

          <BossCard href="/admin/bonus-runs" label="獎金本年已發放" state={bonus}>
            <p className="text-xl font-semibold text-gray-900">{fmtMoney(bonus.data?.yearTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">最近批次 {bonus.data?.latestLabel ?? "—"}</p>
          </BossCard>

          <BossCard href="/admin/approvals" label="待簽核假單" state={pendingReq}>
            <p className="text-xl font-semibold text-gray-900">{pendingReq.data ?? 0}</p>
          </BossCard>

          <BossCard href="/admin/projects/alerts" label="專案示警數" state={alerts}>
            <p className="text-xl font-semibold text-gray-900">{alerts.data?.total ?? 0}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {alerts.data && alerts.data.high > 0 ? `高風險 ${alerts.data.high} 件` : "—"}
            </p>
          </BossCard>

          <BossCard href="/admin/announcements" label="最新公告" state={announcements}>
            {announcements.data && announcements.data.length > 0 ? (
              <ul className="space-y-0.5">
                {announcements.data.map((a) => (
                  <li key={a.id} className="truncate text-sm text-gray-800">
                    {a.title}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-400">無公告</p>
            )}
          </BossCard>

          <BossCard href="/admin/projects" label="最近變更案" state={changes}>
            {changes.data && changes.data.length > 0 ? (
              <ul className="space-y-0.5">
                {changes.data.map((p) => {
                  const root = rootCodeOf(p.code);
                  return (
                    <li key={p.id} className="truncate text-sm text-gray-800">
                      {p.code ?? p.name}
                      {p.kind && <span className="text-gray-400"> · {PROJECT_KIND_LABELS[p.kind]}</span>}
                      {root && <span className="text-gray-400"> · 原案 {root}</span>}
                      {p.archivedAt && <span className="text-gray-400">（已封存）</span>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-gray-400">近期無變更案</p>
            )}
          </BossCard>

          <BossCard href="/admin/backups" label="最近快照" state={snapshot}>
            {snapshot.data ? (
              <>
                <p className="text-xl font-semibold text-gray-900">{snapshot.data.period}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {snapshot.data.manifest?.status === "complete"
                    ? "已完成"
                    : snapshot.data.manifest?.status === "incomplete"
                      ? "不完整（列數不符，請重跑）"
                      : snapshot.data.manifest?.status === "running"
                        ? "產生中"
                        : "—"}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-400">尚無快照</p>
            )}
          </BossCard>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-medium text-gray-500">快捷連結</h2>
          <button
            onClick={() => void onSeedDemo()}
            disabled={seedingDemo}
            className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 disabled:opacity-60 sm:w-auto md:rounded-md md:py-2"
          >
            {seedingDemo ? "建立中…" : "建立 Demo 資料"}
          </button>
        </div>
        {seedError && <p className="mb-3 text-sm text-red-600">{seedError}</p>}
        {demoStatus && <p className="mb-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">{demoStatus}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visibleLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg border border-gray-100 p-4 transition hover:border-gray-300 hover:shadow-sm"
            >
              <p className="text-xs font-medium text-gray-400">{l.module}</p>
              <p className="mt-1 font-medium text-gray-800">{l.label}</p>
              <p className="mt-0.5 text-sm text-gray-500">{l.desc}</p>
            </Link>
          ))}
        </div>
        {visibleLinks.length === 0 && <Empty>無快捷連結</Empty>}
      </Card>
    </>
  );
}
