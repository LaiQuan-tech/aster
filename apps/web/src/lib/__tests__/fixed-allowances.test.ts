import { describe, expect, it } from "vitest";
import {
  buildFixedAllowanceBody,
  EMPTY_FIXED_ALLOWANCE_FORM,
  fixedAllowanceDisplayOf,
  insuredHintText,
  laborCostOf,
  parseEmployerRatePct,
  pensionRatePct,
} from "../fixed-allowances-api";

// 固定津貼／雇主勞退（2026-11-08）前端純函式。⚠️ 金額、名稱都是假資料。

const form = (over = {}) => ({ ...EMPTY_FIXED_ALLOWANCE_FORM, name: "職務加給", amount: "3000", effectiveFrom: "2030-03-01", ...over });

describe("buildFixedAllowanceBody", () => {
  it("合法表單 → body（迄日空白＝null、備註空白＝null）", () => {
    expect(buildFixedAllowanceBody(form())).toEqual({
      ok: true,
      body: { name: "職務加給", amount: 3000, insurable: true, taxType: "taxable", effectiveFrom: "2030-03-01", effectiveTo: null, note: null },
    });
  });
  it("金額要 0 以上整數；名稱必填；迄日不可早於起日", () => {
    expect(buildFixedAllowanceBody(form({ amount: "12.5" })).ok).toBe(false);
    expect(buildFixedAllowanceBody(form({ amount: "-1" })).ok).toBe(false);
    expect(buildFixedAllowanceBody(form({ amount: "0" })).ok).toBe(true);
    expect(buildFixedAllowanceBody(form({ name: "  " })).ok).toBe(false);
    expect(buildFixedAllowanceBody(form({ effectiveTo: "2030-02-28" })).ok).toBe(false);
    expect(buildFixedAllowanceBody(form({ effectiveFrom: "" })).ok).toBe(false);
  });
});

describe("insuredHintText", () => {
  it("合計高於勞保級距 → 提醒不會自動調整", () => {
    expect(insuredHintText("40000", "40100", 3000)).toContain("高於目前勞保投保級距 40,100");
    expect(insuredHintText("40000", "40100", 3000)).toContain("43,000");
  });
  it("未超過 / 沒有計入投保的津貼 / 沒設級距", () => {
    expect(insuredHintText("30000", "40100", 3000)).toContain("未超過");
    expect(insuredHintText("40000", "40100", 0)).toBeNull();
    expect(insuredHintText("40000", "", 3000)).toContain("尚未設定勞保投保級距");
  });
});

describe("薪資單顯示", () => {
  it("固定津貼明細：伙食費拆免稅／應稅；舊薪資單沒有欄位 → 空", () => {
    expect(
      fixedAllowanceDisplayOf({
        fixedAllowances: [
          { id: "a", name: "伙食津貼", amount: 3000, taxableAmount: 600, taxFreeAmount: 2400 },
          { id: "b", name: "職務加給", amount: 2000, taxableAmount: 2000, taxFreeAmount: 0 },
        ],
      }).map((l) => [l.name, l.taxNote]),
    ).toEqual([
      ["伙食津貼", "免稅 2,400＋應稅 600"],
      ["職務加給", "應稅"],
    ]);
    expect(fixedAllowanceDisplayOf({})).toEqual([]);
    expect(fixedAllowanceDisplayOf(null)).toEqual([]);
  });
  it("人事成本 = 應發 + 免稅津貼 + 雇主勞退；舊薪資單 = 應發", () => {
    expect(laborCostOf(43600, { fixedAllowancesTaxFree: 2400, employerPension: 2406 })).toBe(48406);
    expect(laborCostOf(40000, {})).toBe(40000);
  });
  it("提撥率顯示", () => {
    expect(pensionRatePct(0.06)).toBe("6%");
    expect(pensionRatePct(0.075)).toBe("7.5%");
    expect(pensionRatePct(undefined)).toBe("—");
  });
});

describe("parseEmployerRatePct", () => {
  it("6–100 合法；空白＝預設；低於 6 或高於 100 擋", () => {
    expect(parseEmployerRatePct("6")).toEqual({ ok: true, rate: 0.06 });
    expect(parseEmployerRatePct("7.5")).toEqual({ ok: true, rate: 0.075 });
    expect(parseEmployerRatePct("100")).toEqual({ ok: true, rate: 1 });
    expect(parseEmployerRatePct("")).toEqual({ ok: true, rate: null });
    expect(parseEmployerRatePct("5.9").ok).toBe(false);
    expect(parseEmployerRatePct("101").ok).toBe(false);
    expect(parseEmployerRatePct("abc").ok).toBe(false);
  });
});
