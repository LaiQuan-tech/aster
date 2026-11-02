import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { bearerOf, isInternalToken } from "../lib/internal-identity.js"
import { writeAuditLog } from "../services/audit.js"
import { MCP_SCOPE, PAT_DEFAULT_DAYS, PAT_MAX_DAYS, TOKEN_PREFIX, isMcpConfigured } from "../services/mcp/config.js"
import { randomToken } from "../services/mcp/crypto.js"
import { activeEmployeeOf } from "../services/mcp/identity.js"
import {
  McpStoreError,
  createGrant,
  decidePendingAction,
  finishPendingAction,
  getGrant,
  getPendingAction,
  isExpired,
  issuePat,
  listGrants,
  listPendingActions,
  revokeGrant,
  type GrantRow,
  type PendingActionRow,
} from "../services/mcp/store.js"
import type { RequestListener } from "node:http"
import { viaLabel } from "../lib/internal-identity.js"
import { canonicalizePath, isBlockedPath } from "../services/mcp/catalog.js"
import { dispatchAsUser } from "../services/mcp/dispatch.js"
import { formatResult } from "../services/mcp/tools.js"
import { dangerFieldsOf } from "../services/mcp/pending-target.js"
import { clientIpOf } from "../lib/client-ip.js"

/**
 * 個人存取金鑰與已授權 AI 應用（後台「設定 → AI 連接」；本人自助，2026-11-02）。
 *
 *   GET    /me/mcp/keys          我的個人金鑰（不含金鑰本身，只有前綴）
 *   POST   /me/mcp/keys          產生金鑰 { name, expiresInDays? } → 金鑰明文只在這次回應出現一次
 *   DELETE /me/mcp/keys/:id      撤銷
 *   GET    /me/mcp/grants        已授權的 OAuth 應用（claude.ai、ChatGPT…）
 *   DELETE /me/mcp/grants/:id    撤銷
 *   GET    /me/mcp/pending       我的待確認操作（最高風險操作由 AI 建立、等我在後台確認）
 *   GET    /me/mcp/pending/:id   單筆（只看得到自己、本租戶的）
 *   POST   /me/mcp/pending/:id/decision { approve }  確認執行（以我的身分、重新檢查權限）或拒絕
 *
 * 一律只動「自己、本租戶」的列。MCP 程序內派送的身分不能打這組（AI 不能替自己發金鑰），
 * services/mcp/catalog.ts 也把 /me/mcp 列為封鎖路徑（雙重保險）。
 */

export const mcpKeysRouter = Router()

function blockInternal(req: Request, res: Response, next: NextFunction) {
  if (isInternalToken(bearerOf(req.headers.authorization))) {
    res.status(403).json({ error: "forbidden", message: "AI 連線不能管理金鑰與授權" })
    return
  }
  if (!isMcpConfigured()) {
    res.status(503).json({ error: "mcp_not_configured", message: "MCP 連接尚未設定（缺 MCP_TOKEN_SECRET）" })
    return
  }
  next()
}

const guards = [requireAuth, requireTenant, blockInternal]

function keyView(g: GrantRow) {
  return {
    id: g.id,
    name: g.client_name,
    prefix: g.token_prefix,
    createdAt: g.created_at,
    lastUsedAt: g.last_used_at,
    expiresAt: g.expires_at,
  }
}

function grantView(g: GrantRow) {
  return { id: g.id, clientName: g.client_name, createdAt: g.created_at, lastUsedAt: g.last_used_at }
}

function handleError(err: unknown, res: Response, next: NextFunction) {
  // 表還沒套（migration 0082 未套用）→ 409 migration_required，頁面顯示「尚未啟用」。
  if (err instanceof McpStoreError && /mcp_|relation|schema cache/i.test(err.message)) {
    res.status(409).json({ error: "migration_required", message: "AI 連接功能的資料表尚未建立" })
    return
  }
  next(err)
}

mcpKeysRouter.get("/me/mcp/keys", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = Date.now()
    const rows = await listGrants(res.locals.tenantId as string, req.auth!.userId, "pat")
    res.json({ keys: rows.filter((g) => !g.expires_at || Date.parse(g.expires_at) > now).map(keyView) })
  } catch (err) {
    handleError(err, res, next)
  }
})

const createKeyBody = z.object({
  name: z.string().trim().min(1).max(60),
  expiresInDays: z.number().int().min(1).max(PAT_MAX_DAYS).optional(),
})

mcpKeysRouter.post("/me/mcp/keys", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = createKeyBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", message: `名稱必填（60 字內），有效天數 1–${PAT_MAX_DAYS}` })
    return
  }
  try {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth!.userId
    const employee = await activeEmployeeOf(tenantId, userId)
    if (!employee) {
      res.status(403).json({ error: "inactive_account", message: "帳號已停用，無法產生金鑰" })
      return
    }
    const token = randomToken(TOKEN_PREFIX.pat)
    const days = parsed.data.expiresInDays ?? PAT_DEFAULT_DAYS
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
    const grant = await createGrant({
      tenant_id: tenantId,
      user_id: userId,
      employee_id: employee.id,
      kind: "pat",
      client_id: null,
      client_name: parsed.data.name,
      scope: MCP_SCOPE,
      resource: null,
      token_prefix: `${token.slice(0, TOKEN_PREFIX.pat.length + 6)}…`,
      expires_at: expiresAt,
    })
    await issuePat(grant.id, token, expiresAt)
    await writeAuditLog({
      tenantId,
      tableName: "mcp_grants",
      recordId: grant.id,
      action: "INSERT",
      actorEmpId: employee.id,
      context: "MCP 個人金鑰產生",
      newRow: { kind: "pat", name: parsed.data.name, expires_at: expiresAt },
    })
    res.setHeader("Cache-Control", "no-store")
    res.status(201).json({ ...keyView(grant), token })
  } catch (err) {
    handleError(err, res, next)
  }
})

async function revokeOwn(kind: "pat" | "oauth", req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth!.userId
    const id = String(req.params.id)
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const mine = (await listGrants(tenantId, userId, kind)).find((g) => g.id === id)
    if (!mine) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const revoked = await revokeGrant(id, { tenantId, userId })
    if (!revoked) {
      res.status(404).json({ error: "not_found" })
      return
    }
    await writeAuditLog({
      tenantId,
      tableName: "mcp_grants",
      recordId: id,
      action: "UPDATE",
      actorEmpId: mine.employee_id,
      context: kind === "pat" ? "MCP 個人金鑰撤銷" : "MCP OAuth 授權撤銷",
      oldRow: { revoked_at: null },
      newRow: { revoked_at: revoked.revoked_at, name: mine.client_name },
    })
    res.json({ id, revoked: true })
  } catch (err) {
    handleError(err, res, next)
  }
}

mcpKeysRouter.delete("/me/mcp/keys/:id", ...guards, (req, res, next) => revokeOwn("pat", req, res, next))

mcpKeysRouter.get("/me/mcp/grants", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listGrants(res.locals.tenantId as string, req.auth!.userId, "oauth")
    res.json({ grants: rows.map(grantView) })
  } catch (err) {
    handleError(err, res, next)
  }
})

mcpKeysRouter.delete("/me/mcp/grants/:id", ...guards, (req, res, next) => revokeOwn("oauth", req, res, next))

// ── 最高風險操作：待確認（資安驗收 M4）──────────────────────────────────

function pendingView(row: PendingActionRow) {
  return {
    id: row.id,
    clientName: row.client_name,
    method: row.method,
    path: row.path,
    query: row.query,
    body: row.body,
    summary: row.summary,
    targetSummary: row.target_summary,
    dangerFields: dangerFieldsOf(row.body).fields,
    dangerFieldsMore: dangerFieldsOf(row.body).more,
    status: row.status,
    resultStatus: row.result_status,
    result: row.result,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  }
}

mcpKeysRouter.get("/me/mcp/pending", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listPendingActions({ tenantId: res.locals.tenantId as string, userId: req.auth!.userId })
    res.setHeader("Cache-Control", "no-store")
    res.json({ actions: rows.map(pendingView) })
  } catch (err) {
    handleError(err, res, next)
  }
})

mcpKeysRouter.get("/me/mcp/pending/:id", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await getPendingAction(String(req.params.id), { tenantId: res.locals.tenantId as string, userId: req.auth!.userId })
    if (!row) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.setHeader("Cache-Control", "no-store")
    res.json(pendingView(row))
  } catch (err) {
    handleError(err, res, next)
  }
})

mcpKeysRouter.post("/me/mcp/pending/:id/decision", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth!.userId
    const scope = { tenantId, userId }
    const id = String(req.params.id)
    const existing = await getPendingAction(id, scope)
    if (!existing) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const approve = (req.body ?? {}).approve === true
    const claimed = await decidePendingAction(id, scope, approve ? "executing" : "rejected")
    if (!claimed) {
      res.status(409).json({ error: "not_pending", message: "這筆操作已決定過或已逾時", status: existing.status })
      return
    }
    if (!approve) {
      res.json(pendingView(claimed))
      return
    }
    // 執行前重新檢查：帳號仍在職、路徑仍合法；權限由既有 route 以「此刻的我」重新判斷。
    const employee = await activeEmployeeOf(tenantId, userId)
    const canon = canonicalizePath(claimed.path)
    if (!employee || "error" in canon || canon.canon !== claimed.path || isBlockedPath(canon.canon)) {
      await finishPendingAction(id, { status: "failed", resultStatus: null, result: "帳號已停用或路徑不合法，未執行" })
      res.status(403).json({ error: "forbidden", message: "帳號已停用或路徑不合法，未執行" })
      return
    }
    // 來源授權／金鑰必須仍有效（資安複驗 N3）：撤銷後建立的待確認不得再執行。
    const grant = claimed.grant_id ? await getGrant(claimed.grant_id) : null
    if (!grant || grant.revoked_at || isExpired(grant.expires_at)) {
      await finishPendingAction(id, { status: "failed", resultStatus: null, result: "來源 AI 授權或金鑰已撤銷／過期，未執行" })
      res.status(409).json({ error: "grant_revoked", message: "來源 AI 授權或金鑰已撤銷／過期，未執行" })
      return
    }
    let result
    try {
      result = await dispatchAsUser(
        req.app as unknown as RequestListener,
        req.auth!,
        `${claimed.client_name} confirmed`,
        { method: claimed.method, path: claimed.path, query: claimed.query ?? undefined, body: claimed.body ?? undefined },
        { clientIp: clientIpOf(req) },
      )
    } catch (err) {
      // 執行拋錯 → failed＋錯誤訊息，不留在 executing。
      await finishPendingAction(id, { status: "failed", resultStatus: null, result: `執行失敗：${err instanceof Error ? err.message : String(err)}` })
      res.status(502).json({ error: "execution_failed", message: "執行失敗，請到後台查核是否已生效" })
      return
    }
    const text = (formatResult(result, {}).content[0] as { text: string }).text
    await finishPendingAction(id, { status: result.status < 400 ? "done" : "failed", resultStatus: result.status, result: text })
    await writeAuditLog({
      tenantId,
      tableName: "mcp_calls",
      recordId: id,
      action: "INSERT",
      actorEmpId: employee.id,
      context: `[mcp:${viaLabel(claimed.client_name)} confirmed] ${claimed.method} ${claimed.path}`,
      newRow: {
        via: "mcp",
        client: claimed.client_name,
        grant_id: claimed.grant_id,
        method: claimed.method,
        path: claimed.path,
        status: result.status,
        confirmed: "web",
        pending_action_id: id,
      },
    })
    const after = await getPendingAction(id, scope)
    res.json(pendingView(after ?? claimed))
  } catch (err) {
    handleError(err, res, next)
  }
})
