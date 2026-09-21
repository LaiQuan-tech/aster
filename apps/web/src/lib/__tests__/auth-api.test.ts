import { describe, it, expect } from "vitest";
import { accountErrorMessage, accountsFeatureOf } from "../auth-api";

/**
 * lib/auth-api.ts 的純函式：
 *   - accountsFeatureOf：tenants.features.accounts（帳號安全）的讀法，只認 boolean。
 *   - accountErrorMessage：apiFetch 的 `[status] code` 訊息 → HR 看得懂的中文；
 *     weak_password 要指引到「設定 → 進階功能 → 帳號安全」。
 */
describe("accountsFeatureOf（tenants.features.accounts 讀法）", () => {
  it("沒有／null／不是物件／陣列 → {}", () => {
    expect(accountsFeatureOf(undefined)).toEqual({});
    expect(accountsFeatureOf(null)).toEqual({});
    expect(accountsFeatureOf({})).toEqual({});
    expect(accountsFeatureOf({ accounts: null })).toEqual({});
    expect(accountsFeatureOf({ accounts: "true" })).toEqual({});
    expect(accountsFeatureOf({ accounts: [true] })).toEqual({});
  });

  it("只收 boolean 的 allowWeakInitialPassword；字串／數字忽略、不認得的鍵不帶出", () => {
    expect(accountsFeatureOf({ accounts: { allowWeakInitialPassword: true } })).toEqual({ allowWeakInitialPassword: true });
    expect(accountsFeatureOf({ accounts: { allowWeakInitialPassword: false } })).toEqual({ allowWeakInitialPassword: false });
    expect(accountsFeatureOf({ accounts: { allowWeakInitialPassword: "true" } })).toEqual({});
    expect(accountsFeatureOf({ accounts: { allowWeakInitialPassword: 1, other: true } })).toEqual({});
  });

  it("其他 features 鍵（adminModules 等）不影響", () => {
    expect(accountsFeatureOf({ adminModules: { kpi: true }, accounts: { allowWeakInitialPassword: true } })).toEqual({
      allowWeakInitialPassword: true,
    });
  });
});

describe("accountErrorMessage（API 錯誤碼 → 中文）", () => {
  it("weak_password：指引到設定 → 進階功能 → 帳號安全，不再露出原始碼", () => {
    const text = accountErrorMessage(new Error("[422] weak_password"));
    expect(text).toContain("弱密碼防護");
    expect(text).toContain("設定 → 進階功能 → 帳號安全");
    expect(text).not.toContain("[422]");
    expect(text).not.toContain("weak_password");
  });

  it("email_exists／no_account 等既有碼照表翻譯", () => {
    expect(accountErrorMessage(new Error("[409] email_exists"))).toBe("此 Email 已有登入帳號");
    expect(accountErrorMessage(new Error("[409] no_account"))).toBe("此員工尚未綁定登入帳號，請改用「寄邀請信」");
    expect(accountErrorMessage(new Error("[404] not_found"))).toBe("找不到這位員工");
  });

  it("不認得的訊息原樣回；非 Error 或空訊息回 fallback", () => {
    expect(accountErrorMessage(new Error("[500] Internal Server Error"))).toBe("[500] Internal Server Error");
    expect(accountErrorMessage("boom", "操作失敗")).toBe("操作失敗");
    expect(accountErrorMessage(new Error(""), "自訂 fallback")).toBe("自訂 fallback");
  });
});
