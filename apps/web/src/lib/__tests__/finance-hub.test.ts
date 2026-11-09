import { describe, expect, it } from "vitest";
import type { ExpenseClaim, ExpenseReview } from "../admin-api";
import type { FestivalBonus, OvertimeSettlement } from "../cash-payouts-api";
import {
  buildQueue,
  computeStats,
  expenseSettleSummary,
  expenseWarnings,
  filterQueue,
  normalizeRejectReason,
  parseSectionParam,
  reviewIssueCount,
  visibleSections,
  type AdvanceRowLike,
} from "../finance-hub";
import { BEYOND_CAP_VOID_NOTE } from "../overtime-void";

// 全部假資料。
const claim = (over: Partial<ExpenseClaim> = {}): ExpenseClaim => ({
  id: "c1",
  employee_id: "e1",
  category_id: "cat-taxi",
  nature: "reimbursement",
  amount: "350",
  incurred_on: "2026-11-03",
  period: "2026-11",
  note: null,
  status: "submitted",
  status_reason: null,
  settlement_id: null,
  ...over,
});

const review = (over: Partial<ExpenseReview["issues"]> = {}): ExpenseReview => ({
  period: "2026-11",
  claimCount: 2,
  reimbursementTotal: 1000,
  allowanceTotal: 0,
  issues: { missingReceipt: [], overCap: [], attendanceMismatch: [], ...over },
});

const advance = (over: Partial<AdvanceRowLike> = {}): AdvanceRowLike => ({
  id: "a1",
  kind: "trip",
  request_id: "r1",
  employee_id: "e2",
  amount: "5000",
  status: "requested",
  payout_channel: null,
  paid_at: null,
  paid_by_emp_id: null,
  actual_total: null,
  balance: null,
  balance_handling: null,
  recovery_period: null,
  settled_at: null,
  note: null,
  created_at: "2026-11-01T02:00:00Z",
  ...over,
});

const ot = (over: Partial<OvertimeSettlement> = {}): OvertimeSettlement =>
  ({
    id: "o1",
    employee_id: "e3",
    period: "2026-10",
    source: "beyond_cap",
    minutes: 150,
    amount: 1200,
    channel: "cash",
    status: "draft",
    paid_on: null,
    note: null,
    employee_name: "測試三",
    emp_no: "T003",
    ...over,
  }) as OvertimeSettlement;

const fb = (over: Partial<FestivalBonus> = {}): FestivalBonus =>
  ({
    id: "f1",
    employee_id: "e4",
    festival: "mid_autumn",
    year: 2026,
    reference_date: "2026-09-15",
    suggested_amount: 10000,
    prorate_months: 12,
    final_amount: null,
    status: "draft",
    paid_on: null,
    note: null,
    employee_name: "測試四",
    emp_no: "T004",
    hire_date: "2020-01-01",
    ...over,
  }) as FestivalBonus;

describe("visibleSections／parseSectionParam", () => {
  it("會計只看報銷、預支；HR 看全部五區", () => {
    expect(visibleSections(false)).toEqual(["expenses", "advances"]);
    expect(visibleSections(true)).toEqual(["expenses", "advances", "overtime", "festival", "tax"]);
  });

  it("?section= 解析含舊網址別名；會計帶 HR 區塊 → null", () => {
    expect(parseSectionParam("?section=tax", true)).toBe("tax");
    expect(parseSectionParam("?section=payroll-tax", true)).toBe("tax");
    expect(parseSectionParam("section=festival-bonuses", true)).toBe("festival");
    expect(parseSectionParam("?status=draft&all=1&section=overtime", true)).toBe("overtime");
    expect(parseSectionParam("?section=advances", false)).toBe("advances");
    expect(parseSectionParam("?section=tax", false)).toBeNull();
    expect(parseSectionParam("?section=overtime", false)).toBeNull();
    expect(parseSectionParam("?section=nope", true)).toBeNull();
    expect(parseSectionParam("", true)).toBeNull();
  });
});

describe("expenseWarnings／reviewIssueCount", () => {
  it("依 review 清單標缺憑證／超額／出勤不符／出差單未核准", () => {
    const r = review({
      missingReceipt: [{ claimId: "c1", employeeId: "e1", amount: 350 }],
      overCap: [{ employeeId: "e1", categoryId: "cat-taxi", total: 3000, cap: 2000 }],
      attendanceMismatch: [{ claimId: "c1", employeeId: "e1", incurredOn: "2026-11-03", amount: 350, overtimeMinutes: null, hint: "無加班" }],
      tripNotApproved: [{ claimId: "c1", employeeId: "e1", incurredOn: "2026-11-03", amount: 350, tripRequestId: "t1", hint: "簽核中" }],
    });
    expect(expenseWarnings(claim(), r)).toEqual(["missingReceipt", "overCap", "attendanceMismatch", "tripNotApproved"]);
    expect(expenseWarnings(claim({ id: "c2", category_id: "cat-meal" }), r)).toEqual([]);
    expect(expenseWarnings(claim(), null)).toEqual([]);
    expect(reviewIssueCount(r)).toBe(4);
    expect(reviewIssueCount(null)).toBe(0);
  });
});

describe("buildQueue", () => {
  it("只收待處理：submitted 報銷、待撥款／待核銷預支、未付且未作廢的加班另計、三節草稿", () => {
    const q = buildQueue({
      claims: [claim(), claim({ id: "c-settled", status: "settled" }), claim({ id: "c-rej", status: "rejected" })],
      review: review(),
      categoryName: (id) => (id === "cat-taxi" ? "計程車" : id),
      advancesToPay: [advance()],
      advancesToSettle: [advance({ id: "a2", status: "paid", paid_at: "2026-09-01T00:00:00Z", daysOutstanding: 69, overdue: true })],
      overtime: [
        ot(),
        ot({ id: "o-paid", status: "paid" }),
        ot({ id: "o-void", minutes: 0, amount: 0, note: BEYOND_CAP_VOID_NOTE }),
      ],
      festival: [fb(), fb({ id: "f-paid", status: "paid" })],
      festivalLabel: () => "中秋",
    });
    expect(q.map((i) => i.key).sort()).toEqual(
      ["advance_pay:a1", "advance_settle:a2", "expense:c1", "festival:f1", "overtime:o1"].sort(),
    );
    const exp = q.find((i) => i.kind === "expense")!;
    expect(exp).toMatchObject({ summary: "計程車", amount: 350, status: "待月結", employeeId: "e1" });
    const settle = q.find((i) => i.kind === "advance_settle")!;
    expect(settle.warnings).toEqual(["overdue"]);
    expect(settle.status).toBe("待核銷・69 天");
    // 有警示的排最前面
    expect(q[0].key).toBe("advance_settle:a2");
    const f = q.find((i) => i.kind === "festival")!;
    expect(f).toMatchObject({ amount: 10000, summary: "2026 中秋獎金", employeeName: "測試四" });
  });

  it("本期已月結 → 報銷不進佇列；加班另計未填金額標警示", () => {
    const q = buildQueue({ claims: [claim()], expenseSettled: true, overtime: [ot({ amount: null })] });
    expect(q.map((i) => i.kind)).toEqual(["overtime"]);
    expect(q[0].warnings).toEqual(["noAmount"]);
  });

  it("沒警示時依日期舊→新", () => {
    const q = buildQueue({
      claims: [claim({ id: "late", incurred_on: "2026-11-20" }), claim({ id: "early", incurred_on: "2026-11-02" })],
    });
    expect(q.map((i) => i.id)).toEqual(["early", "late"]);
  });
});

describe("computeStats", () => {
  const items = buildQueue({
    claims: [claim(), claim({ id: "c2", amount: "650" })],
    review: review({ missingReceipt: [{ claimId: "c1", employeeId: "e1", amount: 350 }] }),
    advancesToPay: [advance()],
    advancesToSettle: [advance({ id: "a2", status: "paid", overdue: true }), advance({ id: "a3", status: "paid", amount: "1000" })],
    overtime: [ot(), ot({ id: "o2", amount: null })],
    festival: [fb()],
  });

  it("HR：五張磚，含筆數、金額、待確認／逾期／未填金額註記", () => {
    const s = computeStats(items, { isHr: true, reviewIssues: 1 });
    expect(s.map((x) => x.key)).toEqual(["expense", "advance_pay", "advance_settle", "overtime", "festival"]);
    expect(s[0]).toMatchObject({ count: 2, amount: 1000, note: "待確認 1", scope: "period" });
    expect(s[1]).toMatchObject({ count: 1, amount: 5000, note: null, scope: "all" });
    expect(s[2]).toMatchObject({ count: 2, amount: 6000, note: "逾期 1", scope: "all" });
    expect(s[3]).toMatchObject({ count: 2, amount: 1200, note: "未填金額 1", scope: "period" });
    expect(s[4]).toMatchObject({ count: 1, amount: 10000, scope: "all" });
  });

  it("會計：只有報銷與預支三張磚", () => {
    expect(computeStats(items, { isHr: false }).map((x) => x.key)).toEqual(["expense", "advance_pay", "advance_settle"]);
  });
});

describe("filterQueue", () => {
  const items = buildQueue({
    claims: [claim()],
    advancesToPay: [advance()],
    overtime: [ot()],
    festival: [fb({ employee_id: "e1" })],
  });

  it("會計看不到 HR 類型（即使資料混進來）", () => {
    expect(filterQueue(items, { kind: "", employeeId: "" }, { isHr: false }).map((i) => i.kind).sort()).toEqual(["advance_pay", "expense"]);
  });

  it("依類型與員工篩選", () => {
    expect(filterQueue(items, { kind: "overtime", employeeId: "" }, { isHr: true }).map((i) => i.id)).toEqual(["o1"]);
    expect(filterQueue(items, { kind: "", employeeId: "e1" }, { isHr: true }).map((i) => i.kind).sort()).toEqual(["expense", "festival"]);
    expect(filterQueue(items, { kind: "expense", employeeId: "e9" }, { isHr: true })).toEqual([]);
  });
});

describe("expenseSettleSummary／normalizeRejectReason", () => {
  it("月結摘要只算 submitted", () => {
    expect(expenseSettleSummary([claim(), claim({ amount: "650" }), claim({ status: "rejected", amount: "999" })])).toEqual({ count: 2, total: 1000 });
    expect(expenseSettleSummary([])).toEqual({ count: 0, total: 0 });
  });

  it("退件原因必填、去空白、截 250 字", () => {
    expect(normalizeRejectReason("  缺憑證 ")).toBe("缺憑證");
    expect(normalizeRejectReason("   ")).toBeNull();
    expect(normalizeRejectReason(null)).toBeNull();
    expect(normalizeRejectReason("字".repeat(300))?.length).toBe(250);
  });
});
