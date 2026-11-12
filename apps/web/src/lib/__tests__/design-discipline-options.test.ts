import { describe, expect, it } from "vitest";
import { validateOptionRows } from "../option-lists-edit";
import { DEFAULT_DESIGN_DISCIPLINES, canOfferAddDiscipline, designDisciplineSuggestions } from "../design-discipline-options";
import type { OptionItem } from "../option-lists-api";

// ⚠️ 名稱都是明顯的假值（repo 是公開的）。
const item = (code: string, label: string, isActive = true, sortOrder = 10): OptionItem => ({ code, label, sortOrder, isActive });
const LIST = [item("electrical", "電機"), item("fees", "規費"), item("bim", "BIM"), item("old", "舊科別", false)];

describe("designDisciplineSuggestions", () => {
  it("預設值含規費（清單還沒載入時用）", () => {
    expect(DEFAULT_DESIGN_DISCIPLINES).toEqual(["電機", "空調", "消防", "汙水", "規費"]);
    expect(designDisciplineSuggestions([])).toEqual(["電機", "空調", "消防", "汙水", "規費"]);
  });
  it("只列啟用的，順序照清單", () => {
    expect(designDisciplineSuggestions(LIST)).toEqual(["電機", "規費", "BIM"]);
  });
});

describe("canOfferAddDiscipline — 何時顯示「加入常用選項」", () => {
  it("清單裡沒有（去空白、大小寫／全半形不分；停用的也算有）才顯示", () => {
    expect(canOfferAddDiscipline("弱電", LIST)).toBe(true);
    expect(canOfferAddDiscipline(" 規費 ", LIST)).toBe(false);
    expect(canOfferAddDiscipline("bim", LIST)).toBe(false);
    expect(canOfferAddDiscipline("ＢＩＭ", LIST)).toBe(false);
    expect(canOfferAddDiscipline("舊科別", LIST)).toBe(false);
  });
  it("空值、超過 20 字、清單未載入不顯示", () => {
    expect(canOfferAddDiscipline("  ", LIST)).toBe(false);
    expect(canOfferAddDiscipline("字".repeat(21), LIST)).toBe(false);
    expect(canOfferAddDiscipline("弱電", [])).toBe(false);
  });
});

describe("validateOptionRows — 清單自訂上限（設定頁）", () => {
  const row = (label: string, code?: string) => ({ key: code ?? label, code, label, isActive: true, usage: 0 });
  it("名稱超過 labelMax、項目超過 maxItems 都擋", () => {
    expect(validateOptionRows([row("字".repeat(21))], 20)).toContain("超過 20 字");
    expect(validateOptionRows([row("字".repeat(21))])).toBeNull();
    expect(validateOptionRows([row("甲"), row("乙"), row("丙")], 20, 2)).toContain("最多 2 項");
    expect(validateOptionRows([row("甲"), row("乙")], 20, 2)).toBeNull();
  });
});
