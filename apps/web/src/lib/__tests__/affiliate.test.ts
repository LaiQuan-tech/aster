import { describe, it, expect } from "vitest";
import { AFFILIATE_HR_ONLY_TEXT, affiliateInputField, humanizeAffiliateError } from "../affiliate";

describe("關係企業欄位（客戶／廠商表單）", () => {
  it("affiliateInputField：只在旗標有變動時才送；新增＝勾了才送", () => {
    // 新增（沒有原本的列）
    expect(affiliateInputField(false, null)).toEqual({});
    expect(affiliateInputField(true, null)).toEqual({ isAffiliate: true });
    // 編輯：沒變不送，變了才送
    expect(affiliateInputField(false, { isAffiliate: false })).toEqual({});
    expect(affiliateInputField(true, { isAffiliate: true })).toEqual({});
    expect(affiliateInputField(true, { isAffiliate: false })).toEqual({ isAffiliate: true });
    expect(affiliateInputField(false, { isAffiliate: true })).toEqual({ isAffiliate: false });
    // 舊 API 回應沒有這個鍵 → 當作 false
    expect(affiliateInputField(false, {})).toEqual({});
    expect(affiliateInputField(true, {})).toEqual({ isAffiliate: true });
  });

  it("humanizeAffiliateError：認得 affiliate_hr_only（含 apiFetch 的 [403] 前綴）就換成中文，其餘原樣", () => {
    expect(humanizeAffiliateError("[403] affiliate_hr_only")).toBe(AFFILIATE_HR_ONLY_TEXT);
    expect(humanizeAffiliateError("affiliate_hr_only")).toBe(AFFILIATE_HR_ONLY_TEXT);
    expect(humanizeAffiliateError("[409] tax_id_taken")).toBe("[409] tax_id_taken");
    expect(humanizeAffiliateError("儲存失敗")).toBe("儲存失敗");
    expect(AFFILIATE_HR_ONLY_TEXT).toBe("只有 HR 管理員可以設定「關係企業」標記。");
  });
});
