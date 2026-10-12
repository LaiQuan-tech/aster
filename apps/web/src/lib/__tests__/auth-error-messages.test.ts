import { describe, it, expect } from "vitest";
import {
  AuthApiError,
  AuthInvalidCredentialsError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import {
  LOGIN_EMAIL_REQUIRED_MESSAGE,
  LOGIN_PASSWORD_REQUIRED_MESSAGE,
  authErrorMessage,
  classifyAuthError,
  looksLikeEmail,
  validateLoginInput,
  weakPasswordMessage,
} from "../auth-error-messages";

/**
 * lib/auth-error-messages.ts（純函式）：
 *   - weakPasswordMessage：GoTrue 的 reasons（length｜characters｜pwned）→ 中文，含 pwned 最優先
 *   - classifyAuthError／authErrorMessage：登入頁（sign-in）與首次設定密碼頁（set-password）的 Supabase Auth 錯誤 → 中文，
 *     依 code → name → status 判斷，message 只當後備；任何情況都不能把英文原文整句丟給使用者
 *   - looksLikeEmail／validateLoginInput：登入頁送出前的輸入檢查（不像 Email 就不呼叫 Supabase）
 */

const GOTRUE_PWNED = "Password is known to be weak and easy to guess, please choose a different one.";
const GOTRUE_SHORT = "Password should be at least 8 characters.";

/** 有一整句英文（兩個以上的英文單字連在一起）＝把原文丟給使用者了。 */
const ENGLISH_SENTENCE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;

describe("weakPasswordMessage（reasons → 中文）", () => {
  it("含 pwned → 太常見或曾外洩", () => {
    expect(weakPasswordMessage(["pwned"])).toBe("這組密碼太常見或曾外洩，請換一組");
  });

  it("length → 太短", () => {
    expect(weakPasswordMessage(["length"])).toBe("密碼太短，請換一組更長的密碼");
  });

  it("characters → 強度不足", () => {
    expect(weakPasswordMessage(["characters"])).toBe("密碼強度不足，請混用英文大小寫、數字或符號");
  });

  it("多個 reasons：pwned 優先，其次 length，再來 characters", () => {
    expect(weakPasswordMessage(["length", "pwned"])).toBe("這組密碼太常見或曾外洩，請換一組");
    expect(weakPasswordMessage(["characters", "length", "pwned"])).toBe("這組密碼太常見或曾外洩，請換一組");
    expect(weakPasswordMessage(["characters", "length"])).toBe("密碼太短，請換一組更長的密碼");
  });

  it("沒有 reasons／空陣列／不認得的 reasons／形狀怪異 → 通用句", () => {
    const generic = "這組密碼太弱或曾外洩，請換一組";
    expect(weakPasswordMessage()).toBe(generic);
    expect(weakPasswordMessage(undefined)).toBe(generic);
    expect(weakPasswordMessage(null)).toBe(generic);
    expect(weakPasswordMessage([])).toBe(generic);
    expect(weakPasswordMessage(["something_new"])).toBe(generic);
    expect(weakPasswordMessage("pwned")).toBe(generic);
    expect(weakPasswordMessage([1, null, { x: 1 }])).toBe(generic);
  });
});

describe("authErrorMessage — 首次設定密碼頁（set-password）", () => {
  it("AuthWeakPasswordError 依 reasons 顯示中文", () => {
    expect(authErrorMessage(new AuthWeakPasswordError(GOTRUE_PWNED, 422, ["pwned"]), "set-password")).toBe(
      "這組密碼太常見或曾外洩，請換一組",
    );
    expect(authErrorMessage(new AuthWeakPasswordError(GOTRUE_SHORT, 422, ["length"]), "set-password")).toBe(
      "密碼太短，請換一組更長的密碼",
    );
    expect(
      authErrorMessage(new AuthWeakPasswordError("Password should contain at least one character of each: abc.", 422, ["characters"]), "set-password"),
    ).toBe("密碼強度不足，請混用英文大小寫、數字或符號");
    expect(authErrorMessage(new AuthWeakPasswordError(GOTRUE_PWNED, 422, []), "set-password")).toBe("這組密碼太弱或曾外洩，請換一組");
  });

  it("只有 code／status 的 plain object（沒有 name、沒有 message）也認得弱密碼", () => {
    expect(authErrorMessage({ code: "weak_password", status: 422 }, "set-password")).toBe("這組密碼太弱或曾外洩，請換一組");
    expect(authErrorMessage({ code: "weak_password", status: 422, reasons: ["pwned"] }, "set-password")).toBe(
      "這組密碼太常見或曾外洩，請換一組",
    );
  });

  it("只有 name 的序列化錯誤也認得；沒有 code 的舊版 GoTrue 靠 name 判斷", () => {
    expect(authErrorMessage({ name: "AuthWeakPasswordError", status: 422, reasons: ["length"] }, "set-password")).toBe(
      "密碼太短，請換一組更長的密碼",
    );
  });

  it("same_password（code）→ 新密碼不能和舊密碼相同", () => {
    const err = new AuthApiError("New password should be different from the old password.", 422, "same_password");
    expect(authErrorMessage(err, "set-password")).toBe("新密碼不能和舊密碼相同");
    expect(authErrorMessage({ code: "same_password" }, "set-password")).toBe("新密碼不能和舊密碼相同");
  });

  it("same_password 沒有 code 的舊版 GoTrue：message 後備", () => {
    expect(authErrorMessage(new Error("New password should be different from the old password."), "set-password")).toBe(
      "新密碼不能和舊密碼相同",
    );
  });

  it("連結／session 失效 → 設定連結已失效，請重新索取", () => {
    const expired = "設定連結已失效，請重新索取";
    expect(authErrorMessage(new AuthSessionMissingError(), "set-password")).toBe(expired);
    expect(authErrorMessage(new AuthApiError("invalid JWT: token is expired", 401, "bad_jwt"), "set-password")).toBe(expired);
    expect(authErrorMessage(new AuthApiError("Token has expired or is invalid", 403, "otp_expired"), "set-password")).toBe(expired);
    expect(authErrorMessage(new AuthApiError("Session from session_id claim in JWT does not exist", 403, "session_not_found"), "set-password")).toBe(expired);
    // 只有 status 401、沒有 code
    expect(authErrorMessage({ status: 401, message: "unauthorized" }, "set-password")).toBe(expired);
    // message 後備
    expect(authErrorMessage(new Error("Auth session missing!"), "set-password")).toBe(expired);
    expect(authErrorMessage(new Error("Email link is invalid or has expired"), "set-password")).toBe(expired);
  });

  it("rate limit（code／status／message）→ 嘗試太多次，請稍後再試", () => {
    const limited = "嘗試太多次，請稍後再試";
    expect(authErrorMessage(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"), "set-password")).toBe(limited);
    expect(authErrorMessage(new AuthApiError("Email rate limit exceeded", 429, "over_email_send_rate_limit"), "set-password")).toBe(limited);
    expect(authErrorMessage({ status: 429 }, "set-password")).toBe(limited);
    expect(authErrorMessage(new Error("For security purposes, you can only request this after 49 seconds."), "set-password")).toBe(limited);
  });

  it("網路錯誤 → 連線失敗，請檢查網路後再試", () => {
    const offline = "連線失敗，請檢查網路後再試";
    expect(authErrorMessage(new AuthRetryableFetchError("Failed to fetch", 0), "set-password")).toBe(offline);
    expect(authErrorMessage(new TypeError("Failed to fetch"), "set-password")).toBe(offline);
    expect(authErrorMessage(new TypeError("Load failed"), "set-password")).toBe(offline); // Safari
    expect(authErrorMessage(new TypeError("NetworkError when attempting to fetch resource."), "set-password")).toBe(offline); // Firefox
    expect(authErrorMessage("Failed to fetch", "set-password")).toBe(offline);
  });

  it("不認得的錯誤 → 通用中文＋錯誤代碼，不露英文原文", () => {
    const text = authErrorMessage(new AuthApiError("Database error updating user", 500, "unexpected_failure"), "set-password");
    expect(text).toBe("設定密碼失敗，請稍後再試（錯誤代碼：unexpected_failure）");
    expect(text).not.toContain("Database");
    // 沒有 code → 不附代碼
    expect(authErrorMessage(new Error("something odd happened"), "set-password")).toBe("設定密碼失敗，請稍後再試");
  });

  it("Supabase 暫時故障（AuthRetryableFetchError 5xx）不說成網路問題", () => {
    expect(authErrorMessage(new AuthRetryableFetchError("Service Unavailable", 503), "set-password")).toBe("設定密碼失敗，請稍後再試");
  });
});

describe("authErrorMessage — 登入頁（sign-in）", () => {
  it("invalid_credentials → Email 或密碼錯誤", () => {
    expect(authErrorMessage(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"), "sign-in")).toBe("Email 或密碼錯誤");
    expect(authErrorMessage({ code: "invalid_credentials", status: 400 }, "sign-in")).toBe("Email 或密碼錯誤");
    expect(authErrorMessage(new AuthInvalidCredentialsError("Email or password is incorrect"), "sign-in")).toBe("Email 或密碼錯誤");
    // 沒有 code 的舊版 GoTrue：message 後備
    expect(authErrorMessage(new Error("Invalid login credentials"), "sign-in")).toBe("Email 或密碼錯誤");
  });

  it("email_not_confirmed → 帳號尚未啟用，請先到信箱完成設定", () => {
    expect(authErrorMessage(new AuthApiError("Email not confirmed", 400, "email_not_confirmed"), "sign-in")).toBe(
      "帳號尚未啟用，請先到信箱完成設定",
    );
    expect(authErrorMessage(new Error("Email not confirmed"), "sign-in")).toBe("帳號尚未啟用，請先到信箱完成設定");
  });

  it("rate limit／網路錯誤同樣轉中文", () => {
    expect(authErrorMessage(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"), "sign-in")).toBe(
      "嘗試太多次，請稍後再試",
    );
    expect(authErrorMessage(new AuthRetryableFetchError("Failed to fetch", 0), "sign-in")).toBe("連線失敗，請檢查網路後再試");
    expect(authErrorMessage(new TypeError("Failed to fetch"), "sign-in")).toBe("連線失敗，請檢查網路後再試");
  });

  it("其他錯誤 → 通用中文（附錯誤代碼）；session 類錯誤在登入頁不說「設定連結」", () => {
    expect(authErrorMessage(new AuthApiError("User is banned", 403, "user_banned"), "sign-in")).toBe(
      "登入失敗，請稍後再試（錯誤代碼：user_banned）",
    );
    expect(authErrorMessage(new Error("boom"), "sign-in")).toBe("登入失敗，請稍後再試");
    const sessionish = authErrorMessage(new AuthSessionMissingError(), "sign-in");
    expect(sessionish).toBe("登入失敗，請稍後再試");
    expect(sessionish).not.toContain("設定連結");
  });
});

describe("classifyAuthError — 判斷順序與邊界", () => {
  it("code 優先於 message：code 是 weak_password 時，message 長得像連線失敗也歸弱密碼", () => {
    expect(classifyAuthError({ code: "weak_password", message: "Failed to fetch" }).kind).toBe("weak_password");
  });

  it("code 優先於 name／status", () => {
    expect(classifyAuthError({ code: "invalid_credentials", name: "AuthRetryableFetchError", status: 429 }).kind).toBe("invalid_credentials");
  });

  it("AuthRetryableFetchError：status 0 或沒有 → network；5xx → unknown（不是使用者的網路問題）", () => {
    expect(classifyAuthError(new AuthRetryableFetchError("x", 0)).kind).toBe("network");
    expect(classifyAuthError({ name: "AuthRetryableFetchError" }).kind).toBe("network");
    expect(classifyAuthError(new AuthRetryableFetchError("Bad Gateway", 502)).kind).toBe("unknown");
  });

  it("reasons 只收字串", () => {
    expect(classifyAuthError({ code: "weak_password", reasons: ["length", 1, null] }).reasons).toEqual(["length"]);
    expect(classifyAuthError({ code: "weak_password", reasons: "length" }).reasons).toEqual([]);
  });

  it("null／undefined／數字／空物件／空字串 → unknown，不丟例外", () => {
    for (const v of [null, undefined, 42, {}, "", [], true]) {
      expect(classifyAuthError(v).kind).toBe("unknown");
      expect(authErrorMessage(v, "sign-in")).toBe("登入失敗，請稍後再試");
      expect(authErrorMessage(v, "set-password")).toBe("設定密碼失敗，請稍後再試");
    }
  });

  it("code 是 Object.prototype 上的屬性名（constructor／toString）時不會被誤認", () => {
    expect(classifyAuthError({ code: "constructor" }).kind).toBe("unknown");
    expect(classifyAuthError({ code: "toString", name: "hasOwnProperty" }).kind).toBe("unknown");
  });

  it("奇怪的 code 不附在文案後面（只收 snake_case 代碼）", () => {
    expect(authErrorMessage({ code: "<script>alert(1)</script>" }, "sign-in")).toBe("登入失敗，請稍後再試");
    expect(authErrorMessage({ code: "x".repeat(65) }, "sign-in")).toBe("登入失敗，請稍後再試");
  });

  it("任何 Supabase 錯誤都不會把英文原文整句丟出去", () => {
    const samples: unknown[] = [
      new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
      new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
      new AuthApiError("User is banned", 403, "user_banned"),
      new AuthApiError("Database error updating user", 500, "unexpected_failure"),
      new AuthWeakPasswordError(GOTRUE_PWNED, 422, ["pwned"]),
      new AuthWeakPasswordError(GOTRUE_SHORT, 422, ["length"]),
      new AuthSessionMissingError(),
      new AuthRetryableFetchError("Failed to fetch", 0),
      new TypeError("Failed to fetch"),
      new Error("some unexpected thing"),
      { message: "Something went wrong on our side", status: 418 },
    ];
    for (const sample of samples) {
      for (const context of ["sign-in", "set-password"] as const) {
        const text = authErrorMessage(sample, context);
        expect(text, `${context}: ${JSON.stringify(sample)}`).toMatch(/[\u4e00-\u9fff]/);
        // 錯誤代碼（snake_case）可以出現，但不能有一整句英文
        expect(text.replace(/（錯誤代碼：[a-z0-9_]+）/i, ""), `${context}: ${text}`).not.toMatch(ENGLISH_SENTENCE);
      }
    }
  });
});

describe("looksLikeEmail（登入頁輸入檢查）", () => {
  it("像 Email 的都過（含前後空白、加號、子網域、多段網域）", () => {
    expect(looksLikeEmail("a@example.test")).toBe(true);
    expect(looksLikeEmail("  a@example.test  ")).toBe(true);
    expect(looksLikeEmail("first.last+tag@mail.example.co.uk")).toBe(true);
    expect(looksLikeEmail("a_b-c@sub.example.test")).toBe(true);
    expect(looksLikeEmail("王@例子.測試")).toBe(true);
  });

  it("員工編號、舊的 demo 帳號、沒有 @ → 不是", () => {
    expect(looksLikeEmail("A001")).toBe(false);
    expect(looksLikeEmail("12345")).toBe(false);
    expect(looksLikeEmail("demo")).toBe(false);
    expect(looksLikeEmail("Demo")).toBe(false);
  });

  it("空字串、只有空白 → 不是", () => {
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail("   ")).toBe(false);
  });

  it("@ 前或後沒有字 → 不是", () => {
    expect(looksLikeEmail("@example.test")).toBe(false);
    expect(looksLikeEmail("a@")).toBe(false);
    expect(looksLikeEmail("@")).toBe(false);
  });

  it("網域沒有 '.'、或 '.' 在頭尾／連續 → 不是", () => {
    expect(looksLikeEmail("a@example")).toBe(false);
    expect(looksLikeEmail("a@.example")).toBe(false);
    expect(looksLikeEmail("a@example.")).toBe(false);
    expect(looksLikeEmail("a@exa..mple.test")).toBe(false);
    expect(looksLikeEmail("a@.")).toBe(false);
  });

  it("多個 @、中間有空白 → 不是", () => {
    expect(looksLikeEmail("a@b@example.test")).toBe(false);
    expect(looksLikeEmail("a b@example.test")).toBe(false);
    expect(looksLikeEmail("a@exa mple.test")).toBe(false);
  });
});

describe("validateLoginInput（不像 Email 就不呼叫 Supabase）", () => {
  it("不像 Email → 請輸入公司給的 Email", () => {
    expect(LOGIN_EMAIL_REQUIRED_MESSAGE).toBe("請輸入公司給的 Email");
    expect(validateLoginInput("demo", "secret")).toEqual({ ok: false, error: "請輸入公司給的 Email" });
    expect(validateLoginInput("A001", "secret")).toEqual({ ok: false, error: "請輸入公司給的 Email" });
    expect(validateLoginInput("", "secret")).toEqual({ ok: false, error: "請輸入公司給的 Email" });
    // Email 和密碼都有問題時，先講 Email
    expect(validateLoginInput("demo", "")).toEqual({ ok: false, error: "請輸入公司給的 Email" });
  });

  it("Email 對、密碼沒填 → 請輸入密碼", () => {
    expect(LOGIN_PASSWORD_REQUIRED_MESSAGE).toBe("請輸入密碼");
    expect(validateLoginInput("a@example.test", "")).toEqual({ ok: false, error: "請輸入密碼" });
  });

  it("通過 → 回 trim 後的 Email（不改大小寫、不做任何帳號對應）", () => {
    expect(validateLoginInput("  A@Example.test ", "secret")).toEqual({ ok: true, email: "A@Example.test" });
    // 以前「輸入 demo → 換成一個固定的 demo Email」的對應已移除：長得像 Email 的照原樣交給 Supabase
    expect(validateLoginInput("demo@example.test", "secret")).toEqual({ ok: true, email: "demo@example.test" });
  });

  it("密碼只有空白也算有填（密碼可以含空白，不 trim）", () => {
    expect(validateLoginInput("a@example.test", " ")).toEqual({ ok: true, email: "a@example.test" });
  });
});
