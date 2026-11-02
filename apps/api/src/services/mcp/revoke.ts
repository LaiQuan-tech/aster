import { writeAuditLog } from "../audit.js"
import { revokeAllGrantsForUser } from "./store.js"

/**
 * 改密碼／重設密碼時撤銷該使用者在本租戶的所有 MCP 授權與個人金鑰（資安驗收 L4）。
 * 永不 throw：表未套用或 DB 暫時失敗不能讓改密碼失敗（只記 stderr）。
 */
export async function revokeMcpAccessSafely(tenantId: string, userId: string | null | undefined, actorEmpId?: string | null): Promise<void> {
  if (!userId) return
  try {
    const count = await revokeAllGrantsForUser(tenantId, userId)
    if (count > 0) {
      await writeAuditLog({
        tenantId,
        tableName: "mcp_grants",
        action: "UPDATE",
        actorEmpId: actorEmpId ?? undefined,
        context: "改密碼／重設密碼：撤銷所有 MCP 授權與個人金鑰",
        newRow: { revoked_count: count, user_id: userId },
      })
    }
  } catch (err) {
    console.error("[mcp] revoke on password change failed:", err instanceof Error ? err.message : err)
  }
}
