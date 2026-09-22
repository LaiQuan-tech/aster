import { Router } from "express"

/**
 * 加班超額另計（overtime_settlements；M1）——**WP0 stub**，端點由 WP1 填：
 *   GET  /my/overtime-cap?period=            本人本月累計／上限／超額
 *   GET  /overtime-settlements?period=&status=、PATCH /:id、POST /:id/pay、
 *   POST /overtime-settlements（manual）、GET /overtime-settlements/export.xlsx（HR）
 */
export const overtimeSettlementsRouter = Router()
