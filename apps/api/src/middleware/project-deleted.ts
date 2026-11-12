import type { Request, Response, NextFunction } from "express"

/**
 * 刪除專案相關的 DB 錯誤（2026-11-12，migrations 0096／0097）→ 一律 409，不要變成 500：
 *   • PD409 `project_deleted:` ——觸發器 assert_project_not_deleted：所屬專案已刪除。
 *   • RD409 `row_deleted:`     ——同一個觸發器：這一列（期程／合約／副委託）已軟刪除，不能再寫金額／日期。
 *   • 40P01 deadlock／40001 serialization ——同時寫入時偶發（任何路由都可能）；文案保持中性，請使用者重新整理後再試。
 * 服務層多半把 PostgREST 錯誤包成 `new Error(\`…: ${error.message}\`)` 往上丟（code 會掉），所以同時認 code 與訊息。
 *
 * 跟 period-closed.ts 同一個位置：放在所有路由之後、最後那個 500 處理器之前（app.ts）。
 */
export const PROJECT_DELETED_ERRCODE = "PD409"
export const ROW_DELETED_ERRCODE = "RD409"

type ErrLike = { code?: unknown; message?: unknown }
const asErr = (err: unknown): ErrLike | null => (err && typeof err === "object" ? (err as ErrLike) : null)
const msgOf = (e: ErrLike) => (typeof e.message === "string" ? e.message : "")

export function isProjectDeletedError(err: unknown): boolean {
  const e = asErr(err)
  if (!e) return false
  return e.code === PROJECT_DELETED_ERRCODE || /(^|[\s:(])project_deleted:/.test(msgOf(e))
}

export function isRowDeletedError(err: unknown): boolean {
  const e = asErr(err)
  if (!e) return false
  return e.code === ROW_DELETED_ERRCODE || /(^|[\s:(])row_deleted:/.test(msgOf(e))
}

/** 死鎖（40P01）或序列化失敗（40001）：可重試的衝突。 */
export function isRetryableConflictError(err: unknown): boolean {
  const e = asErr(err)
  if (!e) return false
  if (e.code === "40P01" || e.code === "40001") return true
  return /deadlock detected|could not serialize access/i.test(msgOf(e))
}

export function projectDeletedErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (isProjectDeletedError(err)) {
    res.status(409).json({ error: "project_deleted", message: "此專案已刪除，不能再新增或修改相關資料" })
    return
  }
  if (isRowDeletedError(err)) {
    res.status(409).json({ error: "row_deleted", message: "這筆資料已被刪除，不能再寫入金額或日期，請重新整理" })
    return
  }
  if (isRetryableConflictError(err)) {
    res.status(409).json({ error: "conflict_retry", message: "資料正在被其他操作修改，請重新整理後再試" })
    return
  }
  next(err)
}
