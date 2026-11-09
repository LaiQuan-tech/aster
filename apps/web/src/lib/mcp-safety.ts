/**
 * AI 連接（MCP）前端的安全判斷（純函式、無 I/O，有 vitest）。
 *   • safeNextPath：登入後回跳只准回「同源、/oauth/consent、/mcp/confirm/<id>，或站內 /ess、/admin 底下的頁」，
 *     其他一律回預設頁（資安驗收 M2；2026-11-09 起通知信的深連結未登入時經 AuthGate 帶 next=，登入後回到該頁）。
 *   • loginRedirectPath：AuthGate 未登入時要導去的登入網址（帶 next=目前路徑＋query）。
 *   • consentTrust：同意頁判斷用戶端是否「已知」（redirect 網域是 claude.ai／claude.com／chatgpt.com／本機），
 *     以及名稱冒用（名稱含 Claude／Anthropic／ChatGPT／OpenAI 但網域不符）（資安驗收 M5）。
 */

const NEXT_ALLOWED = [/^\/oauth\/consent$/, /^\/mcp\/confirm\/[0-9a-fA-F-]{36}$/, /^\/(ess|admin)(\/[^\\]*)?$/]

export function safeNextPath(next: string | null | undefined, origin: string): string | null {
  if (!next || typeof next !== "string") return null;
  // 控制字元、空白（含 %09 解碼後的 tab）、反斜線一律拒絕；只收 / 開頭、不是 //。
  if (/[\x00-\x20\x7f\\]/.test(next) || !next.startsWith("/") || next.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  if (!NEXT_ALLOWED.some((re) => re.test(url.pathname))) return null;
  return `${url.pathname}${url.search}`;
}

/**
 * AuthGate 未登入時的登入網址：站內 /ess、/admin 頁帶 `?next=<路徑＋query>`（login 頁再用 safeNextPath 驗一次），
 * 其他頁（或回跳不合法）只導 /login。
 * `hadSession`：這個分頁曾經登入過（登出／換人／過期）→ 不帶 next，避免下一位登入者被帶去上一位的頁面；
 * 只有「全新分頁直接開通知信連結」才帶 next。
 */
export function loginRedirectPath(
  pathname: string | null | undefined,
  search: string | null | undefined,
  origin: string,
  hadSession = false,
): string {
  if (!pathname || hadSession) return "/login";
  const query = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  const next = safeNextPath(`${pathname}${query}`, origin);
  return next ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

const KNOWN_HOSTS = ["claude.ai", "claude.com", "chatgpt.com"];
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];
const BRAND_WORDS = /claude|anthropic|chatgpt|openai/i;

export interface ConsentTrust {
  /** redirect 網域是已知的 AI 平台或本機（Claude Code 等）。 */
  verified: boolean;
  /** 名稱自稱 Claude／ChatGPT…，但網域不是官方的。 */
  nameMismatch: boolean;
  hostname: string;
}

export function consentTrust(clientName: string, redirectHost: string): ConsentTrust {
  const hostname = redirectHost.replace(/:\d+$/, "").toLowerCase();
  const official = KNOWN_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  const verified = official || LOOPBACK.includes(hostname);
  return { verified, nameMismatch: BRAND_WORDS.test(clientName) && !verified, hostname };
}
