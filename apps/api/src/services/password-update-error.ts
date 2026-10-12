/**
 * 員工自己改密碼（POST /me/password → services/auth-invite.ts changeOwnPassword）時，GoTrue 擋下新密碼
 * 的錯誤 → 對外 4xx 的描述。純函式、零 import：單元測試不必連 Supabase。
 *
 * 背景（2026-10-12 教育訓練驗收）：admin.updateUserById({ password }) 遇到太短／字元不足／在外洩名單
 * （HIBP）會回 AuthWeakPasswordError（code `weak_password`、status 422、帶 reasons：length｜characters｜pwned）；
 * 新舊密碼相同回 code `same_password`。以前這些都被當一般錯誤 throw → 500 internal_server_error，
 * ESS「修改密碼」畫面只看到「[500] internal_server_error」。
 *
 * ⚠️ 新錯誤碼刻意**不叫** `weak_password`：web 的 accountErrorMessage（lib/auth-api.ts）是子字串比對，
 * `weak_password` 會被 HR 配發初始密碼那句（「請到設定 → 進階功能 → 帳號安全開啟」）先吃掉——
 * 員工自己改密碼沒有那個開關可開。HR 配發初始密碼的 422 weak_password 流程（routes/employees.ts）不在這裡。
 *
 * 密碼太長（2026-10-12 審查）：GoTrue 用 bcrypt，超過 72 個位元組（UTF-8）的密碼直接回 400 validation_failed
 * （「Password cannot be longer than 72 characters」），以前也落成 500。POST /me/password 的 zod 先擋
 * （passwordTooLong），GoTrue 回的同類錯誤也轉成同一個 4xx：422 password_rejected＋reasons ["too_long"]，
 * 形狀與弱密碼一致，web 依 reasons 顯示「密碼太長，請改短一點…」。
 */

/** 新密碼被擋（太短／字元不足／外洩／太長）時的錯誤碼。不能包含子字串 "weak_password"（見檔頭）。 */
export const PASSWORD_REJECTED = "password_rejected"

/** bcrypt 的上限：UTF-8 位元組數（英數一字 1 byte、中文一字 3 bytes）。與 web lib/auth-error-messages.ts 同一個數。 */
export const PASSWORD_MAX_BYTES = 72

/** 密碼太長時 password_rejected 的 reasons 值（GoTrue 自己的 reasons 沒有這個，是這裡加的）。 */
export const PASSWORD_TOO_LONG_REASON = "too_long"

export interface PasswordUpdateRejection {
  code: typeof PASSWORD_REJECTED | "same_password"
  status: 400 | 422
  /** 繁體中文說明（畫面文字由 web 依 reasons 另外挑，這句給其他呼叫端／除錯看）。 */
  message: string
  /**
   * 附加進回應 JSON 的欄位：password_rejected 帶 reasons——GoTrue 的（length｜characters｜pwned，原樣轉出），
   * 或密碼太長的 ["too_long"]。
   */
  extra?: { reasons: string[] }
}

/** 密碼的 UTF-8 位元組數（bcrypt 的上限算的是位元組，不是字數）。 */
export function passwordByteLength(password: string): number {
  return Buffer.byteLength(password, "utf8")
}

/** 超過 72 bytes → true（GoTrue 一定拒絕）。 */
export function passwordTooLong(password: string): boolean {
  return passwordByteLength(password) > PASSWORD_MAX_BYTES
}

/** 新密碼太長的 4xx 描述（路由的 zod 擋下、或 GoTrue 回密碼過長時共用）；每次回新物件。 */
export function passwordTooLongRejection(): PasswordUpdateRejection {
  return {
    code: PASSWORD_REJECTED,
    status: 422,
    message: "密碼太長，請改短一點（最多 72 個位元組，中文約 24 字）",
    extra: { reasons: [PASSWORD_TOO_LONG_REASON] },
  }
}

function field(err: unknown, key: string): unknown {
  return typeof err === "object" && err !== null ? (err as Record<string, unknown>)[key] : undefined
}

/** reasons 只收字串、去重、保持順序；不是陣列（或缺席）→ []。 */
function reasonsOf(err: unknown): string[] {
  const raw = field(err, "reasons")
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((r): r is string => typeof r === "string"))]
}

/**
 * GoTrue 的「密碼過長」：code `validation_failed`（400），message「Password cannot be longer than 72 characters」。
 * validation_failed 是通用碼（其他欄位驗證也用），只有這一種得看 message 才分得出來；其他 validation_failed 不猜。
 * 路由已先擋掉超過 72 bytes 的新密碼，這裡是 GoTrue 上限或算法跟我們不一樣時的保險。
 */
function isPasswordTooLongError(err: unknown): boolean {
  if (field(err, "code") !== "validation_failed") return false
  const message = field(err, "message")
  return typeof message === "string" && /password/i.test(message) && /longer than|too long|exceeds/i.test(message)
}

/**
 * GoTrue（supabase-js）的 updateUserById 錯誤 → 對外的 4xx 描述；不是這幾種就回 null（呼叫端照舊往上丟，維持 500）。
 * 判斷看 code（`weak_password`／`same_password`），沒有 code 時看 name（AuthWeakPasswordError）；
 * 不看 message（GoTrue 的英文原文會隨版本改字）——唯一例外是密碼過長（見 isPasswordTooLongError）。
 */
export function passwordUpdateRejectionFrom(err: unknown): PasswordUpdateRejection | null {
  const code = field(err, "code")
  if (code === "same_password") {
    return { code: "same_password", status: 400, message: "新密碼不可與目前密碼相同" }
  }
  if (isPasswordTooLongError(err)) return passwordTooLongRejection()
  if (code === "weak_password" || field(err, "name") === "AuthWeakPasswordError") {
    return {
      code: PASSWORD_REJECTED,
      status: 422,
      message: "這組密碼太弱或曾外洩，請換一組",
      extra: { reasons: reasonsOf(err) },
    }
  }
  return null
}
