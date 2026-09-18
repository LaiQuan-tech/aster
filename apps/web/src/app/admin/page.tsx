"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/admin-ui";
import { SectionIcon } from "@/components/AdminShell";
import { getRequests, getAnnouncements, type Announcement } from "@/lib/admin-api";
import { homeEntries } from "@/lib/admin-nav";
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

/** 首頁下半的 8 個分區入口（排除 home；順序與側欄一致，來源 lib/admin-nav.ts）。 */
const HOME_ENTRIES = homeEntries();

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

  return (
    <>
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

      <Card title="功能分區">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {HOME_ENTRIES.map((s) => (
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
