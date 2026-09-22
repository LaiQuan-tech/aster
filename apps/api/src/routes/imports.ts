import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { AccountError } from "../services/auth-invite.js"
import { isImportKind, templateFileName, type ImportKind } from "../services/imports/kinds.js"
import { parseImportWorkbook } from "../services/imports/parse.js"
import { runImport } from "../services/imports/run.js"
import { buildImportTemplate } from "../services/imports/template.js"
import { CalendarNotMigratedError } from "../services/imports/writers.js"

/**
 * 批次匯入（Excel 範本下載 → 管理員填寫 → 上傳）——HR only。契約見
 * scratchpad 的 batch-import-contract.md（web 端 BatchImport.tsx 照同一份做）。
 *
 *   GET  /imports/:kind/template   xlsx 範本（attachment；檔名 匯入範本-<中文名>.xlsx）
 *   POST /imports/:kind            { fileName, dataBase64, dryRun?, options? }
 *        → 200 { kind, dryRun, total, valid, errors:[{line,message}], imported?, result? }
 *        → 400 unsupported_file（副檔名不是 .xlsx／檔案讀不出來）
 *        → 400 invalid_header（找不到「資料」工作表或缺必填欄；message 說缺哪個）
 *        → 400 too_many_rows（超過 MAX_ROWS）
 *        → 413 file_too_large（base64 解碼後超過 MAX_BYTES）
 *        → 404 unknown_kind
 *        → 503 calendar_not_migrated（holidays：tenant_calendar_days 尚未建表）
 *
 * kind = punches | schedules | salary-adjustments | onboardings | employees | holidays。
 * dryRun=true 只驗證不寫；否則只寫沒錯的列（跟既有 CSV 匯入一致）。
 * employees 的 options.dryRunInvite=true 是「建帳號但不寄信」（對應 bulkInviteFromCsv 的 dryRun），
 * 跟本端點的 dryRun 是兩回事。
 */
export const importsRouter = Router()

const MAX_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 5000

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  // base64 without data: prefix; size is checked post-decode.
  dataBase64: z.string().min(1),
  dryRun: z.boolean().optional(),
  options: z.record(z.unknown()).optional(),
})

function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

function kindParam(req: Request, res: Response): ImportKind | null {
  const kind = String(req.params.kind ?? "")
  if (!isImportKind(kind)) {
    res.status(404).json({ error: "unknown_kind" })
    return null
  }
  return kind
}

importsRouter.get(
  "/imports/:kind/template",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const kind = kindParam(req, res)
    if (!kind) return
    try {
      const buffer = await buildImportTemplate(kind, tenantId)
      sendXlsx(res, buffer, templateFileName(kind))
    } catch (err) {
      next(err)
    }
  },
)

importsRouter.post(
  "/imports/:kind",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const kind = kindParam(req, res)
    if (!kind) return
    const parsed = uploadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { fileName, dataBase64 } = parsed.data
    if (!/\.xlsx$/i.test(fileName)) {
      res.status(400).json({ error: "unsupported_file", message: "只接受 Excel 範本（.xlsx）" })
      return
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(dataBase64, "base64")
    } catch {
      res.status(400).json({ error: "invalid_base64" })
      return
    }
    if (bytes.length === 0) {
      res.status(400).json({ error: "unsupported_file", message: "檔案是空的" })
      return
    }
    if (bytes.length > MAX_BYTES) {
      res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
      return
    }

    try {
      let parsedWorkbook
      try {
        parsedWorkbook = await parseImportWorkbook(bytes, kind)
      } catch (err) {
        // exceljs 讀不出來（不是 xlsx、檔案損毀、被密碼保護）。
        res.status(400).json({
          error: "unsupported_file",
          message: `檔案無法讀取，請用範本另存成 .xlsx 再上傳（${err instanceof Error ? err.message : "unreadable"}）`,
        })
        return
      }
      if (parsedWorkbook.headerErrors.length > 0) {
        res.status(400).json({ error: "invalid_header", message: parsedWorkbook.headerErrors.join("；") })
        return
      }
      if (parsedWorkbook.rows.length > MAX_ROWS) {
        res.status(400).json({ error: "too_many_rows", maxRows: MAX_ROWS, message: `一次最多 ${MAX_ROWS} 列，請分批上傳` })
        return
      }

      const self = req.auth?.userId ? await resolveSelf(tenantId, req.auth.userId) : null
      const result = await runImport(kind, tenantId, parsedWorkbook.rows, {
        dryRun: parsed.data.dryRun === true,
        options: parsed.data.options,
        actorEmpId: self?.id ?? null,
        warnings: parsedWorkbook.warnings,
      })
      res.status(200).json(result)
    } catch (err) {
      if (err instanceof CalendarNotMigratedError) {
        res.status(503).json({ error: "calendar_not_migrated", detail: err.message })
        return
      }
      if (err instanceof AccountError) {
        res.status(err.status).json({ error: err.code, message: err.message })
        return
      }
      next(err)
    }
  },
)
