"use client";

/**
 * 集團總覽頁的零件：數字卡、各公司表（點列展開下鑽）、月趨勢圖。
 * 2026-10-25 加上人事：在職人數、人事成本、扣人事成本後（人事依員工所屬公司，未指派另列不分攤）。
 * 狀態與資料抓取在 page.tsx；金額格式、圖表座標等純邏輯在 lib/group-overview.ts（有單元測試）。
 */
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Empty, Pill } from "@/components/admin-ui";
import type {
  GroupCompanyRow,
  GroupDataQuality,
  GroupExpenseDetail,
  GroupMonthPoint,
  GroupPayrollSummary,
  GroupQualityRow,
  GroupRevenueDetail,
  GroupTotals,
} from "@/lib/group-overview-api";
import {
  affiliateCellText,
  buildTrendChart,
  eliminatedNote,
  fmtMoney,
  fmtMoneyOrDash,
  fmtPct,
  nameWithShort,
  NO_PAYROLL_TEXT,
  PAYROLL_BASIS_NOTE,
  payrollNotes,
  periodLabel,
  qualityMessages,
  roundedTopBarPath,
  trendSummary,
} from "@/lib/group-overview";

/** 圖表色：categorical 前三格（已用 dataviz validate_palette 驗過 CVD 分離）；文字永遠用文字色，不用系列色。 */
const COLOR = {
  revenue: "#2a78d6",
  expense: "#eb6834",
  profit: "#1baf7a",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  muted: "#898781",
  ink: "#52514e",
  surface: "#ffffff",
  hover: "#f3f4f6",
  selected: "#eff6ff",
} as const;

const negative = (n: number) => (n < 0 ? "text-red-600" : "text-gray-900");

/* ------------------------------------------------------------ 數字卡 --- */

/** 人數：舊版 API 沒有欄位 → 「—」。 */
const fmtCount = (n: number | null | undefined) => (n == null ? "—" : `${n.toLocaleString("zh-TW")} 人`);

export function StatCards({
  group,
  year,
  month,
  payroll,
}: {
  group: GroupTotals;
  year: number;
  month: number | null;
  payroll?: GroupPayrollSummary;
}) {
  const noPayroll = group.payrollCost == null;
  const cards: Array<{ label: string; value: string; hint: string; tone?: string }> = [
    { label: "集團入帳收入", value: fmtMoney(group.revenue), hint: "實際入帳、未稅" },
    { label: "已開票（參考）", value: fmtMoney(group.invoiced), hint: "依開票日、未稅，不併入收入" },
    { label: "放款支出", value: fmtMoney(group.expense), hint: "已匯款、代扣前" },
    { label: "專案毛利", value: fmtMoney(group.grossProfit), hint: "入帳收入 − 放款支出", tone: negative(group.grossProfit) },
    { label: "毛利率", value: fmtPct(group.grossMarginPct), hint: "毛利 ÷ 入帳收入", tone: group.grossMarginPct != null && group.grossMarginPct < 0 ? "text-red-600" : "text-gray-900" },
  ];
  // 人事三張卡：舊版 API（沒有 payroll）不顯示，免得出現一排「—」。
  if (payroll) {
    cards.push(
      { label: "在職人數", value: fmtCount(group.headcount), hint: "目前在職，含未指派公司" },
      { label: "人事成本", value: fmtMoney(group.payrollCost), hint: noPayroll ? NO_PAYROLL_TEXT : "薪資單應發合計" },
      {
        label: "扣人事成本後",
        value: fmtMoney(group.grossProfitAfterPayroll),
        hint: noPayroll ? NO_PAYROLL_TEXT : "專案毛利 − 人事成本",
        tone: group.grossProfitAfterPayroll != null ? negative(group.grossProfitAfterPayroll) : undefined,
      },
    );
  }
  const notes = payrollNotes(payroll, group);
  return (
    <Card title={`集團合計 · ${periodLabel(year, month)}`}>
      <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${payroll ? "lg:grid-cols-4" : "lg:grid-cols-5"}`}>
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs font-medium text-gray-500">{c.label}</p>
            <p className={`mt-1 text-xl font-semibold ${c.tone ?? "text-gray-900"}`}>{c.value}</p>
            <p className="mt-0.5 text-xs text-gray-400">{c.hint}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-gray-500">{eliminatedNote(group.eliminated)}。</p>
      {notes.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
          {notes.map((n) => (
            <li key={n}>{n}。</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------ 資料品質提醒 --- */

function QualityList({ title, rows, showEffective }: { title: string; rows: GroupQualityRow[]; showEffective: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto">
      <p className="mb-1 text-xs font-medium text-amber-900">{title}（金額前 {rows.length} 筆）</p>
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="border-b border-amber-200 text-left text-amber-800">
            <th className="py-1 pr-3">專案</th>
            <th className="py-1 pr-3">期別</th>
            {showEffective && <th className="py-1 pr-3">入帳日</th>}
            <th className="py-1 pr-3 text-right">實收</th>
            {showEffective && <th className="py-1 text-right">該期應收（未稅）</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.projectId}-${r.installmentNo ?? "x"}-${i}`} className="border-b border-amber-100 last:border-0">
              <td className="py-1 pr-3">
                <Link href={`/admin/projects/${r.projectId}`} className="text-amber-950 underline-offset-2 hover:underline">
                  {r.code ? `${r.code} ` : ""}
                  {r.name}
                </Link>
              </td>
              <td className="py-1 pr-3 text-amber-900">{r.installmentNo != null ? `第 ${r.installmentNo} 期` : "—"}</td>
              {showEffective && <td className="py-1 pr-3 text-amber-900">{r.receivedOn ?? "—"}</td>}
              <td className="py-1 pr-3 text-right text-amber-950">{fmtMoney(r.receivedAmount)}</td>
              {showEffective && <td className="py-1 text-right text-amber-950">{fmtMoney(r.effectiveAmount)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 資料品質提醒：沒有問題就不畫。不改任何數字，只是告訴老闆哪裡要人去核對（入帳金額必須填未稅）。 */
export function DataQualityNotice({ quality, year }: { quality: GroupDataQuality; year: number }) {
  const messages = qualityMessages(quality, year);
  if (messages.length === 0) return null;
  return (
    <div role="note" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-medium">資料需要核對</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-amber-800 hover:text-amber-950">看是哪幾筆</summary>
        <QualityList title="沒有入帳日" rows={quality.undatedReceived.sample} showEffective={false} />
        <QualityList title="實收高於應收（未稅）" rows={quality.receivedOverEffective.sample} showEffective />
      </details>
    </div>
  );
}

/* ------------------------------------------------------------ 下鑽 --- */

export type DetailState = {
  key: string;
  revenue: GroupRevenueDetail | null;
  expense: GroupExpenseDetail | null;
  error: string | null;
  loading: boolean;
};

function AffiliateBadge() {
  return (
    <Pill tone="blue" className="ml-1.5 align-middle">
      關係企業
    </Pill>
  );
}

function ListFooter({ count, total, truncated, unit }: { count: number; total: number; truncated: boolean; unit: string }) {
  return (
    <p className="mt-2 text-xs text-gray-500">
      共 {count.toLocaleString("zh-TW")} {unit}，合計 {fmtMoney(total)} 元{truncated ? "（只列金額前 50 名）" : ""}
    </p>
  );
}

function DrillPanel({ detail }: { detail: DetailState | null }) {
  if (!detail || detail.loading) return <p className="text-sm text-gray-400">載入中…</p>;
  if (detail.error) return <p role="alert" className="text-sm text-red-600">{detail.error}</p>;
  const { revenue, expense } = detail;
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <h3 className="mb-1.5 text-sm font-semibold text-gray-700">入帳收入 · 專案</h3>
        {!revenue || revenue.rows.length === 0 ? (
          <Empty>這個期間沒有入帳</Empty>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-1.5 pr-2">專案</th>
                  <th className="py-1.5 pr-2">客戶</th>
                  <th className="py-1.5 text-right">入帳金額</th>
                </tr>
              </thead>
              <tbody>
                {revenue.rows.map((r) => (
                  <tr key={r.projectId} className="border-b last:border-0 align-top">
                    <td className="py-1.5 pr-2">
                      <Link href={`/admin/projects/${r.projectId}`} className="text-gray-900 hover:underline">
                        {r.code ? <span className="mr-1 text-xs text-gray-400">{r.code}</span> : null}
                        {r.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2 text-gray-600">
                      {r.clientName ? nameWithShort(r.clientName, r.clientShortName) : "—"}
                      {r.isAffiliate && <AffiliateBadge />}
                    </td>
                    <td className="py-1.5 text-right text-gray-900">{fmtMoney(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ListFooter count={revenue.count} total={revenue.total} truncated={revenue.truncated} unit="個專案" />
          </>
        )}
      </div>
      <div>
        <h3 className="mb-1.5 text-sm font-semibold text-gray-700">放款支出 · 廠商</h3>
        {!expense || expense.rows.length === 0 ? (
          <Empty>這個期間沒有已匯款的放款</Empty>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-1.5 pr-2">廠商</th>
                  <th className="py-1.5 pr-2 text-right">筆數</th>
                  <th className="py-1.5 text-right">放款金額</th>
                </tr>
              </thead>
              <tbody>
                {expense.rows.map((r) => (
                  <tr key={r.key} className="border-b last:border-0 align-top">
                    <td className="py-1.5 pr-2 text-gray-900">
                      {nameWithShort(r.name, r.shortName)}
                      {r.vendorId === null && <span className="ml-1.5 text-xs text-gray-400">（其他收款方）</span>}
                      {r.isAffiliate && <AffiliateBadge />}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-gray-600">{r.count}</td>
                    <td className="py-1.5 text-right text-gray-900">{fmtMoney(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ListFooter count={expense.count} total={expense.total} truncated={expense.truncated} unit="家廠商" />
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- 各公司表 --- */

const COLUMN_COUNT = 10;

export function CompanyTable({
  companies,
  group,
  expandedId,
  detail,
  onToggle,
  payroll,
}: {
  companies: GroupCompanyRow[];
  group: GroupTotals;
  expandedId: string | null;
  detail: DetailState | null;
  onToggle: (companyId: string) => void;
  payroll?: GroupPayrollSummary;
}) {
  const showUnassigned = (group.unassignedHeadcount ?? 0) > 0 || (group.unassignedPayrollCost ?? 0) !== 0;
  const payrollTitle = payroll?.hasData === false ? NO_PAYROLL_TEXT : undefined;
  return (
    <Card title="各公司" action={<span className="text-xs text-gray-400">點一列看收入（專案）與支出（廠商）</span>}>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-sm">
          <caption className="sr-only">
            各公司入帳收入、已開票（參考）、放款支出、專案毛利、扣人事成本後、毛利率、在職人數與人事成本；每家公司的數字含關係企業往來；{PAYROLL_BASIS_NOTE}
          </caption>
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2 pr-3">公司</th>
              <th className="py-2 pr-3 text-right">入帳收入</th>
              <th className="py-2 pr-3 text-right" title="依開票日、未稅；參考數字，不併入收入">已開票（參考）</th>
              <th className="py-2 pr-3 text-right">放款支出</th>
              <th className="py-2 pr-3 text-right">專案毛利</th>
              <th className="py-2 pr-3 text-right" title={`專案毛利 − 人事成本；${PAYROLL_BASIS_NOTE}`}>扣人事成本後</th>
              <th className="py-2 pr-3 text-right">毛利率</th>
              <th className="py-2 pr-3 text-right" title="目前在職、依員工所屬公司">在職人數</th>
              <th className="py-2 pr-3 text-right" title={`期間內薪資單應發合計；${PAYROLL_BASIS_NOTE}`}>人事成本</th>
              <th className="py-2 text-right" title="客戶是關係企業的專案收入、付給關係企業廠商的放款；已包含在左邊的數字裡，只有集團合計會剔除">
                其中關係企業往來
              </th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => {
              const open = expandedId === c.id;
              const muted = c.excluded ? "text-gray-400" : "";
              return (
                <Fragment key={c.id}>
                  <tr
                    onClick={() => onToggle(c.id)}
                    className={`cursor-pointer border-b hover:bg-gray-50 ${open ? "bg-gray-50" : ""} ${muted}`}
                  >
                    <td className="py-2 pr-3 font-medium">
                      <button
                        type="button"
                        aria-expanded={open}
                        className={`inline-flex items-center gap-1.5 text-left ${c.excluded ? "text-gray-400" : "text-gray-900"}`}
                      >
                        <span aria-hidden="true" className="inline-block w-3 text-xs text-gray-400">{open ? "▾" : "▸"}</span>
                        {c.name}
                      </button>
                      {c.isDefault && <Pill tone="gray" className="ml-2">預設</Pill>}
                      {!c.isActive && <Pill tone="gray" className="ml-2">已停用</Pill>}
                      {c.excluded && <Pill tone="gray" className="ml-2">未納入合計</Pill>}
                    </td>
                    <td className="py-2 pr-3 text-right">{fmtMoney(c.revenue)}</td>
                    <td className="py-2 pr-3 text-right">{fmtMoney(c.invoiced)}</td>
                    <td className="py-2 pr-3 text-right">{fmtMoney(c.expense)}</td>
                    <td className={`py-2 pr-3 text-right font-medium ${c.excluded ? "" : negative(c.grossProfit)}`}>{fmtMoney(c.grossProfit)}</td>
                    <td
                      className={`py-2 pr-3 text-right ${c.excluded || c.grossProfitAfterPayroll == null ? "" : negative(c.grossProfitAfterPayroll)}`}
                      title={payrollTitle}
                    >
                      {fmtMoney(c.grossProfitAfterPayroll)}
                    </td>
                    <td className="py-2 pr-3 text-right">{fmtPct(c.grossMarginPct)}</td>
                    <td className="py-2 pr-3 text-right">{c.headcount ?? "—"}</td>
                    <td className="py-2 pr-3 text-right" title={payrollTitle}>{fmtMoney(c.payrollCost)}</td>
                    <td className="py-2 text-right text-xs">{affiliateCellText(c.affiliate)}</td>
                  </tr>
                  {open && (
                    <tr className="border-b bg-gray-50">
                      <td colSpan={COLUMN_COUNT} className="px-2 pb-4 pt-2">
                        {/* sticky：表格橫向捲動時，展開的面板固定在可視範圍左側，不被推到畫面外 */}
                        <div className="sticky left-0 whitespace-normal" style={{ width: "min(calc(100vw - 4rem), 60rem)" }}>
                          <DrillPanel detail={detail} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {showUnassigned && (
              <tr className="border-b text-gray-600">
                <td className="py-2 pr-3">
                  未指派公司的員工
                  <span className="ml-2 text-xs text-gray-400">（人事成本不分攤）</span>
                </td>
                <td className="py-2 pr-3 text-right text-gray-400" colSpan={6}>
                  <Link href="/admin/employees" className="text-xs underline hover:text-gray-700">
                    到員工管理指派所屬公司
                  </Link>
                </td>
                <td className="py-2 pr-3 text-right">{group.unassignedHeadcount}</td>
                <td className="py-2 pr-3 text-right" title={payrollTitle}>{fmtMoney(group.unassignedPayrollCost)}</td>
                <td className="py-2 text-right text-xs">—</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-800 font-semibold">
              <td className="py-2 pr-3">
                集團合計
                <span className="ml-2 text-xs font-normal text-gray-500">（已剔除關係企業往來，不含未納入的公司；人事含未指派）</span>
              </td>
              <td className="py-2 pr-3 text-right">{fmtMoney(group.revenue)}</td>
              <td className="py-2 pr-3 text-right">{fmtMoney(group.invoiced)}</td>
              <td className="py-2 pr-3 text-right">{fmtMoney(group.expense)}</td>
              <td className={`py-2 pr-3 text-right ${negative(group.grossProfit)}`}>{fmtMoney(group.grossProfit)}</td>
              <td
                className={`py-2 pr-3 text-right ${group.grossProfitAfterPayroll == null ? "" : negative(group.grossProfitAfterPayroll)}`}
                title={payrollTitle}
              >
                {fmtMoney(group.grossProfitAfterPayroll)}
              </td>
              <td className="py-2 pr-3 text-right">{fmtPct(group.grossMarginPct)}</td>
              <td className="py-2 pr-3 text-right">{group.headcount ?? "—"}</td>
              <td className="py-2 pr-3 text-right" title={payrollTitle}>{fmtMoney(group.payrollCost)}</td>
              <td className="py-2 text-right text-xs font-normal text-gray-500">已剔除 {fmtMoney(group.eliminated.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------- 月趨勢圖 --- */

function Legend() {
  return (
    <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600" aria-label="圖例">
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COLOR.revenue }} aria-hidden="true" />
        入帳收入
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COLOR.expense }} aria-hidden="true" />
        放款支出
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-flex items-center" aria-hidden="true">
          <span className="inline-block h-0.5 w-3" style={{ backgroundColor: COLOR.profit }} />
          <span className="-ml-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: COLOR.profit }} />
        </span>
        專案毛利
      </li>
    </ul>
  );
}

function pointText(p: GroupMonthPoint): string {
  return `${p.month} 月：入帳收入 ${fmtMoney(p.revenue)}、放款支出 ${fmtMoney(p.expense)}、專案毛利 ${fmtMoney(p.grossProfit)}`;
}

/**
 * 月趨勢：每月入帳收入與放款支出兩根長條＋專案毛利折線，同一條 Y 軸（同為新台幣）。
 * 數字照所選對象的口徑（公司那條含關係企業往來，集團那條已剔除）。每個月一個命中區，hover／鍵盤 focus
 * 都顯示同一份明細；圖下面一定有逐月數字表。
 */
export function TrendCard({
  points,
  label,
  highlightMonth,
}: {
  points: GroupMonthPoint[];
  label: string;
  highlightMonth: number | null;
}) {
  const chart = useMemo(() => buildTrendChart(points), [points]);
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover === null ? null : (chart.columns[hover] ?? null);
  const total = (pick: (p: GroupMonthPoint) => number) => points.reduce((s, p) => s + pick(p), 0);

  // tooltip 靠哪一側，避免在最左／最右的月份被切掉
  const anchor = hover === null ? "center" : hover <= 2 ? "left" : hover >= points.length - 3 ? "right" : "center";

  return (
    <Card title={`月趨勢 · ${label}`}>
      <Legend />
      {chart.isEmpty ? (
        <Empty>這個年度沒有資料</Empty>
      ) : (
        <div className="overflow-x-auto">
          <div className="relative" style={{ minWidth: 640 }}>
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width="100%" role="img" aria-label={trendSummary(points, label)}>
              {chart.ticks.map((t) => (
                <g key={t.value}>
                  <line x1={chart.plotLeft} x2={chart.plotRight} y1={t.y} y2={t.y} stroke={COLOR.grid} strokeWidth={1} />
                  <text x={chart.plotLeft - 8} y={t.y + 4} textAnchor="end" fontSize={11} fill={COLOR.muted}>
                    {t.label}
                  </text>
                </g>
              ))}
              <line x1={chart.plotLeft} x2={chart.plotRight} y1={chart.zeroY} y2={chart.zeroY} stroke={COLOR.axis} strokeWidth={1} />

              {chart.columns.map((c, i) => {
                const band = hover === i ? COLOR.hover : highlightMonth === c.month ? COLOR.selected : null;
                return (
                  <g key={c.month}>
                    {band && <rect x={c.slotX} y={chart.plotTop} width={c.slotWidth} height={chart.plotBottom - chart.plotTop} fill={band} />}
                    <text x={c.cx} y={chart.height - 10} textAnchor="middle" fontSize={11} fill={highlightMonth === c.month ? COLOR.ink : COLOR.muted} fontWeight={highlightMonth === c.month ? 600 : 400}>
                      {c.month}月
                    </text>
                  </g>
                );
              })}

              {chart.columns.map((c) => (
                <g key={`bars-${c.month}`}>
                  {c.revenueBar && <path d={roundedTopBarPath(c.revenueBar)} fill={COLOR.revenue} />}
                  {c.expenseBar && <path d={roundedTopBarPath(c.expenseBar)} fill={COLOR.expense} />}
                </g>
              ))}

              <path d={chart.profitPath} fill="none" stroke={COLOR.profit} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {chart.columns.map((c) => (
                <circle key={`dot-${c.month}`} cx={c.profit.x} cy={c.profit.y} r={4} fill={COLOR.profit} stroke={COLOR.surface} strokeWidth={2} />
              ))}

              {/* 命中區：整個月欄（比長條大），滑鼠與鍵盤焦點都會顯示明細 */}
              {chart.columns.map((c, i) => (
                <rect
                  key={`hit-${c.month}`}
                  x={c.slotX}
                  y={chart.plotTop}
                  width={c.slotWidth}
                  height={chart.plotBottom - chart.plotTop}
                  fill="transparent"
                  tabIndex={0}
                  role="img"
                  aria-label={pointText(c.point)}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((cur) => (cur === i ? null : cur))}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((cur) => (cur === i ? null : cur))}
                  style={{ outline: "none" }}
                />
              ))}
            </svg>

            {hovered && (
              <div
                role="tooltip"
                className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-md"
                style={
                  anchor === "left"
                    ? { left: `${(hovered.slotX / chart.width) * 100}%` }
                    : anchor === "right"
                      ? { right: `${((chart.width - hovered.slotX - hovered.slotWidth) / chart.width) * 100}%` }
                      : { left: `${(hovered.cx / chart.width) * 100}%`, transform: "translateX(-50%)" }
                }
              >
                <p className="mb-1 font-medium text-gray-700">{hovered.point.month} 月</p>
                {(
                  [
                    ["入帳收入", hovered.point.revenue, COLOR.revenue],
                    ["放款支出", hovered.point.expense, COLOR.expense],
                    ["專案毛利", hovered.point.grossProfit, COLOR.profit],
                  ] as const
                ).map(([name, value, color]) => (
                  <p key={name} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="flex items-center gap-1.5 text-gray-500">
                      <span className="inline-block h-0.5 w-3" style={{ backgroundColor: color }} aria-hidden="true" />
                      {name}
                    </span>
                    <span className={`font-semibold ${value < 0 ? "text-red-600" : "text-gray-900"}`}>{fmtMoney(value)}</span>
                  </p>
                ))}
                <p className="mt-0.5 flex items-center justify-between gap-2 border-t pt-1 text-gray-400">
                  <span>已開票（參考）</span>
                  <span>{fmtMoney(hovered.point.invoiced)}</span>
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-900">逐月數字（表格）</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-1.5 pr-3">月份</th>
                <th className="py-1.5 pr-3 text-right">入帳收入</th>
                <th className="py-1.5 pr-3 text-right">已開票（參考）</th>
                <th className="py-1.5 pr-3 text-right">放款支出</th>
                <th className="py-1.5 text-right">專案毛利</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.month} className={`border-b last:border-0 ${highlightMonth === p.month ? "bg-blue-50" : ""}`}>
                  <td className="py-1.5 pr-3 text-gray-700">{p.month} 月</td>
                  <td className="py-1.5 pr-3 text-right text-gray-700">{fmtMoneyOrDash(p.revenue)}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-500">{fmtMoneyOrDash(p.invoiced)}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-700">{fmtMoneyOrDash(p.expense)}</td>
                  <td className={`py-1.5 text-right ${p.grossProfit < 0 ? "text-red-600" : "text-gray-700"}`}>{fmtMoneyOrDash(p.grossProfit)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-800 font-semibold">
                <td className="py-2 pr-3">全年</td>
                <td className="py-2 pr-3 text-right">{fmtMoney(total((p) => p.revenue))}</td>
                <td className="py-2 pr-3 text-right text-gray-500">{fmtMoney(total((p) => p.invoiced))}</td>
                <td className="py-2 pr-3 text-right">{fmtMoney(total((p) => p.expense))}</td>
                <td className={`py-2 text-right ${negative(total((p) => p.grossProfit))}`}>{fmtMoney(total((p) => p.grossProfit))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
    </Card>
  );
}
