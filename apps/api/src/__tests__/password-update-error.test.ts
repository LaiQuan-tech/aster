import { describe, expect, it } from "vitest"
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthWeakPasswordError } from "@supabase/supabase-js"
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_REJECTED,
  PASSWORD_TOO_LONG_REASON,
  passwordByteLength,
  passwordTooLong,
  passwordTooLongRejection,
  passwordUpdateRejectionFrom,
} from "../services/password-update-error.js"

/**
 * services/password-update-error.ts（純函式，不連任何 DB／GoTrue）：
 * 員工自己改密碼時，GoTrue 擋下新密碼的錯誤 → 對外 4xx 描述。
 *   • weak_password（AuthWeakPasswordError，或只有 code／name 的 plain object）→ 422 password_rejected＋reasons
 *   • 密碼過長（validation_failed「Password cannot be longer than 72 characters」）→ 422 password_rejected＋["too_long"]
 *   • same_password → 400 same_password（跟路由預先檢查的既有回應一致）
 *   • 其他（含 500、網路錯誤、別的 validation_failed、亂七八糟的值）→ null，呼叫端照舊丟 500
 * 路由層（HTTP 狀態與回應形狀）在 me-password-rejected.test.ts。
 */

const GOTRUE_PWNED = "Password is known to be weak and easy to guess, please choose a different one."
/** GoTrue 對超過 72 bytes 的密碼（bcrypt 上限）回的錯誤。 */
const GOTRUE_TOO_LONG = "Password cannot be longer than 72 characters"
const TOO_LONG_TEXT = "密碼太長，請改短一點（最多 72 個位元組，中文約 24 字）"

describe("passwordUpdateRejectionFrom — 弱密碼／外洩 → 422 password_rejected", () => {
  it("AuthWeakPasswordError（pwned）→ 422、帶 reasons、中文說明", () => {
    const rejected = passwordUpdateRejectionFrom(new AuthWeakPasswordError(GOTRUE_PWNED, 422, ["pwned"]))
    expect(rejected).toEqual({
      code: "password_rejected",
      status: 422,
      message: "這組密碼太弱或曾外洩，請換一組",
      extra: { reasons: ["pwned"] },
    })
  })

  it.each(["length", "characters", "pwned"] as const)("reasons 單一值 %s 原樣帶出", (reason) => {
    const rejected = passwordUpdateRejectionFrom(new AuthWeakPasswordError("x", 422, [reason]))
    expect(rejected?.code).toBe("password_rejected")
    expect(rejected?.status).toBe(422)
    expect(rejected?.extra).toEqual({ reasons: [reason] })
  })

  it("多個 reasons 保持順序", () => {
    const rejected = passwordUpdateRejectionFrom(new AuthWeakPasswordError("x", 422, ["length", "characters", "pwned"]))
    expect(rejected?.extra).toEqual({ reasons: ["length", "characters", "pwned"] })
  })

  it("只有 code／status 的 plain object（沒有 reasons）→ 一樣 422，reasons 為空陣列", () => {
    const rejected = passwordUpdateRejectionFrom({ code: "weak_password", status: 422 })
    expect(rejected).toMatchObject({ code: "password_rejected", status: 422, extra: { reasons: [] } })
  })

  it("沒有 code、只有 name 的 plain object（序列化後的 AuthWeakPasswordError）→ 也認得", () => {
    const rejected = passwordUpdateRejectionFrom({ name: "AuthWeakPasswordError", status: 422, reasons: ["characters"] })
    expect(rejected).toMatchObject({ code: "password_rejected", status: 422, extra: { reasons: ["characters"] } })
  })

  it("reasons 形狀怪異時清乾淨：非陣列 → []；非字串項目丟掉；重複項目去重", () => {
    expect(passwordUpdateRejectionFrom({ code: "weak_password", reasons: "pwned" })?.extra).toEqual({ reasons: [] })
    expect(passwordUpdateRejectionFrom({ code: "weak_password", reasons: null })?.extra).toEqual({ reasons: [] })
    expect(passwordUpdateRejectionFrom({ code: "weak_password", reasons: [1, null, "length", { x: 1 }, "length"] })?.extra).toEqual({
      reasons: ["length"],
    })
  })

  it("GoTrue 沒見過的 reason 字串照樣轉出（由 web 決定怎麼顯示）", () => {
    expect(passwordUpdateRejectionFrom({ code: "weak_password", reasons: ["something_new"] })?.extra).toEqual({
      reasons: ["something_new"],
    })
  })

  it("新錯誤碼不含子字串 weak_password（web 的 accountErrorMessage 靠子字串比對，weak_password 會被 HR 文案先吃掉）", () => {
    expect(PASSWORD_REJECTED).toBe("password_rejected")
    expect(PASSWORD_REJECTED).not.toContain("weak_password")
    const rejected = passwordUpdateRejectionFrom({ code: "weak_password" })
    expect(rejected?.code).not.toContain("weak_password")
  })

  it("說明是中文，不外露 GoTrue 的英文原文", () => {
    const rejected = passwordUpdateRejectionFrom(new AuthWeakPasswordError(GOTRUE_PWNED, 422, ["pwned"]))
    expect(rejected?.message).toMatch(/[\u4e00-\u9fff]/)
    expect(rejected?.message).not.toMatch(/[A-Za-z]{3,}/)
  })
})

describe("passwordTooLong／passwordByteLength — bcrypt 的 72 個位元組（UTF-8）上限", () => {
  it("英數一字 1 byte：72 個可以、73 個太長", () => {
    expect(PASSWORD_MAX_BYTES).toBe(72)
    expect(passwordByteLength("a".repeat(72))).toBe(72)
    expect(passwordTooLong("a".repeat(72))).toBe(false)
    expect(passwordTooLong("a".repeat(73))).toBe(true)
  })

  it("中文一字 3 bytes：24 字剛好 72 bytes、25 字太長；emoji 一個 4 bytes", () => {
    expect(passwordByteLength("密".repeat(24))).toBe(72)
    expect(passwordTooLong("密".repeat(24))).toBe(false)
    expect(passwordTooLong("密".repeat(25))).toBe(true)
    expect(passwordByteLength("😀")).toBe(4)
    expect(passwordTooLong("😀".repeat(19))).toBe(true)
  })
})

describe("passwordUpdateRejectionFrom — 密碼過長 → 422 password_rejected＋reasons [too_long]", () => {
  it("GoTrue 400 validation_failed「Password cannot be longer than 72 characters」→ 422、中文說明、reasons too_long", () => {
    const rejected = passwordUpdateRejectionFrom(new AuthApiError(GOTRUE_TOO_LONG, 400, "validation_failed"))
    expect(rejected).toEqual({
      code: "password_rejected",
      status: 422,
      message: TOO_LONG_TEXT,
      extra: { reasons: ["too_long"] },
    })
    expect(rejected).toEqual(passwordTooLongRejection())
    expect(PASSWORD_TOO_LONG_REASON).toBe("too_long")
  })

  it("只有 code／message 的 plain object 也認得；說法換成 too long／exceeds 也認得", () => {
    expect(passwordUpdateRejectionFrom({ code: "validation_failed", message: GOTRUE_TOO_LONG })?.extra).toEqual({ reasons: ["too_long"] })
    expect(passwordUpdateRejectionFrom({ code: "validation_failed", message: "Password is too long" })?.code).toBe("password_rejected")
    expect(passwordUpdateRejectionFrom({ code: "validation_failed", message: "password length exceeds 72 bytes" })?.status).toBe(422)
  })

  it("別的 validation_failed、或沒有 validation_failed 碼只靠 message → 不猜（null，維持 500）", () => {
    expect(passwordUpdateRejectionFrom(new AuthApiError("Unable to validate email address: invalid format", 400, "validation_failed"))).toBeNull()
    expect(passwordUpdateRejectionFrom({ code: "validation_failed" })).toBeNull()
    expect(passwordUpdateRejectionFrom({ status: 400, message: GOTRUE_TOO_LONG })).toBeNull()
    expect(passwordUpdateRejectionFrom(new Error(GOTRUE_TOO_LONG))).toBeNull()
  })

  it("每次回新物件（呼叫端改了 reasons 也不會污染下一次）", () => {
    const first = passwordTooLongRejection()
    first.extra?.reasons.push("tampered")
    expect(passwordTooLongRejection().extra).toEqual({ reasons: ["too_long"] })
  })
})

describe("passwordUpdateRejectionFrom — same_password → 400 same_password", () => {
  it("AuthApiError（code same_password、status 422）→ 400，文案同路由預先檢查，沒有 extra", () => {
    const rejected = passwordUpdateRejectionFrom(
      new AuthApiError("New password should be different from the old password.", 422, "same_password"),
    )
    expect(rejected).toEqual({ code: "same_password", status: 400, message: "新密碼不可與目前密碼相同" })
    expect(rejected).not.toHaveProperty("extra")
  })

  it("只有 code 的 plain object 也認得", () => {
    expect(passwordUpdateRejectionFrom({ code: "same_password" })).toMatchObject({ code: "same_password", status: 400 })
  })
})

describe("passwordUpdateRejectionFrom — 其他錯誤 → null（維持 500）", () => {
  it("未知 code 的 AuthApiError／伺服器錯誤／網路錯誤／缺 session → null", () => {
    expect(passwordUpdateRejectionFrom(new AuthApiError("Database error updating user", 500, "unexpected_failure"))).toBeNull()
    expect(passwordUpdateRejectionFrom(new AuthApiError("User not found", 404, "user_not_found"))).toBeNull()
    expect(passwordUpdateRejectionFrom(new AuthRetryableFetchError("Failed to fetch", 0))).toBeNull()
    expect(passwordUpdateRejectionFrom(new AuthSessionMissingError())).toBeNull()
  })

  it("一般 Error、空物件、null、undefined、字串、數字 → null", () => {
    expect(passwordUpdateRejectionFrom(new Error("boom"))).toBeNull()
    expect(passwordUpdateRejectionFrom({})).toBeNull()
    expect(passwordUpdateRejectionFrom(null)).toBeNull()
    expect(passwordUpdateRejectionFrom(undefined)).toBeNull()
    expect(passwordUpdateRejectionFrom("weak_password")).toBeNull()
    expect(passwordUpdateRejectionFrom(422)).toBeNull()
  })

  it("只靠 message 長得像弱密碼、沒有 code／name → 不猜（null）", () => {
    expect(passwordUpdateRejectionFrom({ status: 422, message: GOTRUE_PWNED })).toBeNull()
    expect(passwordUpdateRejectionFrom(new Error(GOTRUE_PWNED))).toBeNull()
  })
})
