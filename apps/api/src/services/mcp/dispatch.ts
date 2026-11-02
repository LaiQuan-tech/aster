import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { registerInternalIdentity, viaLabel } from "../../lib/internal-identity.js"
import type { AuthedUser } from "../../lib/supabase.js"

/**
 * 以使用者身分在「同一程序內」呼叫既有 Express routes（MCP 工具的唯一出口）。
 *
 * 做法：對同一個 app 開一個只綁 127.0.0.1、port 隨機的 loopback server（每個 app 實例一個、lazy、unref），
 * 帶一次性內部 token（lib/internal-identity.ts）打過去。好處是完全走真實的 middleware 鏈
 * （requireAuth → requireTenant → requireRole／resolveSelf → essTabGuard → route → error handlers），
 * 權限與業務邏輯一行都不複製；route 寫的稽核 context 會自動帶 [mcp:<用戶端>]（app.ts）。
 */

export interface DispatchRequest {
  method: string
  path: string
  query?: Record<string, unknown>
  body?: unknown
}

export interface DispatchResult {
  status: number
  contentType: string
  json?: unknown
  text?: string
  binary?: { bytes: number; filename: string | null }
}

const servers = new WeakMap<object, Promise<number>>()

function loopbackPort(app: RequestListener): Promise<number> {
  const existing = servers.get(app)
  if (existing) return existing
  const started = new Promise<number>((resolve, reject) => {
    const server: Server = createServer(app)
    server.once("error", (err) => {
      servers.delete(app)
      reject(err)
    })
    server.listen(0, "127.0.0.1", () => {
      server.unref()
      resolve((server.address() as AddressInfo).port)
    })
  })
  servers.set(app, started)
  return started
}

export function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v))
    else if (typeof value === "object") params.append(key, JSON.stringify(value))
    else params.append(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

const TEXT_LIMIT = 20_000

export async function dispatchAsUser(
  app: RequestListener,
  user: AuthedUser,
  via: string,
  req: DispatchRequest,
  opts: { clientIp?: string | null } = {},
): Promise<DispatchResult> {
  const port = await loopbackPort(app)
  const { token, release } = registerInternalIdentity(user, via)
  try {
    const method = req.method.toUpperCase()
    const hasBody = method !== "GET" && method !== "HEAD" && req.body !== undefined
    const res = await fetch(`http://127.0.0.1:${port}${req.path}${buildQueryString(req.query)}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        // 外層（AI 用戶端）請求的原始 IP：打卡等記 IP 的 route 照 lib/client-ip.ts 讀 x-forwarded-for（資安驗收 L3）。
        // 沒有就標 mcp-dispatch 的 loopback 不填，route 會記成 127.0.0.1／null。
        ...(opts.clientIp ? { "x-forwarded-for": opts.clientIp } : {}),
        "x-mcp-dispatch": viaLabel(via),
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(45_000),
    })
    const contentType = res.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      const raw = await res.text()
      let json: unknown = raw
      try {
        json = raw ? JSON.parse(raw) : null
      } catch {
        /* 保留原文 */
      }
      return { status: res.status, contentType, json }
    }
    if (contentType.startsWith("text/") || contentType === "") {
      const text = await res.text()
      return { status: res.status, contentType, text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…（已截斷）` : text }
    }
    const buf = await res.arrayBuffer()
    const disposition = res.headers.get("content-disposition") ?? ""
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? null
    return { status: res.status, contentType, binary: { bytes: buf.byteLength, filename: filename ? decodeURIComponent(filename) : null } }
  } finally {
    release()
  }
}
