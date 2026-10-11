import type { Request, Response, NextFunction } from "express"
import { isPrivilegeError } from "../services/privileged-accounts.js"

/**
 * 特權帳號邊界的全域錯誤處理：任何路由或服務層丟出的 `PrivilegeError`（services/privileged-accounts.ts）
 * 一律變成 **403 `{ error: "not_boss" | "platform_admin_required", message }`**；其他錯誤原樣交給下一個處理器。
 *
 * 跟 period-closed.ts 同一個位置：放在所有路由之後、最後那個 500 處理器之前（app.ts）。測試用的迷你 app 也要掛。
 */
export function privilegeErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (isPrivilegeError(err)) {
    res.status(err.httpStatus).json(err.toBody())
    return
  }
  next(err)
}
