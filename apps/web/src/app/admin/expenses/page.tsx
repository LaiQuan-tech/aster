"use client";

/**
 * 費用與給付（2026-11-09，業主核准）：把報銷、預支、三節獎金、加班超額另計、稅務申報五頁合併成一頁，
 * 讓管理員一目了然、在同頁處理。
 *
 *   ① 頂部：月份（報銷／加班另計依月份；預支、三節獎金標「全部未結」）＋待處理統計磚（點了篩選清單）
 *   ② 待處理清單（混合佇列）＋明細面板（桌機右側、手機下方），各類型的單筆動作在面板裡
 *   ③ 下方分區（可收合、`?section=` 定位）：報銷、預支、加班超額另計、三節獎金、報表與申報——原頁完整功能
 *
 * 權限：會計（requireFinance 非 HR）只看到報銷、預支；HR／老闆看全部（isHrRole，同員工頁的判斷方式）。
 * API 仍是最終守門；這裡只是不去抓、不顯示會計按了必 403 的東西。
 * 舊網址（/admin/payroll-tax 等）由 next.config 轉址到 `?section=`。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, ErrorText, Pill, inputCls, labelCls } from "@/components/admin-ui";
import { EmployeeCombobox } from "@/components/EmployeeCombobox";
import { AdvancesSection } from "@/components/finance/AdvancesSection";
import { ExpensesSection } from "@/components/finance/ExpensesSection";
import { FestivalSection } from "@/components/finance/FestivalSection";
import { FinanceDetailPanel } from "@/components/finance/FinanceDetailPanel";
import { OvertimeSection } from "@/components/finance/OvertimeSection";
import { TaxSection } from "@/components/finance/TaxSection";
import {
  getAdvances,
  getEmployees,
  getExpenseCategories,
  getExpenseClaims,
  getExpenseReview,
  getExpenseSettlements,
  getOutstandingAdvances,
  type Employee,
  type ExpenseCategory,
  type ExpenseClaim,
  type ExpenseReview,
} from "@/lib/admin-api";
import { advanceSubject } from "@/lib/advance-view";
import {
  FESTIVALS,
  FESTIVAL_LABEL,
  getFestivalBonuses,
  getOvertimeSettlements,
  money,
  type Festival,
  type FestivalBonus,
  type OvertimeSettlement,
} from "@/lib/cash-payouts-api";
import { employeeLabel, employeeOptionsOf } from "@/lib/employee-combobox";
import { todayKey } from "@/lib/ess-format";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import {
  HUB_SECTION_LABEL,
  QUEUE_KIND_LABEL,
  QUEUE_KIND_SECTION,
  QUEUE_WARNING_LABEL,
  buildQueue,
  computeStats,
  filterQueue,
  parseSectionParam,
  reviewIssueCount,
  visibleSections,
  type AdvanceRowLike,
  type HubSection,
  type QueueFilter,
  type QueueItem,
  type QueueKind,
} from "@/lib/finance-hub";
import { isHrRole } from "@/lib/roles";

interface HubData {
  claims: ExpenseClaim[];
  review: ExpenseReview | null;
  expenseSettled: boolean;
  categories: ExpenseCategory[];
  advancesToPay: AdvanceRowLike[];
  advancesToSettle: AdvanceRowLike[];
  overtime: OvertimeSettlement[];
  festival: FestivalBonus[];
}

const EMPTY: HubData = {
  claims: [],
  review: null,
  expenseSettled: false,
  categories: [],
  advancesToPay: [],
  advancesToSettle: [],
  overtime: [],
  festival: [],
};

function errText(r: PromiseSettledResult<unknown>, label: string): string | null {
  if (r.status === "fulfilled") return null;
  return `${label}：${r.reason instanceof Error ? r.reason.message : "載入失敗"}`;
}

export default function FinanceHubPage() {
  const [period, setPeriod] = useState(() => todayKey().slice(0, 7));
  const [isHr, setIsHr] = useState(() => isHrRole(peekMeCached()?.role));
  const [roleReady, setRoleReady] = useState(() => peekMeCached() !== null);
  const [data, setData] = useState<HubData>(EMPTY);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>({ kind: "", employeeId: "" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** 任何動作後 +1：清單、統計與各區塊一起重新載入。 */
  const [refreshKey, setRefreshKey] = useState(0);
  const [openSections, setOpenSections] = useState<Set<HubSection>>(() => new Set());
  const [pendingScroll, setPendingScroll] = useState<HubSection | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const queueRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    getMeCached()
      .then((me) => active && setIsHr(isHrRole(me.role)))
      .catch(() => active && setIsHr(false))
      .finally(() => active && setRoleReady(true));
    getEmployees()
      .then((r) => active && setEmployees(r.employees))
      .catch(() => null);
    return () => {
      active = false;
    };
  }, []);

  // ?section= → 展開並捲到該區（角色確定後才判斷：會計帶 HR 區塊的參數就不動作）。
  useEffect(() => {
    if (!roleReady) return;
    const section = parseSectionParam(window.location.search, isHr);
    if (!section) return;
    setOpenSections((prev) => new Set(prev).add(section));
    setPendingScroll(section);
  }, [roleReady, isHr]);

  const load = useCallback(async () => {
    if (!roleReady) return;
    setLoading(true);
    const year = Number(period.slice(0, 4)) || new Date().getFullYear();
    const festivalYears = [year - 1, year];
    const [claims, review, settlements, categories, toPay, toSettle, overtime, festival] = await Promise.allSettled([
      getExpenseClaims({ period }),
      getExpenseReview(period),
      getExpenseSettlements(period),
      getExpenseCategories(),
      getAdvances({ status: "requested" }),
      getOutstandingAdvances(),
      isHr ? getOvertimeSettlements({ period, status: "draft" }) : Promise.resolve({ settlements: [] }),
      isHr
        ? Promise.all(festivalYears.flatMap((y) => FESTIVALS.map((f) => getFestivalBonuses(f, y))))
        : Promise.resolve([]),
    ]);
    setData({
      claims: claims.status === "fulfilled" ? claims.value.claims : [],
      review: review.status === "fulfilled" ? review.value : null,
      expenseSettled:
        settlements.status === "fulfilled" && settlements.value.settlements[0]?.status === "settled",
      categories: categories.status === "fulfilled" ? categories.value.categories : [],
      advancesToPay: toPay.status === "fulfilled" ? toPay.value.advances : [],
      advancesToSettle: toSettle.status === "fulfilled" ? toSettle.value.advances : [],
      overtime: overtime.status === "fulfilled" ? overtime.value.settlements : [],
      festival: festival.status === "fulfilled" ? festival.value.flatMap((r) => r.bonuses) : [],
    });
    setErrors(
      [
        errText(claims, "報銷"),
        errText(review, "報銷待確認"),
        errText(toPay, "預支"),
        errText(toSettle, "預支未核銷"),
        errText(overtime, "加班另計"),
        errText(festival, "三節獎金"),
      ].filter((x): x is string => x !== null),
    );
    setLoading(false);
    setDataLoaded(true);
  }, [period, isHr, roleReady]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 等上方統計與清單載完（高度穩定）才捲，否則捲到一半內容長高、位置就偏了。
  useEffect(() => {
    if (!pendingScroll || loading || !dataLoaded) return;
    const t = window.setTimeout(() => {
      document.getElementById(`section-${pendingScroll}`)?.scrollIntoView({ block: "start" });
      setPendingScroll(null);
    }, 50);
    return () => window.clearTimeout(t);
  }, [pendingScroll, loading, dataLoaded]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const catName = useCallback(
    (id: string) => data.categories.find((c) => c.id === id)?.name ?? id.slice(0, 8),
    [data.categories],
  );

  const queue = useMemo(
    () =>
      buildQueue({
        claims: data.claims,
        review: data.review,
        expenseSettled: data.expenseSettled,
        categoryName: catName,
        advancesToPay: data.advancesToPay,
        advancesToSettle: data.advancesToSettle,
        advanceSubject: (a) => advanceSubject(a),
        overtime: isHr ? data.overtime : [],
        festival: isHr ? data.festival : [],
        festivalLabel: (f) => FESTIVAL_LABEL[f as Festival] ?? f,
      }),
    [data, catName, isHr],
  );
  const stats = useMemo(
    () => computeStats(queue, { isHr, reviewIssues: data.expenseSettled ? 0 : reviewIssueCount(data.review) }),
    [queue, isHr, data.review, data.expenseSettled],
  );
  const shown = useMemo(() => filterQueue(queue, filter, { isHr }), [queue, filter, isHr]);
  const selected = useMemo(() => queue.find((i) => i.key === selectedKey) ?? null, [queue, selectedKey]);
  const sections = visibleSections(isHr);

  const empName = useCallback(
    (item: QueueItem) => {
      const e = employees.find((x) => x.id === item.employeeId);
      if (e) return employeeLabel(e);
      return item.employeeName ?? item.employeeId.slice(0, 8);
    },
    [employees],
  );

  function select(key: string) {
    setSelectedKey(key);
    setMessage(null);
    // 手機上面板在清單下方：點了捲過去。桌機面板在右側，scrollIntoView 的 nearest 不會亂跳。
    window.setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }

  function onDone(msg: string) {
    setMessage(msg);
    setSelectedKey(null);
    refresh();
  }

  function onTile(kind: QueueKind) {
    setFilter((f) => ({ ...f, kind: f.kind === kind ? "" : kind }));
    queueRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleSection(s: HubSection) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls} htmlFor="hub-period">
              月份
            </label>
            <input
              id="hub-period"
              type="month"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              className={inputCls}
            />
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="min-h-10 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            {loading ? "載入中…" : "重新整理"}
          </button>
          <p className="w-full text-xs text-gray-500 sm:w-auto sm:flex-1">
            報銷{isHr ? "、加班另計" : ""}依月份；預支{isHr ? "、三節獎金" : ""}不受月份限制（全部未結）。
          </p>
        </div>
        <div className={`mt-4 grid grid-cols-2 gap-3 ${isHr ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-3"}`}>
          {stats.map((s) => {
            const active = filter.kind === s.kind;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onTile(s.kind)}
                aria-pressed={active}
                className={`min-w-0 rounded-xl border p-3 text-left transition-colors ${
                  active ? "border-[var(--brand)] bg-gray-50" : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <div className="truncate text-xs text-gray-500">{s.label}</div>
                <div className="mt-1 text-2xl font-semibold text-gray-900">{s.count}</div>
                <div className="truncate text-xs text-gray-500">
                  {money(s.amount)} 元・{s.scope === "all" ? "全部未結" : period}
                </div>
                {s.note && <div className="mt-1 truncate text-xs font-medium text-amber-700">{s.note}</div>}
              </button>
            );
          })}
        </div>
        {errors.length > 0 && (
          <div className="mt-3 space-y-1">
            {errors.map((e) => (
              <ErrorText key={e}>{e}</ErrorText>
            ))}
          </div>
        )}
        {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div ref={queueRef} className="min-w-0 scroll-mt-20">
          <Card>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <h2 className="w-full text-sm font-medium text-gray-500 sm:w-auto sm:flex-1">
                待處理（{shown.length}
                {shown.length !== queue.length ? ` / ${queue.length}` : ""}）
              </h2>
              <div className="min-w-0 flex-1 sm:flex-none">
                <label className={labelCls} htmlFor="hub-kind">
                  類型
                </label>
                <select
                  id="hub-kind"
                  className={inputCls}
                  value={filter.kind}
                  onChange={(e) => setFilter((f) => ({ ...f, kind: e.target.value as QueueKind | "" }))}
                >
                  <option value="">全部類型</option>
                  {(Object.keys(QUEUE_KIND_LABEL) as QueueKind[])
                    .filter((k) => sections.includes(QUEUE_KIND_SECTION[k]))
                    .map((k) => (
                      <option key={k} value={k}>
                        {QUEUE_KIND_LABEL[k]}
                      </option>
                    ))}
                </select>
              </div>
              <div className="w-full min-w-0 sm:w-64">
                <label className={labelCls}>員工</label>
                <EmployeeCombobox
                  className="w-full"
                  options={employeeOptionsOf(employees)}
                  value={filter.employeeId}
                  onChange={(id) => setFilter((f) => ({ ...f, employeeId: id }))}
                  emptyLabel="全部員工"
                  ariaLabel="員工"
                />
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="rounded-lg bg-gray-50 px-3 py-6 text-center text-sm text-gray-500">
                {loading ? "載入中…" : queue.length === 0 ? "目前沒有待處理項目。" : "沒有符合篩選的項目。"}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {shown.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => select(item.key)}
                      aria-current={item.key === selectedKey}
                      className={`flex w-full min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-2 py-2.5 text-left text-sm hover:bg-gray-50 ${
                        item.key === selectedKey ? "bg-gray-50 ring-1 ring-inset ring-[var(--brand)]" : ""
                      }`}
                    >
                      <span className="shrink-0">
                        <Pill tone={item.kind === "expense" ? "gray" : item.kind.startsWith("advance") ? "blue" : "brand"}>
                          {QUEUE_KIND_LABEL[item.kind]}
                        </Pill>
                      </span>
                      <span className="min-w-0 flex-1 basis-40">
                        <span className="block truncate font-medium text-gray-900">{empName(item)}</span>
                        <span className="block truncate text-xs text-gray-500">{item.summary}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-medium text-gray-900">{money(item.amount)}</span>
                        <span className="block text-xs text-gray-500">
                          {item.date ?? "—"}・{item.status}
                        </span>
                      </span>
                      {item.warnings.length > 0 && (
                        <span className="flex w-full flex-wrap gap-1">
                          {item.warnings.map((w) => (
                            <Pill key={w} tone={w === "attendanceMismatch" || w === "overdue" ? "red" : "amber"}>
                              {QUEUE_WARNING_LABEL[w]}
                            </Pill>
                          ))}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div ref={panelRef} className="min-w-0 scroll-mt-20 lg:sticky lg:top-4 lg:self-start">
          <FinanceDetailPanel
            item={selected}
            sources={{
              claims: data.claims,
              review: data.review,
              categoryName: catName,
              advances: [...data.advancesToPay, ...data.advancesToSettle],
              overtime: data.overtime,
              festival: data.festival,
            }}
            empName={empName}
            onDone={onDone}
            onClose={() => setSelectedKey(null)}
          />
        </div>
      </div>

      {sections.map((s) => (
        <HubSectionBlock key={s} section={s} open={openSections.has(s)} onToggle={() => toggleSection(s)}>
          {s === "expenses" && (
            <ExpensesSection
              period={period}
              refreshKey={refreshKey}
              onChanged={refresh}
              onSelectClaim={(id) => select(`expense:${id}`)}
            />
          )}
          {s === "advances" && <AdvancesSection refreshKey={refreshKey} onChanged={refresh} />}
          {s === "overtime" && <OvertimeSection period={period} refreshKey={refreshKey} onChanged={refresh} />}
          {s === "festival" && <FestivalSection refreshKey={refreshKey} onChanged={refresh} />}
          {s === "tax" && <TaxSection />}
        </HubSectionBlock>
      ))}
    </div>
  );
}

const SECTION_HINT: Record<HubSection, string> = {
  expenses: "本期合計、待確認項目、本期單據（可看憑證）、報銷類別設定、一次性月結核銷",
  advances: "已撥款未核銷（逾期標示）、已核准待撥款、已核銷",
  overtime: "月表核准自動開草稿；給付方式／金額／備註、標記付款、手動補登、匯出",
  festival: "產生建議、逐人調整、一次發放並凍結、匯出 xlsx",
  tax: "扣繳／補充保費 CSV、調薪紀錄與批次調薪、非員工所得、二代健保與扣繳試算",
};

/**
 * 可收合的分區。第一次展開才掛載內容（收合的區塊不去打 API）；之後收合只是隱藏，填到一半的欄位會保留。
 * `id="section-<key>"` 給 `?section=` 捲動定位。
 */
function HubSectionBlock({
  section,
  open,
  onToggle,
  children,
}: {
  section: HubSection;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const panelId = `section-${section}-panel`;
  return (
    <section id={`section-${section}`} className="scroll-mt-20" data-open={open ? "true" : "false"}>
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          <span className="min-w-0">
            <span className="block text-base font-semibold text-gray-800">{HUB_SECTION_LABEL[section]}</span>
            <span className="block truncate text-xs font-normal text-gray-500">{SECTION_HINT[section]}</span>
          </span>
          <span aria-hidden="true" className="shrink-0 text-sm text-gray-500">
            {open ? "收起 ▲" : "展開 ▼"}
          </span>
        </button>
      </h2>
      {mounted && (
        <div id={panelId} hidden={!open} className="mt-3 space-y-4">
          {children}
        </div>
      )}
    </section>
  );
}
