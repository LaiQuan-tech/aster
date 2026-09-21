/**
 * 帳號／密碼相關的 API client（A1）：忘記密碼、改密碼、首次設密碼完成、HR 寄邀請信／
 * 重設密碼信、CSV 批次邀請。
 *
 * 刻意不動 ess-api.ts / admin-api.ts 的 Me 型別：/me 新增的欄位（mustChangePassword、
 * employmentType、essTabs）在這裡用自己的型別擴充，讀取時一律 optional，舊 API
 * 部署前後都不會炸。
 */
import { apiFetch } from "./api-client";
import type { AccountsFeatureSettings } from "./admin-api";

/* ------------------------------------------------------------------ me ----- */

export interface MeAuth {
  id: string;
  name: string;
  role: string;
  email: string | null;
  /** HR 配發暫時密碼後為 true；AuthGate 據此導去 /auth/set-password?mode=change。 */
  mustChangePassword?: boolean;
  employmentType?: string | null;
  /** null＝全部分頁；陣列＝只顯示這些 ESS 分頁 key（intern 預設六個）。 */
  essTabs?: string[] | null;
}

export function getMeAuth() {
  return apiFetch<MeAuth>("/me");
}

/** 舊密碼換新密碼。舊密碼錯 → 401 invalid_current_password。 */
export function changeMyPassword(currentPassword: string, newPassword: string) {
  return apiFetch<{ ok: true }>("/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

/** 自設密碼完成 → 清 must_change_password（只清自己）。 */
export function markPasswordDone() {
  return apiFetch<{ ok: true; cleared: boolean }>("/me/password-done", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/* ------------------------------------------------------- forgot password ----- */

/** 免登入；不論帳號存不存在都回 { ok: true }。 */
export function forgotPassword(email: string) {
  return apiFetch<{ ok: true }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/* ------------------------------------------------------------ HR: invite ----- */

export type AccountLinkType = "invite" | "recovery";

export interface AccountLinkResult {
  sent: boolean;
  /** true＝沒寄信（API 沒設 RESEND_API_KEY 或呼叫時指定），link 給 HR 手動轉交。 */
  dryRun: boolean;
  type: AccountLinkType;
  email: string;
  action: "created" | "bound" | "existing";
  link?: string;
}

/**
 * 寄邀請信：已有帳號者改寄重設密碼信（recovery）；未綁帳號者建 auth user 並綁定
 * （invite）。`email` 只在員工未綁帳號、My Data 也沒填信箱時需要指定。
 * 409：no_email / email_in_other_tenant / email_already_bound / user_already_bound。
 */
export function sendEmployeeInvite(id: string, opts: { dryRun?: boolean; email?: string } = {}) {
  return apiFetch<AccountLinkResult>(`/employees/${id}/invite`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

/** 寄重設密碼信（只對已綁帳號者；沒帳號 → 409 no_account）。 */
export function sendEmployeeReset(id: string, opts: { dryRun?: boolean } = {}) {
  return apiFetch<AccountLinkResult>(`/employees/${id}/send-reset`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export interface BulkInviteRow {
  line: number;
  name: string | null;
  email: string | null;
  action: "created" | "bound" | "skipped";
  type?: AccountLinkType;
  sent?: boolean;
  link?: string;
  warning?: string;
  error?: string;
}

export interface BulkInviteResult {
  created: number;
  bound: number;
  invited: number;
  sent: number;
  skipped: number;
  dryRun: boolean;
  errors: Array<{ line: number; error: string }>;
  rows: BulkInviteRow[];
}

/**
 * CSV 批次建帳號＋寄邀請信。表頭 `name,email,empNo,deptName,employmentType,hireDate,role`
 * （只有 name／email 必填；BOM／CRLF／引號逗號都能吃）。
 */
export function bulkInviteEmployees(csv: string, dryRun?: boolean) {
  return apiFetch<BulkInviteResult>("/employees/bulk-invite", {
    method: "POST",
    body: JSON.stringify({ csv, dryRun }),
  });
}

/** 把單筆表單值組成一行 CSV（含表頭），給「不填密碼就寄邀請信」的單筆流程用。 */
export function toInviteCsv(row: {
  name: string;
  email: string;
  empNo?: string;
  deptName?: string;
  employmentType?: string;
  hireDate?: string;
  role?: string;
}): string {
  const esc = (v: string | undefined) => {
    const s = (v ?? "").trim();
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "name,email,empNo,deptName,employmentType,hireDate,role";
  const line = [row.name, row.email, row.empNo, row.deptName, row.employmentType, row.hireDate, row.role]
    .map(esc)
    .join(",");
  return `${header}\n${line}`;
}

/* ------------------------------------------------- tenant: 帳號安全設定 ----- */

/**
 * 從 tenants.features 讀 accounts（帳號安全）設定：只收 boolean 的 allowWeakInitialPassword，
 * 其餘忽略；沒有／格式不對 → {}（＝維持 GoTrue 弱密碼檢查）。仿 lib/admin-nav.ts 的 adminModulesOf。
 */
export function accountsFeatureOf(features: Record<string, unknown> | null | undefined): AccountsFeatureSettings {
  const raw = features?.accounts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AccountsFeatureSettings = {};
  const allow = (raw as Record<string, unknown>).allowWeakInitialPassword;
  if (typeof allow === "boolean") out.allowWeakInitialPassword = allow;
  return out;
}

/** API 回的 4xx 錯誤碼（409／422／404）→ 給 HR 看的中文；apiFetch 的訊息格式是 `[status] code`。 */
export function accountErrorMessage(err: unknown, fallback = "操作失敗"): string {
  const message = err instanceof Error ? err.message : "";
  const table: Record<string, string> = {
    no_email: "此員工沒有 Email：請先在 My Data 填公司或私人信箱，或在邀請時指定",
    no_account: "此員工尚未綁定登入帳號，請改用「寄邀請信」",
    email_in_other_tenant: "此 Email 已屬於其他公司的帳號",
    email_already_bound: "此 Email 已綁定本公司其他員工",
    user_already_bound: "此帳號已綁定其他員工",
    already_bound: "此員工已綁定登入帳號",
    auth_user_missing: "員工綁定的登入帳號已不存在",
    invalid_current_password: "目前密碼不正確",
    same_password: "新密碼不可與目前密碼相同",
    weak_password:
      "這組密碼太常見或在外洩名單中，Supabase 弱密碼防護擋下。若要允許簡單的初始密碼，請到「設定 → 進階功能 → 帳號安全」開啟（僅適用於新增員工帳號；重設密碼請改用系統產生的暫時密碼）。",
    email_exists: "此 Email 已有登入帳號",
    not_found: "找不到這位員工",
  };
  for (const [code, text] of Object.entries(table)) {
    if (message.includes(code)) return text;
  }
  return message || fallback;
}
