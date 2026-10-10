import { describe, it, expect } from "vitest";
import {
  OPTION_DELETED_MARK,
  OPTION_INACTIVE_MARK,
  humanizeOptionListError,
  optionChoices,
  optionLabel,
  type OptionItem,
} from "../option-lists-api";

// ⚠️ 名稱都是明顯的假值（repo 是公開的）。
const ARCH: OptionItem = { code: "architect", label: "建築師", sortOrder: 10, isActive: true };
const GOV: OptionItem = { code: "gov", label: "政府機關", sortOrder: 20, isActive: true };
const OLD: OptionItem = { code: "option_old", label: "舊分類", sortOrder: 30, isActive: false };
const OLD_2: OptionItem = { code: "option_old_2", label: "舊分類乙", sortOrder: 40, isActive: false };
const ALL = [ARCH, GOV, OLD, OLD_2];

describe("optionLabel — code 翻成名稱", () => {
  it("找得到回名稱；停用的項目照樣翻得出名稱（舊資料照常顯示原名稱）", () => {
    expect(optionLabel(ALL, "architect")).toBe("建築師");
    expect(optionLabel(ALL, "option_old")).toBe("舊分類");
  });

  it("找不到（例如項目被刪掉前留下的舊資料）回 code 本身", () => {
    expect(optionLabel(ALL, "legacy_code")).toBe("legacy_code");
    expect(optionLabel([], "architect")).toBe("architect");
  });

  it("沒有值（null／undefined／空字串）回空字串", () => {
    expect(optionLabel(ALL, null)).toBe("");
    expect(optionLabel(ALL, undefined)).toBe("");
    expect(optionLabel(ALL, "")).toBe("");
  });
});

describe("optionChoices — 新表單只列啟用的項目", () => {
  it("沒有已選的項目：已停用的不出現，順序照清單", () => {
    expect(optionChoices(ALL).map((c) => c.code)).toEqual(["architect", "gov"]);
    expect(optionChoices(ALL, null).map((c) => c.code)).toEqual(["architect", "gov"]);
    expect(optionChoices(ALL, undefined).map((c) => c.code)).toEqual(["architect", "gov"]);
    expect(optionChoices(ALL, "").map((c) => c.code)).toEqual(["architect", "gov"]);
  });

  it("已選的是啟用的項目：選項不變；所有選項都帶 inactive 旗標（啟用的是 false）", () => {
    expect(optionChoices(ALL, "gov").map((c) => c.code)).toEqual(["architect", "gov"]);
    expect(optionChoices(ALL, "gov").every((c) => c.inactive === false)).toBe(true);
    expect(optionChoices(ALL)[0]).toEqual({ code: "architect", label: "建築師", inactive: false });
  });
});

describe("optionChoices — 編輯舊資料時保留已選的停用項", () => {
  it("已選的項目已停用：留在選項裡（原本的排序位置），標「（已停用）」；其他停用的仍不列", () => {
    const choices = optionChoices(ALL, "option_old");

    expect(choices.map((c) => c.code)).toEqual(["architect", "gov", "option_old"]);
    expect(choices.find((c) => c.code === "option_old")).toEqual({
      code: "option_old",
      label: `舊分類${OPTION_INACTIVE_MARK}`,
      inactive: true,
    });
    expect(OPTION_INACTIVE_MARK).toBe("（已停用）");
    expect(choices.some((c) => c.code === "option_old_2")).toBe(false);
  });

  it("停用的項目排在清單中間，也維持在原位，不會被挪到最後", () => {
    expect(optionChoices([ARCH, OLD, GOV], "option_old").map((c) => c.code)).toEqual(["architect", "option_old", "gov"]);
  });

  it("清單已載入、但已選的 code 不在清單裡（舊值）：補一個「code（已刪除）」，畫面如實顯示目前存的值", () => {
    const choices = optionChoices(ALL, "legacy_code");

    expect(choices.map((c) => c.code)).toEqual(["architect", "gov", "legacy_code"]);
    expect(choices[2]).toEqual({ code: "legacy_code", label: `legacy_code${OPTION_DELETED_MARK}`, inactive: true });
  });

  it("清單還沒載入（空）：不補，免得載入中閃過原始代碼；也不會當掉", () => {
    expect(optionChoices([], "architect")).toEqual([]);
    expect(optionChoices([], null)).toEqual([]);
  });

  it("沒有 isActive 欄位（舊版回應）一律當啟用", () => {
    const legacy = [{ code: "x", label: "甲", sortOrder: 1 }] as unknown as OptionItem[];
    expect(optionChoices(legacy).map((c) => c.code)).toEqual(["x"]);
  });
});

describe("humanizeOptionListError — API 錯誤碼 → 中文", () => {
  it("label_taken／too_many_items／forbidden／not_found／list_not_found 各自的說明；list_not_found 不會被 not_found 吃掉", () => {
    expect(humanizeOptionListError(new Error("[409] label_taken"), "x")).toBe("名稱重複，請改一下再存。");
    expect(humanizeOptionListError(new Error("[400] too_many_items"), "x")).toContain("最多 200 項");
    expect(humanizeOptionListError(new Error("[403] forbidden"), "x")).toBe("你沒有管理這份清單的權限。");
    expect(humanizeOptionListError(new Error("[404] not_found"), "x")).toContain("找不到這個選項");
    expect(humanizeOptionListError(new Error("[404] list_not_found"), "x")).toContain("找不到這份清單");
    expect(humanizeOptionListError(new Error("[400] duplicate_item"), "x")).toContain("出現了兩次");
  });

  it("option_in_use：有筆數就帶筆數，沒有就不帶；一律提示可改為停用", () => {
    const withCount = Object.assign(new Error("[409] option_in_use"), { body: { error: "option_in_use", usage: 3 } });
    expect(humanizeOptionListError(withCount, "x")).toBe("這個選項已被 3 筆資料使用，無法刪除，可改為停用。");
    expect(humanizeOptionListError(new Error("[409] option_in_use"), "x")).toBe("這個選項已被資料使用，無法刪除，可改為停用。");
  });

  it("不認得的錯誤原樣回；不是 Error 用 fallback", () => {
    expect(humanizeOptionListError(new Error("[500] internal_server_error"), "x")).toBe("[500] internal_server_error");
    expect(humanizeOptionListError("boom", "儲存失敗")).toBe("儲存失敗");
  });
});
