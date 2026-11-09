/**
 * 「費用與給付」合併頁（/admin/expenses，2026-11-09）的純函式：混合待處理佇列、統計磚、
 * 篩選、區塊可見性與 `?section=` 解析。畫面在 app/admin/expenses/page.tsx。
 *
 * 合併前是五頁：報銷、預支、三節獎金、加班超額另計、稅務申報。這裡只負責「把各來源的待處理
 * 項目攤成同一種列」，不做任何 API 呼叫，方便單元測試（__tests__/finance-hub.test.ts）。
 *
 * 權限：會計（requireFinance 但非 HR）只看得到報銷與預支；HR／老闆看全部。API 仍是最終守門，
 * 這裡只決定畫面要不要去抓、要不要顯示（會計抓 HR 端點只會 403）。
 */
import type { Advance, ExpenseClaim, ExpenseReview } from "./admin-api";
import type { FestivalBonus, OvertimeSettlement } from "./cash-payouts-api";
import { isVoidedBeyondCapDraft } from "./overtime-void";

/* ── 區塊 ─────────────────────────────────────────────────────────── */

export const HUB_SECTIONS = ["expenses", "advances", "overtime", "festival", "tax"] as const;
export type HubSection = (typeof HUB_SECTIONS)[number];

export const HUB_SECTION_LABEL: Record<HubSection, string> = {
  expenses: "報銷",
  advances: "預支",
  overtime: "加班超額另計",
  festival: "三節獎金",
  tax: "報表與申報",
};

/** HR 專屬區塊（會計看不到）。 */
const HR_ONLY_SECTIONS: ReadonlySet<HubSection> = new Set(["overtime", "festival", "tax"]);

export function visibleSections(isHr: boolean): HubSection[] {
  return HUB_SECTIONS.filter((s) => isHr || !HR_ONLY_SECTIONS.has(s));
}

/**
 * `?section=` → 區塊。舊網址轉址帶來的別名也接受（payroll-tax→tax、festival-bonuses→festival、
 * overtime-settlements→overtime）。不認得或該角色看不到 → null（不捲動、不展開）。
 */
const SECTION_ALIAS: Record<string, HubSection> = {
  expenses: "expenses",
  expense: "expenses",
  advances: "advances",
  advance: "advances",
  overtime: "overtime",
  "overtime-settlements": "overtime",
  festival: "festival",
  "festival-bonuses": "festival",
  tax: "tax",
  "payroll-tax": "tax",
};

export function parseSectionParam(search: string, isHr: boolean): HubSection | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("section");
  if (!raw) return null;
  const section = SECTION_ALIAS[raw.trim().toLowerCase()];
  if (!section) return null;
  return visibleSections(isHr).includes(section) ? section : null;
}

/* ── 混合佇列 ──────────────────────────────────────────────────────── */

export type QueueKind = "expense" | "advance_pay" | "advance_settle" | "overtime" | "festival";

export const QUEUE_KIND_LABEL: Record<QueueKind, string> = {
  expense: "報銷",
  advance_pay: "預支・待撥款",
  advance_settle: "預支・待核銷",
  overtime: "加班另計",
  festival: "三節獎金",
};

/** 每種類型歸哪個區塊（篩選「類型」與 HR 可見性都用它）。 */
export const QUEUE_KIND_SECTION: Record<QueueKind, HubSection> = {
  expense: "expenses",
  advance_pay: "advances",
  advance_settle: "advances",
  overtime: "overtime",
  festival: "festival",
};

export type QueueWarning = "missingReceipt" | "overCap" | "attendanceMismatch" | "tripNotApproved" | "overdue" | "noAmount";

export const QUEUE_WARNING_LABEL: Record<QueueWarning, string> = {
  missingReceipt: "缺憑證",
  overCap: "超額",
  attendanceMismatch: "出勤不符",
  tripNotApproved: "出差單未核准",
  overdue: "逾期",
  noAmount: "未填金額",
};

export interface QueueItem {
  /** 全頁唯一：`${kind}:${id}`。 */
  key: string;
  kind: QueueKind;
  /** 原始列 id（報銷單／預支／加班另計／三節獎金）。 */
  id: string;
  employeeId: string;
  /** API 有帶姓名就用（加班另計、三節獎金），沒有由畫面用員工清單對。 */
  employeeName: string | null;
  summary: string;
  amount: number | null;
  /** YYYY-MM-DD；排序用（舊→新）。 */
  date: string | null;
  status: string;
  warnings: QueueWarning[];
}

export type AdvanceRowLike = Advance & {
  daysOutstanding?: number | null;
  overdue?: boolean;
};

export interface QueueSources {
  /** 本期報銷單（GET /expenses?period=）。只有 submitted 會進佇列。 */
  claims?: readonly ExpenseClaim[];
  review?: ExpenseReview | null;
  /** 本期已月結 → 報銷不進佇列（已鎖定）。 */
  expenseSettled?: boolean;
  categoryName?: (categoryId: string) => string;
  /** 預支：已核准待撥款（status=requested）。 */
  advancesToPay?: readonly AdvanceRowLike[];
  /** 預支：已撥款未核銷（GET /advances/outstanding）。 */
  advancesToSettle?: readonly AdvanceRowLike[];
  advanceSubject?: (a: AdvanceRowLike) => string;
  /** 加班另計（本期）。只有未作廢的 draft 進佇列。 */
  overtime?: readonly OvertimeSettlement[] | null;
  /** 三節獎金（今年各節）。只有 draft 進佇列。 */
  festival?: readonly FestivalBonus[] | null;
  festivalLabel?: (festival: string) => string;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 報銷單 → 警示（依 review 的待確認清單）。 */
export function expenseWarnings(claim: Pick<ExpenseClaim, "id" | "employee_id" | "category_id">, review: ExpenseReview | null | undefined): QueueWarning[] {
  if (!review) return [];
  const i = review.issues;
  const out: QueueWarning[] = [];
  if (i.missingReceipt.some((r) => r.claimId === claim.id)) out.push("missingReceipt");
  if (i.overCap.some((r) => r.employeeId === claim.employee_id && r.categoryId === claim.category_id)) out.push("overCap");
  if (i.attendanceMismatch.some((r) => r.claimId === claim.id)) out.push("attendanceMismatch");
  if ((i.tripNotApproved ?? []).some((r) => r.claimId === claim.id)) out.push("tripNotApproved");
  return out;
}

export function reviewIssueCount(review: ExpenseReview | null | undefined): number {
  if (!review) return 0;
  const i = review.issues;
  return i.missingReceipt.length + i.overCap.length + i.attendanceMismatch.length + (i.tripNotApproved?.length ?? 0);
}

export function buildQueue(src: QueueSources): QueueItem[] {
  const items: QueueItem[] = [];
  const catName = src.categoryName ?? ((id: string) => id.slice(0, 8));
  const subject = src.advanceSubject ?? ((a: AdvanceRowLike) => (a.kind === "petty_cash" ? "零用金預支" : "出差預支"));
  const festLabel = src.festivalLabel ?? ((f: string) => f);

  if (!src.expenseSettled) {
    for (const c of src.claims ?? []) {
      if (c.status !== "submitted") continue;
      items.push({
        key: `expense:${c.id}`,
        kind: "expense",
        id: c.id,
        employeeId: c.employee_id,
        employeeName: null,
        summary: `${catName(c.category_id)}${c.nature === "allowance" ? "（定額補貼）" : ""}${c.note ? ` · ${c.note}` : ""}`,
        amount: num(c.amount),
        date: c.incurred_on,
        status: "待月結",
        warnings: expenseWarnings(c, src.review),
      });
    }
  }

  for (const a of src.advancesToPay ?? []) {
    items.push({
      key: `advance_pay:${a.id}`,
      kind: "advance_pay",
      id: a.id,
      employeeId: a.employee_id,
      employeeName: null,
      summary: subject(a),
      amount: num(a.amount),
      date: a.created_at?.slice(0, 10) ?? null,
      status: "待撥款",
      warnings: [],
    });
  }

  for (const a of src.advancesToSettle ?? []) {
    items.push({
      key: `advance_settle:${a.id}`,
      kind: "advance_settle",
      id: a.id,
      employeeId: a.employee_id,
      employeeName: null,
      summary: subject(a),
      amount: num(a.amount),
      date: a.paid_at?.slice(0, 10) ?? null,
      status: a.daysOutstanding !== null && a.daysOutstanding !== undefined ? `待核銷・${a.daysOutstanding} 天` : "待核銷",
      warnings: a.overdue ? ["overdue"] : [],
    });
  }

  for (const o of src.overtime ?? []) {
    if (o.status === "paid" || isVoidedBeyondCapDraft(o)) continue;
    items.push({
      key: `overtime:${o.id}`,
      kind: "overtime",
      id: o.id,
      employeeId: o.employee_id,
      employeeName: o.employee_name ?? null,
      summary: `${o.period} 超額 ${Math.round((o.minutes ?? 0) / 6) / 10} 小時`,
      amount: o.amount,
      date: `${o.period}-01`,
      status: "待給付",
      warnings: o.amount === null ? ["noAmount"] : [],
    });
  }

  for (const f of src.festival ?? []) {
    if (f.status === "paid") continue;
    items.push({
      key: `festival:${f.id}`,
      kind: "festival",
      id: f.id,
      employeeId: f.employee_id,
      employeeName: f.employee_name ?? null,
      summary: `${f.year} ${festLabel(f.festival)}獎金`,
      amount: f.final_amount ?? f.suggested_amount,
      date: f.reference_date,
      status: "草稿",
      warnings: f.final_amount === null && f.suggested_amount === null ? ["noAmount"] : [],
    });
  }

  // 有警示的排前面（要先看），其次依日期舊→新（越拖越糟的先處理）。
  return items.sort((x, y) => {
    const wx = x.warnings.length > 0 ? 0 : 1;
    const wy = y.warnings.length > 0 ? 0 : 1;
    if (wx !== wy) return wx - wy;
    return (x.date ?? "9999").localeCompare(y.date ?? "9999");
  });
}

/* ── 統計磚 ────────────────────────────────────────────────────────── */

export type StatKey = "expense" | "advance_pay" | "advance_settle" | "overtime" | "festival";

export interface HubStat {
  key: StatKey;
  label: string;
  count: number;
  amount: number;
  /** 例「待確認 2」「逾期 1」。 */
  note: string | null;
  /** 不受月份限制的來源標「全部未結」。 */
  scope: "period" | "all";
  /** 點磚 → 佇列篩這個類型。 */
  kind: QueueKind;
}

export function computeStats(items: readonly QueueItem[], opts: { isHr: boolean; reviewIssues?: number }): HubStat[] {
  const of = (kind: QueueKind) => items.filter((i) => i.kind === kind);
  const sum = (rows: QueueItem[]) => rows.reduce((t, r) => t + (r.amount ?? 0), 0);
  const expense = of("expense");
  const pay = of("advance_pay");
  const settle = of("advance_settle");
  const overdue = settle.filter((i) => i.warnings.includes("overdue")).length;
  const issues = opts.reviewIssues ?? expense.filter((i) => i.warnings.length > 0).length;
  const stats: HubStat[] = [
    { key: "expense", label: "報銷待月結", count: expense.length, amount: sum(expense), note: issues > 0 ? `待確認 ${issues}` : null, scope: "period", kind: "expense" },
    { key: "advance_pay", label: "預支待撥款", count: pay.length, amount: sum(pay), note: null, scope: "all", kind: "advance_pay" },
    { key: "advance_settle", label: "預支待核銷", count: settle.length, amount: sum(settle), note: overdue > 0 ? `逾期 ${overdue}` : null, scope: "all", kind: "advance_settle" },
  ];
  if (opts.isHr) {
    const ot = of("overtime");
    const noAmount = ot.filter((i) => i.warnings.includes("noAmount")).length;
    const fest = of("festival");
    stats.push(
      { key: "overtime", label: "加班另計待給付", count: ot.length, amount: sum(ot), note: noAmount > 0 ? `未填金額 ${noAmount}` : null, scope: "period", kind: "overtime" },
      { key: "festival", label: "三節獎金草稿", count: fest.length, amount: sum(fest), note: null, scope: "all", kind: "festival" },
    );
  }
  return stats;
}

/* ── 篩選 ──────────────────────────────────────────────────────────── */

export interface QueueFilter {
  /** "" = 全部類型。 */
  kind: QueueKind | "";
  /** "" = 全部員工。 */
  employeeId: string;
}

export function filterQueue(items: readonly QueueItem[], filter: QueueFilter, opts: { isHr: boolean }): QueueItem[] {
  const sections = new Set(visibleSections(opts.isHr));
  return items.filter(
    (i) =>
      sections.has(QUEUE_KIND_SECTION[i.kind]) &&
      (!filter.kind || i.kind === filter.kind) &&
      (!filter.employeeId || i.employeeId === filter.employeeId),
  );
}

/** 報銷月結核銷前的摘要：會核銷幾張、合計多少（只算 submitted）。 */
export function expenseSettleSummary(claims: readonly Pick<ExpenseClaim, "status" | "amount">[]): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const c of claims) {
    if (c.status !== "submitted") continue;
    count += 1;
    total += num(c.amount) ?? 0;
  }
  return { count, total };
}

/** 退件原因：必填、去空白、最長 250（API claimPatchSchema.statusReason 同上限）。回 null＝不合格。 */
export function normalizeRejectReason(reason: string | null | undefined): string | null {
  const t = (reason ?? "").trim();
  if (!t) return null;
  return t.slice(0, 250);
}
