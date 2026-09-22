import { Router } from "express"

/**
 * 值日生／總機輪播排班（duty_rosters；M8）——**WP0 stub**，端點由 WP8 填：
 *   POST /duty-rosters/generate、GET /duty-rosters?from&to&dutyType、PATCH /:id、DELETE /:id（HR）
 *   GET  /duty-rosters/today（任何員工）
 */
export const dutyRostersRouter = Router()
