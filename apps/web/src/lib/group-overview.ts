/**
 * 集團總覽（/admin/group-overview）的純函式：金額／百分比格式、查詢字串、公司勾選、月趨勢圖的幾何。
 * 全部無 React、無 IO，有 vitest（lib/__tests__/group-overview.test.ts）。
 * 後端口徑見 apps/api/src/services/group-overview.ts 檔頭；型別在 lib/group-overview-api.ts。
 *
 * 圖表沒有引入套件：repo 沒有圖表套件，圖表一律手刻 inline SVG，這裡沿用——頁面只負責畫，
 * 座標、刻度、長條與折線路徑都在這裡算好，才測得到。
 */

/** 頁首／手機版頁面頂端的口徑說明（與 lib/admin-nav.ts 集團總覽分頁的 desc 同一句，測試會對照）。 */
export const OVERVIEW_BASIS_NOTE = "收入＝實際入帳（未稅）；支出＝已匯款放款＋未經放款單的已付複委託（代扣前）；專案毛利不含人事成本";

/** 只有一家公司時的提示（正式庫現況）。 */
export const SINGLE_COMPANY_HINT =
  "目前只有一家公司。其他關係企業請到 名冊 → 公司主體 新增；舊專案未填承接公司者計入預設公司。";

/** 後端查不到承接公司時的假列（見 services/group-overview.ts UNASSIGNED_COMPANY_ID）。 */
export const UNASSIGNED_COMPANY_ID = "unassigned";

/* ------------------------------------------------------------- 格式 --- */

/** 全站金額格式：千分位、到「元」；null／undefined 顯示「—」。四捨五入成 0 的負小數顯示 0，不顯示「-0」。 */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  const rounded = Math.round(n);
  return (rounded === 0 ? 0 : rounded).toLocaleString("zh-TW");
}

/** 毛利率：一位小數；null（收入為 0）顯示「—」。 */
export function fmtPct(p: number | null | undefined): string {
  return p == null ? "—" : `${p.toFixed(1)}%`;
}

/** 0 顯示「—」（逐月表一眼掃過去，沒往來的月份不會被一堆 0 洗版）。 */
export function fmtMoneyOrDash(n: number): string {
  return n === 0 ? "—" : fmtMoney(n);
}

/** 圖表座標軸刻度用的單位：依整條軸的最大絕對值選一個，整條軸共用（不混「5,000萬」與「1.5億」）。 */
export type AxisUnit = "億" | "萬" | "";

export function axisUnitFor(maxAbs: number): AxisUnit {
  if (maxAbs >= 1e8) return "億";
  if (maxAbs >= 1e4) return "萬";
  return "";
}

export function fmtAxisMoney(n: number, unit: AxisUnit): string {
  if (n === 0) return "0";
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (unit === "億") return `${sign}${trimDecimals(abs / 1e8, 2)}億`;
  if (unit === "萬") return `${sign}${trimDecimals(abs / 1e4, 1)}萬`;
  return `${sign}${Math.round(abs).toLocaleString("zh-TW")}`;
}

function trimDecimals(x: number, digits: number): string {
  const rounded = Number(x.toFixed(digits));
  return rounded.toLocaleString("zh-TW", { maximumFractionDigits: digits });
}

/** 期間文字：「2026 年全年」「2026 年 3 月」。 */
export function periodLabel(year: number, month: number | null): string {
  return month === null ? `${year} 年全年` : `${year} 年 ${month} 月`;
}

export const MONTH_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: "全年" },
  ...Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1} 月` })),
];

/** 年份選項：明年到過去 8 年，新到舊。 */
export function yearOptions(thisYear: number): number[] {
  return Array.from({ length: 10 }, (_, i) => thisYear + 1 - i);
}

/* ------------------------------------------------------ 資料品質提醒 --- */

/** 後端 dataQuality 的兩項（lib/group-overview-api.ts 的 GroupDataQuality 結構相同；這裡只取算文字要用的欄位）。 */
export type QualitySummary = {
  undatedReceived: { count: number; amount: number };
  receivedOverEffective: { count: number; excess: number };
};

/**
 * 資料品質提醒的文字（沒有問題 → 空陣列，頁面就不畫提醒）。不改任何數字，只告訴老闆哪裡要人去核對：
 * 沒有入帳日的入帳金額（無法歸月，不在任何一個月裡）、實收大於該期應收（未稅）（可能把含稅金額當未稅填了）。
 */
export function qualityMessages(q: QualitySummary, year: number): string[] {
  const out: string[] = [];
  if (q.undatedReceived.count > 0) {
    out.push(
      `有 ${q.undatedReceived.count.toLocaleString("zh-TW")} 筆入帳金額（合計 ${fmtMoney(q.undatedReceived.amount)} 元）沒有填入帳日，無法歸月，沒有算進以上任何數字。請到該專案的請款期程補上入帳日。`,
    );
  }
  if (q.receivedOverEffective.count > 0) {
    out.push(
      `${year} 年有 ${q.receivedOverEffective.count.toLocaleString("zh-TW")} 筆入帳金額高於該期應收（未稅），合計多 ${fmtMoney(q.receivedOverEffective.excess)} 元。入帳金額請填未稅；若填的是銀行入帳的含稅金額，收入會多算 5%。`,
    );
  }
  return out;
}

/* ------------------------------------------------------ 查詢／勾選 --- */

/** `/group-overview` 與 `/group-overview/detail` 共用的查詢字串（月份省略＝全年；排除清單省略＝全部納入）。 */
export function buildOverviewQuery(params: {
  year?: number;
  month?: number | null;
  exclude?: readonly string[];
  companyId?: string;
  kind?: "revenue" | "expense";
}): string {
  const qs = new URLSearchParams();
  if (params.companyId) qs.set("companyId", params.companyId);
  if (params.kind) qs.set("kind", params.kind);
  if (params.year !== undefined) qs.set("year", String(params.year));
  if (params.month !== undefined && params.month !== null) qs.set("month", String(params.month));
  if (params.exclude && params.exclude.length > 0) qs.set("exclude", params.exclude.join(","));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** 勾選／取消勾選某家公司「納入集團合計」：回傳新的排除清單（不改原陣列、不重複）。 */
export function toggleExcluded(excluded: readonly string[], companyId: string): string[] {
  return excluded.includes(companyId) ? excluded.filter((id) => id !== companyId) : [...excluded, companyId];
}

/** 公司清單裡真正的公司家數（不含「（未歸屬公司）」假列）；≤ 1 時頁面顯示 SINGLE_COMPANY_HINT。 */
export function realCompanyCount(companies: ReadonlyArray<{ id: string }>): number {
  return companies.filter((c) => c.id !== UNASSIGNED_COMPANY_ID).length;
}

/** 「集團合計已剔除關係企業往來 X 元」一行字（X＝收入端＋放款端；開票是參考數字，不併入）。 */
export function eliminatedNote(eliminated: { revenue: number; expense: number; total: number }): string {
  return `集團合計已剔除關係企業往來 ${fmtMoney(eliminated.total)} 元（收入 ${fmtMoney(eliminated.revenue)} 元、放款支出 ${fmtMoney(eliminated.expense)} 元）`;
}

/** 各公司表「其中關係企業往來」欄：只列有金額的項目；全 0 → 「—」。 */
export function affiliateCellText(a: { revenue: number; invoiced: number; expense: number }): string {
  const parts: string[] = [];
  if (a.revenue !== 0) parts.push(`收入 ${fmtMoney(a.revenue)}`);
  if (a.invoiced !== 0) parts.push(`開票 ${fmtMoney(a.invoiced)}`);
  if (a.expense !== 0) parts.push(`放款 ${fmtMoney(a.expense)}`);
  return parts.length === 0 ? "—" : parts.join("／");
}

/* ------------------------------------------------------------ 人事 --- */

/** 「扣人事成本後」的口徑標示（頁面、表頭 title 共用）。 */
export const PAYROLL_BASIS_NOTE = "人事成本以員工所屬公司歸屬，未指派者不分攤";

/** 人事成本為 null（期間內沒有任何薪資單）時畫面上的字。 */
export const NO_PAYROLL_TEXT = "尚無薪資資料";

/** 後端 payroll.basisNote 的預設值（舊版 API 沒帶時用）。 */
export const PAYROLL_GROSS_NOTE = "應發（gross）口徑：未扣請假／遲到扣款、不含雇主負擔、加班另計與獎金";

export type PayrollSummaryLike = {
  hasData: boolean;
  slipCount: number;
  draftSlipCount: number;
  companyAssignmentReady: boolean;
  employerCostIncluded: boolean;
  basisNote?: string;
  overtimeSettlementAvailable?: boolean;
  overtimeSettlementCount?: number;
  overtimeSettlementDraftCount?: number;
  overtimeSettlementNoAmountCount?: number;
};

/**
 * 集團合計卡下方的人事說明（純文字陣列，一句一行）。人事成本以應發（gross）為主，扣款後與加班另計只是補充。
 * `payroll` 省略＝舊版 API（沒有人事欄位），回空陣列不顯示。
 */
export function payrollNotes(
  payroll: PayrollSummaryLike | undefined,
  group: {
    unassignedHeadcount?: number;
    unassignedPayrollCost?: number | null;
    payrollCostNet?: number | null;
    overtimeSettlementCost?: number | null;
  },
): string[] {
  if (!payroll) return [];
  const notes: string[] = [];
  if (!payroll.companyAssignmentReady) {
    notes.push("員工所屬公司尚未啟用（資料庫待更新），所有員工暫列「未指派」");
  }
  notes.push(`人事成本＝期間內薪資單${payroll.basisNote ?? PAYROLL_GROSS_NOTE}；${PAYROLL_BASIS_NOTE}`);
  if (!payroll.hasData) {
    notes.push(`${NO_PAYROLL_TEXT}：這段期間還沒有產生任何薪資單，人事成本與「扣人事成本後」顯示「—」`);
  } else {
    if (payroll.draftSlipCount > 0) {
      notes.push(`${payroll.slipCount} 張薪資單中有 ${payroll.draftSlipCount} 張尚未定稿，數字可能再變動`);
    }
    if (group.payrollCostNet != null) {
      notes.push(`補充：扣除請假／遲到扣款後 ${fmtMoney(group.payrollCostNet)} 元`);
    }
  }
  if (payroll.overtimeSettlementAvailable && group.overtimeSettlementCost != null && (payroll.overtimeSettlementCount ?? 0) > 0) {
    const extra: string[] = [];
    if ((payroll.overtimeSettlementDraftCount ?? 0) > 0) extra.push(`其中 ${payroll.overtimeSettlementDraftCount} 筆草稿`);
    if ((payroll.overtimeSettlementNoAmountCount ?? 0) > 0) extra.push(`${payroll.overtimeSettlementNoAmountCount} 筆尚無金額未計`);
    notes.push(
      `補充：加班超額另計 ${fmtMoney(group.overtimeSettlementCost)} 元（${payroll.overtimeSettlementCount} 筆${extra.length ? `，${extra.join("、")}` : ""}；不在人事成本內）`,
    );
  }
  const unassigned = group.unassignedHeadcount ?? 0;
  const unassignedCost = group.unassignedPayrollCost ?? null;
  if (unassigned > 0 || (unassignedCost ?? 0) !== 0) {
    const cost = payroll.hasData ? `、人事成本 ${fmtMoney(unassignedCost)} 元` : "";
    notes.push(`未指派公司的員工 ${unassigned} 人${cost}：不分攤到任何公司，但計入集團合計；可到「員工管理」指派所屬公司`);
  }
  return notes;
}

/** 客戶／廠商顯示名：有簡稱且不同於全名 → 「簡稱（全名）」，否則全名。 */
export function nameWithShort(name: string, shortName: string | null | undefined): string {
  return shortName && shortName !== name ? `${shortName}（${name}）` : name;
}

/* ------------------------------------------------------------ 圖表 --- */

export type TrendInputPoint = { month: number; revenue: number; invoiced: number; expense: number; grossProfit: number };

export type Bar = { x: number; y: number; width: number; height: number };

export type TrendColumn = {
  month: number;
  /** 這個月的欄位（含兩根長條與間距）：hover／focus 命中區，比長條大。 */
  slotX: number;
  slotWidth: number;
  /** 欄中心 x。 */
  cx: number;
  /** 值為 0 的長條是 null（不畫）。 */
  revenueBar: Bar | null;
  expenseBar: Bar | null;
  /** 毛利折線上的點。 */
  profit: { x: number; y: number };
  point: TrendInputPoint;
};

export type TrendChart = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  /** 0 的 y 座標（長條由這條基線長出來；毛利為負時折線會落到它下面）。 */
  zeroY: number;
  unit: AxisUnit;
  ticks: Array<{ value: number; y: number; label: string }>;
  columns: TrendColumn[];
  /** 毛利折線的 SVG path（"M x y L x y …"）；沒有資料時是空字串。 */
  profitPath: string;
  /** 12 個月全是 0。 */
  isEmpty: boolean;
};

/** 1／2／5 × 10^k 的「好看」刻度間距。 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const mantissa = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mantissa * pow;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 長條最粗 24px（不填滿欄位），兩根長條之間留 2px 底色間隙。 */
export const MAX_BAR_WIDTH = 24;
export const BAR_GAP = 2;

/**
 * 月趨勢圖的幾何：每月兩根長條（入帳收入、放款支出，由同一條 0 基線往上長）＋毛利折線，**同一條 Y 軸**
 * （同為新台幣，不做雙軸）。Y 範圍含 0 與所有數值（毛利為負時往下延伸），刻度取 1／2／5×10^k。
 */
export function buildTrendChart(
  points: ReadonlyArray<TrendInputPoint>,
  opts: { width?: number; height?: number } = {},
): TrendChart {
  const width = opts.width ?? 720;
  const height = opts.height ?? 280;
  const plotLeft = 64;
  const plotRight = width - 12;
  const plotTop = 14;
  const plotBottom = height - 30;
  const plotHeight = plotBottom - plotTop;

  const values = points.flatMap((p) => [p.revenue, p.expense, p.grossProfit]);
  const dataMax = Math.max(0, ...values);
  const dataMin = Math.min(0, ...values);
  const isEmpty = dataMax === 0 && dataMin === 0;

  const step = isEmpty ? 1 : niceStep((dataMax - dataMin) / 4);
  const lo = Math.floor(dataMin / step) * step;
  let hi = Math.ceil(dataMax / step) * step;
  if (hi <= lo) hi = lo + step;
  const y = (v: number) => plotTop + ((hi - v) / (hi - lo)) * plotHeight;

  const unit = axisUnitFor(Math.max(Math.abs(lo), Math.abs(hi)));
  const tickCount = Math.round((hi - lo) / step);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const value = lo + i * step;
    return { value, y: r2(y(value)), label: fmtAxisMoney(value, unit) };
  });

  const zeroY = r2(y(0));
  const slotWidth = (plotRight - plotLeft) / Math.max(1, points.length);
  const barWidth = Math.max(2, Math.min(MAX_BAR_WIDTH, Math.floor((slotWidth - 12) / 2) - BAR_GAP / 2));

  const bar = (value: number, x: number): Bar | null => {
    if (value <= 0) return null;
    const top = y(value);
    return { x: r2(x), y: r2(top), width: barWidth, height: r2(Math.max(1, zeroY - top)) };
  };

  const columns: TrendColumn[] = points.map((p, i) => {
    const slotX = plotLeft + i * slotWidth;
    const cx = slotX + slotWidth / 2;
    const pairLeft = cx - (2 * barWidth + BAR_GAP) / 2;
    return {
      month: p.month,
      slotX: r2(slotX),
      slotWidth: r2(slotWidth),
      cx: r2(cx),
      revenueBar: bar(p.revenue, pairLeft),
      expenseBar: bar(p.expense, pairLeft + barWidth + BAR_GAP),
      profit: { x: r2(cx), y: r2(y(p.grossProfit)) },
      point: p,
    };
  });

  const profitPath = isEmpty ? "" : columns.map((c, i) => `${i === 0 ? "M" : "L"}${c.profit.x} ${c.profit.y}`).join(" ");

  return { width, height, plotLeft, plotRight, plotTop, plotBottom, zeroY, unit, ticks, columns, profitPath, isEmpty };
}

/** 只有資料端（上端）圓角 4px、基線端方角的長條 path。 */
export function roundedTopBarPath(b: Bar, radius = 4): string {
  const r = Math.max(0, Math.min(radius, b.width / 2, b.height));
  const { x, y, width: w, height: h } = b;
  return [
    `M${x} ${r2(y + h)}`,
    `L${x} ${r2(y + r)}`,
    `Q${x} ${y} ${r2(x + r)} ${y}`,
    `L${r2(x + w - r)} ${y}`,
    `Q${r2(x + w)} ${y} ${r2(x + w)} ${r2(y + r)}`,
    `L${r2(x + w)} ${r2(y + h)}`,
    "Z",
  ].join(" ");
}

/** 圖表的 aria-label：全年入帳／放款／毛利一句話。 */
export function trendSummary(points: ReadonlyArray<TrendInputPoint>, label: string): string {
  const sum = (pick: (p: TrendInputPoint) => number) => points.reduce((s, p) => s + pick(p), 0);
  return `${label}月趨勢：全年入帳收入 ${fmtMoney(sum((p) => p.revenue))} 元、放款支出 ${fmtMoney(sum((p) => p.expense))} 元、專案毛利 ${fmtMoney(sum((p) => p.grossProfit))} 元`;
}
