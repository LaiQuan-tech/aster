import { supabaseAdmin } from "../../lib/supabase.js"
import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_CODE_TTL_SEC,
  CONFIRM_TOKEN_TTL_SEC,
  PENDING_ACTION_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  TOKEN_PREFIX,
} from "./config.js"
import { hashToken, randomToken } from "./crypto.js"

/**
 * MCP 連接的資料存取（表定義見 packages/db/sql/0072_mcp_access.sql）。
 * 所有 token／授權碼／金鑰都只存 HMAC 雜湊（crypto.ts hashToken），明文只在發出當下回給呼叫端一次。
 * 一次性的東西（授權碼、refresh token、confirm_token）一律用「UPDATE … WHERE used_at IS NULL RETURNING」原子地消耗。
 */

export class McpStoreError extends Error {}

const iso = (ms: number) => new Date(ms).toISOString()
const nowIso = () => new Date().toISOString()

function fail(where: string, error: { message: string } | null): never {
  throw new McpStoreError(`${where}: ${error?.message ?? "unknown"}`)
}

// ── OAuth clients（DCR）────────────────────────────────────────────────

export interface OAuthClient {
  client_id: string
  client_secret_hash: string | null
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: string
}

export async function insertClient(row: OAuthClient & { metadata: Record<string, unknown> }): Promise<void> {
  const { error } = await supabaseAdmin.from("mcp_oauth_clients").insert(row)
  if (error) fail("insertClient", error)
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 200) return null
  const { data, error } = await supabaseAdmin
    .from("mcp_oauth_clients")
    .select("client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method")
    .eq("client_id", clientId)
    .maybeSingle()
  if (error) fail("getClient", error)
  return (data as OAuthClient | null) ?? null
}

// ── 授權碼 ────────────────────────────────────────────────────────────

export interface AuthCodeRow {
  code_hash: string
  client_id: string
  tenant_id: string
  user_id: string
  employee_id: string | null
  redirect_uri: string
  code_challenge: string
  scope: string | null
  resource: string | null
  expires_at: string
  used_at: string | null
  grant_id: string | null
}

export async function createAuthCode(input: Omit<AuthCodeRow, "code_hash" | "expires_at" | "used_at" | "grant_id">): Promise<string> {
  const code = randomToken(TOKEN_PREFIX.code)
  const { error } = await supabaseAdmin.from("mcp_oauth_codes").insert({
    ...input,
    code_hash: hashToken(code),
    expires_at: iso(Date.now() + AUTH_CODE_TTL_SEC * 1000),
  })
  if (error) fail("createAuthCode", error)
  return code
}

const CODE_COLS =
  "code_hash, client_id, tenant_id, user_id, employee_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at, grant_id"

/**
 * 原子地消耗授權碼。回 { row, replay }：
 *   • row 有值＝這次成功消耗（仍需呼叫端檢查到期、client、redirect_uri、PKCE）。
 *   • replay＝這個碼早就用過（RFC 6749 §4.1.2：應撤銷用它發出的 token）。
 */
export async function consumeAuthCode(code: string): Promise<{ row: AuthCodeRow | null; replay: AuthCodeRow | null }> {
  const codeHash = hashToken(code)
  const { data, error } = await supabaseAdmin
    .from("mcp_oauth_codes")
    .update({ used_at: nowIso() })
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .select(CODE_COLS)
  if (error) fail("consumeAuthCode", error)
  const row = ((data ?? []) as AuthCodeRow[])[0] ?? null
  if (row) return { row, replay: null }
  const { data: existing, error: e2 } = await supabaseAdmin
    .from("mcp_oauth_codes")
    .select(CODE_COLS)
    .eq("code_hash", codeHash)
    .maybeSingle()
  if (e2) fail("consumeAuthCode(lookup)", e2)
  return { row: null, replay: (existing as AuthCodeRow | null) ?? null }
}

export async function linkCodeToGrant(codeHash: string, grantId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("mcp_oauth_codes").update({ grant_id: grantId }).eq("code_hash", codeHash)
  if (error) fail("linkCodeToGrant", error)
}

// ── 授權（grant）＝一次 OAuth 授權或一把個人金鑰 ──────────────────────

export interface GrantRow {
  id: string
  tenant_id: string
  user_id: string
  employee_id: string | null
  kind: "oauth" | "pat"
  client_id: string | null
  client_name: string
  scope: string | null
  resource: string | null
  token_prefix: string | null
  expires_at: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

const GRANT_COLS =
  "id, tenant_id, user_id, employee_id, kind, client_id, client_name, scope, resource, token_prefix, expires_at, created_at, last_used_at, revoked_at"

export async function createGrant(input: {
  tenant_id: string
  user_id: string
  employee_id: string | null
  kind: "oauth" | "pat"
  client_id: string | null
  client_name: string
  scope: string | null
  resource: string | null
  token_prefix?: string | null
  expires_at?: string | null
}): Promise<GrantRow> {
  const { data, error } = await supabaseAdmin.from("mcp_grants").insert(input).select(GRANT_COLS)
  if (error) fail("createGrant", error)
  const row = ((data ?? []) as GrantRow[])[0]
  if (!row) fail("createGrant", { message: "no row returned" })
  return row
}

export async function getGrant(id: string): Promise<GrantRow | null> {
  const { data, error } = await supabaseAdmin.from("mcp_grants").select(GRANT_COLS).eq("id", id).maybeSingle()
  if (error) fail("getGrant", error)
  return (data as GrantRow | null) ?? null
}

export async function listGrants(tenantId: string, userId: string, kind: "oauth" | "pat"): Promise<GrantRow[]> {
  const { data, error } = await supabaseAdmin
    .from("mcp_grants")
    .select(GRANT_COLS)
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("kind", kind)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
  if (error) fail("listGrants", error)
  return (data ?? []) as GrantRow[]
}

/** 撤銷整個授權（連帶它所有 access／refresh token 失效：驗 token 時一律回查 grant.revoked_at）。 */
export async function revokeGrant(id: string, scope?: { tenantId: string; userId: string }): Promise<GrantRow | null> {
  let q = supabaseAdmin.from("mcp_grants").update({ revoked_at: nowIso() }).eq("id", id).is("revoked_at", null)
  if (scope) q = q.eq("tenant_id", scope.tenantId).eq("user_id", scope.userId)
  const { data, error } = await q.select(GRANT_COLS)
  if (error) fail("revokeGrant", error)
  return ((data ?? []) as GrantRow[])[0] ?? null
}

/** last_used_at 每 5 分鐘最多寫一次（避免每個 MCP 請求都寫 DB）。失敗不影響請求。 */
export async function touchGrant(grant: GrantRow): Promise<void> {
  const last = grant.last_used_at ? Date.parse(grant.last_used_at) : 0
  if (Date.now() - last < 5 * 60 * 1000) return
  try {
    await supabaseAdmin.from("mcp_grants").update({ last_used_at: nowIso() }).eq("id", grant.id)
  } catch {
    /* ignore */
  }
}

// ── token ────────────────────────────────────────────────────────────

export interface TokenRow {
  token_hash: string
  grant_id: string
  kind: "access" | "refresh" | "pat"
  expires_at: string | null
  used_at: string | null
  revoked_at: string | null
}

const TOKEN_COLS = "token_hash, grant_id, kind, expires_at, used_at, revoked_at"

async function insertToken(grantId: string, kind: TokenRow["kind"], token: string, expiresAt: string | null): Promise<void> {
  const { error } = await supabaseAdmin
    .from("mcp_tokens")
    .insert({ token_hash: hashToken(token), grant_id: grantId, kind, expires_at: expiresAt })
  if (error) fail("insertToken", error)
}

export async function issueOAuthTokens(grantId: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = randomToken(TOKEN_PREFIX.access)
  const refreshToken = randomToken(TOKEN_PREFIX.refresh)
  await insertToken(grantId, "access", accessToken, iso(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000))
  await insertToken(grantId, "refresh", refreshToken, iso(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000))
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SEC }
}

export async function issuePat(grantId: string, token: string, expiresAt: string | null): Promise<void> {
  await insertToken(grantId, "pat", token, expiresAt)
}

export async function findToken(token: string): Promise<TokenRow | null> {
  if (!token || token.length > 400) return null
  const { data, error } = await supabaseAdmin.from("mcp_tokens").select(TOKEN_COLS).eq("token_hash", hashToken(token)).maybeSingle()
  if (error) fail("findToken", error)
  return (data as TokenRow | null) ?? null
}

/** 原子地消耗 refresh token（輪替）。回 { row, reused }：reused＝這把早已用過（疑似外洩 → 呼叫端撤銷整個 grant）。 */
export async function consumeRefreshToken(token: string): Promise<{ row: TokenRow | null; reused: TokenRow | null }> {
  if (!token || token.length > 400) return { row: null, reused: null }
  const tokenHash = hashToken(token)
  const { data, error } = await supabaseAdmin
    .from("mcp_tokens")
    .update({ used_at: nowIso() })
    .eq("token_hash", tokenHash)
    .eq("kind", "refresh")
    .is("used_at", null)
    .select(TOKEN_COLS)
  if (error) fail("consumeRefreshToken", error)
  const row = ((data ?? []) as TokenRow[])[0] ?? null
  if (row) return { row, reused: null }
  const existing = await findToken(token)
  return { row: null, reused: existing && existing.kind === "refresh" ? existing : null }
}

// ── 危險操作 confirm_token ────────────────────────────────────────────

export async function createConfirmation(input: {
  grant_id: string
  user_id: string
  tenant_id: string
  args_hash: string
  summary: string
}): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(TOKEN_PREFIX.confirm, 18)
  const expiresAt = iso(Date.now() + CONFIRM_TOKEN_TTL_SEC * 1000)
  const { error } = await supabaseAdmin
    .from("mcp_confirmations")
    .insert({ ...input, token_hash: hashToken(token), expires_at: expiresAt })
  if (error) fail("createConfirmation", error)
  return { token, expiresAt }
}

/**
 * 消耗 confirm_token：一次性（不論參數對不對，一經出示就作廢），綁同一 user＋grant，5 分鐘內有效，
 * 參數雜湊要完全相同。回 ok 或失敗原因。
 */
export async function consumeConfirmation(
  token: string,
  bind: { grantId: string; userId: string; argsHash: string },
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "expired" | "mismatch" }> {
  if (!token || token.length > 200) return { ok: false, reason: "invalid" }
  const { data, error } = await supabaseAdmin
    .from("mcp_confirmations")
    .update({ used_at: nowIso() })
    .eq("token_hash", hashToken(token))
    .eq("user_id", bind.userId)
    .eq("grant_id", bind.grantId)
    .is("used_at", null)
    .select("args_hash, expires_at")
  if (error) fail("consumeConfirmation", error)
  const row = ((data ?? []) as Array<{ args_hash: string; expires_at: string }>)[0]
  if (!row) return { ok: false, reason: "invalid" }
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" }
  if (row.args_hash !== bind.argsHash) return { ok: false, reason: "mismatch" }
  return { ok: true }
}

export function isExpired(expiresAt: string | null | undefined): boolean {
  return !!expiresAt && Date.parse(expiresAt) <= Date.now()
}

// ── 最高風險操作：待使用者在後台確認（mcp_pending_actions）────────────────

export type PendingStatus = "pending" | "executing" | "done" | "failed" | "rejected" | "expired"

export interface PendingActionRow {
  id: string
  tenant_id: string
  user_id: string
  employee_id: string | null
  grant_id: string | null
  client_name: string
  method: string
  path: string
  query: Record<string, unknown> | null
  body: unknown
  summary: string
  status: PendingStatus
  result_status: number | null
  result: string | null
  expires_at: string
  decided_at: string | null
  created_at: string
}

const PENDING_COLS =
  "id, tenant_id, user_id, employee_id, grant_id, client_name, method, path, query, body, summary, status, result_status, result, expires_at, decided_at, created_at"

/** 讀出時把「過期還沒決定」顯示成 expired（DB 不必有排程去改）。 */
function withExpiry(row: PendingActionRow): PendingActionRow {
  return row.status === "pending" && isExpired(row.expires_at) ? { ...row, status: "expired" } : row
}

export async function createPendingAction(input: {
  tenant_id: string
  user_id: string
  employee_id: string | null
  grant_id: string | null
  client_name: string
  method: string
  path: string
  query: Record<string, unknown> | null
  body: unknown
  summary: string
}): Promise<PendingActionRow> {
  const { data, error } = await supabaseAdmin
    .from("mcp_pending_actions")
    .insert({
      ...input,
      body: input.body === undefined ? null : input.body,
      status: "pending",
      expires_at: iso(Date.now() + PENDING_ACTION_TTL_SEC * 1000),
    })
    .select(PENDING_COLS)
  if (error) fail("createPendingAction", error)
  const row = ((data ?? []) as PendingActionRow[])[0]
  if (!row) fail("createPendingAction", { message: "no row returned" })
  return row
}

/** 只回本人＋本租戶的；別人的、別租戶的一律當不存在。 */
export async function getPendingAction(id: string, scope: { tenantId: string; userId: string }): Promise<PendingActionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data, error } = await supabaseAdmin
    .from("mcp_pending_actions")
    .select(PENDING_COLS)
    .eq("id", id)
    .eq("tenant_id", scope.tenantId)
    .eq("user_id", scope.userId)
    .maybeSingle()
  if (error) fail("getPendingAction", error)
  return data ? withExpiry(data as PendingActionRow) : null
}

export async function listPendingActions(scope: { tenantId: string; userId: string }): Promise<PendingActionRow[]> {
  const { data, error } = await supabaseAdmin
    .from("mcp_pending_actions")
    .select(PENDING_COLS)
    .eq("tenant_id", scope.tenantId)
    .eq("user_id", scope.userId)
    .order("created_at", { ascending: false })
    .limit(30)
  if (error) fail("listPendingActions", error)
  return ((data ?? []) as PendingActionRow[]).map(withExpiry)
}

/** 原子地把 pending（未過期）改成 executing／rejected；回改到的列（null＝已決定、已過期或不存在）。 */
export async function decidePendingAction(
  id: string,
  scope: { tenantId: string; userId: string },
  next: "executing" | "rejected",
): Promise<PendingActionRow | null> {
  const { data, error } = await supabaseAdmin
    .from("mcp_pending_actions")
    .update({ status: next, decided_at: nowIso() })
    .eq("id", id)
    .eq("tenant_id", scope.tenantId)
    .eq("user_id", scope.userId)
    .eq("status", "pending")
    .gt("expires_at", nowIso())
    .select(PENDING_COLS)
  if (error) fail("decidePendingAction", error)
  return ((data ?? []) as PendingActionRow[])[0] ?? null
}

export async function finishPendingAction(id: string, result: { status: "done" | "failed"; resultStatus: number | null; result: string }): Promise<void> {
  const { error } = await supabaseAdmin
    .from("mcp_pending_actions")
    .update({ status: result.status, result_status: result.resultStatus, result: result.result.slice(0, 60_000) })
    .eq("id", id)
  if (error) fail("finishPendingAction", error)
}

// ── 撤銷某使用者的所有 MCP 授權與金鑰（改密碼／重設密碼時；資安驗收 L4）──

export async function revokeAllGrantsForUser(tenantId: string, userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("mcp_grants")
    .update({ revoked_at: nowIso() })
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id")
  if (error) fail("revokeAllGrantsForUser", error)
  return (data ?? []).length
}

// ── DCR 用戶端：總量上限＋90 天未使用清理（資安驗收 L2）──────────────────

/** 刪掉 90 天沒用過的用戶端（從沒用過的看建立時間），回目前剩下的數量（最多數到 limit+1）。 */
export async function pruneAndCountClients(idleDays: number, limit: number): Promise<number> {
  const cutoff = iso(Date.now() - idleDays * 86_400_000)
  const a = await supabaseAdmin.from("mcp_oauth_clients").delete().not("last_used_at", "is", null).lt("last_used_at", cutoff)
  if (a.error) fail("pruneClients(last_used)", a.error)
  const b = await supabaseAdmin.from("mcp_oauth_clients").delete().is("last_used_at", null).lt("created_at", cutoff)
  if (b.error) fail("pruneClients(never_used)", b.error)
  const { data, error } = await supabaseAdmin.from("mcp_oauth_clients").select("client_id").limit(limit + 1)
  if (error) fail("countClients", error)
  return (data ?? []).length
}

export async function touchClient(clientId: string): Promise<void> {
  try {
    await supabaseAdmin.from("mcp_oauth_clients").update({ last_used_at: nowIso() }).eq("client_id", clientId)
  } catch {
    /* ignore */
  }
}
