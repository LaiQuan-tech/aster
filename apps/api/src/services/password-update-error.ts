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
 */

/** 新密碼被擋（太短／字元不足／外洩）時的錯誤碼。不能包含子字串 "weak_password"（見檔頭）。 */
export const PASSWORD_REJECTED = "password_rejected"

export interface PasswordUpdateRejection {
  code: typeof PASSWORD_REJECTED | "same_password"
  status: 400 | 422
  /** 繁體中文說明（畫面文字由 web 依 reasons 另外挑，這句給其他呼叫端／除錯看）。 */
  message: string
  /** 附加進回應 JSON 的欄位：password_rejected 帶 GoTrue 的 reasons（length｜characters｜pwned，原樣轉出）。 */
  extra?: { reasons: string[] }
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
 * GoTrue（supabase-js）的 updateUserById 錯誤 → 對外的 4xx 描述；不是這兩種就回 null（呼叫端照舊往上丟，維持 500）。
 * 判斷看 code（`weak_password`／`same_password`），沒有 code 時看 name（AuthWeakPasswordError）；
 * 不看 message（GoTrue 的英文原文會隨版本改字）。
 */
export function passwordUpdateRejectionFrom(err: unknown): PasswordUpdateRejection | null {
  const code = field(err, "code")
  if (code === "same_password") {
    return { code: "same_password", status: 400, message: "新密碼不可與目前密碼相同" }
  }
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
