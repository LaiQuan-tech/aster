import { describe, it, expect } from "vitest";
import { companyOptions, defaultActiveCompanyId, isCompanyActive, type SelectableCompany } from "../company-options";
import { humanizeCompanyError, humanizeProjectExtError, SUBCONTRACT_ERRORS } from "../projects-ext-api";
import { DISBURSEMENT_ERRORS, humanizeDisbursementError } from "../disbursements-api";

// ⚠️ 公司名都是明顯的假值（repo 是公開的）。
const DEFAULT: SelectableCompany = { id: "c-default", name: "測試設計顧問公司", isDefault: true, isActive: true };
const SECOND: SelectableCompany = { id: "c-second", name: "測試工程公司", isDefault: false, isActive: true };
const OLD: SelectableCompany = { id: "c-old", name: "測試舊公司", isDefault: false, isActive: false };
const OLD_2: SelectableCompany = { id: "c-old-2", name: "測試舊公司乙", isDefault: false, isActive: false };

describe("isCompanyActive", () => {
  it("明確 false 才算停用；沒有這個欄位（舊版 API）一律當啟用", () => {
    expect(isCompanyActive({ isActive: true })).toBe(true);
    expect(isCompanyActive({ isActive: false })).toBe(false);
    expect(isCompanyActive({})).toBe(true);
  });
});

describe("companyOptions — 新表單只列啟用的公司", () => {
  const all = [DEFAULT, SECOND, OLD, OLD_2];

  it("沒有已選的公司：已停用的不出現，順序照名冊", () => {
    expect(companyOptions(all, null).map((o) => o.id)).toEqual(["c-default", "c-second"]);
    expect(companyOptions(all, undefined).map((o) => o.id)).toEqual(["c-default", "c-second"]);
    expect(companyOptions(all, "").map((o) => o.id)).toEqual(["c-default", "c-second"]);
  });

  it("已選的是啟用的公司：選項不變", () => {
    expect(companyOptions(all, "c-second").map((o) => o.id)).toEqual(["c-default", "c-second"]);
  });

  it("所有選項都帶 inactive 旗標；啟用的是 false", () => {
    expect(companyOptions(all, null).every((o) => o.inactive === false)).toBe(true);
  });
});

describe("companyOptions — 編輯舊單據時保留已選的停用公司", () => {
  const all = [DEFAULT, SECOND, OLD, OLD_2];

  it("已選的公司已停用：留在選項裡（原本的排序位置），標「（已停用）」；其他停用的公司仍不列", () => {
    const options = companyOptions(all, "c-old");
    expect(options.map((o) => o.id)).toEqual(["c-default", "c-second", "c-old"]);
    expect(options.find((o) => o.id === "c-old")).toEqual({ id: "c-old", label: "測試舊公司（已停用）", inactive: true });
    expect(options.some((o) => o.id === "c-old-2")).toBe(false);
  });

  it("停用的公司排在名冊中間，也維持在原位，不會被挪到最後", () => {
    const options = companyOptions([DEFAULT, OLD, SECOND], "c-old");
    expect(options.map((o) => o.id)).toEqual(["c-default", "c-old", "c-second"]);
  });

  it("已選的 id 不在名冊裡（例如名冊還沒載入完）：不憑空生出選項", () => {
    expect(companyOptions(all, "c-missing").map((o) => o.id)).toEqual(["c-default", "c-second"]);
    expect(companyOptions([], "c-old")).toEqual([]);
  });
});

describe("companyOptions — 標籤", () => {
  it("markDefault 才在預設公司後面加「（預設）」；沒開就只有公司名", () => {
    expect(companyOptions([DEFAULT, SECOND], null).map((o) => o.label)).toEqual(["測試設計顧問公司", "測試工程公司"]);
    expect(companyOptions([DEFAULT, SECOND], null, { markDefault: true }).map((o) => o.label)).toEqual([
      "測試設計顧問公司（預設）",
      "測試工程公司",
    ]);
  });

  it("停用的公司就算開了 markDefault 也只標「（已停用）」", () => {
    expect(companyOptions([DEFAULT, OLD], "c-old", { markDefault: true }).map((o) => o.label)).toEqual([
      "測試設計顧問公司（預設）",
      "測試舊公司（已停用）",
    ]);
  });

  it("沒有 isActive 欄位的公司（舊版 API）照常列出", () => {
    expect(companyOptions([{ id: "x", name: "測試甲公司" }], null).map((o) => o.label)).toEqual(["測試甲公司"]);
  });
});

describe("defaultActiveCompanyId — 新表單預設仍是預設公司", () => {
  it("啟用公司裡標預設的那間（不是清單第一間）", () => {
    expect(defaultActiveCompanyId([SECOND, DEFAULT, OLD])).toBe("c-default");
  });

  it("沒有標預設：取第一間「啟用的」，不會取到排在前面的停用公司", () => {
    expect(defaultActiveCompanyId([OLD, SECOND])).toBe("c-second");
  });

  it("停用的公司就算標了預設也不選（預設公司本來就不能停用，資料異常時不要選到它）", () => {
    expect(defaultActiveCompanyId([{ ...OLD, isDefault: true }, SECOND])).toBe("c-second");
  });

  it("沒有任何可選的公司回空字串", () => {
    expect(defaultActiveCompanyId([])).toBe("");
    expect(defaultActiveCompanyId([OLD, OLD_2])).toBe("");
  });
});

describe("錯誤訊息人性化（新增的錯誤碼）", () => {
  const apiError = (status: number, code: string) => new Error(`[${status}] ${code}`);

  it("公司主體名冊：預設不能停用／不能刪、使用中不能刪、找不到", () => {
    expect(humanizeCompanyError(apiError(400, "default_company_inactive"), "x")).toBe("預設公司不能停用，請先把預設改到其他公司。");
    expect(humanizeCompanyError(apiError(409, "company_is_default"), "x")).toBe("預設公司不能刪除，請先把預設改到其他公司。");
    expect(humanizeCompanyError(apiError(409, "company_in_use"), "x")).toBe("這間公司已被紀錄使用，無法刪除，可改為停用。");
    expect(humanizeCompanyError(apiError(404, "not_found"), "x")).toBe("找不到這間公司，可能已被刪除，請重新整理。");
    // 既有的訊息不受影響
    expect(humanizeCompanyError(apiError(400, "multiple_defaults"), "x")).toBe("預設主體只能勾一筆。");
    expect(humanizeCompanyError("不是 Error", "備用訊息")).toBe("備用訊息");
  });

  it("專案／放款／下包付款寫入被擋（company_inactive）都有中文訊息", () => {
    expect(humanizeProjectExtError(apiError(400, "company_inactive"), "x")).toBe("選到的承接公司已停用，請改選其他公司。");
    expect(humanizeDisbursementError(apiError(400, "company_inactive"), "x")).toBe(DISBURSEMENT_ERRORS.company_inactive);
    expect(SUBCONTRACT_ERRORS.company_inactive).toContain("已停用");
    // 先前的 invalid_company 仍是原本的訊息，沒被新的碼蓋掉
    expect(humanizeProjectExtError(apiError(400, "invalid_company"), "x")).toContain("不存在或不屬於本租戶");
  });
});
