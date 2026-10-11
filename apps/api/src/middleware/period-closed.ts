import type { Request, Response, NextFunction } from "express"
import { isPeriodClosedError } from "../services/period-lock.js"

/**
 * 發薪鎖定的全域錯誤處理（Express 的 4 參數 error middleware）：任何寫入端點或服務層丟出的
 * `PeriodClosedError`（services/period-lock.ts）一律變成 **409 `{ error: "period_closed", period }`**，
 * 不必每支路由的 catch 各自轉；其他錯誤原樣交給下一個處理器（app.ts 最後的 500）。
 *
 * 要放在所有路由之後、最後那個 500 處理器之前（app.ts）。測試用的迷你 app 也要掛這個，行為才與正式一致。
 */
export function periodClosedErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (isPeriodClosedError(err)) {
    res.status(err.httpStatus).json(err.toBody())
    return
  }
  next(err)
}
