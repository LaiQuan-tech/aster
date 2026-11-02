import { randomBytes } from "node:crypto"
import type { AuthedUser } from "./supabase.js"

/**
 * MCP 程序內派送用的「一次性內部身分 token」登記表（2026-11-02 MCP 連接）。
 *
 * 為什麼：MCP 工具要「以該使用者身分」走既有 Express routes（權限、業務邏輯、稽核全部沿用，不另寫一套）。
 * 做法是 services/mcp/dispatch.ts 在同一個程序內開一個只綁 127.0.0.1 的 loopback server 打自己的 app，
 * 請求帶 `Authorization: Bearer aster_mcpi_<隨機 256 bit>`；lib/supabase.ts getUserFromToken 先查這張表，
 * 查到就回登記時解出的 AuthedUser（MCP 層每次請求重新向 Supabase Auth 讀的，不是 token 裡快取的權限），
 * 之後 requireTenant／requireRole／resolveSelf 照常從 DB 重讀角色。
 *
 * 安全性：
 *   • token 只存在本程序記憶體、256 bit 隨機、派送結束立刻刪除（另有 60 秒逾時保險）。
 *   • app.ts 會擋「非 loopback 來源」帶內部 token 的請求（isLoopbackAddress）。
 *   • 不碰 DB、不落 log。
 */

export const INTERNAL_TOKEN_PREFIX = "aster_mcpi_"
const TTL_MS = 60_000

export interface InternalIdentity {
  user: AuthedUser
  /** 稽核標記用的用戶端名稱（例：Claude、ChatGPT、個人金鑰名稱）；只留可見 ASCII。 */
  via: string
  expiresAt: number
}

const registry = new Map<string, InternalIdentity>()

function sweep(now: number) {
  for (const [key, value] of registry) if (value.expiresAt <= now) registry.delete(key)
}

/** 稽核 context 用：只留可見 ASCII、去掉中括號，最多 40 字；全被濾掉就叫 client。 */
export function viaLabel(name: string | null | undefined): string {
  const cleaned = (name ?? "").replace(/[^\x20-\x7e]/g, "").replace(/[[\]]/g, "").trim().slice(0, 40)
  return cleaned || "client"
}

export function registerInternalIdentity(user: AuthedUser, via: string): { token: string; release: () => void } {
  const now = Date.now()
  sweep(now)
  const token = `${INTERNAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
  registry.set(token, { user, via: viaLabel(via), expiresAt: now + TTL_MS })
  return { token, release: () => void registry.delete(token) }
}

/** 查內部 token；不是內部格式、查無或逾時 → null（呼叫端照一般 Supabase token 處理或回 401）。 */
export function resolveInternalIdentity(token: string | null | undefined): InternalIdentity | null {
  if (!token || !token.startsWith(INTERNAL_TOKEN_PREFIX)) return null
  const hit = registry.get(token)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    registry.delete(token)
    return null
  }
  return hit
}

export function isInternalToken(token: string | null | undefined): boolean {
  return !!token && token.startsWith(INTERNAL_TOKEN_PREFIX)
}

/** 從 Authorization header 取出 bearer token（沒有 → null）。 */
export function bearerOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value || !/^Bearer\s+/i.test(value)) return null
  const token = value.replace(/^Bearer\s+/i, "").trim()
  return token || null
}

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
}
