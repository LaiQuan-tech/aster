/**
 * Supabase Auth 錯誤 → 繁體中文，以及登入頁送出前的輸入檢查（純函式，登入頁與首次設定密碼頁共用）。
 *
 * 為什麼要有這支：登入（signInWithPassword）與首次設定密碼（updateUser）是瀏覽器直接呼叫 Supabase，
 * 錯誤物件的 message 是 GoTrue 的英文原文（"Invalid login credentials"、"Password is known to be weak…"），
 * 以前整句丟給使用者看（2026-10-12 教育訓練驗收發現）。這裡一律轉成中文；認不得的錯誤畫面上只顯示
 * 通用中文（不附英文代碼、也不叫人「稍後再試」——validation_failed 這類錯誤再試幾次都一樣），代碼改用
 * console.warn 記錄給客服／開發查。
 *
 * 判斷依據：code → name → status，message 文字比對只當後備（GoTrue 的 message 會隨版本改字）。
 * 走 API 的改密碼（ESS 修改密碼，POST /me/password）不經這裡，見 auth-api.ts 的 accountErrorMessage
 * （它只借用這裡的 passwordRejectedMessage）。
 */

/** 錯誤出在哪一頁：決定「不認得的錯誤」的通用文案，以及 session 過期要講「連結失效」還是通用句。 */
export type AuthErrorContext = "sign-in" | "set-password";

export type AuthErrorKind =
  | "weak_password"
  | "password_too_long"
  | "same_password"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "session_expired"
  | "rate_limited"
  | "network"
  /** Supabase 暫時故障（AuthRetryableFetchError 帶 5xx）：不是使用者的網路，也不是輸入的問題，稍後再試是對的。 */
  | "unavailable"
  | "unknown";

export interface AuthErrorInfo {
  kind: AuthErrorKind;
  /** GoTrue 的錯誤代碼（有才有）；「不認得的錯誤」用 console.warn 記下來，不顯示在畫面上。 */
  code: string | null;
  /** 弱密碼的原因（length｜characters｜pwned）；沒有就是空陣列。 */
  reasons: string[];
  /** 錯誤類別名稱（AuthApiError…）與 HTTP 狀態；只給 console.warn 記錄用。 */
  name: string | null;
  status: number | null;
}

/* ----------------------------------------------------------- 密碼長度 ----- */

/**
 * 密碼上限 72 個位元組（UTF-8）：GoTrue 用 bcrypt，bcrypt 只吃前 72 bytes，GoTrue 對更長的密碼直接拒絕
 * （400 validation_failed「Password cannot be longer than 72 characters」）。英數一字 1 byte、中文一字 3 bytes。
 * 與 API 的 services/password-update-error.ts PASSWORD_MAX_BYTES 同一個數。
 */
export const PASSWORD_MAX_BYTES = 72;

/** 密碼太長的中文提示（首次設定密碼頁、ESS 修改密碼共用）。 */
export const PASSWORD_TOO_LONG_MESSAGE = "密碼太長，請改短一點（最多 72 個位元組，中文約 24 字）";

/** 密碼的 UTF-8 位元組數（bcrypt 的上限算的是位元組，不是字數）。 */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

/** 超過 72 bytes → true（首次設定密碼頁送出前先擋，不必等 GoTrue 回錯）。 */
export function passwordTooLong(password: string): boolean {
  return passwordByteLength(password) > PASSWORD_MAX_BYTES;
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

/**
 * ESS 修改密碼被 API 擋下（POST /me/password → 422 password_rejected）的中文：reasons 含 too_long（超過 72 bytes，
 * API 自己加的原因）→ 密碼太長；其他照 weakPasswordMessage（GoTrue 的 length｜characters｜pwned）。
 */
export function passwordRejectedMessage(reasons?: unknown): string {
  if (stringList(reasons).includes("too_long")) return PASSWORD_TOO_LONG_MESSAGE;
  return weakPasswordMessage(reasons);
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

/**
 * 後備：沒有 code／name／status 可看時才比對 message（英文原文；瀏覽器各家的連線失敗字樣不同）。
 * 密碼太長只能靠這裡：GoTrue 用的是通用的 validation_failed（別的欄位驗證也是這個碼），要看 message 才分得出來。
 */
function kindFromMessage(message: string): AuthErrorKind | undefined {
  if (!message) return undefined;
  if (/password/i.test(message) && /longer than|too long|exceeds/i.test(message)) return "password_too_long";
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
  if (!kind && name === "AuthRetryableFetchError") kind = status ? "unavailable" : "network";
  if (!kind && status === 429) kind = "rate_limited";
  if (!kind && status === 401) kind = "session_expired";
  if (!kind) kind = kindFromMessage(message);

  return { kind: kind ?? "unknown", code, reasons, name, status };
}

/* ----------------------------------------------------------- 文案 ----- */

/** 認不得的錯誤：畫面上的通用中文（不附代碼；這類錯誤多半再試也一樣，所以指向能處理的人）。 */
export const AUTH_UNKNOWN_ERROR_MESSAGE: Readonly<Record<AuthErrorContext, string>> = {
  "sign-in": "登入失敗，請確認 Email 與密碼；若持續發生請洽 HR",
  "set-password": "設定密碼失敗，請重新開啟設定連結或洽 HR",
};

/** Supabase 暫時故障（unavailable）：維持原本的「稍後再試」。 */
const AUTH_UNAVAILABLE_MESSAGE: Readonly<Record<AuthErrorContext, string>> = {
  "sign-in": "登入失敗，請稍後再試",
  "set-password": "設定密碼失敗，請稍後再試",
};

/** 錯誤代碼只在長得像 GoTrue 的 snake_case 代碼時才記，避免把奇怪字串寫進 console。 */
const SAFE_CODE = /^[a-z0-9_]{1,64}$/i;

/** 認不得的錯誤：代碼、類別名稱、HTTP 狀態寫進 console.warn（不記 message，避免把原文整句帶出去）。 */
function warnUnknownAuthError(info: AuthErrorInfo, context: AuthErrorContext): void {
  if (typeof console === "undefined") return;
  console.warn(`[auth] ${context} 認不得的錯誤`, {
    code: info.code && SAFE_CODE.test(info.code) ? info.code : null,
    name: info.name && SAFE_CODE.test(info.name) ? info.name : null,
    status: info.status,
  });
}

/**
 * Supabase Auth 錯誤 → 給使用者看的中文。
 *   sign-in（登入頁）：invalid_credentials「Email 或密碼錯誤」、email_not_confirmed、rate limit、連線失敗；
 *   set-password（首次設定密碼頁）：弱密碼依 reasons、密碼太長、新舊密碼相同、連結／session 失效、rate limit、連線失敗；
 *   Supabase 暫時故障 → 「…請稍後再試」；其餘一律通用中文（AUTH_UNKNOWN_ERROR_MESSAGE），代碼只記在 console.warn。
 * 畫面上不會出現英文原文或錯誤代碼。
 */
export function authErrorMessage(err: unknown, context: AuthErrorContext): string {
  const info = classifyAuthError(err);
  switch (info.kind) {
    case "weak_password":
      return weakPasswordMessage(info.reasons);
    case "password_too_long":
      return PASSWORD_TOO_LONG_MESSAGE;
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
    case "unavailable":
      return AUTH_UNAVAILABLE_MESSAGE[context];
    case "session_expired":
      if (context === "set-password") return "設定連結已失效，請重新索取";
      break;
    default:
      break;
  }
  warnUnknownAuthError(info, context);
  return AUTH_UNKNOWN_ERROR_MESSAGE[context];
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
