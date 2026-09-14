import { AsyncLocalStorage } from "node:async_hooks"

/**
 * 每個 HTTP 請求一份的「操作者情境」（AsyncLocalStorage）。
 *
 * 用途：讓 `lib/supabase.ts` 的 fetch 包裝在每次打 PostgREST 時自動夾帶
 * `x-actor-emp-id`／`x-actor-route` 兩個 header，DB trigger `audit_row()`
 * （sql/0033 [A]）再從 GUC `request.headers` 讀出來寫進 audit_logs 的
 * actor_emp_id／context——於是「誰改的」由資料庫層記錄，不必每支 route 自己補。
 *
 * 流程：
 *   app.ts 的全域 middleware `runWithRequestContext({ route }, next)` 開一個 store
 *   → 任一處查到呼叫者 employee 時 `setActor(emp.id)`（middleware/role.ts、
 *     middleware/scope.ts resolveSelf、requests.ts 私有 resolveSelf）
 *   → 之後同一請求內所有 supabaseAdmin 呼叫都帶 header。
 *
 * 沒有 store（cron／測試直接呼叫 supabaseAdmin／啟動期）→ getRequestContext()
 * 回 undefined，fetch 不加 header，trigger 記 null——「不誤記」比「一定要記」重要。
 *
 * `route` 允許給函式：Express 的 `req.route.path`（`/employees/:id` 這種 pattern）
 * 要等 route 層 match 之後才有，全域 middleware 當下拿不到，所以延遲到真正
 * 打 DB 的那一刻才解析。
 */
export interface RequestContext {
  actorEmpId?: string
  route?: string | (() => string | undefined)
}

export interface ResolvedRequestContext {
  actorEmpId?: string
  route?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** 記下呼叫者的 employee id；沒有 store（非請求情境）或空值時靜默略過。 */
export function setActor(empId: string | null | undefined): void {
  const store = storage.getStore()
  if (store && empId) store.actorEmpId = empId
}

export function getRequestContext(): ResolvedRequestContext | undefined {
  const store = storage.getStore()
  if (!store) return undefined
  let route: string | undefined
  try {
    route = typeof store.route === "function" ? store.route() : store.route
  } catch {
    route = undefined
  }
  return { actorEmpId: store.actorEmpId, route: route || undefined }
}
