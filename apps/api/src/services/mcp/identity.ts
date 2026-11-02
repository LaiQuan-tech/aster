import { getAuthUserById, supabaseAdmin, type AuthedUser } from "../../lib/supabase.js"
import { TOKEN_PREFIX } from "./config.js"
import { findToken, getGrant, isExpired, touchGrant, type GrantRow } from "./store.js"

/**
 * MCP 呼叫者身分（每個請求重新解，不快取權限）：
 *   bearer（OAuth access token 或個人金鑰）→ mcp_tokens → mcp_grants（未撤銷、未過期）
 *   → Supabase Auth 帳號（未停權、app_metadata.tenant_id 仍是授權當時的租戶）
 *   → employees（同租戶、status='active'）。
 * 任何一關不過 → null（/mcp 回 401 invalid_token）。角色不在這裡判斷：派送到既有 route 後由
 * requireRole／resolveSelf 從 DB 重讀，所以降權、停用立即生效。
 */
export interface McpIdentity {
  user: AuthedUser
  tenantId: string
  employeeId: string
  employeeName: string | null
  role: string
  grant: GrantRow
  /** 稽核／預覽顯示用：OAuth 用戶端名稱或個人金鑰名稱。 */
  clientName: string
}

export type EmployeeCheck = { id: string; name: string | null; role: string } | null

/** 同租戶、在職的員工列（停用／離職 → null）。 */
export async function activeEmployeeOf(tenantId: string, userId: string): Promise<EmployeeCheck> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name, role, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { id: string; name?: string | null; role?: string | null; status?: string | null }
  if ((row.status ?? "active") !== "active") return null
  return { id: row.id, name: row.name ?? null, role: row.role ?? "employee" }
}

/** 帳號＋員工身分檢查（token 交換、refresh、每次 /mcp 都跑）。 */
export async function checkAccount(tenantId: string, userId: string): Promise<{ user: AuthedUser; employee: NonNullable<EmployeeCheck> } | null> {
  const user = await getAuthUserById(userId)
  if (!user || user.banned) return null
  if (String(user.appMetadata?.tenant_id ?? "") !== tenantId) return null
  const employee = await activeEmployeeOf(tenantId, userId)
  if (!employee) return null
  return { user: { userId: user.userId, email: user.email, appMetadata: user.appMetadata }, employee }
}

export function looksLikeMcpToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX.access) || token.startsWith(TOKEN_PREFIX.pat)
}

export async function resolveMcpIdentity(bearer: string | null): Promise<McpIdentity | null> {
  if (!bearer || !looksLikeMcpToken(bearer)) return null
  const token = await findToken(bearer)
  if (!token || token.revoked_at || isExpired(token.expires_at)) return null
  if (token.kind !== "access" && token.kind !== "pat") return null
  const grant = await getGrant(token.grant_id)
  if (!grant || grant.revoked_at || isExpired(grant.expires_at)) return null
  const account = await checkAccount(grant.tenant_id, grant.user_id)
  if (!account) return null
  await touchGrant(grant)
  return {
    user: account.user,
    tenantId: grant.tenant_id,
    employeeId: account.employee.id,
    employeeName: account.employee.name,
    role: account.employee.role,
    grant,
    clientName: grant.client_name,
  }
}
