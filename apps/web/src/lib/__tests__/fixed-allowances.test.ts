import { describe, expect, it } from "vitest";
import {
  buildFixedAllowanceBody,
  EMPTY_FIXED_ALLOWANCE_FORM,
  fixedAllowanceDisplayOf,
  insuredHintText,
  laborCostOf,
  midMonthHint,
  parseEmployerRatePct,
  parseMealTaxFree,
  parsePensionLevels,
  pensionRatePct,
  pensionWageHintText,
  staleNoticeText,
  TAX_TYPE_LABEL,
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
          { id: "a", name: "伙食津貼", amount: 3600, taxableAmount: 600, taxFreeAmount: 3000 },
          { id: "b", name: "職務加給", amount: 2000, taxableAmount: 2000, taxFreeAmount: 0 },
        ],
      }).map((l) => [l.name, l.taxNote]),
    ).toEqual([
      ["伙食津貼", "免稅 3,000＋應稅 600"],
      ["職務加給", "應稅"],
    ]);
    expect(fixedAllowanceDisplayOf({})).toEqual([]);
    expect(fixedAllowanceDisplayOf(null)).toEqual([]);
  });
  it("人事成本 = 應發 + 免稅津貼 + 雇主勞退；舊薪資單 = 應發", () => {
    expect(laborCostOf(43600, { fixedAllowancesTaxFree: 3000, employerPension: 2406 })).toBe(49006);
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

describe("第二輪：伙食費 3,000、月中提示、草稿過期、勞退參數", () => {
  it("課稅方式文案是 3,000（規則可調），不再出現 2,400", () => {
    expect(TAX_TYPE_LABEL.meal_exempt).toContain("3,000");
    expect(TAX_TYPE_LABEL.meal_exempt).not.toContain("2,400");
  });
  it("月中起訖 → 提示整月帶入；1 號起、月底止 → 不提示", () => {
    expect(midMonthHint({ effectiveFrom: "2030-03-16", effectiveTo: "" })).toContain("當月整月帶入");
    expect(midMonthHint({ effectiveFrom: "2030-03-01", effectiveTo: "2030-03-15" })).toContain("迄日 2030-03-15");
    expect(midMonthHint({ effectiveFrom: "2030-03-01", effectiveTo: "2030-03-31" })).toBeNull();
    expect(midMonthHint({ effectiveFrom: "2032-02-01", effectiveTo: "2032-02-29" })).toBeNull();
  });
  it("草稿過期提醒", () => {
    expect(staleNoticeText(["2030-03"])).toContain("2030-03 的草稿薪資單");
    expect(staleNoticeText([])).toBeNull();
  });
  it("伙食費免稅額、分級表解析", () => {
    expect(parseMealTaxFree("")).toEqual({ ok: true, value: null });
    expect(parseMealTaxFree("3000")).toEqual({ ok: true, value: 3000 });
    expect(parseMealTaxFree("12.5").ok).toBe(false);
    expect(parsePensionLevels("3000, 1500 1500，150000")).toEqual({ ok: true, levels: [1500, 3000, 150000] });
    expect(parsePensionLevels("1500, abc").ok).toBe(false);
  });
  it("勞退月提繳工資提示：留空＝自動值；不適用新制", () => {
    const p = { autoWage: 43900, levelsEffectiveFrom: "2026-01-01", manualWage: null, newSystem: true, nationality: null, nationalityHint: null };
    expect(pensionWageHintText(p, "")).toContain("43,900");
    expect(pensionWageHintText(p, "45800")).toContain("手填值");
    expect(pensionWageHintText({ ...p, newSystem: false }, "")).toContain("都為 0");
  });
});
