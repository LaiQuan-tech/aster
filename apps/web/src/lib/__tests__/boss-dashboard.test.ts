import { describe, it, expect } from "vitest";
import {
  bossLinks,
  companyRows,
  complianceItems,
  fmtCount,
  fmtPct1,
  fmtWan,
  groupKpis,
  isSingleCompany,
  marginPct,
  needsAttention,
  optionalColumns,
  readEnumParam,
  readFlagParam,
  readPeriodParam,
  type GroupCompanyLite,
  type GroupOverviewLite,
} from "../boss-dashboard";

// ⚠️ 名稱都是明顯的假值（repo 是公開的）。

function months(fill: Partial<Record<number, { revenue: number; expense: number }>>) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const v = fill[m] ?? { revenue: 0, expense: 0 };
    return { month: m, revenue: v.revenue, expense: v.expense, grossProfit: v.revenue - v.expense };
  });
}

function company(id: string, extra: Partial<GroupCompanyLite> = {}): GroupCompanyLite {
  const monthly = extra.monthly ?? months({ 10: { revenue: 300_000, expense: 100_000 }, 3: { revenue: 700_000, expense: 200_000 } });
  const revenue = monthly.reduce((s, m) => s + m.revenue, 0);
  const expense = monthly.reduce((s, m) => s + m.expense, 0);
  return {
    id,
    name: `測試公司${id}`,
    isActive: true,
    revenue,
    expense,
    grossProfit: revenue - expense,
    grossMarginPct: marginPct(revenue - expense, revenue),
    monthly,
    ...extra,
  };
}

function overview(companies: GroupCompanyLite[]): GroupOverviewLite {
  const monthly = months({ 10: { revenue: 600_000, expense: 250_000 } });
  return {
    period: { year: 2026 },
    companies,
    group: { revenue: 2_000_000, expense: 600_000, grossProfit: 1_400_000, grossMarginPct: 70, monthly },
  };
}

describe("格式", () => {
  it("fmtWan：滿一萬用萬（一位小數、千分位），未滿到元，null →「—」", () => {
    expect(fmtWan(null)).toBe("—");
    expect(fmtWan(undefined)).toBe("—");
    expect(fmtWan(Number.NaN)).toBe("—");
    expect(fmtWan(0)).toBe("0");
    expect(fmtWan(-0.4)).toBe("0");
    expect(fmtWan(9_999)).toBe("9,999");
    expect(fmtWan(10_000)).toBe("1 萬");
    expect(fmtWan(123_456)).toBe("12.3 萬");
    expect(fmtWan(-250_000)).toBe("-25 萬");
    expect(fmtWan(123_456_789)).toBe("12,345.7 萬");
  });

  it("fmtCount／fmtPct1／marginPct／needsAttention", () => {
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(1234)).toBe("1,234");
    expect(fmtPct1(null)).toBe("—");
    expect(fmtPct1(33.333)).toBe("33.3%");
    expect(marginPct(50, 0)).toBeNull();
    expect(marginPct(1, 3)).toBe(33.3);
    expect(needsAttention(0)).toBe(false);
    expect(needsAttention(null)).toBe(false);
    expect(needsAttention(2)).toBe(true);
  });
});

describe("集團 KPI 與各公司列", () => {
  it("groupKpis：本月取 group.monthly[月]、本年取合計", () => {
    const k = groupKpis(overview([company("A")]), 10);
    expect(k.month).toEqual({ revenue: 600_000, expense: 250_000, grossProfit: 350_000, grossMarginPct: 58.3 });
    expect(k.year).toEqual({ revenue: 2_000_000, expense: 600_000, grossProfit: 1_400_000, grossMarginPct: 70 });
    expect(groupKpis(overview([]), 2).month.grossMarginPct).toBeNull();
  });

  it("companyRows：本月／本年切換、逾期依 id 對上、停用且無數字者略過、未歸屬列補在最後", () => {
    const ov = overview([
      company("A"),
      company("B", { monthly: months({}) }),
      company("C", { isActive: false, monthly: months({}) }),
    ]);
    const overdue = [
      { companyId: "A", companyName: "測試公司A", overdueAmount: 50_000, overdueCount: 2 },
      { companyId: "unassigned", companyName: "（未歸屬公司）", overdueAmount: 1_000, overdueCount: 1 },
      { companyId: "zero", companyName: "零", overdueAmount: 0, overdueCount: 0 },
    ];
    const year = companyRows(ov, overdue, "year", 10);
    expect(year.map((r) => r.id)).toEqual(["A", "B", "unassigned"]);
    expect(year[0]).toMatchObject({ revenue: 1_000_000, expense: 300_000, grossProfit: 700_000, grossMarginPct: 70, overdue: 50_000, overdueCount: 2 });
    expect(year[1]).toMatchObject({ overdue: 0, overdueCount: 0 });
    const month = companyRows(ov, overdue, "month", 10);
    expect(month[0]).toMatchObject({ revenue: 300_000, expense: 100_000, grossProfit: 200_000, grossMarginPct: 66.7 });
  });

  it("companyRows：逾期應收讀不到（null）→ 每列 overdue 為 null（畫面顯示「—」）", () => {
    const rows = companyRows(overview([company("A")]), null, "year", 10);
    expect(rows[0]?.overdue).toBeNull();
    expect(rows[0]?.overdueCount).toBeNull();
  });

  it("isSingleCompany 與選填欄位（headcount／payrollCost 有才顯示）", () => {
    const one = overview([company("A")]);
    expect(isSingleCompany(companyRows(one, [], "year", 10))).toBe(true);
    expect(isSingleCompany(companyRows(overview([company("A"), company("B")]), [], "year", 10))).toBe(false);
    expect(optionalColumns(one)).toEqual({ headcount: false, payrollCost: false });
    const withHc = overview([company("A", { headcount: 12 }), company("B")]);
    expect(optionalColumns(withHc)).toEqual({ headcount: true, payrollCost: false });
    expect(companyRows(withHc, [], "year", 10)[0]?.headcount).toBe(12);
  });
});

describe("下鑽連結與下游頁讀網址", () => {
  it("bossLinks 帶篩選", () => {
    expect(bossLinks.attendanceAnomalies("2026-10")).toBe("/admin/attendance-sheets?period=2026-10&anomaly=1");
    expect(bossLinks.overtimeDrafts("2026-09")).toBe("/admin/overtime-settlements?status=draft&period=2026-09");
    expect(bossLinks.overtimeDrafts(null)).toBe("/admin/overtime-settlements?status=draft");
    expect(bossLinks.leaveApprovals).toBe("/admin/approvals?status=pending");
    expect(bossLinks.disbursementApprovals).toBe("/admin/disbursements/approvals?scope=all");
  });

  it("readPeriodParam／readFlagParam／readEnumParam 擋掉格式不對的值", () => {
    expect(readPeriodParam("?period=2026-10&anomaly=1")).toBe("2026-10");
    expect(readPeriodParam("?period=2026-13")).toBeNull();
    expect(readPeriodParam("")).toBeNull();
    expect(readFlagParam("?anomaly=1", "anomaly")).toBe(true);
    expect(readFlagParam("?anomaly=true", "anomaly")).toBe(true);
    expect(readFlagParam("?anomaly=0", "anomaly")).toBe(false);
    expect(readEnumParam("?status=draft", "status", ["draft", "paid", "all"] as const)).toBe("draft");
    expect(readEnumParam("?status=hack", "status", ["draft", "paid", "all"] as const)).toBeNull();
  });

  it("complianceItems 固定四項順序", () => {
    const items = complianceItems({ total: 3, sevenDayRule: 1, regularLeaveWork: 0, dailyOver12h: 2, monthlyOtOver46h: 0 });
    expect(items.map((i) => `${i.label}:${i.count}`)).toEqual(["七休一:1", "例假出勤:0", "單日>12h:2", "月>46h:0"]);
  });
});
