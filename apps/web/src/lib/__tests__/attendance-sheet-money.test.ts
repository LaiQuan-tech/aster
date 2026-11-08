import { describe, expect, it } from "vitest";
import { sheetMoneySections } from "../attendance-sheet-money";
import type { SheetMoney } from "../attendance-sheets-api";

// 出勤月表薪資試算卡（2026-11-08）：補貼欄標題、免稅津貼列，應發 − 應扣 ＋ 免稅 ＝ 實發。假資料。
const base: SheetMoney = {
  base: 40000, hourlyWage: 166.6667, otPay: 0, otPayByTier: { tier1: 0, tier2: 0, tier3: 0 }, nightPay: 0, attendanceBonus: 0,
  allowances: 3000, leaveDeduction: 0, lateEarlyDeduction: 0, laborInsurance: 1003, healthInsurance: 622, pensionVoluntary: 0,
  advance: 0, gross: 43000, totalDeductions: 1625, expenses: 0, net: 44375, netPlusExpenses: 44375, fixedAllowancesTaxFree: 3000,
};
const T: [string, string, string] = ["≤2h", "3-8h", "9-12h"];
const value = (sections: ReturnType<typeof sheetMoneySections>, label: string) =>
  sections.flatMap((s) => s.rows).find(([l]) => l === label)?.[1];

describe("sheetMoneySections", () => {
  it("補貼欄標題＝定額補貼＋固定津貼（應稅）；實發段有免稅津貼列，應發−應扣＋免稅＝實發", () => {
    const s = sheetMoneySections(base, T);
    expect(value(s, "定額補貼＋固定津貼（應稅）")).toBe(3000);
    expect(value(s, "定額補貼")).toBeUndefined();
    const taxFree = value(s, "免稅津貼（不計應發）")!;
    expect(taxFree).toBe(3000);
    expect(value(s, "應發合計")! - value(s, "應扣合計")! + taxFree).toBe(value(s, "實發金額"));
  });
  it("沒有免稅津貼（含舊快照沒有這欄）→ 不多一列", () => {
    const { fixedAllowancesTaxFree: _omit, ...legacy } = base;
    const s = sheetMoneySections({ ...legacy, net: 41375, netPlusExpenses: 41375 }, T);
    expect(s[2]!.rows.map(([l]) => l)).toEqual(["實發金額", "代墊支出（不計薪資所得）", "薪資＋代墊"]);
  });
});
