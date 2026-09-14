import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { getRequestContext } from "./request-context.js"

const url = process.env.SUPABASE_URL ?? ""
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
const anonKey = process.env.SUPABASE_ANON_KEY ?? ""

/** HTTP header 只能放可見 ASCII；超長就截斷（route 字串／uuid 都遠短於 200）。 */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").slice(0, 200)
}

/**
 * supabase-js 的 `global.fetch`：每次打 PostgREST 前，從本請求的
 * AsyncLocalStorage（lib/request-context.ts）取出操作者 employee id 與 route，
 * 夾成 `x-actor-emp-id`／`x-actor-route` header。DB trigger `audit_row()`
 * （sql/0033 [A]）讀 GUC `request.headers` 把兩者寫進 audit_logs，稽核因此
 * 記得到「誰改的」。沒有請求情境（cron、測試直接呼叫）→ 不加 header →
 * trigger 記 null，不會誤記。
 *
 * 每次都讀 `globalThis.fetch` 而不是在模組載入時抓住，測試若替換全域 fetch 仍生效。
 */
const actorFetch: typeof fetch = (input, init) => {
  const ctx = getRequestContext()
  if (!ctx || (!ctx.actorEmpId && !ctx.route)) return globalThis.fetch(input, init)
  const headers = new Headers(init?.headers)
  if (ctx.actorEmpId) headers.set("x-actor-emp-id", headerSafe(ctx.actorEmpId))
  if (ctx.route) headers.set("x-actor-route", headerSafe(ctx.route))
  return globalThis.fetch(input, { ...init, headers })
}

/**
 * Admin client backed by the service_role key. Bypasses RLS — use only on the
 * server for trusted, tenant-scoped queries where the API itself enforces the
 * tenant boundary (the second line of defence alongside DB RLS).
 *
 * We do NOT throw at import time when env vars are missing so that the module
 * can be imported in test/build environments without live credentials.
 */
export const supabaseAdmin: SupabaseClient = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
  global: { fetch: actorFetch },
})

/**
 * Anon client used purely to validate a user's access token via getUser().
 * It carries no elevated privileges.
 */
const supabaseAnon: SupabaseClient = createClient(url, anonKey, {
  auth: { persistSession: false },
})

export interface AuthedUser {
  userId: string
  email: string | null
  appMetadata: Record<string, unknown>
}

/**
 * Resolve a Supabase access token to the underlying user. Returns null when the
 * token is missing or invalid, so callers can map that to a 401.
 */
export async function getUserFromToken(token: string): Promise<AuthedUser | null> {
  if (!token) return null
  const {
    data: { user },
    error,
  } = await supabaseAnon.auth.getUser(token)
  if (error || !user) return null
  return {
    userId: user.id,
    email: user.email ?? null,
    appMetadata: user.app_metadata ?? {},
  }
}
