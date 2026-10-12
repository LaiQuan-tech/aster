import { afterEach, describe, it, expect, vi } from "vitest";
import { accountErrorMessage, accountsFeatureOf, changeMyPassword } from "../auth-api";

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
  it("weak_password：指引到設定 → 進階功能 → 帳號安全，不再露出原始碼；文案同時適用新增帳號與設定密碼", () => {
    const text = accountErrorMessage(new Error("[422] weak_password"));
    expect(text).toContain("外洩名單");
    expect(text).toContain("設定 → 進階功能 → 帳號安全");
    expect(text).not.toContain("[422]");
    expect(text).not.toContain("weak_password");
    // 後台「設定密碼」現在也走同一個開關，不能再叫 HR「改用暫時密碼」或說「僅適用於新增」
    expect(text).not.toContain("僅適用於新增");
    expect(text).not.toContain("暫時密碼");
  });

  it("set_password_failed（設定密碼時帳號已消失）→ 中文說明", () => {
    expect(accountErrorMessage(new Error("[500] set_password_failed"))).toContain("找不到該員工的登入帳號");
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

/**
 * ESS「修改密碼」：POST /me/password 遇弱密碼／外洩回 422 password_rejected＋reasons（apiFetch 把整包 JSON 掛在
 * err.body）。員工看到的是依 reasons 挑的中文，不是「[500] internal_server_error」，也不是 HR 那句
 * 「請到設定 → 進階功能 → 帳號安全開啟」（員工自己改密碼沒有那個開關）。
 */
describe("accountErrorMessage — 員工改密碼被擋（password_rejected＋reasons）", () => {
  /** 仿 apiFetch 丟出的錯誤：message 是 `[status] code`，code／status／body 掛在物件上。 */
  function apiError(status: number, code: string, body: Record<string, unknown> = {}) {
    return Object.assign(new Error(`[${status}] ${code}`), { status, code, body: { error: code, ...body } });
  }

  it("reasons 含 pwned → 太常見或曾外洩", () => {
    const text = accountErrorMessage(apiError(422, "password_rejected", { reasons: ["pwned"] }), "修改密碼失敗");
    expect(text).toBe("這組密碼太常見或曾外洩，請換一組");
  });

  it("reasons 是 length → 太短；characters → 強度不足", () => {
    expect(accountErrorMessage(apiError(422, "password_rejected", { reasons: ["length"] }))).toBe("密碼太短，請換一組更長的密碼");
    expect(accountErrorMessage(apiError(422, "password_rejected", { reasons: ["characters"] }))).toBe(
      "密碼強度不足，請混用英文大小寫、數字或符號",
    );
  });

  it("多個 reasons：pwned 優先；length 其次", () => {
    expect(accountErrorMessage(apiError(422, "password_rejected", { reasons: ["length", "characters", "pwned"] }))).toBe(
      "這組密碼太常見或曾外洩，請換一組",
    );
    expect(accountErrorMessage(apiError(422, "password_rejected", { reasons: ["characters", "length"] }))).toBe(
      "密碼太短，請換一組更長的密碼",
    );
  });

  it("沒有 reasons／空陣列／body 不是物件 → 通用句", () => {
    const generic = "這組密碼太弱或曾外洩，請換一組";
    expect(accountErrorMessage(apiError(422, "password_rejected"))).toBe(generic);
    expect(accountErrorMessage(apiError(422, "password_rejected", { reasons: [] }))).toBe(generic);
    expect(accountErrorMessage(Object.assign(new Error("[422] password_rejected"), { body: null }))).toBe(generic);
    expect(accountErrorMessage(Object.assign(new Error("[422] password_rejected"), { body: "oops" }))).toBe(generic);
    // 只有訊息、沒有 code／body 的 Error 也認得
    expect(accountErrorMessage(new Error("[422] password_rejected"))).toBe(generic);
  });

  it("文案是中文，不露出錯誤碼、HR 指引或 500", () => {
    for (const reasons of [["pwned"], ["length"], ["characters"], []]) {
      const text = accountErrorMessage(apiError(422, "password_rejected", { reasons }), "修改密碼失敗");
      expect(text).toMatch(/[\u4e00-\u9fff]/);
      expect(text).not.toContain("password_rejected");
      expect(text).not.toContain("[422]");
      expect(text).not.toContain("internal_server_error");
      expect(text).not.toContain("設定 → 進階功能 → 帳號安全");
    }
  });

  it("新錯誤碼不含 weak_password：HR 的 weak_password 文案不會誤套到員工改密碼", () => {
    expect("password_rejected").not.toContain("weak_password");
    // 反過來，HR 那條路（新增帳號／後台設定密碼）的文案不變
    expect(accountErrorMessage(apiError(422, "weak_password", { hint: "allow_weak_initial_password" }))).toContain(
      "設定 → 進階功能 → 帳號安全",
    );
  });

  it("reasons 含 too_long（新密碼超過 72 bytes）→ 密碼太長，請改短一點；不露出 too_long 或錯誤碼", () => {
    const text = accountErrorMessage(apiError(422, "password_rejected", { reasons: ["too_long"] }), "修改密碼失敗");
    expect(text).toBe("密碼太長，請改短一點（最多 72 個位元組，中文約 24 字）");
    expect(text).not.toContain("too_long");
    expect(text).not.toContain("password_rejected");
  });

  it("同一支修改密碼 API 的其他錯誤文案不變", () => {
    expect(accountErrorMessage(apiError(401, "invalid_current_password"))).toBe("目前密碼不正確");
    expect(accountErrorMessage(apiError(400, "same_password"))).toBe("新密碼不可與目前密碼相同");
    expect(accountErrorMessage(apiError(500, "internal_server_error"), "修改密碼失敗")).toBe("[500] internal_server_error");
  });
});

/**
 * 串起來驗一次：真的 apiFetch（只把全域 fetch 換成假的）→ changeMyPassword 丟出的錯誤 → accountErrorMessage。
 * 確認 API 回應 body 的 reasons 一路留在錯誤物件上，ESS 修改密碼畫面拿得到。
 */
describe("changeMyPassword → accountErrorMessage（走真的 apiFetch，fetch 換成假的）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function caught(): Promise<unknown> {
    try {
      await changeMyPassword("old-pass-1234", "new-pass-5678");
    } catch (err) {
      return err;
    }
    throw new Error("changeMyPassword 應該要丟錯");
  }

  it("422 password_rejected＋reasons=['pwned'] → 畫面顯示中文，不是 [422] password_rejected", async () => {
    const fetchMock = stubFetch(422, { error: "password_rejected", message: "這組密碼太弱或曾外洩，請換一組", reasons: ["pwned"] });
    const err = await caught();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/me/password");
    expect((err as Error).message).toBe("[422] password_rejected");
    expect(accountErrorMessage(err, "修改密碼失敗")).toBe("這組密碼太常見或曾外洩，請換一組");
  });

  it("422 password_rejected＋reasons=['length'] → 太短", async () => {
    stubFetch(422, { error: "password_rejected", message: "x", reasons: ["length"] });
    expect(accountErrorMessage(await caught(), "修改密碼失敗")).toBe("密碼太短，請換一組更長的密碼");
  });

  it("422 password_rejected 沒帶 reasons → 通用句", async () => {
    stubFetch(422, { error: "password_rejected", message: "x" });
    expect(accountErrorMessage(await caught(), "修改密碼失敗")).toBe("這組密碼太弱或曾外洩，請換一組");
  });

  it("422 password_rejected＋reasons=['too_long']（API 擋下超過 72 bytes 的新密碼）→ 密碼太長", async () => {
    stubFetch(422, { error: "password_rejected", message: "密碼太長，請改短一點（最多 72 個位元組，中文約 24 字）", reasons: ["too_long"] });
    const err = await caught();
    expect((err as Error).message).toBe("[422] password_rejected");
    expect(accountErrorMessage(err, "修改密碼失敗")).toBe("密碼太長，請改短一點（最多 72 個位元組，中文約 24 字）");
  });

  it("401 invalid_current_password 仍是原本的文案", async () => {
    stubFetch(401, { error: "invalid_current_password", message: "目前密碼不正確" });
    expect(accountErrorMessage(await caught(), "修改密碼失敗")).toBe("目前密碼不正確");
  });
});
