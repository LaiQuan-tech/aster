import { describe, it, expect } from "vitest";
import {
  BAR_GAP,
  MAX_BAR_WIDTH,
  MONTH_OPTIONS,
  OVERVIEW_BASIS_NOTE,
  SINGLE_COMPANY_HINT,
  UNASSIGNED_COMPANY_ID,
  affiliateCellText,
  axisUnitFor,
  buildOverviewQuery,
  buildTrendChart,
  eliminatedNote,
  fmtAxisMoney,
  fmtMoney,
  fmtMoneyOrDash,
  fmtPct,
  nameWithShort,
  niceStep,
  periodLabel,
  qualityMessages,
  realCompanyCount,
  roundedTopBarPath,
  toggleExcluded,
  trendSummary,
  yearOptions,
  type TrendInputPoint,
} from "../group-overview";
import { ADMIN_TABS } from "../admin-nav";

/** 12 個月全 0 的趨勢點，再蓋上指定月份。 */
function monthly(overrides: Record<number, Partial<TrendInputPoint>> = {}): TrendInputPoint[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    revenue: 0,
    invoiced: 0,
    expense: 0,
    grossProfit: 0,
    ...overrides[i + 1],
  }));
}

describe("口徑文字與導覽一致", () => {
  it("頁首口徑與 admin-nav 集團總覽分頁的 desc 同一句；單一公司提示含新增公司的去處", () => {
    const tab = ADMIN_TABS.finance.find((t) => t.key === "groupOverview");
    expect(tab?.desc).toBe(OVERVIEW_BASIS_NOTE);
    expect(OVERVIEW_BASIS_NOTE).toBe("收入＝實際入帳（未稅）；支出＝已匯款放款（代扣前）；專案毛利不含人事成本");
    expect(SINGLE_COMPANY_HINT).toContain("名冊 → 公司主體");
    expect(SINGLE_COMPANY_HINT).toContain("舊專案未填承接公司者計入預設公司");
  });
});

describe("格式", () => {
  it("fmtMoney：千分位、到元、null 顯示 —", () => {
    expect(fmtMoney(1234567.4)).toBe("1,234,567");
    expect(fmtMoney(1234567.5)).toBe("1,234,568");
    expect(fmtMoney(0)).toBe("0");
    expect(fmtMoney(-3000)).toBe("-3,000");
    // 四捨五入成 0 的負小數不顯示「-0」
    expect(fmtMoney(-0.3)).toBe("0");
    expect(fmtMoney(-0.49)).toBe("0");
    expect(fmtMoney(-0.5)).toBe("0"); // Math.round(-0.5) = -0
    expect(fmtMoney(-0.51)).toBe("-1");
    expect(fmtMoney(0.4)).toBe("0");
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
  });

  it("fmtPct：一位小數；null（收入為 0）顯示 —", () => {
    expect(fmtPct(88.6)).toBe("88.6%");
    expect(fmtPct(93)).toBe("93.0%");
    expect(fmtPct(-50)).toBe("-50.0%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(null)).toBe("—");
  });

  it("fmtMoneyOrDash：0 顯示 —", () => {
    expect(fmtMoneyOrDash(0)).toBe("—");
    expect(fmtMoneyOrDash(1500)).toBe("1,500");
    expect(fmtMoneyOrDash(-1500)).toBe("-1,500");
  });

  it("座標軸：單位依整條軸最大值選一個（億／萬／無），刻度共用", () => {
    expect(axisUnitFor(2_000_000)).toBe("萬");
    expect(axisUnitFor(99_999)).toBe("萬");
    expect(axisUnitFor(10_000)).toBe("萬");
    expect(axisUnitFor(9_999)).toBe("");
    expect(axisUnitFor(100_000_000)).toBe("億");
    expect(fmtAxisMoney(1_500_000, "萬")).toBe("150萬");
    expect(fmtAxisMoney(15_000, "萬")).toBe("1.5萬");
    expect(fmtAxisMoney(250_000_000, "億")).toBe("2.5億");
    expect(fmtAxisMoney(50_000_000, "億")).toBe("0.5億");
    expect(fmtAxisMoney(-500_000, "萬")).toBe("−50萬");
    expect(fmtAxisMoney(5000, "")).toBe("5,000");
    expect(fmtAxisMoney(0, "萬")).toBe("0");
    expect(fmtAxisMoney(1_234_000_000, "億")).toBe("12.34億");
  });

  it("periodLabel／yearOptions／MONTH_OPTIONS", () => {
    expect(periodLabel(2026, null)).toBe("2026 年全年");
    expect(periodLabel(2026, 3)).toBe("2026 年 3 月");
    const years = yearOptions(2026);
    expect(years).toHaveLength(10);
    expect(years[0]).toBe(2027);
    expect(years[years.length - 1]).toBe(2018);
    expect(years).toContain(2026);
    expect(MONTH_OPTIONS).toHaveLength(13);
    expect(MONTH_OPTIONS[0]).toEqual({ value: null, label: "全年" });
    expect(MONTH_OPTIONS[12]).toEqual({ value: 12, label: "12 月" });
  });

  it("nameWithShort：有簡稱且不同於全名 → 簡稱（全名）；否則全名", () => {
    expect(nameWithShort("測試客戶股份有限公司", "測試客戶")).toBe("測試客戶（測試客戶股份有限公司）");
    expect(nameWithShort("測試客戶", "測試客戶")).toBe("測試客戶");
    expect(nameWithShort("測試客戶", null)).toBe("測試客戶");
    expect(nameWithShort("測試客戶", undefined)).toBe("測試客戶");
    expect(nameWithShort("測試客戶", "")).toBe("測試客戶");
  });
});

describe("查詢字串與公司勾選", () => {
  it("buildOverviewQuery：月份省略＝全年、排除清單空＝不帶、順序固定", () => {
    expect(buildOverviewQuery({})).toBe("");
    expect(buildOverviewQuery({ year: 2026 })).toBe("?year=2026");
    expect(buildOverviewQuery({ year: 2026, month: null })).toBe("?year=2026");
    expect(buildOverviewQuery({ year: 2026, month: 3 })).toBe("?year=2026&month=3");
    expect(buildOverviewQuery({ year: 2026, exclude: [] })).toBe("?year=2026");
    expect(buildOverviewQuery({ year: 2026, month: 3, exclude: ["a", "b"] })).toBe("?year=2026&month=3&exclude=a%2Cb");
    expect(buildOverviewQuery({ companyId: "c1", kind: "expense", year: 2026, month: 12 })).toBe(
      "?companyId=c1&kind=expense&year=2026&month=12",
    );
    expect(buildOverviewQuery({ companyId: "c 1&x", kind: "revenue", year: 2026 })).toBe("?companyId=c+1%26x&kind=revenue&year=2026");
  });

  it("toggleExcluded：沒在清單就加入、在清單就移除；不改原陣列、不重複", () => {
    const base = ["a", "b"] as const;
    expect(toggleExcluded([], "a")).toEqual(["a"]);
    expect(toggleExcluded(base, "c")).toEqual(["a", "b", "c"]);
    expect(toggleExcluded(base, "a")).toEqual(["b"]);
    expect(base).toEqual(["a", "b"]);
    expect(toggleExcluded(toggleExcluded([], "a"), "a")).toEqual([]);
  });

  it("realCompanyCount：不算「（未歸屬公司）」假列", () => {
    expect(realCompanyCount([])).toBe(0);
    expect(realCompanyCount([{ id: "c1" }])).toBe(1);
    expect(realCompanyCount([{ id: "c1" }, { id: UNASSIGNED_COMPANY_ID }])).toBe(1);
    expect(realCompanyCount([{ id: "c1" }, { id: "c2" }, { id: UNASSIGNED_COMPANY_ID }])).toBe(2);
    expect(UNASSIGNED_COMPANY_ID).toBe("unassigned");
  });

  it("eliminatedNote：集團合計已剔除關係企業往來 X 元（X＝收入＋放款），並列出兩端", () => {
    expect(eliminatedNote({ revenue: 300_000, expense: 50_000, total: 350_000 })).toBe(
      "集團合計已剔除關係企業往來 350,000 元（收入 300,000 元、放款支出 50,000 元）",
    );
    expect(eliminatedNote({ revenue: 0, expense: 0, total: 0 })).toBe("集團合計已剔除關係企業往來 0 元（收入 0 元、放款支出 0 元）");
  });

  it("affiliateCellText：只列有金額的項目；全 0 → —", () => {
    expect(affiliateCellText({ revenue: 0, invoiced: 0, expense: 0 })).toBe("—");
    expect(affiliateCellText({ revenue: 300_000, invoiced: 0, expense: 0 })).toBe("收入 300,000");
    expect(affiliateCellText({ revenue: 0, invoiced: 0, expense: 50_000 })).toBe("放款 50,000");
    expect(affiliateCellText({ revenue: 300_000, invoiced: 200_000, expense: 50_000 })).toBe("收入 300,000／開票 200,000／放款 50,000");
  });
});

describe("qualityMessages（資料品質提醒的文字）", () => {
  const none = { undatedReceived: { count: 0, amount: 0 }, receivedOverEffective: { count: 0, excess: 0 } };

  it("沒有問題 → 空陣列（頁面不畫提醒）", () => {
    expect(qualityMessages(none, 2026)).toEqual([]);
  });

  it("沒有入帳日的入帳金額：說明無法歸月、沒算進任何數字", () => {
    const [msg, ...rest] = qualityMessages({ ...none, undatedReceived: { count: 2, amount: 340_000.5 } }, 2026);
    expect(rest).toEqual([]);
    expect(msg).toContain("有 2 筆入帳金額（合計 340,001 元）沒有填入帳日");
    expect(msg).toContain("無法歸月");
    expect(msg).toContain("沒有算進以上任何數字");
  });

  it("實收高於應收（未稅）：帶年份、筆數與多出來的合計，提醒入帳要填未稅（含稅會多算 5%）", () => {
    const [msg, ...rest] = qualityMessages({ ...none, receivedOverEffective: { count: 3, excess: 60_000 } }, 2026);
    expect(rest).toEqual([]);
    expect(msg).toContain("2026 年有 3 筆入帳金額高於該期應收（未稅）");
    expect(msg).toContain("合計多 60,000 元");
    expect(msg).toContain("入帳金額請填未稅");
    expect(msg).toContain("多算 5%");
  });

  it("兩項都有 → 兩句，先講沒有入帳日、再講實收高於應收", () => {
    const msgs = qualityMessages({ undatedReceived: { count: 1, amount: 100 }, receivedOverEffective: { count: 1, excess: 50 } }, 2025);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("沒有填入帳日");
    expect(msgs[1]).toContain("2025 年");
  });
});

describe("niceStep", () => {
  it("取 1／2／5 × 10^k", () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(5)).toBe(5);
    expect(niceStep(5.1)).toBe(10);
    expect(niceStep(325_000)).toBe(500_000);
    expect(niceStep(500_000)).toBe(500_000);
    expect(niceStep(80_000)).toBe(100_000);
    expect(niceStep(0.3)).toBe(0.5);
  });

  it("不合法輸入退回 1", () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-5)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
    expect(niceStep(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("buildTrendChart", () => {
  const points = monthly({
    3: { revenue: 1_000_000, invoiced: 900_000, expense: 400_000, grossProfit: 600_000 },
    6: { revenue: 2_000_000, expense: 500_000, grossProfit: 1_500_000 },
  });

  it("12 個月各一欄；欄位連續、剛好鋪滿繪圖區；命中區比長條大", () => {
    const chart = buildTrendChart(points);
    expect(chart.columns).toHaveLength(12);
    expect(chart.columns.map((c) => c.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(chart.columns[0]?.slotX).toBeCloseTo(chart.plotLeft, 1);
    const last = chart.columns[11]!;
    expect(last.slotX + last.slotWidth).toBeCloseTo(chart.plotRight, 1);
    for (let i = 1; i < 12; i++) {
      const prev = chart.columns[i - 1]!;
      expect(chart.columns[i]!.slotX).toBeCloseTo(prev.slotX + prev.slotWidth, 1);
    }
    for (const c of chart.columns) {
      expect(c.cx).toBeCloseTo(c.slotX + c.slotWidth / 2, 1);
      if (c.revenueBar && c.expenseBar) {
        const pairWidth = c.expenseBar.x + c.expenseBar.width - c.revenueBar.x;
        expect(c.slotWidth).toBeGreaterThan(pairWidth);
      }
    }
  });

  it("Y 軸含 0 與最大值，刻度是 1／2／5 的倍數、由下往上遞增，標籤共用「萬」單位", () => {
    const chart = buildTrendChart(points);
    expect(chart.isEmpty).toBe(false);
    expect(chart.ticks.map((t) => t.value)).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000]);
    expect(chart.ticks.map((t) => t.label)).toEqual(["0", "50萬", "100萬", "150萬", "200萬"]);
    expect(chart.unit).toBe("萬");
    const ys = chart.ticks.map((t) => t.y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys); // value 越大 y 越小
    expect(ys[0]).toBe(chart.zeroY);
    expect(ys[ys.length - 1]).toBe(chart.plotTop);
    expect(chart.zeroY).toBe(chart.plotBottom);
  });

  it("長條由 0 基線往上長，高度與金額成正比；值為 0 的月份沒有長條", () => {
    const chart = buildTrendChart(points);
    const mar = chart.columns[2]!;
    const jun = chart.columns[5]!;
    expect(mar.revenueBar).not.toBeNull();
    expect(jun.revenueBar).not.toBeNull();
    // 6 月入帳 200 萬＝滿格；3 月 100 萬＝一半
    expect(jun.revenueBar!.height).toBeCloseTo(chart.plotBottom - chart.plotTop, 1);
    expect(mar.revenueBar!.height).toBeCloseTo(jun.revenueBar!.height / 2, 1);
    // 放款 40 萬／50 萬
    expect(mar.expenseBar!.height / jun.expenseBar!.height).toBeCloseTo(0.8, 2);
    // 所有長條的底部都在 0 基線
    for (const c of chart.columns) {
      for (const bar of [c.revenueBar, c.expenseBar]) {
        if (bar) expect(bar.y + bar.height).toBeCloseTo(chart.zeroY, 1);
      }
    }
    // 沒有往來的月份不畫長條
    expect(chart.columns[0]!.revenueBar).toBeNull();
    expect(chart.columns[0]!.expenseBar).toBeNull();
  });

  it("長條最粗 24px、兩根之間留 2px 間隙、都落在自己的月欄裡", () => {
    for (const width of [400, 720, 2000]) {
      const chart = buildTrendChart(points, { width });
      for (const c of chart.columns) {
        if (!c.revenueBar || !c.expenseBar) continue;
        expect(c.revenueBar.width).toBeLessThanOrEqual(MAX_BAR_WIDTH);
        expect(c.revenueBar.width).toBe(c.expenseBar.width);
        expect(c.expenseBar.x - (c.revenueBar.x + c.revenueBar.width)).toBeCloseTo(BAR_GAP, 1);
        expect(c.revenueBar.x).toBeGreaterThanOrEqual(c.slotX);
        expect(c.expenseBar.x + c.expenseBar.width).toBeLessThanOrEqual(c.slotX + c.slotWidth);
      }
    }
    // 寬圖才會頂到 24；窄圖會縮小但不小於 2
    expect(buildTrendChart(points, { width: 2000 }).columns[2]!.revenueBar!.width).toBe(MAX_BAR_WIDTH);
    expect(buildTrendChart(points, { width: 200 }).columns[2]!.revenueBar!.width).toBeGreaterThanOrEqual(2);
  });

  it("毛利折線：每月一個點、同一條 Y 軸；正毛利的點在 0 基線上方", () => {
    const chart = buildTrendChart(points);
    expect(chart.profitPath.startsWith("M")).toBe(true);
    expect(chart.profitPath.match(/[ML]/g)).toHaveLength(12);
    const jun = chart.columns[5]!;
    expect(jun.profit.x).toBe(jun.cx);
    expect(jun.profit.y).toBeLessThan(chart.zeroY);
    // 毛利 150 萬、入帳 200 萬：折線點在入帳長條頂端下面
    expect(jun.profit.y).toBeGreaterThan(jun.revenueBar!.y);
    // 沒往來的月份毛利 0 → 落在基線
    expect(chart.columns[0]!.profit.y).toBe(chart.zeroY);
  });

  it("毛利為負：Y 軸往 0 以下延伸，折線點落在基線下方，刻度含負值", () => {
    const chart = buildTrendChart(
      monthly({
        1: { revenue: 0, expense: 300_000, grossProfit: -300_000 },
        2: { revenue: 1_000_000, expense: 200_000, grossProfit: 800_000 },
      }),
    );
    expect(chart.ticks[0]!.value).toBeLessThan(0);
    expect(chart.ticks.map((t) => t.value)).toContain(0);
    expect(chart.ticks[0]!.label.startsWith("−")).toBe(true);
    expect(chart.zeroY).toBeLessThan(chart.plotBottom);
    expect(chart.columns[0]!.profit.y).toBeGreaterThan(chart.zeroY);
    expect(chart.columns[1]!.profit.y).toBeLessThan(chart.zeroY);
    // 放款長條仍是由基線往上
    const bar = chart.columns[0]!.expenseBar!;
    expect(bar.y + bar.height).toBeCloseTo(chart.zeroY, 1);
  });

  it("12 個月全是 0 → isEmpty、沒有折線、沒有長條，不會除以 0", () => {
    const chart = buildTrendChart(monthly());
    expect(chart.isEmpty).toBe(true);
    expect(chart.profitPath).toBe("");
    expect(chart.columns.every((c) => c.revenueBar === null && c.expenseBar === null)).toBe(true);
    expect(chart.ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of chart.ticks) expect(Number.isFinite(t.y)).toBe(true);
    for (const c of chart.columns) expect(Number.isFinite(c.profit.y)).toBe(true);
  });

  it("很小的金額也至少 1px 高；億元級的軸用「億」", () => {
    const tiny = buildTrendChart(monthly({ 1: { revenue: 1, grossProfit: 1 }, 2: { revenue: 1_000_000, grossProfit: 1_000_000 } }));
    expect(tiny.columns[0]!.revenueBar!.height).toBeGreaterThanOrEqual(1);
    const big = buildTrendChart(monthly({ 5: { revenue: 350_000_000, grossProfit: 350_000_000 } }));
    expect(big.unit).toBe("億");
    expect(big.ticks.at(-1)!.label.endsWith("億")).toBe(true);
  });

  it("自訂尺寸：viewBox 寬高跟著，繪圖區在座標軸標籤之內", () => {
    const chart = buildTrendChart(points, { width: 1000, height: 400 });
    expect(chart.width).toBe(1000);
    expect(chart.height).toBe(400);
    expect(chart.plotRight).toBe(988);
    expect(chart.plotBottom).toBe(370);
    expect(chart.plotLeft).toBeGreaterThan(40); // 留位置給刻度標籤
  });
});

describe("roundedTopBarPath", () => {
  it("只有資料端（上端）圓角 4px，基線端方角", () => {
    expect(roundedTopBarPath({ x: 10, y: 20, width: 19, height: 100 })).toBe("M10 120 L10 24 Q10 20 14 20 L25 20 Q29 20 29 24 L29 120 Z");
  });

  it("很矮或很窄的長條圓角縮小，不超過高度與半個寬度", () => {
    expect(roundedTopBarPath({ x: 0, y: 99, width: 19, height: 1 })).toBe("M0 100 L0 100 Q0 99 1 99 L18 99 Q19 99 19 100 L19 100 Z");
    expect(roundedTopBarPath({ x: 0, y: 0, width: 4, height: 50 })).toBe("M0 50 L0 2 Q0 0 2 0 L2 0 Q4 0 4 2 L4 50 Z");
  });
});

describe("trendSummary", () => {
  it("一句話講全年入帳、放款與毛利（給 aria-label）", () => {
    const text = trendSummary(points(), "集團合計");
    expect(text).toBe("集團合計月趨勢：全年入帳收入 3,000,000 元、放款支出 900,000 元、專案毛利 2,100,000 元");
  });

  function points(): TrendInputPoint[] {
    return monthly({
      3: { revenue: 1_000_000, expense: 400_000, grossProfit: 600_000 },
      6: { revenue: 2_000_000, expense: 500_000, grossProfit: 1_500_000 },
    });
  }
});
