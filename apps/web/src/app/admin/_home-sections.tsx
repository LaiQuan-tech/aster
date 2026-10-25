"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Card, Segmented } from "@/components/admin-ui";
import type { BossSummary } from "@/lib/dashboard-api";
import {
  bossLinks,
  companyRows,
  complianceItems,
  fmtCount,
  fmtPct1,
  fmtWan,
  groupKpis,
  isSingleCompany,
  needsAttention,
  optionalColumns,
  type CompanyRow,
  type CompanyView,
  type GroupOverviewLite,
  type Kpi,
} from "@/lib/boss-dashboard";

/* 後台首頁新版三區（集團總覽／待處理／人事）。資料由 page.tsx 讀好傳進來，這裡只負責畫；格式與計算在 lib/boss-dashboard.ts。 */

export type Load<T> = { loading: boolean; error: string | null; data: T | null };

/* ----------------------------------------------------------- 共用元件 --- */

function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={["block animate-pulse rounded bg-slate-200/80", className].filter(Boolean).join(" ")} />;
}

function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-gray-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <p className="text-sm text-red-600" title={message}>
      載入失敗
    </p>
  );
}

/** 一格數字。href 有給就整格可點。tone：attention＝>0 時標色。 */
function Tile({
  label,
  value,
  sub,
  href,
  loading,
  attention,
  danger,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  href?: string;
  loading?: boolean;
  attention?: boolean;
  danger?: boolean;
}) {
  const valueColor = danger ? "text-red-600" : attention ? "text-amber-600" : "text-gray-900";
  const body = (
    <>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-7 w-16" />
          <Skeleton className="mt-2 h-3 w-24" />
        </>
      ) : (
        <>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
          {sub ? <div className="mt-0.5 text-xs text-gray-500">{sub}</div> : null}
        </>
      )}
    </>
  );
  const cls = "block min-w-0 rounded-xl bg-slate-50 p-4";
  return href && !loading ? (
    <Link href={href} className={`${cls} transition hover:bg-slate-100`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/* ---------------------------------------------------------- 集團總覽區 --- */

function KpiBlock({ title, kpi }: { title: string; kpi: Kpi | null }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <p className="text-xs font-medium text-gray-500">{title}</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-gray-400">收入</p>
          {kpi ? <p className="truncate text-lg font-semibold tabular-nums text-gray-900 sm:text-xl">{fmtWan(kpi.revenue)}</p> : <Skeleton className="mt-1 h-6 w-16" />}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-gray-400">毛利</p>
          {kpi ? (
            <p className={`truncate text-lg font-semibold tabular-nums sm:text-xl ${kpi.grossProfit < 0 ? "text-red-600" : "text-gray-900"}`}>{fmtWan(kpi.grossProfit)}</p>
          ) : (
            <Skeleton className="mt-1 h-6 w-16" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-gray-400">毛利率</p>
          {kpi ? <p className="truncate text-lg font-semibold tabular-nums text-gray-900 sm:text-xl">{fmtPct1(kpi.grossMarginPct)}</p> : <Skeleton className="mt-1 h-6 w-12" />}
        </div>
      </div>
    </div>
  );
}

function CompanyTable({ rows, cols }: { rows: CompanyRow[]; cols: { headcount: boolean; payrollCost: boolean } }) {
  return (
    <>
      {/* 桌機：表格 */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="py-2 pr-3 font-medium">公司</th>
              <th className="py-2 pr-3 text-right font-medium">收入</th>
              <th className="py-2 pr-3 text-right font-medium">放款支出</th>
              <th className="py-2 pr-3 text-right font-medium">毛利</th>
              <th className="py-2 pr-3 text-right font-medium">毛利率</th>
              <th className="py-2 pr-3 text-right font-medium">逾期應收</th>
              {cols.headcount ? <th className="py-2 pr-3 text-right font-medium">人數</th> : null}
              {cols.payrollCost ? <th className="py-2 text-right font-medium">薪資成本</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-50 last:border-0">
                <td className="max-w-[14rem] truncate py-2 pr-3 text-gray-800">{r.name}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtWan(r.revenue)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtWan(r.expense)}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${r.grossProfit < 0 ? "text-red-600" : ""}`}>{fmtWan(r.grossProfit)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500">{fmtPct1(r.grossMarginPct)}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${needsAttention(r.overdue) ? "text-amber-600" : ""}`}>
                  {fmtWan(r.overdue)}
                  {needsAttention(r.overdueCount) ? <span className="ml-1 text-xs text-gray-400">{r.overdueCount} 筆</span> : null}
                </td>
                {cols.headcount ? <td className="py-2 pr-3 text-right tabular-nums">{fmtCount(r.headcount)}</td> : null}
                {cols.payrollCost ? <td className="py-2 text-right tabular-nums">{fmtWan(r.payrollCost)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* 手機：一家公司一張小卡 */}
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-gray-100 p-3">
            <p className="truncate text-sm font-medium text-gray-800">{r.name}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-gray-500">收入</dt>
              <dd className="text-right tabular-nums text-gray-900">{fmtWan(r.revenue)}</dd>
              <dt className="text-gray-500">放款支出</dt>
              <dd className="text-right tabular-nums text-gray-900">{fmtWan(r.expense)}</dd>
              <dt className="text-gray-500">毛利（{fmtPct1(r.grossMarginPct)}）</dt>
              <dd className={`text-right tabular-nums ${r.grossProfit < 0 ? "text-red-600" : "text-gray-900"}`}>{fmtWan(r.grossProfit)}</dd>
              <dt className="text-gray-500">逾期應收</dt>
              <dd className={`text-right tabular-nums ${needsAttention(r.overdue) ? "text-amber-600" : "text-gray-900"}`}>{fmtWan(r.overdue)}</dd>
              {cols.headcount ? (
                <>
                  <dt className="text-gray-500">人數</dt>
                  <dd className="text-right tabular-nums text-gray-900">{fmtCount(r.headcount)}</dd>
                </>
              ) : null}
              {cols.payrollCost ? (
                <>
                  <dt className="text-gray-500">薪資成本</dt>
                  <dd className="text-right tabular-nums text-gray-900">{fmtWan(r.payrollCost)}</dd>
                </>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function SingleCompanySummary({ row, cols }: { row: CompanyRow; cols: { headcount: boolean; payrollCost: boolean } }) {
  return (
    <div>
      <p className="mb-2 truncate text-sm font-medium text-gray-800">{row.name}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="收入" value={fmtWan(row.revenue)} />
        <Tile label="放款支出" value={fmtWan(row.expense)} />
        <Tile label="毛利" value={fmtWan(row.grossProfit)} sub={`毛利率 ${fmtPct1(row.grossMarginPct)}`} danger={row.grossProfit < 0} />
        <Tile
          label="逾期應收"
          value={fmtWan(row.overdue)}
          sub={row.overdueCount == null ? "—" : `${row.overdueCount} 筆`}
          href="/admin/projects/receivables"
          attention={needsAttention(row.overdue)}
        />
        {cols.headcount ? <Tile label="人數" value={fmtCount(row.headcount)} /> : null}
        {cols.payrollCost ? <Tile label="薪資成本" value={fmtWan(row.payrollCost)} /> : null}
      </div>
    </div>
  );
}

export function GroupSection({
  overview,
  summary,
  month,
}: {
  overview: Load<GroupOverviewLite>;
  summary: Load<BossSummary>;
  month: number;
}) {
  const [view, setView] = useState<CompanyView>("year");
  const kpis = overview.data ? groupKpis(overview.data, month) : null;
  const overdue = summary.data?.overdueReceivablesByCompany ?? null;
  const rows = overview.data ? companyRows(overview.data, overdue, view, month) : [];
  const cols = overview.data ? optionalColumns(overview.data) : { headcount: false, payrollCost: false };
  const year = overview.data?.period.year;

  return (
    <Card>
      <SectionTitle
        title="集團總覽"
        hint="收入＝實際入帳（未稅）；支出＝已匯款放款（代扣前）；毛利不含人事成本"
        action={
          <Link href={bossLinks.groupOverview} className="text-xs font-medium hover:underline" style={{ color: "var(--brand)" }}>
            查看集團總覽 →
          </Link>
        }
      />
      {overview.error ? (
        <LoadError message={overview.error} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiBlock title={`本月（${month} 月）`} kpi={kpis?.month ?? null} />
            <KpiBlock title={year ? `本年（${year}）` : "本年"} kpi={kpis?.year ?? null} />
          </div>
          <div className="mt-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-gray-500">{isSingleCompany(rows) ? "公司摘要" : "各公司"}</p>
              <Segmented
                size="sm"
                aria-label="各公司數字期間"
                value={view}
                onChange={setView}
                options={[
                  { value: "month", label: "本月" },
                  { value: "year", label: "本年" },
                ]}
              />
            </div>
            {overview.loading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-gray-400">—</p>
            ) : isSingleCompany(rows) ? (
              <SingleCompanySummary row={rows[0] as CompanyRow} cols={cols} />
            ) : (
              <CompanyTable rows={rows} cols={cols} />
            )}
            {summary.data && summary.data.scope.receivablesByCompany && overdue === null ? (
              <p className="mt-2 text-xs text-gray-400">逾期應收暫時讀不到，顯示「—」。</p>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ 待處理區 --- */

function SplitTile({
  label,
  loading,
  value,
  attention,
  lines,
}: {
  label: string;
  loading: boolean;
  value: ReactNode;
  attention?: boolean;
  lines: Array<{ key: string; text: ReactNode; href: string }>;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 p-4">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-7 w-16" />
          <Skeleton className="mt-2 h-3 w-28" />
        </>
      ) : (
        <>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${attention ? "text-amber-600" : "text-gray-900"}`}>{value}</p>
          <ul className="mt-1 space-y-0.5">
            {lines.map((l) => (
              <li key={l.key}>
                <Link href={l.href} className="text-xs text-gray-600 hover:underline">
                  {l.text} →
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function TodoSection({ summary }: { summary: Load<BossSummary> }) {
  const s = summary.data;
  const loading = summary.loading;
  const scope = s?.scope;
  const period = s?.period ?? "";
  const att = s?.attendance ?? null;
  const ot = s?.overtime ?? null;
  const noSheets = att !== null && att.sheetCount === 0;

  const approvalLines: Array<{ key: string; text: ReactNode; href: string }> = [];
  if (loading || scope?.leaveApprovals) approvalLines.push({ key: "leave", text: `假單 ${fmtCount(s?.approvals.leave)}`, href: bossLinks.leaveApprovals });
  if (loading || scope?.disbursementApprovals)
    approvalLines.push({
      key: "disb",
      text: (
        <>
          放款單 {fmtCount(s?.approvals.disbursements)}
          {s?.approvals.disbursementAmount ? <span className="text-gray-400">（{fmtWan(s.approvals.disbursementAmount)}）</span> : null}
        </>
      ),
      href: bossLinks.disbursementApprovals,
    });

  const showApprovals = loading || !!scope?.leaveApprovals || !!scope?.disbursementApprovals;
  const showAttendance = loading || !!scope?.attendance;
  const showOvertime = !loading && !!scope?.overtime;

  return (
    <Card>
      <SectionTitle title="待處理" hint={period ? `${period} 本月` : undefined} />
      {summary.error ? (
        <LoadError message={summary.error} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {showApprovals ? (
            <SplitTile label="待簽核" loading={loading} value={fmtCount(s?.approvals.total)} attention={needsAttention(s?.approvals.total)} lines={approvalLines} />
          ) : null}

          {showAttendance ? (
            <Tile
              label="出勤異常（本月）"
              loading={loading}
              value={fmtCount(att?.anomalies)}
              sub={noSheets ? "本月月表尚未產生" : att ? `${fmtCount(att.anomalySheets)} 張月表有異常` : "—"}
              href={period ? bossLinks.attendanceAnomalies(period) : undefined}
              attention={needsAttention(att?.anomalies)}
            />
          ) : null}

          {showAttendance ? (
            <Link
              href={period ? bossLinks.attendanceAnomalies(period) : "/admin/attendance-sheets"}
              className="block min-w-0 rounded-xl bg-slate-50 p-4 transition hover:bg-slate-100"
            >
              <p className="text-xs font-medium text-gray-500">合規警示（本月）</p>
              {loading ? (
                <>
                  <Skeleton className="mt-2 h-7 w-16" />
                  <Skeleton className="mt-2 h-3 w-32" />
                </>
              ) : (
                <>
                  <p className={`mt-1 text-2xl font-semibold tabular-nums ${needsAttention(att?.compliance.total) ? "text-red-600" : "text-gray-900"}`}>
                    {fmtCount(att?.compliance.total)}
                  </p>
                  {att ? (
                    <ul className="mt-1 grid grid-cols-2 gap-x-2 text-xs text-gray-500">
                      {complianceItems(att.compliance).map((c) => (
                        <li key={c.key} className={c.count > 0 ? "text-red-600" : undefined}>
                          {c.label} {fmtCount(c.count)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-xs text-gray-500">—</p>
                  )}
                </>
              )}
            </Link>
          ) : null}

          {showOvertime ? (
            <SplitTile
              label="加班超上限"
              loading={false}
              value={ot?.overCapPeople == null ? "—" : `${fmtCount(ot.overCapPeople)} 人`}
              attention={needsAttention(ot?.overCapPeople)}
              lines={[
                {
                  key: "draft",
                  text: (
                    <>
                      待發另計 {fmtWan(ot?.draftAmount)}
                      {ot?.draftCount ? <span className="text-gray-400">（{ot.draftCount} 筆{ot.draftMissingAmount ? `，${ot.draftMissingAmount} 筆未填金額` : ""}）</span> : null}
                    </>
                  ),
                  href: bossLinks.overtimeDrafts(ot?.latestDraftPeriod ?? null),
                },
                ...(period ? [{ key: "sheets", text: "看本月月表", href: bossLinks.attendanceAnomalies(period) }] : []),
              ]}
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- 人事區 --- */

export function PeopleSection({ summary }: { summary: Load<BossSummary> }) {
  const s = summary.data;
  const loading = summary.loading;
  const p = s?.people ?? null;
  const att = s?.attendance ?? null;
  return (
    <Card>
      <SectionTitle title="人事" hint={s?.period ? `${s.period} 本月` : undefined} />
      {summary.error ? (
        <LoadError message={summary.error} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="在職" loading={loading} value={fmtCount(p?.active)} href={bossLinks.employees} />
          <Tile label="本月新進" loading={loading} value={fmtCount(p?.hires)} href={bossLinks.employees} />
          <Tile label="本月離職" loading={loading} value={fmtCount(p?.exits)} href={bossLinks.employees} attention={needsAttention(p?.exits)} />
          <Tile
            label="本月出勤異常"
            loading={loading}
            value={fmtCount(att?.anomalies)}
            sub={att && att.sheetCount === 0 ? "本月月表尚未產生" : undefined}
            href={s?.period ? bossLinks.attendanceAnomalies(s.period) : undefined}
            attention={needsAttention(att?.anomalies)}
          />
        </div>
      )}
    </Card>
  );
}
