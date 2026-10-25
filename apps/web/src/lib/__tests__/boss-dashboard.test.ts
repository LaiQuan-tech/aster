import { describe, it, expect } from "vitest";
import {
  activeCompanyCount,
  bossLinks,
  fmtCount,
  fmtPct1,
  fmtWan,
  headlineTiles,
  homeLinkModuleEnabled,
  needsAttention,
  readEnumParam,
  readFlagParam,
  readPeriodParam,
  todoDataIncomplete,
  todoItems,
  type GroupOverviewLite,
  type Load,
  type SummaryLoad,
} from "../boss-dashboard";
import { isAdminPathAllowed, roleNavOf } from "../admin-nav";
import type { BossSummary } from "../dashboard-api";

// ⚠️ 數字、名稱都是明顯的假值（repo 是公開的）。

const HR_LINK = (href: string) => isAdminPathAllowed({ pathname: href, roleNav: roleNavOf("hr_admin", null), modules: null });
const ACC_LINK = (href: string) => isAdminPathAllowed({ pathname: href, roleNav: roleNavOf("accountant", null), modules: null });

const done = <T,>(data: T): Load<T> => ({ loading: false, error: null, data });
const loading = <T,>(): Load<T> => ({ loading: true, error: null, data: null });
const failed = <T,>(): Load<T> => ({ loading: false, error: "boom", data: null });
const NONE: Load<number> = { loading: false, error: null, data: null };

function hrSummary(extra: Partial<BossSummary> = {}): BossSummary {
  return {
    period: "2026-10",
    today: "2026-10-25",
    scope: {
      leaveApprovals: true,
      disbursementApprovals: true,
      attendance: true,
      overtime: true,
      people: true,
      receivables: true,
      projectAlerts: true,
      monthDisbursements: false,
    },
    approvals: { leave: 44, disbursements: 3, disbursementAmount: 123_456, total: 47 },
    attendance: {
      sheetCount: 20,
      anomalies: 27,
      anomalySheets: 9,
      compliance: { total: 3, sevenDayRule: 1, regularLeaveWork: 0, dailyOver12h: 2, monthlyOtOver46h: 0 },
    },
    overtime: { overCapPeople: 1, draftCount: 2, draftAmount: 12_000, draftMissingAmount: 0, latestDraftPeriod: "2026-09" },
    people: { active: 38, hires: 2, exits: 1 },
    receivables: { unreceivedTotal: 2_500_000, overdueCount: 4 },
    projectAlerts: { total: 5, high: 2 },
    monthDisbursements: null,
    ...extra,
  };
}

function accSummary(extra: Partial<BossSummary> = {}): BossSummary {
  return hrSummary({
    scope: {
      leaveApprovals: false,
      disbursementApprovals: true,
      attendance: true,
      overtime: false,
      people: false,
      receivables: true,
      projectAlerts: true,
      monthDisbursements: true,
    },
    approvals: { leave: null, disbursements: 3, disbursementAmount: 50_000, total: 3 },
    overtime: null,
    people: null,
    projectAlerts: { total: 1, high: 0 },
    monthDisbursements: { count: 6, amount: 880_000 },
    ...extra,
  });
}

function overview(n: number): GroupOverviewLite {
  return {
    period: { year: 2026 },
    companies: [
      ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, isActive: true, revenue: 1, expense: 0 })),
      { id: "idle", isActive: false, revenue: 0, expense: 0 }, // 停用且沒數字 → 不算
      { id: "ex", isActive: true, excluded: true, revenue: 5, expense: 0 }, // 被排除 → 不算
    ],
    group: { revenue: 12_345_678, grossMarginPct: 41.25 },
  };
}

const s = (data: BossSummary): SummaryLoad => done(data);

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

  it("fmtCount／fmtPct1／needsAttention", () => {
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(1234)).toBe("1,234");
    expect(fmtPct1(null)).toBe("—");
    expect(fmtPct1(33.333)).toBe("33.3%");
    expect(needsAttention(0)).toBe(false);
    expect(needsAttention(null)).toBe(false);
    expect(needsAttention(2)).toBe(true);
  });
});

describe("頂部大數字 headlineTiles", () => {
  it("HR：本年收入／待簽核／未收款／在職人數，各自連到詳細頁", () => {
    const tiles = headlineTiles({ viewer: "group", summary: s(hrSummary()), overview: done(overview(1)), pendingLeave: NONE, linkOn: HR_LINK });
    expect(tiles.map((t) => t.key)).toEqual(["revenue", "approvals", "receivables", "people"]);
    const [rev, appr, recv, people] = tiles;
    expect(rev).toMatchObject({ label: "本年收入", value: "1,234.6 萬", sub: "毛利率 41.3%", note: null, href: "/admin/group-overview" });
    expect(appr).toMatchObject({ label: "待簽核", value: "47", sub: "假單 44・放款 3", href: bossLinks.leaveApprovals, tone: "attention" });
    expect(recv).toMatchObject({ label: "未收款", value: "250 萬", sub: "逾期 4 筆", href: bossLinks.receivables, tone: "attention" });
    expect(people).toMatchObject({ label: "在職人數", value: "38", sub: "本月 +2 / −1", href: bossLinks.employees });
  });

  it("多家公司才在本年收入下加「N 家公司・點看各公司」（停用無數字、被排除的不算）", () => {
    expect(activeCompanyCount(overview(1))).toBe(1);
    expect(activeCompanyCount(overview(3))).toBe(3);
    const [rev] = headlineTiles({ viewer: "group", summary: s(hrSummary()), overview: done(overview(3)), pendingLeave: NONE, linkOn: HR_LINK });
    expect(rev?.note).toBe("3 家公司・點看各公司");
  });

  it("會計：本月放款支出／待簽核（只有放款）／未收款／本月出勤異常；不見集團與人事", () => {
    const tiles = headlineTiles({ viewer: "finance", summary: s(accSummary()), overview: loading(), pendingLeave: NONE, linkOn: ACC_LINK });
    expect(tiles.map((t) => t.key)).toEqual(["monthDisbursements", "approvals", "receivables", "attendance"]);
    const [disb, appr, , att] = tiles;
    expect(disb).toMatchObject({ label: "本月放款支出", value: "88 萬", sub: "6 筆已匯款", href: bossLinks.disbursements });
    expect(appr).toMatchObject({ value: "3", sub: "放款 3", href: bossLinks.disbursementApprovals });
    expect(att).toMatchObject({ label: "本月出勤異常", value: "27", sub: "9 張月表有異常", href: bossLinks.attendanceAnomalies("2026-10") });
    expect(tiles.some((t) => t.key === "revenue" || t.key === "people")).toBe(false);
  });

  it("會計月表還沒產生 → 副標「本月月表尚未產生」；scope 關掉的格子不畫", () => {
    const sum = accSummary({
      attendance: { sheetCount: 0, anomalies: 0, anomalySheets: 0, compliance: { total: 0, sevenDayRule: 0, regularLeaveWork: 0, dailyOver12h: 0, monthlyOtOver46h: 0 } },
    });
    const tiles = headlineTiles({ viewer: "finance", summary: s(sum), overview: loading(), pendingLeave: NONE, linkOn: ACC_LINK });
    expect(tiles.find((t) => t.key === "attendance")?.sub).toBe("本月月表尚未產生");
    const noRecv = accSummary({ scope: { ...accSummary().scope, receivables: false }, receivables: null });
    expect(headlineTiles({ viewer: "finance", summary: s(noRecv), overview: loading(), pendingLeave: NONE, linkOn: ACC_LINK }).map((t) => t.key)).not.toContain(
      "receivables",
    );
  });

  it("載入中：格子先畫（骨架）；錯誤：每格「—」不擋其他格", () => {
    const l = headlineTiles({ viewer: "group", summary: loading(), overview: loading(), pendingLeave: loading(), linkOn: HR_LINK });
    expect(l.map((t) => t.key)).toEqual(["revenue", "approvals", "receivables", "people"]);
    expect(l.every((t) => t.loading)).toBe(true);

    // boss-summary 失敗、集團總覽成功 → 只有收入有數字
    const e = headlineTiles({ viewer: "group", summary: failed(), overview: done(overview(1)), pendingLeave: NONE, linkOn: HR_LINK });
    expect(e.map((t) => [t.key, t.value])).toEqual([
      ["revenue", "1,234.6 萬"],
      ["approvals", "—"],
      ["receivables", "—"],
      ["people", "—"],
    ]);
    // 集團總覽失敗 → 只有收入那格「—」
    const g = headlineTiles({ viewer: "group", summary: s(hrSummary()), overview: failed(), pendingLeave: NONE, linkOn: HR_LINK });
    expect(g[0]).toMatchObject({ key: "revenue", value: "—", sub: null });
    expect(g[1]?.value).toBe("47");
    // 子查詢失敗（欄位 null）→ 該格「—」
    const sub = headlineTiles({ viewer: "group", summary: s(hrSummary({ receivables: null })), overview: done(overview(1)), pendingLeave: NONE, linkOn: HR_LINK });
    expect(sub.find((t) => t.key === "receivables")).toMatchObject({ value: "—", sub: null });
  });

  it("待簽核：任一有權限的子項查詢失敗 → 整格「—」，副標只列查得到的部分", () => {
    const partial = hrSummary({ approvals: { leave: null, disbursements: 3, disbursementAmount: 1, total: 3 } });
    const tile = headlineTiles({ viewer: "group", summary: s(partial), overview: done(overview(1)), pendingLeave: NONE, linkOn: HR_LINK }).find(
      (t) => t.key === "approvals",
    );
    expect(tile).toMatchObject({ value: "—", sub: "放款 3", tone: "normal" });
    // 會計沒有假單權限 → 假單 null 不算失敗
    const acc = headlineTiles({ viewer: "finance", summary: s(accSummary()), overview: loading(), pendingLeave: NONE, linkOn: ACC_LINK }).find(
      (t) => t.key === "approvals",
    );
    expect(acc?.value).toBe("3");
    // 兩個都失敗 → 「—」、沒有副標
    const both = hrSummary({ approvals: { leave: null, disbursements: null, disbursementAmount: null, total: null } });
    expect(
      headlineTiles({ viewer: "group", summary: s(both), overview: done(overview(1)), pendingLeave: NONE, linkOn: HR_LINK }).find((t) => t.key === "approvals"),
    ).toMatchObject({ value: "—", sub: null });
  });

  it("舊 API（boss-summary 404）：待簽核退回只算假單；未收款／在職「—」", () => {
    const outdated: SummaryLoad = { loading: false, error: null, data: null, outdated: true };
    const tiles = headlineTiles({ viewer: "group", summary: outdated, overview: done(overview(1)), pendingLeave: done(12), linkOn: HR_LINK });
    expect(tiles.find((t) => t.key === "approvals")).toMatchObject({ value: "12", sub: "假單 12", href: bossLinks.leaveApprovals });
    expect(tiles.find((t) => t.key === "receivables")?.value).toBe("—");
    expect(tiles.find((t) => t.key === "people")?.value).toBe("—");
  });

  it("上一版 API（scope 沒有 receivables 欄、也沒有 receivables 值）→ 未收款格照畫、顯示「—」", () => {
    const { receivables: _r, projectAlerts: _p, monthDisbursements: _m, ...scope } = hrSummary().scope;
    const old = hrSummary({ scope, receivables: undefined });
    const tile = headlineTiles({ viewer: "group", summary: s(old), overview: done(overview(1)), pendingLeave: NONE, linkOn: HR_LINK }).find(
      (t) => t.key === "receivables",
    );
    expect(tile?.value).toBe("—");
  });
});

describe("需要你處理 todoItems", () => {
  it("HR：只列 > 0 的項目、先急後緩，合規警示彙總成一行", () => {
    const items = todoItems({ summary: s(hrSummary()), pendingLeave: NONE, linkOn: HR_LINK });
    expect(items.map((i) => [i.key, i.count])).toEqual([
      ["compliance", "3 筆"],
      ["leave", "44 張"],
      ["disbursements", "3 張"],
      ["projectAlerts", "5 件"],
      ["overCap", "1 人"],
      ["overtimeDrafts", "2 筆"],
      ["anomalies", "27 件"],
    ]);
    expect(items[0]).toMatchObject({ tone: "danger", href: bossLinks.attendanceAnomalies("2026-10") });
    expect(items.find((i) => i.key === "projectAlerts")).toMatchObject({ text: "專案示警（2 件高風險）", tone: "danger" });
    expect(items.find((i) => i.key === "overtimeDrafts")).toMatchObject({ text: "加班另計待發放・NT$ 1.2 萬", href: bossLinks.overtimeDrafts });
    expect(items.find((i) => i.key === "disbursements")?.text).toBe("放款單待簽核・NT$ 12.3 萬");
  });

  it("全部為 0 → 空清單（畫面顯示「目前沒有待處理事項 ✓」）", () => {
    const zero = hrSummary({
      approvals: { leave: 0, disbursements: 0, disbursementAmount: 0, total: 0 },
      attendance: { sheetCount: 3, anomalies: 0, anomalySheets: 0, compliance: { total: 0, sevenDayRule: 0, regularLeaveWork: 0, dailyOver12h: 0, monthlyOtOver46h: 0 } },
      overtime: { overCapPeople: 0, draftCount: 0, draftAmount: 0, draftMissingAmount: 0, latestDraftPeriod: null },
      projectAlerts: { total: 0, high: 0 },
    });
    expect(todoItems({ summary: s(zero), pendingLeave: NONE, linkOn: HR_LINK })).toEqual([]);
  });

  it("會計：沒有假單／加班另計（scope 為 null）；開不了的頁不列", () => {
    const items = todoItems({ summary: s(accSummary()), pendingLeave: NONE, linkOn: ACC_LINK });
    expect(items.map((i) => i.key)).toEqual(["compliance", "disbursements", "projectAlerts", "anomalies"]);
    expect(items.find((i) => i.key === "projectAlerts")).toMatchObject({ text: "專案示警", count: "1 件", tone: "attention" });
    expect(todoItems({ summary: s(accSummary()), pendingLeave: NONE, linkOn: () => false })).toEqual([]);
  });

  it("加班另計有未填金額 → 一併註明；載入中／錯誤 → 空清單", () => {
    const sum = hrSummary({ overtime: { overCapPeople: 0, draftCount: 2, draftAmount: 0, draftMissingAmount: 2, latestDraftPeriod: "2026-09" } });
    expect(todoItems({ summary: s(sum), pendingLeave: NONE, linkOn: HR_LINK }).find((i) => i.key === "overtimeDrafts")?.text).toBe("加班另計待發放（2 筆未填金額）");
    expect(todoItems({ summary: loading(), pendingLeave: NONE, linkOn: HR_LINK })).toEqual([]);
    expect(todoItems({ summary: failed(), pendingLeave: NONE, linkOn: HR_LINK })).toEqual([]);
  });

  it("todoDataIncomplete：有權限的清單欄位為 null 才算不完整（清單空時改顯示「部分資料讀不到」）", () => {
    expect(todoDataIncomplete({ summary: s(hrSummary()), pendingLeave: NONE })).toBe(false);
    expect(todoDataIncomplete({ summary: s(hrSummary({ attendance: null })), pendingLeave: NONE })).toBe(true);
    expect(todoDataIncomplete({ summary: s(hrSummary({ projectAlerts: null })), pendingLeave: NONE })).toBe(true);
    expect(
      todoDataIncomplete({ summary: s(hrSummary({ overtime: { overCapPeople: 0, draftCount: null, draftAmount: null, draftMissingAmount: null, latestDraftPeriod: null } })), pendingLeave: NONE }),
    ).toBe(true);
    expect(todoDataIncomplete({ summary: s(hrSummary({ approvals: { leave: 0, disbursements: null, disbursementAmount: null, total: 0 } })), pendingLeave: NONE })).toBe(true);
    // 會計沒權限的欄位本來就是 null → 不算
    expect(todoDataIncomplete({ summary: s(accSummary()), pendingLeave: NONE })).toBe(false);
    // 與清單無關的欄位（未收款）失敗不影響清單
    expect(todoDataIncomplete({ summary: s(hrSummary({ receivables: null })), pendingLeave: NONE })).toBe(false);
    // 載入中、舊 API
    expect(todoDataIncomplete({ summary: loading(), pendingLeave: NONE })).toBe(false);
    const outdated: SummaryLoad = { loading: false, error: null, data: null, outdated: true };
    expect(todoDataIncomplete({ summary: outdated, pendingLeave: failed() })).toBe(true);
    expect(todoDataIncomplete({ summary: outdated, pendingLeave: done(0) })).toBe(false);
  });

  it("舊 API（404）→ 只剩假單", () => {
    const outdated: SummaryLoad = { loading: false, error: null, data: null, outdated: true };
    expect(todoItems({ summary: outdated, pendingLeave: done(5), linkOn: HR_LINK }).map((i) => [i.key, i.count])).toEqual([["leave", "5 張"]]);
    expect(todoItems({ summary: outdated, pendingLeave: done(0), linkOn: HR_LINK })).toEqual([]);
  });
});

describe("模組開關", () => {
  it("homeLinkModuleEnabled：分頁掛了 module 的要啟用才 true；沒掛 module 的永遠 true", () => {
    expect(homeLinkModuleEnabled("/admin/attendance-sheets?period=2026-10&anomaly=1", {})).toBe(true);
    expect(homeLinkModuleEnabled("/admin/approvals?status=pending", null)).toBe(true);
    expect(homeLinkModuleEnabled("/admin/attendance-settlement", {})).toBe(false);
    expect(homeLinkModuleEnabled("/admin/attendance-settlement", { attendanceSettlement: true })).toBe(true);
    expect(homeLinkModuleEnabled("/admin", {})).toBe(true);
  });
});

describe("下鑽連結與下游頁讀網址", () => {
  it("bossLinks 帶篩選", () => {
    expect(bossLinks.attendanceAnomalies("2026-10")).toBe("/admin/attendance-sheets?period=2026-10&anomaly=1");
    expect(bossLinks.overtimeDrafts).toBe("/admin/overtime-settlements?status=draft&all=1");
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
});
