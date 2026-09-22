import type { Request, Response, NextFunction } from "express"

/**
 * ESS 分頁限縮的 API 層守門（M20）——**WP0 stub，目前 no-op**，由 WP2 填實。
 *
 * 目標行為（計畫 §3.2 末列）：非 HR／非會計、且 GET /me 的 essTabs 非 null 的員工，
 * 打到「路由 → tab」對照表裡屬於被限縮分頁的路由 → 403 `ess_tab_disabled`；
 * `/punch*`、`/me`、`/announcements` 不擋。掛在 app.ts 所有 feature router 之前，
 * 所以這裡什麼都不做時，行為＝現況（只有前端擋）。
 */
export function essTabGuard(_req: Request, _res: Response, next: NextFunction): void {
  next()
}
