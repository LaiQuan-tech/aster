import type { Request, Response, NextFunction } from "express"

/**
 * 已刪除專案的寫入（2026-11-12，migration 0096）：DB 觸發器 assert_project_not_deleted 在「所屬專案已刪除」時
 * RAISE ERRCODE 'PD409'、訊息以 `project_deleted:` 開頭。服務層多半把 PostgREST 錯誤包成
 * `new Error(\`…: ${error.message}\`)` 往上丟，所以同時認 code 與訊息前綴。
 * 一律回 **409 `{ error: "project_deleted", message }`**；其他錯誤原樣交給下一個處理器（app.ts 最後的 500）。
 *
 * 跟 period-closed.ts 同一個位置：放在所有路由之後、最後那個 500 處理器之前（app.ts）。
 */
export const PROJECT_DELETED_ERRCODE = "PD409"

export function isProjectDeletedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === PROJECT_DELETED_ERRCODE) return true
  return typeof e.message === "string" && /(^|[\s:(])project_deleted:/.test(e.message)
}

export function projectDeletedErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (isProjectDeletedError(err)) {
    res.status(409).json({ error: "project_deleted", message: "此專案已刪除，不能再新增或修改相關資料" })
    return
  }
  next(err)
}
