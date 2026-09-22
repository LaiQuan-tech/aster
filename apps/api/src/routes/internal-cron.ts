import { Router } from "express"

/**
 * 排程端點（worker 呼叫；W1 年度給假、M7 生日提醒）——**WP0 stub**，端點由 WP9 填：
 *   POST /internal/leave/annual-grant、POST /internal/people/birthday-reminder
 * 守門 requireInternalToken／requireInternalJobsEnabled 從 routes/internal-jobs.ts 複製。
 */
export const internalCronRouter = Router()
