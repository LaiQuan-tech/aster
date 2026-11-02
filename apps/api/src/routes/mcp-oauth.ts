import express, { Router, type NextFunction, type Request, type Response } from "express"
import cors from "cors"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { bearerOf, isInternalToken } from "../lib/internal-identity.js"
import { logger } from "../lib/logger.js"
import { writeAuditLog } from "../services/audit.js"
import {
  AUTH_REQUEST_TTL_SEC,
  CLIENT_IDLE_PRUNE_DAYS,
  MAX_OAUTH_CLIENTS,
  MCP_SCOPE,
  McpNotConfiguredError,
  SUPPORTED_SCOPES,
  TOKEN_PREFIX,
  isAcceptableResource,
  isMcpConfigured,
  mcpResourceUrl,
  publicBaseUrl,
  webBaseUrl,
} from "../services/mcp/config.js"
import { hashToken, randomToken, safeEqual, signBlob, verifyBlob, verifyPkceS256 } from "../services/mcp/crypto.js"
import { activeEmployeeOf, checkAccount } from "../services/mcp/identity.js"
import {
  consumeAuthCode,
  consumeRefreshToken,
  createAuthCode,
  createGrant,
  findToken,
  getClient,
  getGrant,
  insertClient,
  isExpired,
  issueOAuthTokens,
  linkCodeToGrant,
  pruneAndCountClients,
  revokeGrant,
  touchClient,
  type OAuthClient,
} from "../services/mcp/store.js"

/**
 * MCP 的 OAuth 2.1 授權伺服器＋受保護資源中繼資料（2026-11-02）。
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server[/mcp] RFC 8414（也回 /.well-known/openid-configuration 同內容的子集）
 *   POST /oauth/register                                RFC 7591 動態用戶端註冊（公開用戶端 none，或 client_secret_post／basic）
 *   GET  /oauth/authorize                               驗參數（client、redirect_uri 精確比對、PKCE S256、resource）→ 302 到後台同意頁
 *   GET  /oauth/authorize/describe?req=                 同意頁讀用戶端名稱（簽章 blob，不落 DB）
 *   POST /oauth/authorize/decision                      同意頁送出（Supabase 登入身分）→ 回 redirect_to（帶 code 或 access_denied）
 *   POST /oauth/token                                   authorization_code（PKCE 必須）／refresh_token（輪替、重放偵測）
 *   POST /oauth/revoke                                  RFC 7009（撤銷整個授權）
 *
 * 授權頁的「登入」用既有亞斯特帳號（Supabase）；這裡發的 token 是不透明亂數，DB 只存 HMAC 雜湊。
 */

export const mcpPublicRouter = Router()

const OAUTH_PATHS = ["/.well-known", "/oauth"]

const consentCors = cors({
  origin: (process.env.WEB_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  credentials: true,
})

// 外部用戶端（瀏覽器版 MCP Inspector 等）會跨網域打中繼資料／註冊／token：這幾支開放 CORS（不帶 cookie）。
mcpPublicRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!OAUTH_PATHS.some((p) => req.path.startsWith(p))) return next()
  // 同意頁用的兩支（describe／decision）只給後台網域（WEB_ORIGINS，與全站 CORS 同一份）。
  if (req.path.startsWith("/oauth/authorize/")) return consentCors(req, res, next)
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
  if (req.method === "OPTIONS") {
    res.status(204).end()
    return
  }
  next()
})

mcpPublicRouter.use(["/oauth/token", "/oauth/revoke", "/oauth/register"], express.urlencoded({ extended: false, limit: "64kb" }))
mcpPublicRouter.use(["/oauth/token", "/oauth/revoke", "/oauth/register"], express.json({ limit: "64kb" }))

function notConfigured(res: Response) {
  res.status(503).json({ error: "mcp_not_configured", error_description: "MCP 連接尚未設定（缺 MCP_TOKEN_SECRET）" })
}

function guardConfigured(_req: Request, res: Response, next: NextFunction) {
  if (!isMcpConfigured()) return notConfigured(res)
  next()
}

// ── 中繼資料 ──────────────────────────────────────────────────────────

function protectedResourceMetadata(req: Request) {
  return {
    resource: mcpResourceUrl(req),
    authorization_servers: [publicBaseUrl(req)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "亞斯特 HR 系統",
    resource_documentation: `${webBaseUrl()}/admin/settings/ai-access`,
  }
}

function authorizationServerMetadata(req: Request) {
  const base = publicBaseUrl(req)
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...SUPPORTED_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${webBaseUrl()}/admin/settings/ai-access`,
  }
}

mcpPublicRouter.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300")
  res.json(protectedResourceMetadata(req))
})

mcpPublicRouter.get(
  [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/mcp",
  ],
  (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300")
    res.json(authorizationServerMetadata(req))
  },
)

// ── 動態用戶端註冊（RFC 7591）──────────────────────────────────────────

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const

/** redirect_uri：https，或 http 的 loopback（localhost／127.0.0.1／[::1]，給 Claude Code 等本機用戶端）；不得含 fragment。 */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 500) return false
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.hash || url.username || url.password) return false
  if (url.protocol === "https:") return true
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  return false
}

// 簡單的每 IP 註冊頻率限制（serverless 每個實例各算，只是防呆，不是防禦主力）。
const registerHits = new Map<string, number[]>()
function registerRateLimited(ip: string): boolean {
  const now = Date.now()
  const hits = (registerHits.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000)
  hits.push(now)
  registerHits.set(ip, hits)
  if (registerHits.size > 5000) registerHits.clear()
  return hits.length > 30
}

function registrationError(res: Response, error: string, description: string) {
  res.status(400).json({ error, error_description: description })
}

mcpPublicRouter.post("/oauth/register", guardConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?"
    if (registerRateLimited(ip)) {
      res.status(429).json({ error: "too_many_requests", error_description: "註冊太頻繁，請稍後再試" })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const redirectUris = body.redirect_uris
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10) {
      return registrationError(res, "invalid_redirect_uri", "redirect_uris 必須是 1–10 個網址")
    }
    if (!redirectUris.every(isAllowedRedirectUri)) {
      return registrationError(res, "invalid_redirect_uri", "redirect_uri 只接受 https，或 http://localhost／127.0.0.1（不得含 #fragment）")
    }
    const method = (body.token_endpoint_auth_method ?? "none") as string
    if (!(AUTH_METHODS as readonly string[]).includes(method)) {
      return registrationError(res, "invalid_client_metadata", "token_endpoint_auth_method 只支援 none、client_secret_post、client_secret_basic")
    }
    const grantTypes = (body.grant_types ?? ["authorization_code", "refresh_token"]) as unknown
    if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
      return registrationError(res, "invalid_client_metadata", "grant_types 只支援 authorization_code、refresh_token")
    }
    const responseTypes = (body.response_types ?? ["code"]) as unknown
    if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === "code")) {
      return registrationError(res, "invalid_client_metadata", "response_types 只支援 code")
    }
    const rawName = typeof body.client_name === "string" ? body.client_name.replace(/[\x00-\x1f\x7f]/g, "").trim() : ""
    const clientName = (rawName || "MCP 用戶端").slice(0, 100)
    // 總量上限＋順便清掉 90 天沒用的用戶端（資安驗收 L2）。
    if ((await pruneAndCountClients(CLIENT_IDLE_PRUNE_DAYS, MAX_OAUTH_CLIENTS)) >= MAX_OAUTH_CLIENTS) {
      res.status(503).json({ error: "temporarily_unavailable", error_description: "已註冊的用戶端數量達上限，請聯絡管理員" })
      return
    }
    const clientId = randomToken(TOKEN_PREFIX.client, 16)
    const clientSecret = method === "none" ? null : randomToken(TOKEN_PREFIX.clientSecret)
    const metadata: Record<string, unknown> = {}
    for (const key of ["client_uri", "logo_uri", "software_id", "software_version", "scope"]) {
      if (typeof body[key] === "string") metadata[key] = (body[key] as string).slice(0, 300)
    }
    await insertClient({
      client_id: clientId,
      client_secret_hash: clientSecret ? hashToken(clientSecret) : null,
      client_name: clientName,
      redirect_uris: redirectUris as string[],
      token_endpoint_auth_method: method,
      metadata,
    })
    res.setHeader("Cache-Control", "no-store")
    res.status(201).json({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: grantTypes,
      response_types: ["code"],
      ...metadata,
    })
  } catch (err) {
    next(err)
  }
})

// ── 授權端點 ──────────────────────────────────────────────────────────

interface AuthRequest {
  client_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  state: string | null
  resource: string | null
  exp: number
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  return url.toString()
}

function plainError(res: Response, status: number, message: string) {
  res.status(status).type("text/plain; charset=utf-8").send(`授權失敗：${message}`)
}

mcpPublicRouter.get("/oauth/authorize", guardConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query as Record<string, unknown>
    const clientId = str(q.client_id)
    const client = clientId ? await getClient(clientId) : null
    if (!client) return plainError(res, 400, "未知的 client_id（請重新加入連接器）")
    let redirectUri = str(q.redirect_uri)
    if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0]
    // redirect_uri 必須與註冊值完全相同（逐字比對）；不符就不轉回去（避免開放轉址）。
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return plainError(res, 400, "redirect_uri 與註冊值不符")
    const state = str(q.state) ?? null
    const iss = publicBaseUrl(req)
    const fail = (error: string, description: string) =>
      res.redirect(302, redirectWith(redirectUri as string, { error, error_description: description, state, iss }))

    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type 必須是 code")
    const challenge = str(q.code_challenge)
    if (!challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9\-_]{43}$/.test(challenge)) {
      return fail("invalid_request", "必須使用 PKCE（code_challenge_method=S256）")
    }
    const resource = str(q.resource) ?? null
    if (!isAcceptableResource(req, resource)) return fail("invalid_target", "resource 不是本 MCP 伺服器")
    const requested = (str(q.scope) ?? MCP_SCOPE).split(/\s+/).filter(Boolean)
    const unknown = requested.filter((s) => !(SUPPORTED_SCOPES as readonly string[]).includes(s))
    if (unknown.length) return fail("invalid_scope", `不支援的 scope：${unknown.join(" ")}`)
    const scope = [...new Set([MCP_SCOPE, ...requested])].join(" ")

    const blob = signBlob("authreq", {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      scope,
      state,
      resource,
      exp: Math.floor(Date.now() / 1000) + AUTH_REQUEST_TTL_SEC,
    } satisfies AuthRequest)
    res.redirect(302, `${webBaseUrl()}/oauth/consent?req=${encodeURIComponent(blob)}`)
  } catch (err) {
    next(err)
  }
})

async function loadAuthRequest(blob: unknown): Promise<{ request: AuthRequest; client: OAuthClient } | null> {
  const request = verifyBlob<AuthRequest>("authreq", typeof blob === "string" ? blob : null)
  if (!request || request.exp * 1000 < Date.now()) return null
  const client = await getClient(request.client_id)
  if (!client || !client.redirect_uris.includes(request.redirect_uri)) return null
  return { request, client }
}

mcpPublicRouter.get("/oauth/authorize/describe", guardConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const loaded = await loadAuthRequest(req.query.req)
    if (!loaded) {
      res.status(400).json({ error: "invalid_request", message: "授權連結無效或已過期，請回到 AI 工具重新連接" })
      return
    }
    res.setHeader("Cache-Control", "no-store")
    res.json({
      clientName: loaded.client.client_name,
      redirectHost: new URL(loaded.request.redirect_uri).host,
      scope: loaded.request.scope,
      expiresAt: new Date(loaded.request.exp * 1000).toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

mcpPublicRouter.post(
  "/oauth/authorize/decision",
  express.json({ limit: "16kb" }),
  guardConfigured,
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // MCP 程序內派送的身分不得替自己授權（AI 不能自己按同意）。
      if (isInternalToken(bearerOf(req.headers.authorization))) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const loaded = await loadAuthRequest((req.body ?? {}).req)
      if (!loaded) {
        res.status(400).json({ error: "invalid_request", message: "授權連結無效或已過期，請回到 AI 工具重新連接" })
        return
      }
      const { request } = loaded
      const iss = publicBaseUrl(req)
      if ((req.body ?? {}).approve !== true) {
        res.json({ redirect_to: redirectWith(request.redirect_uri, { error: "access_denied", error_description: "使用者拒絕授權", state: request.state, iss }) })
        return
      }
      const tenantId = res.locals.tenantId as string
      const userId = req.auth!.userId
      const employee = await activeEmployeeOf(tenantId, userId)
      if (!employee) {
        res.status(403).json({ error: "inactive_account", message: "帳號已停用或不在此公司，無法授權" })
        return
      }
      const code = await createAuthCode({
        client_id: request.client_id,
        tenant_id: tenantId,
        user_id: userId,
        employee_id: employee.id,
        redirect_uri: request.redirect_uri,
        code_challenge: request.code_challenge,
        scope: request.scope,
        resource: request.resource,
      })
      res.setHeader("Cache-Control", "no-store")
      res.json({ redirect_to: redirectWith(request.redirect_uri, { code, state: request.state, iss }) })
    } catch (err) {
      next(err)
    }
  },
)

// ── token 端點 ────────────────────────────────────────────────────────

function tokenError(res: Response, status: number, error: string, description: string) {
  res.setHeader("Cache-Control", "no-store")
  res.status(status).json({ error, error_description: description })
}

/** 用戶端認證：公開用戶端只看 client_id；機密用戶端驗 client_secret（post 或 basic）。 */
async function authenticateClient(req: Request): Promise<OAuthClient | null> {
  const body = (req.body ?? {}) as Record<string, unknown>
  let clientId = str(body.client_id)
  let secret = str(body.client_secret)
  const header = req.headers.authorization
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
    const idx = decoded.indexOf(":")
    if (idx > 0) {
      clientId = decodeURIComponent(decoded.slice(0, idx))
      secret = decodeURIComponent(decoded.slice(idx + 1))
    }
  }
  if (!clientId) return null
  const client = await getClient(clientId)
  if (!client) return null
  if (client.token_endpoint_auth_method === "none") return client
  if (!secret || !client.client_secret_hash || !safeEqual(hashToken(secret), client.client_secret_hash)) return null
  return client
}

mcpPublicRouter.post("/oauth/token", guardConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const client = await authenticateClient(req)
    if (!client) return tokenError(res, 401, "invalid_client", "用戶端認證失敗")
    const grantType = str(body.grant_type)

    if (grantType === "authorization_code") {
      const code = str(body.code)
      if (!code) return tokenError(res, 400, "invalid_request", "缺 code")
      const { row, replay } = await consumeAuthCode(code)
      if (!row) {
        // 授權碼重放：撤銷用它發出的整個授權（RFC 6749 §4.1.2）。
        if (replay?.grant_id) await revokeGrant(replay.grant_id)
        return tokenError(res, 400, "invalid_grant", "授權碼無效或已使用")
      }
      if (row.client_id !== client.client_id) return tokenError(res, 400, "invalid_grant", "授權碼不屬於這個用戶端")
      if (isExpired(row.expires_at)) return tokenError(res, 400, "invalid_grant", "授權碼已過期")
      if (str(body.redirect_uri) !== row.redirect_uri) return tokenError(res, 400, "invalid_grant", "redirect_uri 不符")
      if (!verifyPkceS256(str(body.code_verifier), row.code_challenge)) return tokenError(res, 400, "invalid_grant", "PKCE 驗證失敗")
      const resource = str(body.resource) ?? null
      if (resource && (!isAcceptableResource(req, resource) || (row.resource && resource.replace(/\/+$/, "") !== row.resource.replace(/\/+$/, "")))) {
        return tokenError(res, 400, "invalid_target", "resource 不符")
      }
      const account = await checkAccount(row.tenant_id, row.user_id)
      if (!account) return tokenError(res, 400, "invalid_grant", "帳號已停用或租戶已變更")
      const grant = await createGrant({
        tenant_id: row.tenant_id,
        user_id: row.user_id,
        employee_id: account.employee.id,
        kind: "oauth",
        client_id: client.client_id,
        client_name: client.client_name,
        scope: row.scope,
        resource: row.resource ?? resource ?? mcpResourceUrl(req),
      })
      await linkCodeToGrant(row.code_hash, grant.id)
      void touchClient(client.client_id)
      const tokens = await issueOAuthTokens(grant.id)
      await writeAuditLog({
        tenantId: row.tenant_id,
        tableName: "mcp_grants",
        recordId: grant.id,
        action: "INSERT",
        actorEmpId: account.employee.id,
        context: "MCP OAuth 授權",
        newRow: { kind: "oauth", client_name: client.client_name, client_id: client.client_id },
      })
      res.setHeader("Cache-Control", "no-store")
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: row.scope ?? MCP_SCOPE,
      })
      return
    }

    if (grantType === "refresh_token") {
      const refreshToken = str(body.refresh_token)
      if (!refreshToken) return tokenError(res, 400, "invalid_request", "缺 refresh_token")
      const { row, reused } = await consumeRefreshToken(refreshToken)
      if (!row) {
        // refresh token 重複使用＝疑似外洩：整個授權撤銷。
        if (reused) {
          await revokeGrant(reused.grant_id)
          logger.warn({ grantId: reused.grant_id }, "mcp refresh token reuse detected; grant revoked")
        }
        return tokenError(res, 400, "invalid_grant", "refresh_token 無效或已使用")
      }
      if (row.revoked_at || isExpired(row.expires_at)) return tokenError(res, 400, "invalid_grant", "refresh_token 已失效")
      const grant = await getGrant(row.grant_id)
      if (!grant || grant.revoked_at || grant.kind !== "oauth") return tokenError(res, 400, "invalid_grant", "授權已撤銷")
      if (grant.client_id !== client.client_id) return tokenError(res, 400, "invalid_grant", "refresh_token 不屬於這個用戶端")
      const account = await checkAccount(grant.tenant_id, grant.user_id)
      if (!account) return tokenError(res, 400, "invalid_grant", "帳號已停用或租戶已變更")
      const tokens = await issueOAuthTokens(grant.id)
      void touchClient(client.client_id)
      res.setHeader("Cache-Control", "no-store")
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: grant.scope ?? MCP_SCOPE,
      })
      return
    }

    return tokenError(res, 400, "unsupported_grant_type", "只支援 authorization_code、refresh_token")
  } catch (err) {
    if (err instanceof McpNotConfiguredError) return notConfigured(res)
    next(err)
  }
})

// ── 撤銷（RFC 7009）───────────────────────────────────────────────────

mcpPublicRouter.post("/oauth/revoke", guardConfigured, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await authenticateClient(req)
    if (!client) return tokenError(res, 401, "invalid_client", "用戶端認證失敗")
    const token = str((req.body ?? {}).token)
    if (token) {
      const row = await findToken(token)
      if (row) {
        const grant = await getGrant(row.grant_id)
        // 只能撤銷自己（這個用戶端）發出的 token；個人金鑰請到後台撤銷。
        if (grant && grant.kind === "oauth" && grant.client_id === client.client_id && !grant.revoked_at) {
          await revokeGrant(grant.id)
          await writeAuditLog({
            tenantId: grant.tenant_id,
            tableName: "mcp_grants",
            recordId: grant.id,
            action: "UPDATE",
            actorEmpId: grant.employee_id,
            context: "MCP OAuth 撤銷（用戶端）",
            newRow: { revoked: true, client_name: grant.client_name },
          })
        }
      }
    }
    // RFC 7009：不論 token 是否有效都回 200。
    res.setHeader("Cache-Control", "no-store")
    res.status(200).json({})
  } catch (err) {
    next(err)
  }
})
