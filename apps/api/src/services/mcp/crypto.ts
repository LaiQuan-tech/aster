import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { tokenSecret } from "./config.js"

/** 產生帶前綴的高熵 token（256 bit，base64url）。 */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`
}

/** token／授權碼／金鑰在 DB 只存這個（HMAC-SHA256，金鑰＝MCP_TOKEN_SECRET）。 */
export function hashToken(token: string): string {
  return createHmac("sha256", tokenSecret()).update(`tok:${token}`).digest("hex")
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** PKCE S256：BASE64URL(SHA256(code_verifier)) === code_challenge。verifier 必須 43–128 個 unreserved 字元。 */
export function verifyPkceS256(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const computed = createHash("sha256").update(verifier).digest("base64url")
  return safeEqual(computed, challenge)
}

/** 授權請求（給同意頁）的簽章 blob：base64url(JSON).hmac。 */
export function signBlob(kind: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = createHmac("sha256", tokenSecret()).update(`${kind}:${body}`).digest("base64url")
  return `${body}.${sig}`
}

export function verifyBlob<T>(kind: string, blob: string | undefined | null): T | null {
  if (!blob || typeof blob !== "string" || blob.length > 8192) return null
  const [body, sig, extra] = blob.split(".")
  if (!body || !sig || extra !== undefined) return null
  const expected = createHmac("sha256", tokenSecret()).update(`${kind}:${body}`).digest("base64url")
  if (!safeEqual(sig, expected)) return null
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T
  } catch {
    return null
  }
}

/** 鍵排序後的 JSON（危險操作 confirm_token 綁定參數用）。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
