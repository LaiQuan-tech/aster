"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import type { ApiError } from "@/lib/api-client";
import { getGroupOverview, getGroupOverviewDetail, type GroupOverviewResult } from "@/lib/group-overview-api";
import {
  MONTH_OPTIONS,
  OVERVIEW_BASIS_NOTE,
  SINGLE_COMPANY_HINT,
  realCompanyCount,
  toggleExcluded,
  yearOptions,
} from "@/lib/group-overview";
import { CompanyTable, DataQualityNotice, StatCards, TrendCard, type DetailState } from "./_group-overview-components";
import { GROUP_OVERVIEW_ANCHOR } from "@/lib/boss-dashboard";

/**
 * 後台首頁的「集團總覽」區塊（2026-10-27 業主：「集團總覽的內容直接放到首頁，並且只有平台管理員才看得到」）。
 * 原本是 /admin/group-overview 整頁（舊網址導到 /admin#group-overview）；現在由 app/admin/page.tsx 在 group 版
 * （＝/me.canSeeGroupOverview，在職 platform_admin）才掛上，API 也只放行在職 platform_admin（其他人 403）。
 *
 * 集團總覽（2026-10-11 業主拍板第一版）：跨公司彙總入帳收入、放款支出與專案毛利。
 * 2026-10-25 加上人事：各公司在職人數、人事成本（薪資單應發）與「扣人事成本後」；人事依員工所屬公司歸屬，
 * 未指派公司的員工另列一列、不分攤（但計入集團合計）。口徑與資料來源見後端
 * apps/api/src/services/group-overview.ts 檔頭：
 *   收入＝實際入帳（未稅、依入帳日歸月）；已開票只是參考（依開票日）；支出＝已匯款放款＋未經放款單的已付複委託（代扣前毛額、依付款日）；
 *   集團合計剔除「客戶是關係企業的專案收入」與「付給關係企業廠商的放款」，各公司自己的數字照常包含。
 * 公司勾選＝是否納入集團合計；沒勾的公司仍在表格裡（灰色）。
 */

function errorText(err: unknown): string {
  if ((err as ApiError | undefined)?.status === 403) return "集團總覽只開放給平台管理員，這個帳號沒有權限。";
  return err instanceof Error ? err.message : "載入失敗";
}

export function GroupOverviewSection({
  onDefaultResult,
}: {
  /**
   * 預設條件（今年、全年、全部公司納入）那次載入的結果：首頁頂部「本年收入」格共用這份，不另打一次 /group-overview。
   * 成功帶 data、失敗帶 error 訊息。之後切年度／月份／公司不會再呼叫（那格固定是本年）。
   */
  onDefaultResult?: (result: { data: GroupOverviewResult | null; error: string | null }) => void;
} = {}) {
  const thisYear = new Date().getFullYear();
  const years = useMemo(() => yearOptions(thisYear), [thisYear]);

  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState<number | null>(null);
  /** 不納入集團合計的公司 id（預設空＝全選）。 */
  const [excluded, setExcluded] = useState<string[]>([]);
  const [data, setData] = useState<GroupOverviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 月趨勢圖看誰："group" 或公司 id。 */
  const [trendTarget, setTrendTarget] = useState("group");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const seq = useRef(0);
  const onDefaultRef = useRef(onDefaultResult);
  useEffect(() => {
    onDefaultRef.current = onDefaultResult;
  }, [onDefaultResult]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const isDefault = year === thisYear && month === null && excluded.length === 0;
    setLoading(true);
    setError(null);
    try {
      const r = await getGroupOverview({ year, month, exclude: excluded });
      if (isDefault) onDefaultRef.current?.({ data: r, error: null });
      if (mine === seq.current) setData(r);
    } catch (err) {
      if (isDefault) onDefaultRef.current?.({ data: null, error: errorText(err) });
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [year, month, excluded, thisYear]);

  useEffect(() => {
    void load();
  }, [load]);

  // 從舊網址 /admin/group-overview 轉址（或點本年收入格）進來時網址帶 #group-overview：這一區要等 /me 確認身分後
  // 才掛上，瀏覽器原生的錨點捲動當下找不到元素，所以第一份資料畫出來後自己捲一次。
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !data) return;
    scrolled.current = true;
    if (typeof window !== "undefined" && window.location.hash === `#${GROUP_OVERVIEW_ANCHOR}`) {
      document.getElementById(GROUP_OVERVIEW_ANCHOR)?.scrollIntoView({ block: "start" });
    }
  }, [data]);

  const loadDetail = useCallback(
    async (companyId: string) => {
      const key = `${companyId}|${year}|${month ?? "all"}`;
      setDetail({ key, revenue: null, expense: null, error: null, loading: true });
      try {
        const [revenue, expense] = await Promise.all([
          getGroupOverviewDetail({ companyId, kind: "revenue", year, month }),
          getGroupOverviewDetail({ companyId, kind: "expense", year, month }),
        ]);
        setDetail((cur) => (cur && cur.key === key ? { key, revenue, expense, error: null, loading: false } : cur));
      } catch (err) {
        setDetail((cur) => (cur && cur.key === key ? { ...cur, error: errorText(err), loading: false } : cur));
      }
    },
    [year, month],
  );

  // 展開中的公司在年份／月份改變時跟著重抓；公司排除與否不影響下鑽（下鑽是公司自己的數字）。
  useEffect(() => {
    if (expandedId) void loadDetail(expandedId);
  }, [expandedId, loadDetail]);

  const activeDetail =
    expandedId && detail && detail.key === `${expandedId}|${year}|${month ?? "all"}` ? detail : null;

  // 選到的公司不在這次的清單裡（例如換年度後沒往來了）就退回集團合計
  const trendCompany = data && trendTarget !== "group" ? (data.companies.find((c) => c.id === trendTarget) ?? null) : null;
  const trendValue = trendCompany ? trendCompany.id : "group";
  const trend = data
    ? trendCompany
      ? { label: trendCompany.name, points: trendCompany.monthly }
      : { label: "集團合計", points: data.group.monthly }
    : null;

  return (
    <section id={GROUP_OVERVIEW_ANCHOR} aria-labelledby="go-heading" className="scroll-mt-20 space-y-4 pt-2 md:space-y-6">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 id="go-heading" className="text-base font-semibold text-gray-900">
              集團總覽
              <span className="ml-2 align-middle text-xs font-normal text-gray-400">僅平台管理員可見</span>
            </h2>
            <p className="mt-0.5 max-w-2xl text-xs text-gray-500">{OVERVIEW_BASIS_NOTE}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className={labelCls} htmlFor="go-year">年度</label>
              <select id="go-year" className={inputCls} value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="go-month">月份</label>
              <select
                id="go-month"
                className={inputCls}
                value={month ?? ""}
                onChange={(e) => setMonth(e.target.value === "" ? null : Number(e.target.value))}
              >
                {MONTH_OPTIONS.map((m) => (
                  <option key={m.label} value={m.value ?? ""}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            {data && (
              <div>
                <label className={labelCls} htmlFor="go-trend">月趨勢對象</label>
                <select id="go-trend" className={inputCls} value={trendValue} onChange={(e) => setTrendTarget(e.target.value)}>
                  <option value="group">集團合計</option>
                  {data.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {data && (
          <fieldset className="mt-4">
            <legend className={labelCls}>納入集團合計的公司</legend>
            <div className="flex flex-wrap items-center gap-2">
              {data.companies.map((c) => {
                const included = !excluded.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                      included ? "border-gray-300 bg-white text-gray-800" : "border-gray-200 bg-gray-50 text-gray-400"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={included}
                      onChange={() => setExcluded((cur) => toggleExcluded(cur, c.id))}
                    />
                    {c.name}
                  </label>
                );
              })}
              {excluded.length > 0 && (
                <button type="button" onClick={() => setExcluded([])} className="text-xs text-gray-500 underline hover:text-gray-800">
                  全部納入
                </button>
              )}
            </div>
            <p className="mt-1.5 text-xs text-gray-400">沒勾的公司不計入集團合計，仍在下面的表格裡以灰色顯示。</p>
          </fieldset>
        )}
        <ErrorText>{error}</ErrorText>
      </Card>

      {data?.dataQuality && <DataQualityNotice quality={data.dataQuality} year={data.period.year} />}

      {data && realCompanyCount(data.companies) <= 1 && (
        <div className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800">
          {SINGLE_COMPANY_HINT}{" "}
          <Link href="/admin/companies" className="font-medium underline">
            前往公司主體
          </Link>
        </div>
      )}

      {data ? (
        // 重新載入時保留上一份畫面（降低透明度），不閃骨架、不跳版
        <div className={`space-y-4 transition-opacity md:space-y-6 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <StatCards group={data.group} year={data.period.year} month={data.period.month} payroll={data.payroll} />
          <CompanyTable
            companies={data.companies}
            group={data.group}
            expandedId={expandedId}
            detail={activeDetail}
            onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
            payroll={data.payroll}
          />
          {trend && <TrendCard points={trend.points} label={trend.label} highlightMonth={data.period.month} />}
        </div>
      ) : loading ? (
        <Card>
          <Empty>載入中…</Empty>
        </Card>
      ) : null}
    </section>
  );
}
