"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/admin-ui";
import { SectionIcon } from "@/components/AdminShell";
import { getRequests, getAnnouncements, type Announcement } from "@/lib/admin-api";
import { adminModulesOf, homeEntries, isAdminPathAllowed, roleNavOf } from "@/lib/admin-nav";
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
import { getCompanyPages, type CompanyPage } from "@/lib/company-api";
import { getUpcomingBirthdays, type BirthdayPerson } from "@/lib/people-extras-api";
import { useEssState } from "@/lib/ess-state";

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

interface BirthdayCardData {
  month: string;
  people: BirthdayPerson[];
  /** 還沒登記紅包的人數——這張卡的重點是「別漏發」。 */
  unrecorded: number;
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

/**
 * 老闆看板的一張卡。`href` 就是這張卡所屬的後台頁（點卡片會去那裡）；`canOpen(href)` 回 false
 * （這個角色開不了那一頁，例如會計對 /admin/bonus-runs、/admin/backups、/admin/birthday-gifts）
 * 整張卡不畫——2026-09-23 正式站驗收：會計首頁三張卡顯示「載入失敗」（API 403）而不是隱藏。
 */
function BossCard({
  href,
  label,
  state,
  canOpen,
  children,
}: {
  href: string;
  label: string;
  state: { loading: boolean; error: string | null };
  canOpen: (href: string) => boolean;
  children: ReactNode;
}) {
  if (!canOpen(href)) return null;
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
  // 首頁下半的分區入口（排除 home；順序與側欄一致，來源 lib/admin-nav.ts）。
  // 以前是模組層常數＝寫死 8 格，會計會看到自己進不去的分區、隱藏模組也照列；
  // 改成跟 AdminShell 側欄同一套算法：roleNavOf(角色, features) ＋ adminModulesOf(features)。
  const essState = useEssState();
  const roleNav = useMemo(() => roleNavOf(essState.me?.role, essState.features), [essState.me?.role, essState.features]);
  const modules = useMemo(() => adminModulesOf(essState.features), [essState.features]);
  const homeSections = useMemo(() => homeEntries(roleNav, modules), [roleNav, modules]);
  // 老闆看板：每張卡標了自己的後台路徑（BossCard href），開不了那一頁的角色就不畫那張卡，
  // 也不打它的 API（會計對獎金／快照／壽星會 403）。HR／平台管理員 roleNav 為 null＝全部可開。
  const canOpen = useMemo(
    () => (href: string) => isAdminPathAllowed({ pathname: href, roleNav, modules }),
    [roleNav, modules],
  );
  // 下面的載入 effect 只在掛載時跑一次；用 ref 讀「當下」的 canOpen（/me 走 AdminGate 的共用快取，
  // 掛載時多半已知）。萬一 me 還沒回來就全打，卡片仍會在渲染時依角色隱藏，只是多幾個 403。
  const canOpenRef = useRef(canOpen);
  useEffect(() => {
    canOpenRef.current = canOpen;
  }, [canOpen]);
  const [disb, setDisb] = useState<Loadable<DisbursementSummary>>(initLoadable<DisbursementSummary>());
  const [recv, setRecv] = useState<Loadable<ReceivablesCardData>>(initLoadable<ReceivablesCardData>());
  const [annual, setAnnual] = useState<Loadable<AnnualCardData>>(initLoadable<AnnualCardData>());
  const [bonus, setBonus] = useState<Loadable<BonusCardData>>(initLoadable<BonusCardData>());
  const [pendingReq, setPendingReq] = useState<Loadable<number>>(initLoadable<number>());
  const [alerts, setAlerts] = useState<Loadable<AlertsCardData>>(initLoadable<AlertsCardData>());
  const [announcements, setAnnouncements] = useState<Loadable<Announcement[]>>(initLoadable<Announcement[]>());
  const [changes, setChanges] = useState<Loadable<ProjectListItem[]>>(initLoadable<ProjectListItem[]>());
  const [snapshot, setSnapshot] = useState<Loadable<SnapshotPeriodSummary | null>>(initLoadable<SnapshotPeriodSummary | null>());
  const [birthdays, setBirthdays] = useState<Loadable<BirthdayCardData>>(initLoadable<BirthdayCardData>());
  const [benefits, setBenefits] = useState<Loadable<CompanyPage | null>>(initLoadable<CompanyPage | null>());

  useEffect(() => {
    let active = true;

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

    async function loadBirthdays() {
      try {
        const r = await getUpcomingBirthdays();
        if (active) {
          setBirthdays({
            loading: false,
            error: null,
            data: {
              month: r.month,
              people: r.birthdays,
              unrecorded: r.birthdays.filter((b) => !b.gift).length,
            },
          });
        }
      } catch (err) {
        if (active) setBirthdays({ loading: false, error: errMsg(err), data: null });
      }
    }

    async function loadBenefits() {
      try {
        const r = await getCompanyPages();
        if (active) {
          setBenefits({
            loading: false,
            error: null,
            data: r.pages.find((p) => p.slug === "benefits") ?? null,
          });
        }
      } catch (err) {
        if (active) setBenefits({ loading: false, error: errMsg(err), data: null });
      }
    }

    // 卡片 href 與下面 JSX 裡的 BossCard href 一一對應；開不了那一頁就不打那支 API。
    const loaders: Array<[href: string, load: () => Promise<void>]> = [
      ["/admin/disbursements", loadDisbursement],
      ["/admin/projects/receivables", loadReceivables],
      ["/admin/projects/annual", loadAnnual],
      ["/admin/bonus-runs", loadBonus],
      ["/admin/approvals", loadPending],
      ["/admin/projects/alerts", loadAlerts],
      ["/admin/announcements", loadAnnouncements],
      ["/admin/projects", loadChanges],
      ["/admin/backups", loadSnapshot],
      ["/admin/birthday-gifts", loadBirthdays],
      ["/admin/company-info", loadBenefits],
    ];
    void Promise.allSettled(loaders.filter(([href]) => canOpenRef.current(href)).map(([, load]) => load()));

    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">老闆看板</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <BossCard href="/admin/disbursements" label="放款" canOpen={canOpen} state={disb}>
            <p className="text-xl font-semibold text-gray-900">{fmtMoney(disb.data?.monthTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              本年 {fmtMoney(disb.data?.yearTotal)}・應付未付 {fmtMoney(disb.data?.unpaidPayableTotal)}
            </p>
          </BossCard>

          <BossCard href="/admin/projects/receivables" label="未收款總額" canOpen={canOpen} state={recv}>
            <p className="text-xl font-semibold text-amber-600">{fmtMoney(recv.data?.unreceivedTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">逾期 {recv.data?.overdueCount ?? "—"} 筆</p>
          </BossCard>

          <BossCard href="/admin/projects/annual" label={`本年合約總額（民國${currentRocYear()}）`} canOpen={canOpen} state={annual}>
            <p className="text-xl font-semibold text-gray-900">{fmtMoney(annual.data?.amountTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">已收 {annual.data?.pct == null ? "—" : `${annual.data.pct}%`}</p>
          </BossCard>

          <BossCard href="/admin/bonus-runs" label="獎金本年已發放" canOpen={canOpen} state={bonus}>
            <p className="text-xl font-semibold text-gray-900">{fmtMoney(bonus.data?.yearTotal)}</p>
            <p className="mt-0.5 text-xs text-gray-500">最近批次 {bonus.data?.latestLabel ?? "—"}</p>
          </BossCard>

          <BossCard href="/admin/approvals" label="待簽核假單" canOpen={canOpen} state={pendingReq}>
            <p className="text-xl font-semibold text-gray-900">{pendingReq.data ?? 0}</p>
          </BossCard>

          <BossCard href="/admin/projects/alerts" label="專案示警數" canOpen={canOpen} state={alerts}>
            <p className="text-xl font-semibold text-gray-900">{alerts.data?.total ?? 0}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {alerts.data && alerts.data.high > 0 ? `高風險 ${alerts.data.high} 件` : "—"}
            </p>
          </BossCard>

          <BossCard href="/admin/announcements" label="最新公告" canOpen={canOpen} state={announcements}>
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

          <BossCard href="/admin/projects" label="最近變更案" canOpen={canOpen} state={changes}>
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

          <BossCard href="/admin/birthday-gifts" label="本月壽星" canOpen={canOpen} state={birthdays}>
            <p className="text-xl font-semibold text-gray-900">{birthdays.data?.people.length ?? 0}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {birthdays.data && birthdays.data.people.length > 0
                ? birthdays.data.unrecorded > 0
                  ? `${birthdays.data.unrecorded} 位尚未登記紅包`
                  : "紅包都登記了"
                : "本月沒有壽星"}
            </p>
          </BossCard>

          <BossCard href="/admin/company-info" label="福利" canOpen={canOpen} state={benefits}>
            {benefits.data?.exists ? (
              <>
                <p className="truncate text-base font-semibold text-gray-900">{benefits.data.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  更新於 {benefits.data.updatedAt ? benefits.data.updatedAt.slice(0, 10) : "—"}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-400">尚未填寫公司福利</p>
            )}
          </BossCard>

          <BossCard href="/admin/backups" label="最近快照" canOpen={canOpen} state={snapshot}>
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

      <Card title="功能分區">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {homeSections.map((s) => (
            <Link
              key={s.key}
              href={s.href}
              className="flex items-start gap-3 rounded-lg border border-gray-100 p-4 transition hover:border-gray-300 hover:shadow-sm"
            >
              <span className="mt-0.5 shrink-0" style={{ color: "var(--brand)" }}>
                <SectionIcon name={s.icon} className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <p className="font-medium text-gray-800">{s.label}</p>
                <p className="mt-0.5 text-sm text-gray-500">{s.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
