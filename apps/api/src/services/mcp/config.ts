import type { Request } from "express"

/**
 * MCP 連接（2026-11-02）的設定與常數。
 *
 * 環境變數（apps/api）：
 *   • MCP_TOKEN_SECRET（必要）：token／授權碼雜湊（HMAC-SHA256 pepper）與授權請求簽章的金鑰。
 *     沒設 → 所有 MCP／OAuth 端點回 503 mcp_not_configured（不會用弱預設值）。
 *   • MCP_PUBLIC_URL（建議）：API 對外網址（例 https://aster-hr-api.vercel.app），當 OAuth issuer 與 MCP resource。
 *     沒設 → 由請求的 x-forwarded-proto／host 推（本機開發用）。
 *   • WEB_URL（既有）：後台網址，授權同意頁在 `${WEB_URL}/oauth/consent`。
 *   • MCP_ALLOWED_ORIGINS（選用）：額外允許的瀏覽器 Origin（逗號分隔）。
 */

export const ACCESS_TOKEN_TTL_SEC = 60 * 60 // 1 小時
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60 // 30 天（每次 refresh 輪替、重新起算）
export const AUTH_CODE_TTL_SEC = 5 * 60
export const AUTH_REQUEST_TTL_SEC = 10 * 60
export const CONFIRM_TOKEN_TTL_SEC = 5 * 60
export const PENDING_ACTION_TTL_SEC = 10 * 60
export const MAX_OAUTH_CLIENTS = 1000
export const CLIENT_IDLE_PRUNE_DAYS = 90
export const PAT_DEFAULT_DAYS = 90
export const PAT_MAX_DAYS = 365
export const MCP_SCOPE = "aster"
export const SUPPORTED_SCOPES = [MCP_SCOPE, "offline_access"] as const

export const TOKEN_PREFIX = {
  access: "aster_at_",
  refresh: "aster_rt_",
  pat: "aster_pat_",
  code: "aster_ac_",
  client: "aster_c_",
  clientSecret: "aster_cs_",
  confirm: "cfm_",
} as const

/** 官方用戶端的 Origin（claude.ai／Claude 桌面、ChatGPT）。沒帶 Origin（伺服器對伺服器）一律放行。 */
const BUILTIN_ORIGINS = ["https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://chat.openai.com"]

export class McpNotConfiguredError extends Error {
  constructor() {
    super("mcp_not_configured")
  }
}

export function tokenSecret(): string {
  const secret = process.env.MCP_TOKEN_SECRET?.trim()
  if (!secret || secret.length < 32) throw new McpNotConfiguredError()
  return secret
}

export function isMcpConfigured(): boolean {
  const secret = process.env.MCP_TOKEN_SECRET?.trim()
  return !!secret && secret.length >= 32
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

/** API 對外 base URL（OAuth issuer）。 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.MCP_PUBLIC_URL?.trim()
  if (configured) return stripSlash(configured)
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol || "http"
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.get("host") || "localhost"
  return `${proto}://${host}`
}

/** MCP 端點（也是 RFC 8707 resource／RFC 9728 resource 的值）。 */
export function mcpResourceUrl(req: Request): string {
  return `${publicBaseUrl(req)}/mcp`
}

export function webBaseUrl(): string {
  return stripSlash(process.env.WEB_URL?.trim() || "https://aster-system.vercel.app")
}

export function allowedOrigins(): string[] {
  const fromEnv = [process.env.WEB_ORIGINS, process.env.MCP_ALLOWED_ORIGINS]
    .flatMap((v) => (v ?? "").split(","))
    .map((o) => stripSlash(o.trim()))
    .filter(Boolean)
  return [...new Set([...BUILTIN_ORIGINS, ...fromEnv])]
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  return allowedOrigins().includes(stripSlash(origin))
}

/** resource 參數（RFC 8707）比對：接受 MCP 端點或 API base，忽略結尾斜線。 */
export function isAcceptableResource(req: Request, resource: string | undefined | null): boolean {
  if (!resource) return true
  const r = stripSlash(resource)
  return r === mcpResourceUrl(req) || r === publicBaseUrl(req)
}
