/**
 * Supabase Auth 錯誤 → 繁體中文，以及登入頁送出前的輸入檢查（純函式，登入頁與首次設定密碼頁共用）。
 *
 * 為什麼要有這支：登入（signInWithPassword）與首次設定密碼（updateUser）是瀏覽器直接呼叫 Supabase，
 * 錯誤物件的 message 是 GoTrue 的英文原文（"Invalid login credentials"、"Password is known to be weak…"），
 * 以前整句丟給使用者看（2026-10-12 教育訓練驗收發現）。這裡一律轉成中文；認不得的錯誤顯示
 * 通用中文＋錯誤代碼（給客服查），不再露出英文整句。
 *
 * 判斷依據：code → name → status，message 文字比對只當後備（GoTrue 的 message 會隨版本改字）。
 * 走 API 的改密碼（ESS 修改密碼，POST /me/password）不經這裡，見 auth-api.ts 的 accountErrorMessage
 * （它只借用這裡的 weakPasswordMessage）。
 */

/** 錯誤出在哪一頁：決定「不認得的錯誤」的通用文案，以及 session 過期要講「連結失效」還是通用句。 */
export type AuthErrorContext = "sign-in" | "set-password";

export type AuthErrorKind =
  | "weak_password"
  | "same_password"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "session_expired"
  | "rate_limited"
  | "network"
  | "unknown";

export interface AuthErrorInfo {
  kind: AuthErrorKind;
  /** GoTrue 的錯誤代碼（有才有），給「不認得的錯誤」附在文案後面。 */
  code: string | null;
  /** 弱密碼的原因（length｜characters｜pwned）；沒有就是空陣列。 */
  reasons: string[];
}

/* ----------------------------------------------------------- 弱密碼文案 ----- */

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * 弱密碼／外洩的中文提示，依 GoTrue 的 reasons 挑一句：含 pwned（外洩名單）最優先，其次太短、字元不足；
 * 沒有 reasons（或不認得的 reasons）用通用句。登入／設密碼頁與 ESS 修改密碼（API 的 password_rejected）共用。
 */
export function weakPasswordMessage(reasons?: unknown): string {
  const list = stringList(reasons);
  if (list.includes("pwned")) return "這組密碼太常見或曾外洩，請換一組";
  if (list.includes("length")) return "密碼太短，請換一組更長的密碼";
  if (list.includes("characters")) return "密碼強度不足，請混用英文大小寫、數字或符號";
  return "這組密碼太弱或曾外洩，請換一組";
}

/* ----------------------------------------------------------- 分類 ----- */

// 用 Map 查表：錯誤的 code／name 是外來字串，物件字面量查 "constructor" 之類會撞到原型上的屬性。
const KIND_BY_CODE = new Map<string, AuthErrorKind>([
  ["weak_password", "weak_password"],
  ["same_password", "same_password"],
  ["invalid_credentials", "invalid_credentials"],
  ["email_not_confirmed", "email_not_confirmed"],
  ["over_request_rate_limit", "rate_limited"],
  ["over_email_send_rate_limit", "rate_limited"],
  ["over_sms_send_rate_limit", "rate_limited"],
  ["session_not_found", "session_expired"],
  ["session_expired", "session_expired"],
  ["bad_jwt", "session_expired"],
  ["no_authorization", "session_expired"],
  ["refresh_token_not_found", "session_expired"],
  ["refresh_token_already_used", "session_expired"],
  ["otp_expired", "session_expired"],
  ["flow_state_expired", "session_expired"],
  ["flow_state_not_found", "session_expired"],
  ["reauthentication_needed", "session_expired"],
  ["reauthentication_not_valid", "session_expired"],
]);

const KIND_BY_NAME = new Map<string, AuthErrorKind>([
  ["AuthWeakPasswordError", "weak_password"],
  ["AuthInvalidCredentialsError", "invalid_credentials"],
  ["AuthSessionMissingError", "session_expired"],
]);

/** 後備：沒有 code／name／status 可看時才比對 message（英文原文；瀏覽器各家的連線失敗字樣不同）。 */
function kindFromMessage(message: string): AuthErrorKind | undefined {
  if (!message) return undefined;
  if (/different from the old password/i.test(message)) return "same_password";
  if (/invalid login credentials/i.test(message)) return "invalid_credentials";
  if (/email not confirmed/i.test(message)) return "email_not_confirmed";
  if (/rate limit|too many requests|for security purposes/i.test(message)) return "rate_limited";
  if (/known to be weak|easy to guess|password should (be at least|contain)/i.test(message)) return "weak_password";
  if (/auth session missing|\bjwt\b|\b(token|otp|link)\b.*\b(expired|invalid)\b|\bsession\b.*\b(expired|not found)\b/i.test(message)) {
    return "session_expired";
  }
  if (/failed to fetch|load failed|network ?error|network request failed|fetch failed/i.test(message)) return "network";
  return undefined;
}

/**
 * 把 Supabase Auth 丟出／回傳的錯誤歸類。吃 AuthError 實例、只有 code／status 的 plain object、
 * 瀏覽器的 TypeError("Failed to fetch")、字串；其他（null、數字…）歸 unknown。
 */
export function classifyAuthError(err: unknown): AuthErrorInfo {
  let code: string | null = null;
  let name: string | null = null;
  let status: number | null = null;
  let message = "";
  let reasons: string[] = [];

  if (typeof err === "string") {
    message = err;
  } else if (typeof err === "object" && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o.code === "string" && o.code) code = o.code;
    if (typeof o.name === "string" && o.name) name = o.name;
    if (typeof o.status === "number") status = o.status;
    if (typeof o.message === "string") message = o.message;
    reasons = stringList(o.reasons);
  }

  let kind: AuthErrorKind | undefined = code ? KIND_BY_CODE.get(code) : undefined;
  if (!kind && name) kind = KIND_BY_NAME.get(name);
  // AuthRetryableFetchError：status 0（或沒有）＝根本連不上；5xx＝Supabase 暫時故障，不是使用者的網路問題。
  if (!kind && name === "AuthRetryableFetchError") kind = status ? "unknown" : "network";
  if (!kind && status === 429) kind = "rate_limited";
  if (!kind && status === 401) kind = "session_expired";
  if (!kind) kind = kindFromMessage(message);

  return { kind: kind ?? "unknown", code, reasons };
}

/* ----------------------------------------------------------- 文案 ----- */

/** 錯誤代碼只在長得像 GoTrue 的 snake_case 代碼時才附上，避免把奇怪字串秀給使用者。 */
const SAFE_CODE = /^[a-z0-9_]{1,64}$/i;

/**
 * Supabase Auth 錯誤 → 給使用者看的中文。
 *   sign-in（登入頁）：invalid_credentials「Email 或密碼錯誤」、email_not_confirmed、rate limit、連線失敗；
 *   set-password（首次設定密碼頁）：弱密碼依 reasons、新舊密碼相同、連結／session 失效、rate limit、連線失敗；
 *   其餘一律通用中文（附錯誤代碼），不會出現英文原文。
 */
export function authErrorMessage(err: unknown, context: AuthErrorContext): string {
  const { kind, code, reasons } = classifyAuthError(err);
  switch (kind) {
    case "weak_password":
      return weakPasswordMessage(reasons);
    case "same_password":
      return "新密碼不能和舊密碼相同";
    case "invalid_credentials":
      return "Email 或密碼錯誤";
    case "email_not_confirmed":
      return "帳號尚未啟用，請先到信箱完成設定";
    case "rate_limited":
      return "嘗試太多次，請稍後再試";
    case "network":
      return "連線失敗，請檢查網路後再試";
    case "session_expired":
      if (context === "set-password") return "設定連結已失效，請重新索取";
      break;
    default:
      break;
  }
  const base = context === "sign-in" ? "登入失敗，請稍後再試" : "設定密碼失敗，請稍後再試";
  return code && SAFE_CODE.test(code) ? `${base}（錯誤代碼：${code}）` : base;
}

/* ----------------------------------------------------------- 登入頁輸入檢查 ----- */

export const LOGIN_EMAIL_REQUIRED_MESSAGE = "請輸入公司給的 Email";
export const LOGIN_PASSWORD_REQUIRED_MESSAGE = "請輸入密碼";

/**
 * 輸入「像不像 Email」（不是完整的 RFC 驗證，只擋明顯不是的，例如員工編號、舊的 demo 帳號）：
 * trim 後恰好一個 @、@ 前後都有字、網域含 "." 且不以 "." 開頭／結尾／連續、中間沒有空白。
 */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return true;
}

export type LoginInputCheck = { ok: true; email: string } | { ok: false; error: string };

/**
 * 登入頁送出前的檢查：Email 不像 Email → 「請輸入公司給的 Email」；密碼沒填 → 「請輸入密碼」。
 * 沒過就直接在畫面顯示、**不呼叫 Supabase**；過了回 trim 後的 Email 給 signInWithPassword 用。
 * （表單加了 noValidate，原生驗證泡泡不會出現，必填檢查改由這裡負責。）
 */
export function validateLoginInput(email: string, password: string): LoginInputCheck {
  if (!looksLikeEmail(email)) return { ok: false, error: LOGIN_EMAIL_REQUIRED_MESSAGE };
  if (!password) return { ok: false, error: LOGIN_PASSWORD_REQUIRED_MESSAGE };
  return { ok: true, email: email.trim() };
}
