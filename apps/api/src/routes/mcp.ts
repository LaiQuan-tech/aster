import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express"
import type { IncomingMessage, RequestListener } from "node:http"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { bearerOf } from "../lib/internal-identity.js"
import { logger } from "../lib/logger.js"
import { MCP_SCOPE, isMcpConfigured, isOriginAllowed, publicBaseUrl } from "../services/mcp/config.js"
import { resolveMcpIdentity } from "../services/mcp/identity.js"
import { createMcpServer } from "../services/mcp/tools.js"

/**
 * MCP 端點（Streamable HTTP，stateless；2026-11-02）。
 *
 * 放在 apps/api（同一個 Vercel 專案 aster-hr-api）的理由：工具要在程序內以使用者身分打既有 Express routes
 * （services/mcp/dispatch.ts），跟 API 同程序才不用再過一次網路、也不必把使用者 token 往外送。
 *
 * stateless：每個 POST 建一個新的 McpServer＋transport（sessionIdGenerator: undefined、回 JSON 不開 SSE），
 * 不依賴 serverless 實例黏著。GET（SSE 通知串流）與 DELETE（結束 session）在 stateless 下回 405。
 * 認證：Authorization: Bearer <OAuth access token 或個人金鑰>；缺或無效 → 401 帶
 * WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"（RFC 9728）。
 * Origin：有帶就要在允許清單（claude.ai、chatgpt.com、後台網域…）；沒帶＝伺服器對伺服器，放行。
 */

export const mcpRouter = Router()

const MCP_PATH = "/mcp"

function setCors(req: Request, res: Response) {
  const origin = req.headers.origin
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID")
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate")
  }
}

function unauthorized(req: Request, res: Response, invalid: boolean) {
  const metadata = `${publicBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${metadata}", scope="${MCP_SCOPE}"${invalid ? ', error="invalid_token", error_description="token is invalid, expired, revoked, or the account is disabled"' : ""}`,
  )
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: invalid ? "invalid_token" : "unauthorized" },
    id: null,
  })
}

const originGuard: RequestHandler = (req, res, next) => {
  setCors(req, res)
  if (!isOriginAllowed(req.headers.origin)) {
    res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "origin_not_allowed" }, id: null })
    return
  }
  next()
}

mcpRouter.options(MCP_PATH, originGuard, (_req, res) => {
  res.status(204).end()
})

mcpRouter.post(MCP_PATH, originGuard, express.json({ limit: "4mb" }), async (req: Request, res: Response, next: NextFunction) => {
  if (!isMcpConfigured()) {
    res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "mcp_not_configured" }, id: null })
    return
  }
  const bearer = bearerOf(req.headers.authorization)
  if (!bearer) return unauthorized(req, res, false)
  let identity
  try {
    identity = await resolveMcpIdentity(bearer)
  } catch (err) {
    return next(err)
  }
  if (!identity) return unauthorized(req, res, true)

  const server = createMcpServer({ app: req.app as unknown as RequestListener, identity })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on("close", () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    // req.auth 是本專案的 AuthedUser（/mcp 不跑 requireAuth，這裡永遠是 undefined），型別與 SDK 的 AuthInfo 撞名，轉型即可。
    await transport.handleRequest(req as unknown as IncomingMessage, res, req.body)
  } catch (err) {
    logger.error({ err }, "mcp request failed")
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal_error" }, id: null })
    }
  }
})

const methodNotAllowed: RequestHandler = (req, res) => {
  // 沒帶 token 的探測先回 401（讓用戶端走 OAuth 探索）；帶了才說明不支援。
  if (!bearerOf(req.headers.authorization)) return unauthorized(req, res, false)
  res.setHeader("Allow", "POST, OPTIONS")
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "method_not_allowed（本伺服器為 stateless，不提供 SSE／session）" }, id: null })
}
mcpRouter.get(MCP_PATH, originGuard, methodNotAllowed)
mcpRouter.delete(MCP_PATH, originGuard, methodNotAllowed)
